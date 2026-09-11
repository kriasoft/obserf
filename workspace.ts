/**
 * The operator's workspace: the profiles they author, and the state Obserf keeps
 * for them. Everything personal lives here; nothing personal lives in this
 * repository.
 *
 *   ~/dev/marketing/
 *     obserf.config.ts      the marker that makes this a workspace
 *     projects/*.ts         profiles, authored and version-controlled
 *     .env                  read by Bun, not by Obserf
 *     .obserf/obserf.db     state Obserf owns
 *     .obserf/backups/
 *
 * Found by walking up from the working directory, the way `git` and `tsc` find
 * theirs, so which database and profiles a command uses does not change with the
 * directory it was run from. Credentials do: Bun loads `.env` from the working
 * directory and Obserf does not parse one, so a command that needs source
 * credentials is run from the root. `OBSERF_HOME` overrides discovery for
 * automation and for running the engine checkout against a workspace elsewhere.
 *
 * Paths here are conventions, resolved synchronously and without reading the
 * config file, because `drizzle.config.ts` needs the database path at module
 * scope and must not pull the source adapters into drizzle-kit to get it. Only
 * the profile loaders read the config file, and only they are async.
 *
 * Nothing in this module throws while being imported: `obserf init` has to run
 * before a workspace exists, and `obserf help` has to run outside one.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkspaceConfig } from "./index";
import type { ProjectProfile } from "./project";

/** What identifies a workspace root. Its contents are optional; its presence is not. */
export const MARKER = "obserf.config.ts";

/**
 * The nearest workspace root at or above `from`, or undefined when there is
 * none. Reporting the miss belongs to whoever needs a workspace, so that a
 * command which does not — `init`, `help` — still runs.
 *
 * Takes its inputs rather than reading the environment, so it can be tested.
 */
export function findWorkspaceRoot(from: string, override?: string): string | undefined {
  if (override) return resolve(override);

  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Where paths below are anchored. Falls back to the working directory so that
 * they are always computable — `requireWorkspace` is what turns "there is no
 * workspace" into an error, at the point where one is actually needed.
 */
export const workspaceRoot: string =
  findWorkspaceRoot(process.cwd(), process.env.OBSERF_HOME) ?? process.cwd();

/** State Obserf owns. One directory, so a workspace has one thing to gitignore. */
export const stateDir: string = join(workspaceRoot, ".obserf");

/**
 * An `OBSERF_DB` relative to the working directory would make `obserf list`
 * answer differently depending on where it was invoked — a wrong answer rather
 * than an error — so it resolves against the workspace, as every other path here
 * does. An absolute one is used as given.
 */
export const databasePath: string = process.env.OBSERF_DB
  ? isAbsolute(process.env.OBSERF_DB)
    ? process.env.OBSERF_DB
    : join(workspaceRoot, process.env.OBSERF_DB)
  : join(stateDir, "obserf.db");

/**
 * Snapshots stay in the workspace even when `OBSERF_DB` points outside it, so
 * that all state is under one directory. Which database a snapshot belongs to is
 * carried by its filename instead — see `db/backup.ts`.
 */
export const backupsDir: string = join(stateDir, "backups");

/**
 * That a database may be created at `databasePath`, and that its directory
 * exists — the two halves of "you may write a new database here".
 *
 * The workspace's own is created on demand: `obserf init` then `obserf scan` is
 * the whole setup, and `obserf restore` can rebuild a workspace straight from a
 * snapshot. One named by `OBSERF_DB` is not: you set that to reach a database
 * you already have, so a typo has to fail rather than quietly become an empty
 * second one. Both the opener and the restorer answer to this, because a rule
 * stated twice is a rule that drifts.
 */
export function requireCreatableDatabase(): void {
  requireWorkspace();
  if (existsSync(databasePath)) return;
  if (process.env.OBSERF_DB) {
    throw new Error(
      `No database at ${databasePath} (OBSERF_DB). Unset it to use the workspace's own.`,
    );
  }
  mkdirSync(dirname(databasePath), { recursive: true });
}

/** Fails with the path it looked at, because "no workspace" is usually "wrong directory". */
export function requireWorkspace(root: string = workspaceRoot): void {
  if (existsSync(join(root, MARKER))) return;
  throw new Error(
    `No ${MARKER} in ${root} or any directory above it.\n` +
      `Run \`obserf init\` to create a workspace here, or set OBSERF_HOME to an existing one.`,
  );
}

/**
 * Every profile in the workspace, in filename order.
 *
 * Async because the profiles are TypeScript modules outside this repository, so
 * they arrive through `import()` rather than the module graph. Loudly: a
 * workspace with no profiles, a file that exports nothing usable, two profiles
 * claiming one key, or a profile naming a source that does not exist are all
 * failures, because each of them silently narrows what a scan looks at.
 */
export async function loadProjects(root: string = workspaceRoot): Promise<ProjectProfile[]> {
  const dir = await requireProfilesDir(root);
  const projects = await readProfiles(dir);
  if (!projects.length) throw new Error(`No project profiles in ${dir}.`);
  return projects;
}

/**
 * Allow an empty profiles directory when reading stored findings and drafts:
 * retiring the last profile must not hide its history. Missing directories and
 * invalid profiles still fail, so a configuration error cannot masquerade as
 * absent venue guidance.
 */
export async function loadProjectsIfAny(root: string = workspaceRoot): Promise<ProjectProfile[]> {
  return readProfiles(await requireProfilesDir(root));
}

async function requireProfilesDir(root: string): Promise<string> {
  requireWorkspace(root);
  const settings = (await importDefault<WorkspaceConfig>(join(root, MARKER))) ?? {};
  const dir = resolve(root, settings.projectsDir ?? "projects");
  if (!existsSync(dir)) {
    throw new Error(
      `No profiles directory at ${dir}. Add one, or set \`projectsDir\` in ${MARKER}.`,
    );
  }
  return dir;
}

async function readProfiles(dir: string): Promise<ProjectProfile[]> {
  const files: string[] = [];
  for await (const name of new Bun.Glob("*.ts").scan({ cwd: dir })) files.push(name);
  files.sort();

  const projects: ProjectProfile[] = [];
  const seen = new Map<string, string>();
  for (const name of files) {
    const file = join(dir, name);
    const profile = await importDefault<ProjectProfile>(file);
    if (!profile) throw new Error(`${file} must \`export default defineProject({ … })\`.`);
    checkProfile(profile, file);
    const first = seen.get(profile.key);
    if (first) {
      throw new Error(`Two profiles claim the key "${profile.key}": ${first} and ${file}.`);
    }
    seen.set(profile.key, file);
    projects.push(profile);
  }

  // No source selection to validate; avoid importing the adapters.
  if (!projects.length) return projects;

  // Imported here rather than at the top of the file: the adapters reach the
  // Agent SDK and the network, and `drizzle.config.ts` imports this module only
  // for a path. Checking now still beats failing partway through a scan.
  const { selectSources } = await import("./sources");
  for (const project of projects) selectSources(project.sources);

  return projects;
}

/**
 * The fields whose absence would not announce itself. `ProjectProfile` is a
 * TypeScript contract and a workspace is expected to typecheck against it, but
 * these modules are executed rather than compiled by Obserf, so nothing here can
 * assume that happened.
 *
 * Every one of these is prompt text or an identifier: a profile missing `voice`
 * or `notFor` does not fail, it produces confident assessments and drafts built
 * on less than the model was meant to have. That is the failure this catches —
 * not malformed input, but quietly weakened input. Omitting an optional field is
 * a choice the format allows and goes unchecked; writing one badly is checked
 * where its readers would otherwise treat the mistake as an absence.
 */
function checkProfile(profile: ProjectProfile, file: string): void {
  for (const field of ["key", "name", "url", "pitch", "voice"] as const) {
    if (typeof profile[field] !== "string" || !profile[field].trim()) {
      throw new Error(`${file}: \`${field}\` must be a non-empty string.`);
    }
  }
  for (const field of ["solves", "notFor"] as const) {
    if (!strings(profile[field]) || !profile[field].length) {
      throw new Error(`${file}: \`${field}\` must be a non-empty array of strings.`);
    }
  }
  // Optional, but not free-form once it is there: this is the operator's own
  // verified evidence about where a mention is allowed, and every reader of it
  // treats an entry it cannot use as no entry — so the workspace would be told
  // that nothing was recorded for a venue it recorded something for.
  const guidance: unknown = profile.venueGuidance;
  if (guidance !== undefined) {
    if (!record(guidance)) {
      throw new Error(`${file}: \`venueGuidance\` must be a plain object mapping venue to rule.`);
    }
    for (const [venue, rule] of Object.entries(guidance)) {
      // Matched exactly against the venue a source reports, so a padded key is a
      // rule that can never be found — rejected rather than trimmed, since which
      // venue string a rule is about is the operator's to state.
      if (!venue || venue !== venue.trim()) {
        throw new Error(
          `${file}: \`venueGuidance\` is keyed by the venue exactly as a source reports it; "${venue}" is not.`,
        );
      }
      if (typeof rule !== "string" || !rule.trim()) {
        throw new Error(`${file}: \`venueGuidance["${venue}"]\` must be a non-empty string.`);
      }
    }
  }

  // Empty is allowed: a project may reach its audience through the GitHub
  // queries alone. A non-string in it is not — it reaches the source adapters.
  const queries = profile.queries as ProjectProfile["queries"] | undefined;
  if (!queries || !strings(queries.search)) {
    throw new Error(`${file}: \`queries.search\` must be an array of strings.`);
  }
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Require a plain record of enumerable data properties. Maps and inherited
 * entries can hide configured rules from both readers. Non-enumerable own
 * properties reach `venueRuleFor` but not the assessment's `Object.entries`,
 * and getters can return different rules on successive reads. Class instances
 * are outside the plain-record contract even when their fields are enumerable.
 */
const record = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (property) => property.enumerable && "value" in property,
  );
};

async function importDefault<T>(file: string): Promise<T | undefined> {
  const module = (await import(file)) as { default?: T };
  return module.default;
}

/** The profile for a key, or an error naming the ones that exist. */
export function projectByKey(projects: ProjectProfile[], key: string): ProjectProfile {
  const project = projects.find((p) => p.key === key);
  if (!project) {
    throw new Error(
      `Unknown project "${key}". Available: ${projects.map((p) => p.key).join(", ")}`,
    );
  }
  return project;
}
