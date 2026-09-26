import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  db,
  findingById,
  knownFindingsForDryRun,
  latestRunPerProject,
  latestScanMark,
  schema,
  setTriage,
  DecisionChanged,
  storedProjects,
} from "../db";
import { eq } from "drizzle-orm";
import { migrate } from "../db/migrate";

/**
 * `storedProjects` is what lets `obserf list` and `runs` reject a
 * mistyped `--project` without also locking the operator out of the history of a
 * profile they have since retired. Pinned here: either table alone counts, a
 * project in both is named once, and the list is sorted.
 *
 * Other suites write to the same test database (`test/setup.ts`), so the
 * membership and dedupe assertions use keys unique to this test.
 */
test("names every project the database holds rows for, once", () => {
  const insertFinding = (project: string) =>
    db
      .insert(schema.findings)
      .values({
        project,
        sourceId: "github",
        url: `https://example.com/${project}`,
        title: "a",
        venue: "example.com",
        discoveredAt: new Date(),
      })
      .run();
  const insertRun = (project: string) =>
    db
      .insert(schema.runs)
      .values({ project, startedAt: new Date(), sources: ["github"] })
      .run();

  insertRun("stored-projects-run-only");
  insertFinding("stored-projects-finding-only");
  insertRun("stored-projects-both");
  insertFinding("stored-projects-both");

  const stored = storedProjects();
  expect(stored).toContain("stored-projects-run-only");
  expect(stored).toContain("stored-projects-finding-only");
  expect(stored.filter((key) => key === "stored-projects-both")).toHaveLength(1);
  expect(stored).toEqual([...stored].sort());
});

/**
 * The query behind an unfiltered inbox: each stored project's newest scan,
 * chosen by id, since a clock that moved backwards would otherwise pick an older
 * one.
 */
test("latestRunPerProject keeps each project's newest run, by id", () => {
  const insertRun = (project: string, startedAt: number) =>
    db
      .insert(schema.runs)
      .values({ project, startedAt: new Date(startedAt), sources: ["github"] })
      .returning()
      .get().id;

  const olderA = insertRun("latest-run-a", 2000);
  const newerA = insertRun("latest-run-a", 1000);
  const onlyB = insertRun("latest-run-b", 0);

  const ours = latestRunPerProject()
    .filter((run) => run.project.startsWith("latest-run-"))
    .map((run) => run.id);
  expect(ours).toEqual([onlyB, newerA]);
  expect(ours).not.toContain(olderA);
});

/**
 * The history behind `scan --dry-run`'s gate counts. The old read-only connection
 * could not open a closed WAL database and swallowed the error, so every dry run
 * counted as though nothing had been seen.
 */
describe("knownFindingsForDryRun", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "obserf-dry-"));
    dirs.push(dir);
    return dir;
  }

  function insertFinding(handle: Database, url: string): number {
    const row = handle
      .query<{ id: number }, [string]>(
        `INSERT INTO findings (project, source_id, url, title, venue, discovered_at)
         VALUES ('p', 'hn', ?, 't', 'example.com', 0) RETURNING id`,
      )
      .get(url);
    if (!row) throw new Error("fixture insert returned no id");
    return row.id;
  }

  /**
   * A closed WAL database without sidecars. Bun on macOS keeps them on close, so
   * they are removed by hand to stage it everywhere.
   */
  function closedWalDatabase(seed: (handle: Database) => void): string {
    const path = join(tempDir(), "obserf.db");
    const handle = new Database(path, { readwrite: true, create: true });
    migrate(handle);
    handle.exec("PRAGMA journal_mode = WAL");
    seed(handle);
    handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    handle.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    return path;
  }

  test("no database at all is no history, not a failure", () => {
    expect(knownFindingsForDryRun("p", join(tempDir(), "obserf.db")).size).toBe(0);
  });

  /** The regression, asserting every field the gate reads, not just the count. */
  test("reads a closed WAL database, whose sidecars are gone", () => {
    const path = closedWalDatabase((handle) => {
      const id = insertFinding(handle, "https://example.com/a");
      handle
        .query(`UPDATE findings SET metrics = '{"points":5}', is_thread_comment = 1 WHERE id = ?`)
        .run(id);
      insertFinding(handle, "https://example.com/b");
      handle
        .query("INSERT INTO triage (finding_id, status, updated_at) VALUES (?, 'dismissed', 0)")
        .run(id);
      const assess = handle.query(
        `INSERT INTO assessments (finding_id, model, prompt_fingerprint, relevance, intent,
           welcome, reach, reason, disqualified, created_at)
         VALUES (?, 'm', 'f', 1, 1, 1, 1, 'r', ?, ?)`,
      );
      assess.run(id, 0, 1);
      assess.run(id, 1, 2);
    });
    expect(existsSync(`${path}-wal`)).toBe(false);

    const known = knownFindingsForDryRun("p", path);
    expect(known.get("https://example.com/a")).toEqual({
      status: "dismissed",
      lastAssessedAt: new Date(2_000),
      disqualified: true,
      title: "t",
      excerpt: "",
      metrics: { points: 5 },
      isThreadComment: true,
    });
    expect(known.get("https://example.com/b")?.status).toBe("new");
  });

  /** Committed but not yet checkpointed still counts as known. */
  test("sees history still sitting in the WAL", () => {
    const path = closedWalDatabase((handle) => insertFinding(handle, "https://example.com/a"));
    const writer = new Database(path, { readwrite: true });
    try {
      insertFinding(writer, "https://example.com/uncheckpointed");
      expect(knownFindingsForDryRun("p", path).size).toBe(2);
    } finally {
      writer.close();
    }
  });

  /**
   * `OBSERF_DB` can name any file. An empty history would fake new findings, and
   * the shared connection would migrate or switch the journal of a file obserf
   * does not own.
   */
  test("an unreadable history fails, naming the file, and leaves it as it was", () => {
    const path = join(tempDir(), "not-obserf.db");
    const alien = new Database(path, { readwrite: true, create: true });
    alien.exec("CREATE TABLE unrelated (x INTEGER)");
    alien.close();
    const describe = () => {
      const handle = new Database(path, { readonly: true });
      try {
        return {
          journal: handle.query("PRAGMA journal_mode").get(),
          tables: handle.query("SELECT name FROM sqlite_master ORDER BY name").all(),
        };
      } finally {
        handle.close();
      }
    };
    const before = describe();

    expect(() => knownFindingsForDryRun("p", path)).toThrow(
      `Could not read what is already known from ${path}`,
    );
    expect(describe()).toEqual(before);
  });

  /** Against the real `databasePath`, fixed at import, so in a child process. */
  async function dryRunIn(env: Record<string, string>) {
    const root = tempDir();
    writeFileSync(join(root, "obserf.config.ts"), "export default {};");
    // Removed rather than emptied: the fresh case is a variable never set.
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...env,
      OBSERF_HOME: root,
    };
    if (!("OBSERF_DB" in env)) delete childEnv.OBSERF_DB;
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `import { knownFindingsForDryRun } from ${JSON.stringify(join(import.meta.dir, "..", "db"))};
         console.log(knownFindingsForDryRun("p").size);`,
      ],
      { env: childEnv, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { root, code: await child.exited, stdout, stderr };
  }

  /** The half of `requireReachableDatabase` that allows. */
  test("a fresh workspace reads as no history, and creates nothing", async () => {
    const { root, code, stdout, stderr } = await dryRunIn({});
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe("0");
    expect(existsSync(join(root, ".obserf"))).toBe(false);
  });

  test("a mistyped OBSERF_DB fails rather than reading as no history", async () => {
    const typo = join(tmpdir(), `obserf-typo-${process.pid}.db`);
    const { code, stderr } = await dryRunIn({ OBSERF_DB: typo });
    expect(code).not.toBe(0);
    expect(stderr).toContain(`No database at ${typo} (OBSERF_DB)`);
    expect(existsSync(typo)).toBe(false);
  });
});

/**
 * A category describes a dismissal, so it lives exactly as long as one: kept
 * while the note is edited, gone once the finding is reopened, and never stored
 * beside another status.
 */
describe("setTriage and the dismissal category", () => {
  const id = db
    .insert(schema.findings)
    .values({
      project: "triage-category",
      sourceId: "hn",
      url: "https://example.com/triage-category",
      title: "t",
      venue: "example.com",
      discoveredAt: new Date(),
    })
    .returning()
    .get().id;
  const category = () => findingById(id)?.dismissalCategory;

  test("survives a note edit, and is cleared by reopening", () => {
    setTriage(id, { status: "dismissed", category: "paid" });
    setTriage(id, { status: "dismissed", note: "why" });
    expect(category()).toBe("paid");
    setTriage(id, { status: "dismissed", category: null });
    expect(category()).toBeNull();
    setTriage(id, { status: "dismissed", category: "concluded" });
    setTriage(id, { status: "new" });
    expect(category()).toBeNull();
    // Dismissed again without one: the old cause does not come back.
    setTriage(id, { status: "dismissed" });
    expect(category()).toBeNull();
  });

  /** A category typed in the inbox must not undo a reopening made from the terminal. */
  test("an amendment is refused once the decision changed", () => {
    setTriage(id, { status: "dismissed" });
    setTriage(id, { status: "new" });
    expect(() => setTriage(id, { status: "dismissed", category: "paid", amend: true })).toThrow(
      DecisionChanged,
    );
    expect(findingById(id)?.status).toBe("new");

    setTriage(id, { status: "dismissed" });
    setTriage(id, { status: "dismissed", category: "paid", amend: true });
    expect(category()).toBe("paid");
  });

  /** The reopened finding is judged by someone who saw the first verdict. */
  test("records whether the first decision was hidden, once", () => {
    const hiddenOf = () => findingById(id)?.firstDecidedHidden;
    setTriage(id, { status: "new" });
    // This finding may already carry a first decision from the test above.
    db.update(schema.triage)
      .set({ firstDecidedHidden: null })
      .where(eq(schema.triage.findingId, id))
      .run();
    setTriage(id, { status: "new", note: "still new", hidden: true });
    expect(hiddenOf()).toBeNull();
    setTriage(id, { status: "shortlisted", hidden: true });
    expect(hiddenOf()).toBe(true);
    setTriage(id, { status: "new" });
    setTriage(id, { status: "dismissed" });
    expect(hiddenOf()).toBe(true);
  });

  /** Where it was posted, added after `a` without overwriting a note edited since. */
  test("appends a line to whatever note is stored when it runs", () => {
    const note = () => findingById(id)?.note;
    setTriage(id, { status: "acted", note: null });
    setTriage(id, { status: "acted", appendNote: "Posted: first" });
    expect(note()).toBe("Posted: first");
    setTriage(id, { status: "acted", note: "edited since" });
    setTriage(id, { status: "acted", appendNote: "Posted: second" });
    expect(note()).toBe("edited since\nPosted: second");
    expect(() => setTriage(id, { status: "acted", note: "a", appendNote: "b" })).toThrow(
      "not both",
    );
  });

  /** Undo restores the whole decision it took back, category included. */
  test("reports the status and category it replaced", () => {
    setTriage(id, { status: "dismissed", category: "paid" });
    expect(setTriage(id, { status: "shortlisted" })).toEqual({
      status: "dismissed",
      category: "paid",
    });
  });

  /** Only a dismissal says Obserf was wrong, so only it keeps a cause. */
  test("is cleared when a dismissal is changed to skipped", () => {
    setTriage(id, { status: "dismissed", category: "vocabulary-only" });
    setTriage(id, { status: "skipped" });
    expect(category()).toBeNull();
  });

  test("is refused beside any other status", () => {
    expect(() => setTriage(id, { status: "shortlisted", category: "paid" })).toThrow(
      "dismissal category",
    );
  });
});

/** What a review starts with: what the latest scan added, and what it looked at again. */
describe("latestScanMark", () => {
  const run = { id: 7 };

  test("new when that scan first stored it, whoever wrote its verdict", () => {
    expect(latestScanMark({ firstRunId: 7 }, { runId: 7 }, run)).toBe("new");
  });

  test("reassessed when that scan wrote the verdict of an earlier finding", () => {
    expect(latestScanMark({ firstRunId: 3 }, { runId: 7 }, run)).toBe("reassessed");
    expect(latestScanMark({ firstRunId: 3 }, { runId: 5 }, run)).toBeNull();
  });

  /** Recorded before verdicts named their run: unknown, so unmarked. */
  test("nothing for a legacy verdict, or without a scan to compare against", () => {
    expect(latestScanMark({ firstRunId: 3 }, { runId: null }, run)).toBeNull();
    expect(latestScanMark({ firstRunId: null }, { runId: 7 }, undefined)).toBeNull();
  });
});
