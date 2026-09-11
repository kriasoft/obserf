# ADR-010 The Engine Is Public, The Workspace Is Private

- **Status:** Accepted
- **Date:** 2026-09-10
- **Tags:** distribution, configuration, dx

## Problem

Obserf is meant to be public under Apache 2.0, and eventually an `obserf` package. What it operates on is not: project profiles carry the queries, `notFor` lines, `venueGuidance` and measured results that amount to one operator's marketing strategy, and the database holds every finding, judgment, note and draft. Those lived inside the repository — profiles as tracked modules that `projects/index.ts` statically imported, the database at the repository root, snapshots under `db/`. Publishing meant publishing all of it, and every user adding a project would have edited a tracked file and conflicted on the next pull.

## Decision

Two things, with one boundary between them.

The **engine** is this repository: the CLI, the pipeline, the source adapters, the schema, the inbox. It ships no profiles and no data, and it is the only thing that ever becomes public.

A **workspace** is a directory the operator owns, marked by `obserf.config.ts`:

```
~/dev/marketing/
  obserf.config.ts      the marker; almost empty by design
  projects/*.ts         profiles, authored and version-controlled
  .env                  read by Bun, not by Obserf
  .obserf/obserf.db     state Obserf owns
  .obserf/backups/
```

Obserf finds it by walking up from the working directory, the way `git` and `tsc` find theirs, so the database and profiles a command resolves do not change with the directory it was run from. `OBSERF_HOME` overrides that for automation and for running an engine checkout against a workspace elsewhere.

Credentials deliberately do not follow the same rule. Bun loads `.env` from the process's working directory, and Obserf does not parse one itself, so a command run from a subdirectory sees the workspace's database and not its `.env`. Making that uniform would mean shipping a dotenv loader to duplicate what the runtime already does, for a case the documentation can state in a sentence: run credentialed commands from the root.

`obserf.config.ts` is nearly empty on purpose. Its job is to make the root unambiguous — a directory named `projects` is too common a thing to key on — and to be the place the first workspace-wide setting goes, so that adding one later does not require inventing a location for it. The layout is convention; only the profiles directory is overridable today, as `projectsDir` — named for a path rather than `projects`, which reads like a list of the profiles themselves.

The public contract is two functions and the types they take: `defineProject` and `defineConfig`. Nothing else is exported, and nothing `index.ts` reaches may read the environment, the working directory, or the disk: a workspace's config file imports it _while Obserf is dynamically loading that file_, so the public entry must not be the module that decides where the workspace is. `workspace.ts` depends on `index.ts`, never the reverse. The pipeline's order, the gate rules, the scoring weights and the source registry are the product's decisions, not its configuration surface — the way to change those is to fork a small, readable repository.

Paths resolve synchronously from conventions and never read the config file, because `drizzle.config.ts` needs the database path at module scope and must not pull the source adapters into drizzle-kit to get it. Only profile loading reads the config file, and only it is async.

## Alternatives (brief)

- **Template repository** – every install becomes a fork, so there is no way to ship a fix. Right for scaffolding people are expected to rewrite; wrong for an opinionated application with unusually editable configuration.
- **Runtime-loadable source adapters** – would require deciding today which internals are public API, versioned against a `Candidate` shape that still changes. There is one source implementer. Fork instead.
- **Configurable pipeline stages** – the order is the product. Deterministic gates before judgment, expensive evidence after them, model judges and code ranks, hard zeros: those are invariants, and a configuration point would turn each into a default.
- **`projects/` as the workspace marker** – too generic to walk up to safely, and it leaves nowhere for a workspace setting to live.
- **Keeping profiles in the repository, gitignored** – the history still carries them, and a fresh clone is not a working install.

## Impact

- Positive: the repository can be published without redaction. A user adds a project without touching a tracked file. `obserf init` produces a workspace that runs. The same workspace works against a checkout today and a published package later — the import in a profile does not change.
- Negative/Risks: profiles leave the engine's `tsc` run. The compiler is still the validator — `obserf init` scaffolds a `tsconfig.json` and a `typecheck` script so a workspace can run it — but Obserf executes these modules rather than compiling them and cannot assume anyone did. The loader therefore checks a deliberate subset at load time: the fields whose absence would not announce itself. A profile with no `voice` or `notFor` does not fail, it produces confident output built on less than the model was meant to have; a mistyped optional field is the compiler's job. Loading is async and dynamic, which is why the failures it reports are loud and name the file. Publishing this repository still requires an audited history: the profiles are in every commit made before this one.

## Links

- Code/Docs: `workspace.ts`, `init.ts`, `project.ts`, `index.ts`, [Architecture](../architecture.md)
- Related ADRs: [ADR-001](001-local-first-sqlite.md), [ADR-006](006-project-profiles-are-typescript.md), [ADR-007](007-sources-are-adapters.md), [ADR-011](011-the-engine-owns-the-schema.md)
