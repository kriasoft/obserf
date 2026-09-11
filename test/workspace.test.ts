import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../init";
import {
  MARKER,
  findWorkspaceRoot,
  loadProjects,
  loadProjectsIfAny,
  projectByKey,
} from "../workspace";
import { venueRuleFor } from "../project";
import type { ProjectProfile } from "../project";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A workspace on disk. `profiles` are written verbatim, so a test can be invalid on purpose. */
function workspace(profiles: Record<string, string>, config = "export default {};"): string {
  const root = mkdtempSync(join(tmpdir(), "obserf-"));
  roots.push(root);
  writeFileSync(join(root, MARKER), config);
  mkdirSync(join(root, "projects"), { recursive: true });
  for (const [name, source] of Object.entries(profiles)) {
    writeFileSync(join(root, "projects", name), source);
  }
  return root;
}

const profile = (key: string, extra = "") =>
  `export default { key: ${JSON.stringify(key)}, name: "N", url: "https://e.com",
     pitch: "p", solves: ["s"], notFor: ["n"], voice: "v",
     queries: { search: [], subreddits: [], github: [] }${extra} };`;

describe("findWorkspaceRoot", () => {
  test("finds the marker from a directory inside the workspace", () => {
    const root = workspace({ "a.ts": profile("a") });
    const nested = join(root, "projects");
    expect(findWorkspaceRoot(nested)).toBe(root);
  });

  // Reporting the miss belongs to `requireWorkspace`, so that `obserf init` and
  // `obserf help` still run where there is no workspace at all.
  test("reports the miss as undefined rather than throwing", () => {
    const stray = mkdtempSync(join(tmpdir(), "obserf-none-"));
    roots.push(stray);
    expect(findWorkspaceRoot(stray)).toBeUndefined();
  });

  test("an override wins over anything on disk", () => {
    const root = workspace({ "a.ts": profile("a") });
    expect(findWorkspaceRoot("/tmp", root)).toBe(root);
  });
});

describe("loadProjects", () => {
  test("loads every profile, in filename order", async () => {
    const root = workspace({ "b.ts": profile("second"), "a.ts": profile("first") });
    expect((await loadProjects(root)).map((p) => p.key)).toEqual(["first", "second"]);
  });

  test("respects a projects directory named in the config", async () => {
    const root = workspace({}, 'export default { projectsDir: "./briefs" };');
    mkdirSync(join(root, "briefs"));
    writeFileSync(join(root, "briefs", "x.ts"), profile("x"));
    expect((await loadProjects(root)).map((p) => p.key)).toEqual(["x"]);
  });

  // Each of these silently narrows what a scan looks at, which is the failure
  // this loader exists to make impossible.
  test("a directory with no profiles is an error, not an empty scan", async () => {
    await expect(loadProjects(workspace({}))).rejects.toThrow(/No project profiles/);
  });

  test("a file that exports no profile names the file", async () => {
    const root = workspace({ "broken.ts": "export const nope = 1;" });
    await expect(loadProjects(root)).rejects.toThrow(/broken\.ts must/);
  });

  test("two profiles claiming one key name both files", async () => {
    const root = workspace({ "a.ts": profile("same"), "b.ts": profile("same") });
    await expect(loadProjects(root)).rejects.toThrow(/Two profiles claim the key "same"/);
  });

  test("an unregistered source is caught before a scan starts", async () => {
    const root = workspace({ "a.ts": profile("a", ', sources: ["redit"]') });
    await expect(loadProjects(root)).rejects.toThrow(/Unknown source "redit"/);
  });

  // The compiler is the real validator, but Obserf executes these files rather
  // than compiling them, so a workspace that never ran `tsc` still gets told.
  test("a profile missing prompt text names the field", async () => {
    const root = workspace({ "a.ts": 'export default { key: "a", name: "N" };' });
    await expect(loadProjects(root)).rejects.toThrow(/a\.ts: `url` must be a non-empty string/);
  });

  /**
   * The one field whose malformed contents look exactly like its absence: both
   * readers drop an entry they cannot use, so without this the operator is told
   * no rule was recorded for a venue they recorded one for.
   */
  test("a venue rule that is not a rule names the venue", async () => {
    const root = workspace({ "a.ts": profile("a", ', venueGuidance: { "r/golang": 42 }') });
    await expect(loadProjects(root)).rejects.toThrow(
      /`venueGuidance\["r\/golang"\]` must be a non-empty string/,
    );
  });

  test("venue guidance that is not a map at all says so", async () => {
    const root = workspace({ "a.ts": profile("a", ', venueGuidance: ["r/golang"]') });
    await expect(loadProjects(root)).rejects.toThrow(/`venueGuidance` must be a plain object/);
  });

  /**
   * Maps and inherited entries hide configured rules from both readers. A
   * non-enumerable own property instead reaches `venueRuleFor` but is absent
   * from the assessment's `Object.entries`.
   */
  test("guidance that is not a plain record is refused", async () => {
    for (const source of [
      'new Map([["r/golang", "rule"]])',
      'Object.create({ "r/golang": "r" })',
      'Object.defineProperty({}, "r/golang", { value: "rule" })',
    ]) {
      const root = workspace({ "a.ts": profile("a", `, venueGuidance: ${source}`) });
      await expect(loadProjects(root)).rejects.toThrow(/`venueGuidance` must be a plain object/);
    }
  });

  /** `venueRuleFor` matches the venue a source reports exactly, and " r/golang " is not it. */
  test("a key with whitespace around it is refused, not trimmed", async () => {
    const root = workspace({ "a.ts": profile("a", ', venueGuidance: { " r/golang ": "rule" }') });
    await expect(loadProjects(root)).rejects.toThrow(/keyed by the venue exactly/);
  });

  test("a directory that is not a workspace says so", async () => {
    const stray = mkdtempSync(join(tmpdir(), "obserf-none-"));
    roots.push(stray);
    await expect(loadProjects(stray)).rejects.toThrow(new RegExp(`No ${MARKER}`));
  });
});

/**
 * Reading history back is not a scan: `obserf show` prints a stored finding and
 * its drafts long after the profile that produced them was retired, and the
 * workspace's last profile is no different from its second-to-last.
 */
describe("loadProjectsIfAny", () => {
  test("no profiles is no profiles, not an error", async () => {
    expect(await loadProjectsIfAny(workspace({}))).toEqual([]);
  });

  /**
   * Tolerating this too would turn a mistyped `projectsDir` into "this venue has
   * no recorded guidance", which is a claim about the venue made out of a
   * misconfigured workspace.
   */
  test("a directory that is not there is still an error", async () => {
    const root = workspace({}, 'export default { projectsDir: "./gone" };');
    await expect(loadProjectsIfAny(root)).rejects.toThrow(/No profiles directory/);
  });

  test("a profile that will not load still fails loudly", async () => {
    const root = workspace({ "broken.ts": "export const nope = 1;" });
    await expect(loadProjectsIfAny(root)).rejects.toThrow(/broken\.ts must/);
  });

  test("and otherwise loads what `loadProjects` loads", async () => {
    const root = workspace({ "b.ts": profile("second"), "a.ts": profile("first") });
    expect((await loadProjectsIfAny(root)).map((p) => p.key)).toEqual(["first", "second"]);
  });
});

describe("initWorkspace", () => {
  test("scaffolds a workspace its own loader accepts", async () => {
    const root = mkdtempSync(join(tmpdir(), "obserf-init-"));
    roots.push(root);
    expect(initWorkspace(root)).toContain(MARKER);
    // Standing in for `bun add @obserf/cli`, which `init` deliberately leaves to
    // the package manager: every file it writes imports the package by name. The
    // scope is a real directory, so it has to exist before the link does.
    mkdirSync(join(root, "node_modules", "@obserf"), { recursive: true });
    symlinkSync(join(import.meta.dir, ".."), join(root, "node_modules", "@obserf", "cli"));
    // The example profile is the format's documentation, so it has to be valid.
    expect((await loadProjects(root)).map((p) => p.key)).toEqual(["example"]);
  });

  test("never overwrites, so it is safe to re-run", () => {
    const root = workspace({ "a.ts": profile("a") });
    writeFileSync(join(root, MARKER), "export default { projectsDir: './keep' };");
    expect(initWorkspace(root)).not.toContain(MARKER);
  });
});

test("projectByKey names what is available", async () => {
  const projects = await loadProjects(workspace({ "a.ts": profile("acme") }));
  expect(projectByKey(projects, "acme").key).toBe("acme");
  expect(() => projectByKey(projects, "nope")).toThrow(/Unknown project "nope". Available: acme/);
});

describe("venueRuleFor", () => {
  const withGuidance = (venueGuidance: unknown): ProjectProfile =>
    ({
      key: "k",
      name: "N",
      url: "https://e.com",
      pitch: "p",
      solves: ["s"],
      notFor: ["n"],
      voice: "v",
      queries: { search: [], subreddits: [], github: [] },
      venueGuidance,
    }) as ProjectProfile;

  test("returns the rule recorded for that exact venue", () => {
    const project = withGuidance({
      "r/golang": "Friday thread only (sidebar, checked 2026-09-09)",
    });
    expect(venueRuleFor(project, "r/golang")).toMatch(/Friday thread only/);
  });

  /** A rule about one repository's contribution policy is not a rule about github.com. */
  test("does not match by prefix", () => {
    const project = withGuidance({ "github.com": "anything goes" });
    expect(venueRuleFor(project, "github.com/acme/widget")).toBeNull();
  });

  test("no guidance at all is no rule, not an error", () => {
    expect(venueRuleFor(withGuidance(undefined), "r/golang")).toBeNull();
  });

  /**
   * A profile is executed, not compiled, by Obserf. A bare lookup would find
   * `Object.prototype.constructor` and hand a JavaScript builtin to the model as
   * a verified fact about a venue.
   */
  test("a venue named after an Object member finds nothing", () => {
    expect(venueRuleFor(withGuidance({}), "constructor")).toBeNull();
    expect(venueRuleFor(withGuidance({}), "toString")).toBeNull();
  });

  /**
   * The assessment enumerates own entries, so an inherited one would be a rule
   * to the drafter and no rule to the score that decides permission.
   */
  test("an inherited entry is not a recorded one", () => {
    const project = withGuidance(Object.create({ "r/golang": "inherited" }) as object);
    expect(venueRuleFor(project, "r/golang")).toBeNull();
  });

  test("a non-string or blank entry is no rule", () => {
    expect(venueRuleFor(withGuidance({ "r/golang": 42 }), "r/golang")).toBeNull();
    expect(venueRuleFor(withGuidance({ "r/golang": "   " }), "r/golang")).toBeNull();
  });
});
