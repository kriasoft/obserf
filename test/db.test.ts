import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, knownFindingsForDryRun, latestRunPerProject, schema, storedProjects } from "../db";
import { migrate } from "../db/migrate";

/**
 * `storedProjects` is what lets `obserf list`, `runs` and `rescore` reject a
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
           welcome, reach, reason, score, disqualified, created_at)
         VALUES (?, 'm', 'f', 1, 1, 1, 1, 'r', 0, ?, ?)`,
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
