import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";

/**
 * The CLI run as a CLI, for what is true of the process rather than of a return
 * value. `main()` sits behind `import.meta.main`, so a test spawns it the way an
 * operator runs it, against a workspace of its own.
 */
const CLI = join(import.meta.dir, "..", "cli.ts");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

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

describe("a stored draft, re-read", () => {
  /** A finding with a draft against it, and a profile that recorded a venue rule. */
  function workspaceWithADraft(guidance: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "obserf-cli-"));
    roots.push(root);
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(join(root, "obserf.config.ts"), "export default {};");
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
