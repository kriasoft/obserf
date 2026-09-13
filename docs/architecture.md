# Architecture

Obserf is a Bun CLI over a SQLite file, plus a local web UI for triage. Four source adapters fan out, a deterministic gate narrows, survivors are enriched with evidence too expensive to fetch for everything, one model call per survivor assesses it, code computes its score, and opportunity state lands in three tables that separate evidence from judgment from decision — `runs` and `drafts` are recorded alongside them.

```
workspace ──────┐
                ▼
          ┌───────────┐   candidates   ┌───────────┐  survivors  ┌──────────┐
          │  sources  │ ─────────────▶ │   gate    │ ──────────▶ │  enrich  │
          │ brave hn  │                │ duplicate │             │ (github) │
          │ reddit gh │                │ settled   │             └────┬─────┘
          └───────────┘                │ blocked   │                  ▼
                                       │ stale     │             ┌──────────┐
                                       │ thin      │             │  assess  │
                                       │ unchanged │             │  (model) │
                                       │ ruled-out │             └────┬─────┘
                                       └───────────┘                  │ components
                                                                      ▼
                                                                 ┌─────────┐
                                                                 │  score  │  code, not model
                                                                 └────┬────┘
                                                                      ▼
                           ┌──────────────────── obserf.db ────────────────────┐
                           │  runs · findings · assessments · triage · drafts │
                           └───────────────┬──────────────┬───────────────────┘
                                           ▼              ▼
                                      obserf list     obserf serve
                                      obserf draft   (review inbox)
```

## Layout

There is no build step — Bun runs TypeScript directly — so there is no `src/` to separate from a `dist/`. Modules sit at the root, grouped by the stage of the pipeline they belong to.

```
cli.ts               Command dispatch and terminal output
config.ts            Environment and tunables
url.ts               URL canonicalization (the dedupe key)
html.ts              Other people's markup as text: decode, flatten, truncate
vocabulary.ts        Enums and defaultKindFor, shared with the browser
agent.ts             Claude Agent SDK wrapper: ask, askForJson, pool
db/
  schema.ts          Drizzle tables
  index.ts           Connection, resolved path, schema check, query helpers
  backup.ts          VACUUM INTO snapshots, and the way back from one
sources/
  types.ts           Source and Candidate contracts
  shared.ts          nonBlank and sleep, the two every adapter needs
  index.ts           Registry
  brave.ts hackernews.ts reddit.ts github.ts
pipeline/
  scan.ts            Orchestrates discover → gate → enrich → assess → store
  gate.ts            Deterministic rejections
  enrich.ts          Post-gate adapter evidence, and the one-for-one contract
  assess.ts          One structured model call per candidate
  score.ts           Components → 0-100, pure
  rescore.ts         Re-runs score over stored components; no model
  draft-context.ts   Draft-time thread fetch (plain HTTP, no browser)
  draft.ts           Comment/reply/submission generation
web/
  server.ts          Bun.serve with routes and HTML import
  index.html app.tsx Review inbox
project.ts           The ProjectProfile contract, defineProject, venueRuleFor
workspace.ts         Finding a workspace, its paths, loading its profiles
init.ts              obserf init: the scaffold, and only files
index.ts             Package entry: defineProject and defineConfig, and no more
drizzle/             Generated migrations, committed and shipped
test/                Pure-logic tests
docs/                This documentation and docs/adr/
```

Profiles and the database are not here. They live in an operator's workspace, which this repository never contains — see [ADR-010](adr/010-engine-and-workspace.md). `project.ts` and `workspace.ts` sit at the root rather than in a `projects/` directory, because a directory holding one file is what `config/`, `core/`, and `utils/` are deliberately absent for.

`workspace.ts` resolves its paths synchronously and reads no config file, so `drizzle.config.ts` can import the database path at module scope without pulling the source adapters into drizzle-kit. Only `loadProjects` is async, and it imports the registry lazily for the same reason.

`index.ts` is inert: nothing it reaches reads the environment, the working directory, or the disk. A workspace's `obserf.config.ts` imports it while Obserf is dynamically loading that very file, so the public entry must not be what decides where the workspace is. `workspace.ts` depends on `index.ts`; never the reverse.

The database is opened lazily, and opening it for writing applies any pending migration from `drizzle/` first ([ADR-011](adr/011-the-engine-owns-the-schema.md)). `scan --dry-run` and the read-only history query never take that path, which is what keeps a dry run free of writes.

`vocabulary.ts` supplies the review inbox's runtime enums and default draft-kind mapping without database or pipeline dependencies. Both the browser and server import it directly; `db/schema.ts` uses its types but does not re-export them. Keep it free of imports so server-only dependencies cannot enter the browser bundle through shared vocabulary.

## Data flow

**Discover.** `scan` receives a profile and selects the profile’s default sources (all if omitted), or the explicit `--source` set, and queries available selections sequentially in registry order. Adapters normalize to `Candidate`, supply the source id, and handle their own rate limiting ([ADR-007](adr/007-sources-are-adapters.md)). If any source fails, discovery finishes attempting the others, then the scan fails before gating or assessment. Unavailable sources are reported as skips, whether the reason is a missing credential or a profile that gave that adapter no queries to send. A scan whose every selected source was unavailable fails rather than reporting zero candidates, which is what a genuinely empty search reports.

**Gate.** Candidates are canonicalized and passed through seven deterministic rules, applied in this order — duplicate, settled, blocked, stale, thin, unchanged, ruled-out — with per-rule counts reported ([ADR-004](adr/004-deterministic-gates-before-the-model.md)).

**Enrich.** Adapters that implement `enrich` receive their own gate survivors to add expensive evidence ([ADR-009](adr/009-expensive-evidence-after-the-gate.md)). GitHub gathers each surviving repository’s merged and closed-unmerged pull-request counts over the last year, plus its current open count. These inform the model’s judgment of receptiveness; they do not prove permission to submit. The pipeline requires each candidate back exactly once with its URL and source id preserved. Contract violations and request failures fail the scan before assessment. Dry runs skip enrichment.

**Assess.** Each survivor gets one `askForJson` call with a Zod-constrained schema. The system prompt is the rubric plus the project profile — identical for every candidate in a scan, so it caches; the candidate is the only part that varies. Calls run through a small concurrency pool.

**Score.** A pure function turns components into 0–100 ([ADR-003](adr/003-model-scores-components-code-ranks.md)). It is the only place the weights appear, and `obserf rescore` re-runs it over stored components without touching the model.

**Store.** The finding is inserted or its snapshot refreshed, the assessment appended, and a `triage` row created with status `new` if absent.

Only successfully assessed gate survivors reach storage; rejected candidates refresh nothing. A snapshot is dated by the assessment it was stored with. Assessment history retains judgments and prompt fingerprints, not earlier excerpts, repository facts, or raw payloads.

**Database snapshots.** Filenames record the reason after the UTC timestamp: `manual` for an operator request, `upgrade` before a migration, and `replaced` for the database saved before a restore. Older names without a reason remain valid and display as `unlabelled`. Listing filters by the current database’s filename and path hash, then validates the timestamp and optional reason suffix; it does not inspect file contents. Snapshots are sorted by the parsed timestamp, independent of modification times that copying may change, and displayed in local time. `restore` without an argument chooses the newest listed snapshot. Explicit filenames and paths bypass the naming filter, but every restore checks the source’s SQLite integrity before snapshotting and replacing the destination.

**Triage.** Both `obserf triage` and the inbox call `setTriage`: a string note replaces the stored value, `null` clears it, and `undefined` preserves it. The HTTP route trims strings and converts an empty string to `null`; the CLI passes `--note` through unchanged. The inbox sends status and note through the same endpoint and serializes its writes so a note save followed by a status change lands in that order. `setTriage` returns the prior status for reporting and the inbox’s single-level undo, which leaves notes untouched. Its read and write are separate statements, so the prior status is not an atomic snapshot if another process writes concurrently.

**Draft.** Separate from the scan and initiated by the operator. Before writing, `draft-context.ts` fetches the thread as it stands — Hacker News through Algolia's item API, everything else as HTML with tags stripped. Assessment uses discovery text and any enrichment, which do not necessarily include the current conversation; fetching here rather than during a scan keeps the cost proportionate, since a scan touches a hundred candidates and drafting touches the one or two the operator chose. A dead or removed page also surfaces at the moment it matters.

## Schema

| Table | Written by | Mutability | Key |
| --- | --- | --- | --- |
| `runs` | `scan` | Updated once at completion | `id` |
| `findings` | `scan` | Refreshed after successful assessment; `discoveredAt` fixed | unique `(project, url)` |
| `assessments` | `scan`, `rescore` | Append-only, except the derived `score` | `finding_id` |
| `triage` | `scan` initializes; operator updates | Operator decisions survive rescans | `finding_id` (unique) |
| `drafts` | `draft` | Append-only | `finding_id` |

The separation is [ADR-002](adr/002-evidence-judgment-decision.md). Reading "the current state of a finding" therefore means joining its latest assessment and its triage row — done once in `latestFindings()` in `db/index.ts` rather than reconstructed per caller.

## Model use

Obserf calls the model through the **Claude Agent SDK**, on the operator's Claude Code subscription. There is no API key ([ADR-008](adr/008-claude-code-subscription.md)). One model, `claude-opus-5`, serves both assessment and drafting, overridable with `OBSERF_MODEL`.

`agent.ts` is the entire surface: `ask` for prose, `askForJson` for a schema-constrained verdict, `pool` for concurrency. Assessment goes through `askForJson`, so a malformed verdict fails before it reaches the database rather than being stored as a plausible-looking row; drafting uses `ask`, since the output is prose a human will edit.

Token usage is accumulated per run across every model the SDK touched — including its auxiliary calls — and stored on the `runs` row. `estimated_cost_usd` alongside it is the SDK's list-price figure, useful for comparing scans and not an invoice: on a subscription nothing is billed per call.
