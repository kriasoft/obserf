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

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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
 * That a command may reach `databasePath`: there is a workspace, and a database
 * named by `OBSERF_DB` exists. That variable is set to reach a database you have,
 * so a typo must fail rather than read as empty or become a second database. The
 * workspace's own may be absent: `obserf init` then `obserf scan` is the setup.
 */
export function requireReachableDatabase(): void {
  requireWorkspace();
  if (process.env.OBSERF_DB && !existsSync(databasePath)) {
    throw new Error(
      `No database at ${databasePath} (OBSERF_DB). Unset it to use the workspace's own.`,
    );
  }
}

/**
 * That a database may be created at `databasePath`, and its directory exists.
 * The opener and `obserf restore`, which can rebuild a workspace from a snapshot,
 * answer to this; the dry run, which creates nothing, only to the check above.
 */
export function requireCreatableDatabase(): void {
  requireReachableDatabase();
  if (!existsSync(databasePath)) mkdirSync(dirname(databasePath), { recursive: true });
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

/**
 * Profiles that follow edits, for `serve`: its loop is "bad finding → edit
 * `notFor` → look again", and a restart the operator has to remember breaks it
 * silently. Each call compares content hashes rather than watching files, so
 * there is no watcher to leak or miss an event; it sees files at rest, not a
 * transactional snapshot.
 *
 * The first load throws, as a startup failure. A later failure keeps the last
 * good profiles and reports `profileError`, which refuses drafts — a draft from
 * the version just replaced is what the edit was meant to stop — and is retried
 * on the next call. A module the config or a profile imports stays cached.
 */
export async function liveProfiles(root: string = workspaceRoot) {
  const load = async () => {
    // Stamped before importing: a stamp taken after could describe an edit the
    // import missed, and that edit would never load. The other way round costs
    // one extra reload.
    const config = fileState(join(root, MARKER));
    const dir = await requireProfilesDir(root);
    const stamp = profileStamp(dir, config);
    return { dir, stamp, projects: await readProfiles(dir) };
  };
  let loaded = await load();
  let profileError: string | null = null;
  let reloading: Promise<void> | null = null;
  const reload = async () => {
    try {
      loaded = await load();
      profileError = null;
    } catch (cause) {
      profileError = cause instanceof Error ? cause.message : String(cause);
    }
  };

  return async (): Promise<{ projects: ProjectProfile[]; profileError: string | null }> => {
    // A call arriving mid-reload waits for it, then looks again for an edit made
    // meanwhile: answering with the replaced profiles and no error would let a
    // draft use them. A failed reload answers at once.
    for (;;) {
      if (!reloading) {
        const current = profileStamp(loaded.dir, fileState(join(root, MARKER)));
        if (profileError === null && current === loaded.stamp) {
          return { projects: loaded.projects, profileError };
        }
        reloading = reload().finally(() => {
          reloading = null;
        });
      }
      await reloading;
      if (profileError !== null) return { projects: loaded.projects, profileError };
    }
  };
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
  // Imports are cached for the life of the process. A query string the file's
  // content determines is a distinct module to Bun, so an edited file is
  // evaluated again and an unchanged one is not. The real path, because Bun
  // 1.4 can fail to find a file added to a directory it has already resolved
  // through a symlink, such as macOS's `/var`.
  const real = realpathSync(file);
  const module = (await import(`${real}?v=${fileHash(real)}`)) as { default?: T };
  return module.default;
}

function fileHash(file: string): string {
  return Bun.hash(readFileSync(file)).toString(36);
}

/**
 * A file's identity by content, not by mtime and size: an edit of the same
 * length inside one timestamp tick would otherwise read as no edit, and leave
 * either stale prompt text or a fixed profile still refused. Profiles are small.
 */
function fileState(file: string): string {
  try {
    return fileHash(file);
  } catch {
    return "missing";
  }
}

function profileStamp(dir: string, config: string): string {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  } catch {
    // Not `[config]`, which an empty directory also produces: losing the last
    // profile's directory must force the reload that reports it.
    return JSON.stringify([config, null]);
  }
  return JSON.stringify([
    config,
    ...names.sort().map((name) => [name, fileState(join(dir, name))]),
  ]);
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
