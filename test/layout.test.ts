import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The module map in `docs/architecture.md` goes stale silently when a module is
 * added. Presence only: what a line says a module does is not a test's call.
 */
const ROOT = join(import.meta.dir, "..");

/** Configuration for two tools, not part of the program the map describes. */
const UNMAPPED_ROOT_FILES = new Set(["drizzle.config.ts", "srcpack.config.ts"]);

/** The directories the map draws out file by file. */
const MAPPED_DIRS = ["db", "sources", "pipeline", "web"];

/** Declarations such as `web/css.d.ts` are not program modules the map covers. */
function isModule(name: string): boolean {
  return /\.tsx?$/.test(name) && !name.endsWith(".d.ts");
}

function modulesIn(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && isModule(e.name))
    .map((e) => e.name);
}

/** Qualified by directory: `index.ts` exists in three places, and a basename lets one stand in for the others. */
function modules(): string[] {
  return [
    ...modulesIn(".").filter((name) => !UNMAPPED_ROOT_FILES.has(name)),
    ...MAPPED_DIRS.flatMap((dir) => modulesIn(dir).map((name) => `${dir}/${name}`)),
  ];
}

/**
 * The first word of each line in the fenced block under `## Layout`. Files are one
 * per line, so a description can begin with anything; a search of the whole block
 * would pass on a name mentioned only in another entry's description.
 */
function listedModules(): Set<string> {
  const doc = readFileSync(join(ROOT, "docs", "architecture.md"), "utf8");
  const heading = doc.search(/^## Layout\r?$/m);
  expect(heading).toBeGreaterThan(-1);
  const open = doc.indexOf("```", heading);
  expect(open).toBeGreaterThan(heading);
  const close = doc.indexOf("```", open + 3);
  expect(close).toBeGreaterThan(open);

  const listed = new Set<string>();
  // Indentation places an entry under the `dir/` line above it; root entries
  // come both before and after those blocks.
  let dir = "";
  for (const line of doc.slice(open + 3, close).split("\n")) {
    const [name = ""] = line.trim().split(/\s+/, 1);
    const nested = /^\s/.test(line);
    if (!nested) dir = name.endsWith("/") ? name.slice(0, -1) : "";
    if (isModule(name)) listed.add(nested ? `${dir}/${name}` : name);
  }
  return listed;
}

test("the architecture map names every program module", () => {
  const listed = listedModules();
  const missing = modules()
    .filter((name) => !listed.has(name))
    .sort();
  expect(missing).toEqual([]);
});
