/**
 * What a workspace may import from `@obserf/cli`, and the whole of what this
 * package promises to keep working.
 *
 * Two functions and the types they take. Everything else — the pipeline, the
 * gate, the scoring weights, the source adapters, the schema — is deliberately
 * absent: those are the product's decisions, not its configuration surface, and
 * the way to change them is to fork a small, readable repository rather than to
 * reach past this file. See docs/adr/010-engine-and-workspace.md.
 *
 * Nothing here reads the environment, the working directory, or the disk.
 * Importing it is what a workspace's own config file does *while Obserf is
 * loading that file*, so this module must not be the one that decides where the
 * workspace is; `workspace.ts` does that, and depends on this, never the other
 * way round.
 */

export { defineProject, type ProjectProfile, type ProjectQueries } from "./project";
// Already part of the contract above — `ProjectProfile.sources` is `SourceId[]`.
// Exported so a profile helper can name the type instead of reaching for
// `NonNullable<ProjectProfile["sources"]>[number]`. The type only: the registry
// stays internal.
export type { SourceId } from "./vocabulary";

/**
 * Workspace-wide settings. Deliberately almost empty: the layout is convention,
 * and a knob earns its place when a real workspace needs it. The file exists so
 * that the root is unambiguous, and so there is somewhere for the first such
 * knob to go without inventing a location for it later.
 */
export interface WorkspaceConfig {
  /** Where the profiles are, relative to the workspace root. Defaults to `projects`. */
  projectsDir?: string;
}

/** Identity, for the types — as `defineProject` is for a profile. */
export function defineConfig(config: WorkspaceConfig): WorkspaceConfig {
  return config;
}
