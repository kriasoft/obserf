import { afterEach, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { scan } from "../pipeline/scan";
import { defineProject } from "../project";

const project = defineProject({
  key: "test",
  name: "Test",
  url: "https://example.com",
  pitch: "A project.",
  solves: ["a problem"],
  notFor: ["a different problem"],
  queries: { search: ["a problem"], subreddits: [], github: [] },
  voice: "Plain.",
});

const key = process.env.BRAVE_API_KEY;
afterEach(() => {
  if (key === undefined) delete process.env.BRAVE_API_KEY;
  else process.env.BRAVE_API_KEY = key;
});

describe("scan", () => {
  /**
   * The failure this protects against is silent: every selected source
   * unavailable also produces "0 candidates", which is what a genuinely empty
   * search says. A dry run reaches the check before it touches the database.
   */
  test("fails when no selected source could run", async () => {
    delete process.env.BRAVE_API_KEY;
    await expect(scan(project, { dryRun: true, sourceIds: ["brave"] })).rejects.toThrow(
      /No source could run.*BRAVE_API_KEY/,
    );
  });

  /**
   * The half `--source` makes reachable with no credentials involved: a profile
   * that gave this adapter nothing to ask is the same dead end as a missing key,
   * and used to be a scan that succeeded having searched nothing.
   */
  test("a profile that gave the source no queries is the same dead end", async () => {
    const unasked = defineProject({ ...project, queries: { ...project.queries, search: [] } });
    await expect(scan(unasked, { dryRun: true, sourceIds: ["hn"] })).rejects.toThrow(
      /No source could run.*queries\.search/,
    );
  });

  /**
   * Run history must preserve the reasons discovery collected. The two endings
   * write it from different places, so both are covered here; why the successful
   * one writes it early is in `scan.ts`.
   */
  const latestRun = () =>
    db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.project, project.key))
      .orderBy(desc(schema.runs.id))
      .get()!;

  test("an aborted scan records why each source was skipped", async () => {
    delete process.env.BRAVE_API_KEY;
    await expect(scan(project, { sourceIds: ["brave"] })).rejects.toThrow(/No source could run/);

    const run = latestRun();
    expect(run.skipped).toEqual({ brave: expect.stringContaining("BRAVE_API_KEY") });
    expect(run.finishedAt).not.toBeNull();
  });

  test("a successful partial scan records why the other sources were skipped", async () => {
    delete process.env.BRAVE_API_KEY;
    const real = globalThis.fetch;
    // Nothing to find, so the gate keeps nothing and no model call is made.
    globalThis.fetch = (async (_input: URL) =>
      new Response(JSON.stringify({ hits: [] }), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      await scan(project, { sourceIds: ["hn", "brave"] });
    } finally {
      globalThis.fetch = real;
    }

    const run = latestRun();
    expect(run.skipped).toEqual({ brave: expect.stringContaining("BRAVE_API_KEY") });
  });

  test("a successful complete scan records that every source was attempted", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: URL) =>
      new Response(JSON.stringify({ hits: [] }), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      await scan(project, { sourceIds: ["hn"] });
    } finally {
      globalThis.fetch = real;
    }

    expect(latestRun().skipped).toEqual({});
  });
});

/**
 * The cohort the bar is judged on. Seeded with findings an earlier scan stored,
 * because the inbox a scan leaves is not only what that scan assessed.
 */
describe("the frozen inbox", () => {
  const frozen = defineProject({ ...project, key: "frozen-inbox" });
  let seeded = 0;
  const seed = (relevance: number, status: "new" | "shortlisted" | "dismissed" | "acted") => {
    const id = db
      .insert(schema.findings)
      .values({
        project: frozen.key,
        sourceId: "hn",
        url: `https://example.com/frozen/${++seeded}`,
        title: "t",
        venue: "example.com",
        discoveredAt: new Date(),
      })
      .returning()
      .get().id;
    db.insert(schema.assessments)
      .values({
        findingId: id,
        model: "m",
        promptFingerprint: "f",
        relevance,
        intent: 3,
        welcome: 3,
        reach: 3,
        opportunity: "discussion",
        reason: "r",
        createdAt: new Date(),
      })
      .run();
    db.insert(schema.triage).values({ findingId: id, status }).run();
    return id;
  };
  const withEmptyHn = async (run: () => Promise<unknown>) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: URL) =>
      new Response(JSON.stringify({ hits: [] }), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
  };
  const runOf = () =>
    db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.project, frozen.key))
      .orderBy(desc(schema.runs.id))
      .get()!;

  test("holds the undecided top, best first, as scored when the scan finished", async () => {
    const weak = seed(2, "new");
    const strong = seed(5, "new");
    const middle = seed(4, "new");
    // Decided in an earlier review: this scan's ranking cannot take credit for them.
    seed(5, "shortlisted");
    seed(5, "acted");
    seed(5, "dismissed");
    seed(0, "new"); // Zero, which the inbox hides.
    for (let i = 0; i < 10; i++) seed(1, "new"); // Past the tenth place.

    await withEmptyHn(() => scan(frozen, { sourceIds: ["hn"] }));

    const inbox = runOf().inbox!;
    expect(inbox).toHaveLength(10);
    expect(inbox.slice(0, 3).map((entry) => entry.findingId)).toEqual([strong, middle, weak]);
    expect(inbox[0]!.score).toBeGreaterThan(inbox[1]!.score);
    // The verdict each was ranked on, for the model and prompt behind the cohort.
    const [top] = db
      .select()
      .from(schema.assessments)
      .where(eq(schema.assessments.id, inbox[0]!.assessmentId))
      .all();
    expect(top?.findingId).toBe(strong);
  });

  test("is not recorded for a scan that did not finish cleanly", async () => {
    delete process.env.BRAVE_API_KEY;
    await expect(scan(frozen, { sourceIds: ["brave"] })).rejects.toThrow(/No source could run/);
    expect(runOf().inbox).toBeNull();
  });
});
