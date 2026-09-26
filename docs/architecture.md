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
  migrate.ts         Applies pending migrations when the shared connection opens
  backup.ts          VACUUM INTO snapshots, and the way back from one
sources/
  types.ts           Source and Candidate contracts
  shared.ts          nonBlank and sleep, the two every adapter needs
  index.ts           Registry
  brave.ts           Brave web search
  hackernews.ts      Hacker News search via Algolia
  reddit.ts          Reddit search within a profile's subreddits
  github.ts          GitHub issue and repository search
pipeline/
  scan.ts            Orchestrates discover → gate → enrich → assess → store
  gate.ts            Deterministic rejections
  enrich.ts          Post-gate adapter evidence, and the one-for-one contract
  assess.ts          One structured model call per candidate
  score.ts           Components → 0-100, pure
  draft-context.ts   Draft-time context fetch (plain HTTP, no browser)
  draft.ts           Comment/reply/submission generation
web/
  server.ts          Bun.serve with routes and HTML import
  index.html         The inbox's page, which loads app.tsx
  app.tsx            Review inbox (React): the list, triage and undo state
  finding-row.tsx    One row of the list
  detail.tsx         The selected finding: evidence, verdict, note, drafts
  action-bar.tsx     Decisions and drafting, pinned under the finding
  undo-toast.tsx     The last decision, its undo and its follow-up
  scan-status.tsx    Whether each project's latest scan saw everything
  keyboard.tsx       Shortcut keys, the guard every handler shares, and ?
  theme.tsx          System, light or dark
  api.ts             Response shapes and the fetch helpers
project.ts           The ProjectProfile contract, defineProject, venueRuleFor
workspace.ts         Finding a workspace, its paths, loading its profiles
init.ts              obserf init: the scaffold, and the placeholders it leaves
index.ts             Package entry: defineProject and defineConfig, and no more
drizzle/             Generated migrations, committed and shipped
test/                Pure-logic tests
docs/                This documentation and docs/adr/
```

Profiles and the database are not here. They live in an operator's workspace, which this repository never contains — see [ADR-010](adr/010-engine-and-workspace.md). `project.ts` and `workspace.ts` sit at the root rather than in a `projects/` directory, because a directory holding one file is what `config/`, `core/`, and `utils/` are deliberately absent for.

`workspace.ts` resolves its paths synchronously and reads no config file, so `drizzle.config.ts` can import the database path at module scope without pulling the source adapters into drizzle-kit. Only the profile loaders are async, and they import the registry lazily for the same reason.

`index.ts` is inert: nothing it reaches reads the environment, the working directory, or the disk. A workspace's `obserf.config.ts` imports it while Obserf is dynamically loading that very file, so the public entry must not be what decides where the workspace is. `workspace.ts` depends on `index.ts`; never the reverse.

The database is opened lazily, and opening it through the shared connection applies any pending migration from `drizzle/` first ([ADR-011](adr/011-the-engine-owns-the-schema.md)). `scan --dry-run` never takes that path: it reads history through a connection of its own, which neither migrates nor switches journal mode.

That connection refuses SQL writes (`query_only`) but is opened read-write, because Bun's read-only open fails on a WAL database whose sidecars are gone; SQLite may therefore create them and checkpoint on close. Unreadable history fails the dry run rather than reading as empty, since gate counts computed without it are wrong, not conservative.

`vocabulary.ts` supplies the review inbox's runtime enums and default draft-kind mapping without database or pipeline dependencies. Both the browser and server import it directly; `db/schema.ts` uses its types but does not re-export them. Keep it free of imports so server-only dependencies cannot enter the browser bundle through shared vocabulary.

## Data flow

**Discover.** `scan` receives a profile and selects the profile’s default sources (all if omitted), or the explicit `--source` set, and queries available selections sequentially in registry order. Adapters normalize to `Candidate`, supply the source id, and handle their own rate limiting ([ADR-007](adr/007-sources-are-adapters.md)). If any source fails, discovery finishes attempting the others, then the scan fails before gating or assessment. Unavailable sources are reported as skips, recorded on the run with the reason each gave, and named again in the scan's closing summary — whether the reason is a missing credential or a profile that gave that adapter no queries to send. A scan whose every selected source was unavailable fails rather than reporting zero candidates, which is what a genuinely empty search reports.

**Gate.** Candidates are canonicalized and passed through seven deterministic rules, applied in this order — duplicate, settled, blocked, stale, thin, unchanged, ruled-out — with per-rule counts reported ([ADR-004](adr/004-deterministic-gates-before-the-model.md)).

**Enrich.** Adapters that implement `enrich` receive their own gate survivors to add expensive evidence ([ADR-009](adr/009-expensive-evidence-after-the-gate.md)). GitHub gathers each surviving repository’s merged and closed-unmerged pull-request counts over the last year, plus its current open count. These inform the model’s judgment of receptiveness; they do not prove permission to submit. The pipeline requires each candidate back exactly once with its URL and source id preserved. Contract violations and request failures fail the scan before assessment. Dry runs skip enrichment.

**Assess.** Each survivor gets one `askForJson` call with a Zod-constrained schema. The system prompt is the rubric plus the project profile — identical for every candidate in a scan, so it caches; the candidate is the only part that varies. Calls run through a small concurrency pool.

**Score.** A pure function turns components into 0–100 ([ADR-003](adr/003-model-scores-components-code-ranks.md)). It is the only place the weights appear, and no assessment stores its output: `list`, `show` and the inbox run it over the stored components on every read, so decay and a weight change reach the ranking without the model or a maintenance command. The one stored score is a scan's frozen inbox (`runs.inbox`), which keeps what its ten scored when the scan finished, because that is the record the bar is judged on.

**Store.** The finding is inserted or its snapshot refreshed, the assessment appended, and a `triage` row created with status `new` if absent.

Only successfully assessed gate survivors reach storage; rejected candidates refresh nothing. A snapshot is dated by the assessment it was stored with. Assessment history retains judgments and prompt fingerprints, not earlier excerpts, repository facts, or raw payloads.

**The inbox shows the latest scan.** It is read beside a terminal that scans, so it shows the latest run under the list's project filter — one per project in view when unfiltered, since the newest run across a mixed list says nothing about the others — and names any project in view that has none. That is the health of the most recent retrieval, not the provenance of every row: findings persist across scans. The sources that ran, skipped sources, an unfinished run and a recorded error are each surfaced; an open run shows no counts, since totals are written only when it finishes. As with `obserf runs`, retrieval succeeding and retrieval being complete are different facts, and a list short because a key is missing must not read like a quiet week.

**Drafts show a venue reminder.** The CLI and the inbox print it beside new and stored drafts; [opportunities](product/opportunities.md) defines its three states and why none confirms permission or cost. The inbox reads it from the finding's response rather than the draft's, so a stored draft shows the guidance loaded now, not what it was written with. `profileAvailable` there also withholds the draft buttons, since drafting needs a loaded profile. The server hashes the config and profile files on each request that uses a profile and re-imports them when they change (`liveProfiles` in `workspace.ts`), so an edited, added or deleted profile reaches the inbox without a restart; a module the config or a profile imports stays cached. A reload that fails keeps the last good profiles for triage and reminders and refuses drafts, with the error shown, since a draft is written from the profile text the operator just replaced; it is retried on the next request.

**The inbox answers only to this machine.** Every API route goes through `local()`, which refuses a request whose `Host` is not a loopback name. Binding to `127.0.0.1` stops another machine connecting but not DNS rebinding in the operator's own browser; [SECURITY.md](../.github/SECURITY.md) has the attack. The page is left to Bun's own development-mode check, as defense in depth: it carries no data.

**The inbox validates what the CLI validates.** They are two front ends over one query, so an unknown or repeated query key (on the findings list, its per-status `/api/counts`, `/api/runs/latest` and `/api/runs/marker`), a status that is not one, a `min` or `limit` that is not a whole number, and a project key naming neither a profile nor a project the database holds rows for are each a 400 rather than an empty list — an empty list reads as a quiet week. A path id that is not a positive whole number is refused before it reaches the database. An `error` handler answers anything unhandled with a fixed sentence rather than Bun's development error page, which carries the working directory and source lines.

**Database snapshots.** Filenames record the reason after the UTC timestamp: `manual` for an operator request, `upgrade` before a migration, and `replaced` for the database saved before a restore. Older names without a reason remain valid and display as `unlabelled`. Listing filters by the current database’s filename and path hash, then validates the timestamp and optional reason suffix; it does not inspect file contents. Snapshots are sorted by the parsed timestamp, independent of modification times that copying may change, and displayed in local time. `restore` without an argument chooses the newest listed snapshot. Explicit filenames and paths bypass the naming filter, but every restore checks the source’s SQLite integrity before snapshotting and replacing the destination.

**Triage.** Both `obserf triage` and the inbox call `setTriage`: a string note replaces the stored value, `null` clears it, and `undefined` preserves it. The HTTP route trims strings and converts an empty string to `null`; the CLI passes `--note` through unchanged. The inbox sends status and note through the same endpoint and serializes its writes so a note save followed by a status change lands in that order. A dismissal category follows the note's three states while the status is `dismissed`, and any other status clears it, so a count of causes never includes a finding nobody dismissed; both front ends refuse one given with another status. `appendNote` adds a line to the stored note in the same statement that reads it — how the inbox records where an `acted` finding was posted without overwriting a note edited since. Both inbox amendments — that line and a category typed after `d` — pass `amend`, which writes only while the stored status is still the one amended and otherwise answers 409, so neither can reinstate a decision the CLI has since changed. The first decision out of `new` also records whether the model's judgment was hidden while it was made (the inbox sends `hidden`; the CLI counts as shown), once, never on a later reopening. `setTriage` returns the prior status for reporting and the inbox’s single-level undo, which leaves notes untouched. Its read and write are separate statements, so the prior status is not an atomic snapshot if another process writes concurrently.

**Draft.** Separate from the scan and initiated by the operator. Before writing, `draft-context.ts` fetches the source as it stands — Hacker News through Algolia's item API, GitHub issues, pull requests and repository READMEs through GitHub's REST API, everything else as HTML with tags stripped. Assessment uses discovery text and any enrichment, which do not necessarily include the current conversation; fetching here rather than during a scan keeps the cost proportionate, since a scan touches a hundred candidates and drafting touches the one or two the operator chose. A dead or removed page also surfaces at the moment it matters. Drafting refuses before the model call only on a fact the fetch established: the official Hacker News API reports the item deleted or dead, or the story a comment belongs to dead (a killed submission's thread takes no new comments); GitHub answers 410 or 404 for an issue or pull request, or reports it locked. A 404 may only mean the thread is hidden from Obserf's access, and a lock does not bind collaborators; Obserf can tell neither, and has nothing it can stand behind. Anything it cannot establish drafts with a warning: a timeout or unreachable page from the stored excerpt, a failed Hacker News status check beside the thread. A README 404 is checked against the repository, since a list without a README is still a list to submit to; a closed but unlocked issue is drafted from its current text. The gate's rule applies here too: facts, not judgment.

The route is chosen by URL, not by `sourceId`: a GitHub issue Brave found is still a GitHub issue. A venue with an API is read through it because tag stripping keeps a site's navigation alongside its content — a GitHub issue read that way spends its first two thousand characters on GitHub's menu. A shape whose endpoint would have to be guessed falls through to the page fetch: the wrong resource presented as the thread is worse than a noisy copy of the right one.

Every route reports what limits its context — a truncated thread, comments past the first page, a README standing in for a whole repository, a page whose navigation could not be told apart from its content — and that warning is stored with the draft beside `context_source`, so it shows whenever the draft is read back. A live read's warning also reaches the model; an excerpt fallback's reason does not, since the model is told only that it has the excerpt. A partial read presented as a whole one is how a confident reply to the wrong question gets written.

## Schema

| Table | Written by | Mutability | Key |
| --- | --- | --- | --- |
| `runs` | `scan` | Checkpointed after discovery, finalized at completion | `id` |
| `findings` | `scan` | Refreshed after successful assessment; `discoveredAt` fixed | unique `(project, url)` |
| `assessments` | `scan` | Append-only | `finding_id` |
| `triage` | `scan` initializes; operator updates | Operator decisions survive rescans | `finding_id` (unique) |
| `drafts` | `draft` | Append-only | `finding_id` |

The separation is [ADR-002](adr/002-evidence-judgment-decision.md). Reading "the current state of a finding" therefore means joining its latest assessment and its triage row — done in `db/index.ts`, by `latestFindings()` for many findings and `findingById()` for one, through the same latest-assessment subquery, rather than reconstructed per caller. `latestFindings()` returns them unordered: the order is the score now, so its callers pass the rows to `rank()` in `pipeline/score.ts`, which scores, filters, orders and bounds them.

## Model use

Obserf calls the model through the **Claude Agent SDK**, on the operator's Claude Code subscription. There is no API key ([ADR-008](adr/008-claude-code-subscription.md)). One model, `claude-opus-5`, serves both assessment and drafting, overridable with `OBSERF_MODEL`.

`agent.ts` is the entire surface: `ask` for prose, `askForJson` for a schema-constrained verdict, `pool` for concurrency. Assessment goes through `askForJson`, so a malformed verdict fails before it reaches the database rather than being stored as a plausible-looking row; drafting uses `ask`, since the output is prose a human will edit.

`obserf runs` reads the `runs` table back: which sources ran and which were skipped, the gate breakdown, what was assessed, and the token spend. A null `skipped` means the run never recorded which sources ran — distinct from an empty `skipped`, which says every selected source ran. A clean finish also freezes `inbox`: the project's top ten `new` findings with the scores they had then, which `obserf list --run <id>` reads back as the cohort [the bar](product/evaluation.md#the-bar) is counted on. The live ranking cannot serve: it is recomputed against the clock on every read, and labelling a finding moves it out of the default list.

Token usage is accumulated per run across every model the SDK touched — including its auxiliary calls — and stored on the `runs` row. `estimated_cost_usd` alongside it is the SDK's list-price figure, useful for comparing scans and not an invoice: on a subscription nothing is billed per call.
