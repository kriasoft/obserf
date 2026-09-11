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
