import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clipped,
  colourable,
  describeSources,
  listArg,
  venueUnlessRedundant,
  wrapped,
} from "../cli";
import { migrate } from "../db/migrate";

/**
 * The CLI run as a CLI, for the properties that are about the process rather
 * than about a return value: refusing before anything is touched, and what the
 * exit code is. `main()` is behind `import.meta.main`, so the helpers below can
 * simply be imported and called.
 */
const CLI = join(import.meta.dir, "..", "cli.ts");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A workspace with one usable profile, and no database yet. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "obserf-cli-"));
  roots.push(root);
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "obserf.config.ts"), "export default {};");
  writeFileSync(
    join(root, "projects", "p.ts"),
    `export default { key: "p", name: "P", url: "https://e.com", pitch: "p",
       solves: ["s"], notFor: ["n"], voice: "v",
       queries: { search: ["a"], subreddits: [], github: [] } };`,
  );
  return root;
}

async function run(root: string, ...args: string[]) {
  const child = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, OBSERF_HOME: root, OBSERF_DB: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // Both together for what the operator reads, and stdout alone for what a pipe
  // would carry away — a command that failed must not have written the draft to it.
  return { code: await child.exited, output: stdout + stderr, stdout };
}

describe("--project resolution", () => {
  function workspaceWithStoredProject(): string {
    const root = workspace();
    mkdirSync(join(root, ".obserf"), { recursive: true });
    const handle = new Database(join(root, ".obserf", "obserf.db"), { create: true });
    migrate(handle);
    handle
      .query("INSERT INTO runs (project, started_at, sources) VALUES (?,?,?)")
      .run("retired", 0, JSON.stringify(["hn"]));
    handle.close();
    return root;
  }

  test("reports a profile that will not load, rather than calling the key unknown", async () => {
    const root = workspaceWithStoredProject();
    writeFileSync(join(root, "projects", "broken.ts"), `throw new Error("profile is broken");`);
    const { code, output } = await run(root, "rescore", "--project", "p");
    expect(code).not.toBe(0);
    expect(output).toContain("profile is broken");
    expect(output).not.toContain("Unknown project");
  });

  test("still reads a retired project without loading any profile", async () => {
    const root = workspaceWithStoredProject();
    writeFileSync(join(root, "projects", "broken.ts"), `throw new Error("profile is broken");`);
    const { code } = await run(root, "rescore", "--project", "retired");
    expect(code).toBe(0);
  });

  test("an unknown key names the active and the retired projects", async () => {
    const { code, output } = await run(
      workspaceWithStoredProject(),
      "list",
      "--project",
      "missing",
    );
    expect(code).not.toBe(0);
    expect(output).toContain(`Unknown project "missing". Available: p, retired`);
  });

  /** Retiring the last profile must not turn a typo into "no profiles". */
  test("is still named as unknown once every profile is retired", async () => {
    const root = workspaceWithStoredProject();
    rmSync(join(root, "projects", "p.ts"));
    const { code, output } = await run(root, "rescore", "--project", "missing");
    expect(code).not.toBe(0);
    expect(output).toContain(`Unknown project "missing". Available: retired`);
  });

  test("a typo with no projects at all creates no database", async () => {
    const root = workspace();
    rmSync(join(root, "projects", "p.ts"));
    const { code, output } = await run(root, "rescore", "--project", "missing");
    expect(code).not.toBe(0);
    expect(output).toContain(`Unknown project "missing". No projects are available.`);
    expect(existsSync(join(root, ".obserf"))).toBe(false);
  });

  /** A database that fails on open, so reaching the lookup first would fail differently. */
  test("numeric filters are parsed before the lookup", async () => {
    const root = workspace();
    mkdirSync(join(root, ".obserf"), { recursive: true });
    writeFileSync(join(root, ".obserf", "obserf.db"), "not a sqlite database");
    const { code, output } = await run(root, "list", "--project", "p", "--min", "nope");
    expect(code).not.toBe(0);
    expect(output).toContain("--min must be an integer");
    // `runRuns` orders its own parsing, so the list case cannot stand in for it.
    const runs = await run(root, "runs", "--project", "p", "--limit", "nope");
    expect(runs.code).not.toBe(0);
    expect(runs.output).toContain("--limit must be an integer");
  });

  test("an empty key is refused rather than meaning every project", async () => {
    const { code, output } = await run(workspace(), "rescore", "--project", "");
    expect(code).not.toBe(0);
    expect(output).toContain("--project was given no value");
  });
});

/**
 * `obserf draft` has always printed what the operator verified about the venue
 * and what obserf cannot establish — permission and cost — because that is the
 * moment a draft is acted on. `obserf show` prints stored drafts, which is the
 * other moment, and used to print them bare. The inbox already carries the rule
 * on the finding for exactly this reason; the two front ends have to agree.
 */
describe("a stored draft, re-read", () => {
  /** A finding with a draft against it, and a profile that recorded a venue rule. */
  function workspaceWithADraft(guidance: string | null): string {
    const root = workspace();
    writeFileSync(
      join(root, "projects", "p.ts"),
      `export default { key: "p", name: "P", url: "https://e.com", pitch: "p",
         solves: ["s"], notFor: ["n"], voice: "v",
         queries: { search: ["a"], subreddits: [], github: [] }${
           guidance ? `, venueGuidance: { "r/golang": ${JSON.stringify(guidance)} }` : ""
         } };`,
    );

    mkdirSync(join(root, ".obserf"), { recursive: true });
    const handle = new Database(join(root, ".obserf", "obserf.db"), { create: true });
    migrate(handle);
    handle
      .query(
        "INSERT INTO findings (project, source_id, url, title, venue, discovered_at) VALUES (?,?,?,?,?,?)",
      )
      .run("p", "reddit", "https://reddit.com/r/golang/comments/1", "T", "r/golang", 0);
    handle
      .query("INSERT INTO drafts (finding_id, kind, body, model, created_at) VALUES (?,?,?,?,?)")
      .run(1, "comment", "a draft body", "claude-opus-5", 0);
    handle.close();
    return root;
  }

  test("carries the operator's verified rule for the venue", async () => {
    const { code, output } = await run(
      workspaceWithADraft("link only in the weekly thread"),
      "show",
      "1",
    );
    expect(code).toBe(0);
    expect(output).toContain("a draft body");
    expect(output).toContain("link only in the weekly thread");
    expect(output).toContain("Obserf never posts");
  });

  test("says plainly when nothing about the venue was verified", async () => {
    const { code, output } = await run(workspaceWithADraft(null), "show", "1");
    expect(code).toBe(0);
    expect(output).toContain("No verified guidance recorded for r/golang");
    // The product's claim is this weak on purpose: obserf establishes usefulness
    // and neither of the other two conditions.
    expect(output).toContain("permitted");
    expect(output).toContain("costs");
    // And says where what they check goes, since that is the only thing that
    // makes the claim stronger next time.
    expect(output).toContain("venueGuidance");
  });

  /**
   * The reminder is what makes `show` read a profile at all, and a scan's loader
   * refuses a workspace with none. Retiring the last profile has to leave its
   * findings and drafts readable — which is the whole of `loadProjectsIfAny`,
   * and is not observable from that function's own tests.
   */
  test("survives the retirement of the profile that produced it", async () => {
    const root = workspaceWithADraft("link only in the weekly thread");
    rmSync(join(root, "projects", "p.ts"));
    const { code, output } = await run(root, "show", "1");
    expect(code).toBe(0);
    expect(output).toContain("a draft body");
    // And says which of the two it is: this profile recorded a rule, so
    // reporting that none was recorded would be obserf describing evidence it
    // has merely lost the ability to read.
    expect(output).toContain("unreadable");
    expect(output).not.toContain("No verified guidance recorded");
  });

  /**
   * The reminder is the point of reading the profile at all, so a profile that
   * will not load has to stop the draft rather than follow it: `obserf show 42 |
   * pbcopy` would otherwise carry the text away without what obserf could not
   * establish about the venue.
   */
  test("is not printed at all when the profile will not load", async () => {
    const root = workspaceWithADraft("link only in the weekly thread");
    writeFileSync(
      join(root, "projects", "p.ts"),
      `export default { key: "p", name: "P", url: "https://e.com", pitch: "p",
         solves: ["s"], notFor: ["n"], voice: "v",
         queries: { search: ["a"], subreddits: [], github: [] },
         venueGuidance: { "r/golang": 42 } };`,
    );
    const { code, stdout, output } = await run(root, "show", "1");
    expect(code).not.toBe(0);
    expect(stdout).not.toContain("a draft body");
    expect(output).toContain("venueGuidance");
  });
});

/**
 * `obserf show` is where a verdict is diagnosed (docs/product/evaluation.md), so
 * each line it prints is a claim about the record, and each has a state in which
 * printing it would be false.
 */
describe("a finding read back", () => {
  /** A finding with no assessment, triage row or scan behind it, ready for more rows. */
  function bareFinding(): { root: string; handle: Database } {
    const root = workspace();
    mkdirSync(join(root, ".obserf"), { recursive: true });
    const handle = new Database(join(root, ".obserf", "obserf.db"), { create: true });
    migrate(handle);
    handle
      .query(
        "INSERT INTO findings (project, source_id, url, title, venue, author, is_thread_comment, discovered_at, first_run_id) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "p",
        "hn",
        "https://news.ycombinator.com/item?id=1",
        "T",
        "news.ycombinator.com",
        null,
        null,
        0,
        null,
      );
    return { root, handle };
  }

  test("prints every verdict with what produced it, newest first", async () => {
    const { root, handle } = bareFinding();
    handle.run(
      "INSERT INTO runs (project, started_at, sources) VALUES ('p', 0, '[]'), ('p', 0, '[]')",
    );
    handle.run("UPDATE findings SET author = 'alice', is_thread_comment = 1, first_run_id = 2");
    const assess = handle.query(
      "INSERT INTO assessments (finding_id, model, prompt_fingerprint, relevance, intent, welcome, reach, opportunity, disqualified, reason, score, created_at) VALUES (1,?,?,?,?,?,?,'thread',?,?,?,0)",
    );
    assess.run("model-a", "fp-old", 4, 4, 1, 3, 1, "old reason", 0);
    assess.run("model-b", "fp-new", 4, 4, 4, 3, 0, "new reason", 72);
    handle.run("INSERT INTO triage (finding_id, status) VALUES (1, 'shortlisted')");
    handle.run(
      "INSERT INTO drafts (finding_id, kind, body, model, created_at) VALUES (1, 'reply', 'body', 'model-d', 0)",
    );
    handle.close();

    const { code, output } = await run(root, "show", "1");
    expect(code).toBe(0);
    // The venue is the URL's host, so only the URL says it.
    expect(output).toContain("p · hn ·");
    expect(output).toContain("one comment inside a thread, not the thread itself · author: alice");
    expect(output).toContain("first seen");
    expect(output).toContain("in scan #2 · triage updated");
    expect(output).toContain("model-b · prompt fp-new");
    const earlier = output.slice(output.indexOf("Earlier assessments"));
    // No score: `rescore` would have rewritten it. The flag leads, since none of
    // the components shows it.
    expect(earlier).toContain("  disqualified · relevance 4 · intent 4 · welcome 1 · reach 3");
    expect(earlier).toContain("snapshots not kept");
    expect(earlier).toContain("model-a · prompt fp-old");
    expect(earlier).toContain("thread — old reason");
    expect(earlier).not.toContain("fp-new");
    // A draft names its own model, which need not be the verdict's.
    expect(output).toContain("model-d");
  });

  test("claims nothing the record does not hold", async () => {
    const { root, handle } = bareFinding();
    handle.close();
    const { code, output } = await run(root, "show", "1");
    expect(code).toBe(0);
    expect(output).toContain("No assessment recorded.");
    // Neither a missing verdict nor an unclassified shape becomes a claim.
    expect(output).not.toContain("Score ");
    expect(output).not.toContain("one comment inside a thread");
    expect(output).toContain("first seen");
    expect(output).not.toContain("in scan #");
    // Without a triage row the status falls back to `new`, which dates nothing.
    expect(output).not.toContain("triage updated");
    expect(output).not.toContain("author:");
    expect(output).not.toContain("Earlier assessments");
  });

  /** A note written while leaving the status `new` moves the timestamp, but rules nothing. */
  test("dates no decision while the status is still new", async () => {
    const { root, handle } = bareFinding();
    handle.run("INSERT INTO triage (finding_id, status, note) VALUES (1, 'new', 'look again')");
    handle.close();
    const { code, output } = await run(root, "show", "1");
    expect(code).toBe(0);
    expect(output).toContain("look again");
    expect(output).not.toContain("triage updated");
  });
});

/**
 * A scan writes its totals only when it finalizes, so a row without `finishedAt`
 * carries the insert's zeros, and "0 candidates → 0 assessed" for a scan that
 * was killed mid-way is the misreport `obserf runs` exists to prevent.
 */
describe("an unfinished scan", () => {
  test("is reported without the totals it never recorded", async () => {
    const root = workspace();
    mkdirSync(join(root, ".obserf"), { recursive: true });
    const handle = new Database(join(root, ".obserf", "obserf.db"), { create: true });
    migrate(handle);
    handle
      .query("INSERT INTO runs (project, started_at, sources) VALUES (?,?,?)")
      .run("p", 0, JSON.stringify(["hn"]));
    handle.close();

    const { code, output } = await run(root, "runs");
    expect(code).toBe(0);
    expect(output).toContain("unfinished");
    expect(output).toContain("never finished, so its counts and token usage were not recorded");
    expect(output).not.toContain("0 candidates");
  });
});

describe("a finished scan", () => {
  /** A scan that gated 12 candidates and assessed 4, unless a row says otherwise. */
  type RunRow = {
    startedAt?: number;
    project?: string;
    gated?: string | null;
    assessed?: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    error?: string | null;
  };
  function workspaceWithRuns(rows: RunRow[]): string {
    const root = workspace();
    mkdirSync(join(root, ".obserf"), { recursive: true });
    const handle = new Database(join(root, ".obserf", "obserf.db"), { create: true });
    migrate(handle);
    for (const row of rows) {
      const {
        startedAt = 0,
        project = "p",
        gated = JSON.stringify({ duplicate: 3, blocked: 0, stale: 5 }),
        assessed = 4,
        inputTokens = 1000,
        outputTokens = 200,
        estimatedCostUsd = 0.012,
        error = null,
      } = row;
      handle
        .query(
          `INSERT INTO runs (project, started_at, finished_at, sources, skipped, candidates, gated,
             assessed, input_tokens, output_tokens, estimated_cost_usd, error)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          project,
          startedAt,
          startedAt + 75,
          JSON.stringify(["hn", "github"]),
          "{}",
          12,
          gated,
          assessed,
          inputTokens,
          outputTokens,
          estimatedCostUsd,
          error,
        );
    }
    handle.close();
    return root;
  }

  /** A failure keeps the work done before it, and says so in words as well as in red. */
  test("prints the gate breakdown, the spend and the failure", async () => {
    const root = workspaceWithRuns([{ assessed: 3, error: "rate limited" }]);
    const { code, output } = await run(root, "runs");
    expect(code).toBe(0);
    expect(output).toContain("1m15s failed");
    expect(output).toContain("12 candidates → 3 assessed (dropped: 3 duplicate, 5 stale)");
    expect(output).toContain("1000 in (0 cached) / 200 out tokens · ~$0.012 at list price");
    expect(output).toContain("rate limited");
  });

  /** `new Error("")` is recorded as an empty message, and is still a failure. */
  test("an empty stored error still marks the run as failed", async () => {
    const { output } = await run(workspaceWithRuns([{ error: "" }]), "runs");
    expect(output).toContain("1m15s failed");
  });

  /** Ordered by id, so a clock moved backwards cannot bury the latest scan. */
  test("lists the latest runs first, up to --limit", async () => {
    const root = workspaceWithRuns([{ startedAt: 3000 }, { startedAt: 2000 }, { startedAt: 1000 }]);
    const { output } = await run(root, "runs", "--limit", "2");
    expect(output.indexOf("#3")).toBeGreaterThanOrEqual(0);
    expect(output.indexOf("#3")).toBeLessThan(output.indexOf("#2"));
    expect(output).not.toContain("#1 ");
  });

  /**
   * What a discovery failure writes: hn returned 12 candidates, github threw, and
   * nothing after discovery ran, so no gate counts, no assessments, no tokens.
   */
  test("says the gate did not run, rather than drawing an arrow through it", async () => {
    const root = workspaceWithRuns([
      {
        gated: null,
        assessed: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        error: "Discovery failed, so nothing was assessed — github: 502",
      },
    ]);
    const { output } = await run(root, "runs");
    expect(output).toContain("failed");
    expect(output).toContain("12 candidates · the gate did not run");
    expect(output).not.toContain("12 candidates →");
    expect(output).not.toContain("out tokens");
  });

  test("--project shows only that project's runs", async () => {
    const root = workspaceWithRuns([{ project: "p" }, { project: "q" }]);
    const { output } = await run(root, "runs", "--project", "q");
    expect(output).toContain("#2");
    expect(output).not.toContain("#1 ");
  });
});

describe("a flag the command does not use", () => {
  test("is refused, and says what the command does take", async () => {
    const { code, output } = await run(workspace(), "scan", "--limit", "3");
    expect(code).not.toBe(0);
    expect(output).toContain("`obserf scan` does not take --limit");
    expect(output).toContain("--project, --source, --dry-run");
  });

  /**
   * The one that has to be refused before anything happens: a snapshot taken on
   * the way to rejecting the flag is a side effect of a command that failed.
   */
  test("is refused before the command touches the workspace", async () => {
    const root = workspace();
    const { code, output } = await run(root, "backup", "--project", "p");
    expect(code).not.toBe(0);
    expect(output).toContain("It takes no options");
    expect(existsSync(join(root, ".obserf"))).toBe(false);
  });

  test("a command with no options at all says so", async () => {
    const { output } = await run(workspace(), "projects", "--min", "5");
    expect(output).toContain("`obserf projects` does not take --min. It takes no options.");
  });
});

describe("a surplus argument", () => {
  test("is refused rather than dropped", async () => {
    const { code, output } = await run(workspace(), "show", "12", "34");
    expect(code).not.toBe(0);
    expect(output).toContain(`"34" would be ignored`);
  });
});

/** Last-wins for a flag that is not a list: `--min 80 --min 1` listed everything. */
describe("a repeated flag", () => {
  test("is refused rather than half-read", async () => {
    const { code, output } = await run(workspace(), "list", "--min", "80", "--min", "1");
    expect(code).not.toBe(0);
    expect(output).toContain("--min was given more than once");
  });
});

describe("what a command still accepts", () => {
  test("its own flags pass through", async () => {
    // `--status` twice: a list flag, so not refused as a repeat.
    const { code, output } = await run(
      workspace(),
      "list",
      "--project",
      "p",
      "--min",
      "0",
      "--status",
      "new",
      "--status",
      "acted",
    );
    expect(code).toBe(0);
    expect(output).toContain("Nothing to show");
  });

  /** Help is what you run when you do not know the grammar. */
  test("help does not insist on the grammar", async () => {
    const { code, output } = await run(workspace(), "help", "--port", "9");
    expect(code).toBe(0);
    expect(output).toContain("Usage: obserf <command>");
  });
});

describe("what a command was not given", () => {
  /** The lookup opens and upgrades the database; the complaint comes first. */
  test("a missing status is reported without looking the finding up", async () => {
    const root = workspace();
    const { output } = await run(root, "triage", "5");
    expect(output).toContain("Expected a status");
    expect(existsSync(join(root, ".obserf"))).toBe(false);
  });

  /** `draft` and `triage` reach the same check and were told to run `show`. */
  test("a missing id names no particular command", async () => {
    const { output } = await run(workspace(), "draft");
    expect(output).toContain("Expected a finding id");
    expect(output).not.toContain("obserf show");
  });
});

/** `1e2` read as finding 100, and `repyl` was caught only after the database opened. */
describe("input rejected before the database opens", () => {
  test.each([
    [["draft", "1", "--kind", "repyl"], `Unknown draft kind "repyl"`],
    [["show", "1e2"], `Expected a finding id like 12, not "1e2"`],
  ])("%p", async (args, message) => {
    const root = workspace();
    const { code, output } = await run(root, ...args);
    expect(code).not.toBe(0);
    expect(output).toContain(message);
    expect(existsSync(join(root, ".obserf"))).toBe(false);
  });
});

/** For most findings the venue only repeats the URL, and the URL is what gets opened. */
describe("venueUnlessRedundant", () => {
  test("drops a redundant host-qualified venue", () => {
    expect(venueUnlessRedundant("github.com/o/list", "https://github.com/o/list")).toBeNull();
    expect(
      venueUnlessRedundant("news.ycombinator.com", "https://news.ycombinator.com/item?id=1"),
    ).toBeNull();
    expect(venueUnlessRedundant("example.com", "https://www.example.com/a/b")).toBeNull();
    expect(
      venueUnlessRedundant("github.com/o/list", "https://github.com/o/list/issues/1"),
    ).toBeNull();
  });

  /**
   * The case the whole rule exists for: `r/golang` is a substring of the URL, but
   * it is the compact name of the place, so a substring test would throw away
   * the one venue label that is worth reading.
   */
  test("keeps a path-only venue label", () => {
    const url = "https://www.reddit.com/r/golang/comments/abc/whats_good";
    expect(venueUnlessRedundant("r/golang", url)).toBe("r/golang");
  });

  /** A prefix has to end at a segment boundary, or a sibling swallows it. */
  test("does not let one path swallow its neighbour", () => {
    expect(venueUnlessRedundant("github.com/o/list", "https://github.com/o/list-next")).toBe(
      "github.com/o/list",
    );
  });

  test("an unparseable URL settles nothing, so the venue stays", () => {
    expect(venueUnlessRedundant("somewhere", "not a url")).toBe("somewhere");
  });
});

/**
 * A title is other people's text, and the row it goes in is a fixed width, so
 * the cut is by column and grapheme, not `slice`.
 */
describe("clipped", () => {
  test("leaves a title that already fits", () => {
    expect(clipped("short enough", 40)).toBe("short enough");
  });

  /** The ellipsis counts against the budget, so no room means nothing at all. */
  test("fits the ellipsis into the smallest budgets", () => {
    expect(clipped("xy", 1)).toBe("…");
    expect(clipped("xy", 0)).toBe("");
  });

  test("marks the cut, and stays inside the budget", () => {
    const cut = clipped("a".repeat(90), 70);
    expect(cut.endsWith("…")).toBe(true);
    expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(70);
  });

  /** `slice(0, 70)` ended on `\ud83d`, which a terminal draws as a lone box. */
  test("never ends on half an emoji", () => {
    const cut = clipped(`${"x".repeat(69)}🚀 rocket mode`, 70);
    const body = cut.endsWith("…") ? cut.slice(0, -1) : cut;
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(70);
  });

  /** The selector measures zero on its own and two as part of the heart. */
  test("measures a character the way it is drawn, not code point by code point", () => {
    expect(Bun.stringWidth(clipped(`${"x".repeat(67)}❤️abc`, 70))).toBeLessThanOrEqual(70);
  });

  /** Seventy of these are a hundred and forty columns wide. */
  test("counts a wide character as the two columns it occupies", () => {
    expect(Bun.stringWidth(clipped("构".repeat(80), 70))).toBeLessThanOrEqual(70);
  });
});

describe("wrapped", () => {
  const reason =
    "A curated GitHub index of SaaS boilerplates — exactly the category this occupies — with a free way in via pull request.";

  test("breaks prose to the width, every line under the same indent", () => {
    const lines = wrapped(reason, "     ", 60).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith("     ")).toBe(true);
      expect(line.length).toBeLessThanOrEqual(60);
    }
    expect(lines.join(" ").replace(/\s+/g, " ").trim()).toBe(reason);
  });

  /** Width 0 is what `terminalWidth` reports off a terminal. */
  test("leaves prose alone when the output is not a terminal", () => {
    expect(wrapped(reason, "     ", 0)).toBe(`     ${reason}`);
  });

  test("keeps the line breaks and spacing the operator typed into a note", () => {
    expect(wrapped("one\n\ntwo  three", "", 40)).toBe("one\n\ntwo  three");
  });

  /** Columns, not characters: titles and excerpts are other people's text. */
  test("measures what a terminal shows, not what JavaScript counts", () => {
    const cjk = "日本語の説明 日本語の説明 日本語の説明 日本語の説明 日本語の説明";
    for (const line of wrapped(cjk, "     ", 40).split("\n")) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  /** A URL longer than the measure overflows rather than being broken in half. */
  test("never splits a word", () => {
    const long = "https://example.com/a/very/long/path/that/exceeds/the/width";
    expect(wrapped(`see ${long}`, "", 30)).toBe(`see\n${long}`);
  });
});

/**
 * Colour was emitted unconditionally, so `obserf list > today.txt` wrote escape
 * soup and `obserf show 42 | pbcopy` put escapes on the clipboard.
 */
describe("colourable", () => {
  // `""`, not `undefined`: `undefined` falls through to the default parameter
  // and reads the ambient NO_COLOR, so these would fail for anyone who sets it.
  test("a terminal gets colour", () => {
    expect(colourable({ isTTY: true }, "")).toBe(true);
  });

  test("anything that is not a terminal does not", () => {
    expect(colourable({ isTTY: false }, "")).toBe(false);
    expect(colourable({}, "")).toBe(false);
  });

  /** no-color.org: present and non-empty disables, whatever the value. */
  test("NO_COLOR turns it off, and an empty NO_COLOR is not set", () => {
    expect(colourable({ isTTY: true }, "1")).toBe(false);
    expect(colourable({ isTTY: true }, "0")).toBe(false);
    expect(colourable({ isTTY: true }, "")).toBe(true);
  });
});

describe("output that is not going to a terminal", () => {
  test("carries no escape sequences", async () => {
    const root = workspace();
    const { output } = await run(root, "list");
    expect(output).not.toContain("\u001b[");
  });

  /** The one that broke: an error the operator would have redirected into a log. */
  test("including an error", async () => {
    const { output } = await run(workspace(), "show", "abc");
    expect(output).toContain("Expected a finding id like 12");
    expect(output).not.toContain("\u001b[");
  });
});

/**
 * `--status a --status b` kept only `b`, and `--source hn,github` arrived as one
 * unknown id: the two list flags disagreed about their own syntax.
 */
describe("listArg", () => {
  test("accepts a comma-separated list", () => {
    expect(listArg("status", ["new,acted"])).toEqual(["new", "acted"]);
  });

  test("accepts a repeated flag", () => {
    expect(listArg("status", ["new", "acted"])).toEqual(["new", "acted"]);
  });

  test("accepts the two mixed, and tolerates spacing", () => {
    expect(listArg("source", ["hn, , github", "brave,"])).toEqual(["hn", "github", "brave"]);
  });

  test("absent is absent, which is not the same as empty", () => {
    expect(listArg("status", undefined)).toBeUndefined();
  });

  /** `--status ,` asked for something; answering it with every status would not be it. */
  test("given and empty is an error, not everything", () => {
    expect(() => listArg("status", [""])).toThrow("--status was given no value");
    expect(() => listArg("status", [" , "])).toThrow("--status was given no value");
  });
});

/**
 * `obserf runs` is where an operator checks whether the week was quiet or the
 * scan was. The three states of `skipped` become three different sentences, and
 * the one that must never be printed for a row that recorded nothing is "ran".
 */
describe("describeSources", () => {
  test("names what ran and what did not, with the reason", () => {
    expect(describeSources(["hn", "brave"], { brave: "BRAVE_API_KEY is not set" })).toBe(
      "ran hn · skipped brave (BRAVE_API_KEY is not set)",
    );
  });

  test("an empty skip map is the claim that everything ran", () => {
    expect(describeSources(["hn", "github"], {})).toBe("ran hn, github");
  });

  /** Null is not empty: the run never got far enough to establish which ran. */
  test("no record is reported as no record, not as a clean run", () => {
    expect(describeSources(["hn", "github"], null)).toBe(
      "selected hn, github · no record of which ran",
    );
  });

  test("every source skipped says nothing ran", () => {
    expect(describeSources(["brave"], { brave: "no key" })).toBe(
      "nothing ran · skipped brave (no key)",
    );
  });
});

describe("a scan with a scaffold placeholder", () => {
  /** A scaffold dry run is refused and names the remaining placeholder. */
  test("is refused, and names the queries still to replace", async () => {
    const root = mkdtempSync(join(tmpdir(), "obserf-cli-"));
    roots.push(root);
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(join(root, "obserf.config.ts"), "export default {};");
    writeFileSync(
      join(root, "projects", "example.ts"),
      `export default { key: "example", name: "Example", url: "https://e.com", pitch: "p",
         solves: ["s"], notFor: ["n"], voice: "v",
         queries: { search: ["the problem, described the way someone having it would say it"],
           subreddits: [], github: [] } };`,
    );

    const { code, output } = await run(root, "scan", "--dry-run");
    expect(code).toBe(1);
    expect(output).toContain("the problem, described the way someone having it would say it");
    expect(output).toContain(
      "No selected project was scanned: scaffold placeholder queries remain.",
    );
  });
});
