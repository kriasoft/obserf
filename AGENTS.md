## Product

Obserf watches the public web for places where a project can be mentioned usefully and for free, ranks them, and drafts what to say. It is a single-operator tool, not a service — one person, a handful of projects, one SQLite file on one laptop.

Read [`docs/product/overview.md`](docs/product/overview.md) before proposing product work. Two rules there outrank anything else in this file:

- **Obserf never posts.** No posting operation or venue-write code path exists; do not add one, and do not add a flag that would. GitHub search borrows an operator token whose scopes obserf does not constrain, so the boundary is what obserf _does_ with a credential, never an assumption that its credentials are read-only. See [ADR-005](docs/adr/005-obserf-drafts-humans-post.md).
- **An opportunity must be useful, permitted, and free.** All three. Dropping any one produces spam, a ban, or an ads budget. Obserf establishes usefulness; permission and cost are facts about the venue's rules that the model cannot look up, so it rejects on evidence (`welcome: 0`, a disqualified paid placement) but cannot certify their absence. A finding is _not known to be forbidden and not known to cost money_. Do not describe one as permitted or as free. See [`docs/product/opportunities.md`](docs/product/opportunities.md).

Obserf ships no projects and no data. Profiles and state live in an operator's **workspace**, a directory marked by `obserf.config.ts` and found by walking up from the working directory, so a subdirectory resolves to the same database and profiles — though not the same credentials, since Bun reads `.env` from the working directory. See [ADR-010](docs/adr/010-engine-and-workspace.md). Nothing personal belongs in this repository; it is meant to be published.

```
~/dev/marketing/          a workspace
  obserf.config.ts        the marker
  projects/*.ts           profiles, authored and version-controlled
  .env                    read by Bun, not by Obserf
  .obserf/obserf.db       state Obserf owns
  .obserf/backups/
```

## Structure

There is no build step, so there is no `src/` — Bun runs the TypeScript at the root directly.

- `cli.ts` – command dispatch and terminal output; presentation only
- `config.ts` – environment and tunables; keys behind getters so importing needs none. Credential _resolution_ beyond reading an env var belongs in the adapter that needs it, not here — see `sources/github.ts`, which falls back to the `gh` CLI.
- `agent.ts` – the only model surface: `ask`, `askForJson`, `pool`
- `url.ts` – canonicalization, the dedupe key
- `html.ts` – other people's markup turned into text: `decodeEntities`, `plainText` and `truncate`. Imports nothing. Source adapters flatten snippets while `pipeline/draft-context.ts` preserves paragraphs, so only decoding is shared; whitespace policy belongs to the caller
- `vocabulary.ts` – the enums and `defaultKindFor`, shared with the browser. **Nothing here may import anything**: `web/app.tsx` needs these at runtime, so keep them independent of database and pipeline dependencies. Import them directly from `vocabulary.ts`, not through `db/schema.ts`. Verify with `bun build web/index.html --outdir /tmp/b` after touching it.
- `db/` – Drizzle schema, cross-table queries, `migrate.ts` and `backup.ts`. `db/schema.ts` is the only description of the schema; `bun run db:generate` turns a change to it into a migration under `drizzle/`, and `migrate.ts` applies pending ones on every writable open, so an installed package upgrades its own database ([ADR-011](docs/adr/011-the-engine-owns-the-schema.md)). Snapshots live in the workspace, under `.obserf/backups/`. It owns tables, not domain vocabulary, and imports nothing from `pipeline/` — a query's return shape is stated here and checked against the gate's input at the call site.
- `sources/` – one adapter per source, the registry, `types.ts` (the contract) and `shared.ts` (helpers every adapter needs). The registry array is precedence, not just registration: sources run in its order, and the first snapshot of a URL to reach the gate's history checks owns it for that scan, whether or not it survives them. A rejection for what a candidate _is_ — blocked, stale, thin — leaves the URL open to a better-described duplicate; a rejection by comparison with history does not, or a search description would manufacture material change out of an unchanged thread. Specialized adapters precede Brave to favor thread text and engagement over search descriptions.
- `pipeline/` – `scan` (orchestration), `gate`, `enrich` (post-gate adapter evidence; enforces the one-for-one contract rather than trusting it), `assess`, `score`, `draft`, `draft-context` (thread fetch at draft time), `rescore` (score maintenance over stored components; no model)
- `web/` – `Bun.serve()` review inbox (React, localhost, unauthenticated)
- `project.ts` – the `ProjectProfile` contract and `defineProject`; profiles are prompt input as much as configuration
- `workspace.ts` – finding a workspace, its paths, and loading its profiles. Path resolution is synchronous and reads no config file: `drizzle.config.ts` needs the database path at module scope and must not pull the adapters into drizzle-kit. Only the profile loaders are async.
- `init.ts` – `obserf init` and every scaffold template. Split from `workspace.ts` because "where is the workspace" and "how does one come to exist" are different questions. It writes files and nothing else: `node_modules` belongs to the package manager, and the database to `db/migrate.ts`
- `index.ts` – the package entry, and the whole public API: `defineProject` and `defineConfig`. Adding an export here is a commitment; the pipeline, gate, weights and registry are deliberately absent. Nothing it reaches may read the environment or the disk — a workspace's config file imports it _while Obserf is loading that file_
- `drizzle/` – generated migrations, committed and shipped with the package. `meta/` is drizzle-kit's state for generating the next one and stays out of the published files
- `docs/` – product docs and `docs/adr/` for architecture decision records
- `.github/workflows/ci.yml` – the only CI; `SECURITY.md` states what counts as a vulnerability here, which is narrower than it looks because a bad draft is a quality problem

No `config/`, `core/`, `utils/`, or `scripts/` directories: each would wrap a single file or nothing. Add one only when a second real file needs it.

## Tech Stack

- **Runtime:** Bun >=1.4 for everything — CLI, web server, tests, bundler. No Node, no Vite, no separate test runner.
- **Database:** SQLite via `bun:sqlite` and Drizzle ORM (`snake_case` casing). One file.
- **Model:** `claude-opus-5` through the **Claude Agent SDK**, on the operator's Claude Code subscription. **There is no API key** – if `claude` is signed in, obserf works ([ADR-008](docs/adr/008-claude-code-subscription.md)).
- **Frontend:** React 19 through Bun's HTML imports. No bundler config.
- **Validation:** Zod, used only for the model's structured output — not for configuration ([ADR-006](docs/adr/006-project-profiles-are-typescript.md)). One schema serves both directions: `z.toJSONSchema()` constrains the request, `.parse()` validates the response.
- **No browser automation.** Obserf never posts ([ADR-005](docs/adr/005-obserf-drafts-humans-post.md)), so there is nothing to drive. Do not add Playwright; if excerpt quality becomes the bottleneck, a plain `fetch` plus text extraction on gate survivors is the cheaper fix.

## Commands

```bash
bun run obserf scan [--project k] [--source id] [--dry-run]  # discover → gate → enrich → assess
bun run obserf list [--project k] [--status s] [--min n]     # ranked opportunities
bun run obserf show <id>                                     # detail and drafts
bun run obserf draft <id> [--kind comment|reply|submission]
bun run obserf triage <id> <new|shortlisted|dismissed|acted>
bun run obserf rescore [--project k]                          # recompute scores, no model calls
bun run obserf serve [--port n]                              # local review inbox
bun run obserf init [dir]                                    # create a workspace
bun run obserf backup                                        # snapshot the database
bun run obserf backups                                       # list its snapshots
bun run obserf restore [file]                                # replace it with one

bun test                    # bun:test
bun run typecheck           # tsc --noEmit
bun run fmt                 # format with oxfmt
bun run fmt:check           # check formatting without writing
bun run db:generate         # turn a db/schema.ts change into a migration
bun run db:studio
```

## Verification

- Run the narrowest checks covering what you changed, then report what you ran. Never imply verification you did not perform.
- `.github/workflows/ci.yml` runs the format, type, test and bundle-boundary checks on push, and separately packs the tarball and builds a workspace from it. It is deliberately offline — a live scan there would make the suite depend on somebody else's uptime, and the clean-room scan against real sources stays a manual pre-release step.
- `bun test` and `bun run typecheck` are free and cover the pure logic — the gate, the scoring, URL canonicalization.
- **`obserf scan` and `obserf draft` consume the operator's Claude Code rate limits and hit third-party APIs.** Nothing is billed per call ([ADR-008](docs/adr/008-claude-code-subscription.md)), but the quota is shared with their interactive sessions, so a scan run "to check that it works" can throttle the work they are actually doing. Use `obserf scan --dry-run`, which discovers and gates without model calls or database writes. It reads existing history when available and creates no database on a fresh checkout; source requests still consume their quotas.
- Commands run against a workspace. From this checkout there is none, so pass `OBSERF_HOME=<workspace>`. Bun loads `.env` from the working directory, not the workspace, so a checkout-run command sees no workspace credentials unless given `--env-file`.
- After a schema change, `bun run db:generate`, then commit the SQL it writes. `bun test` compares a freshly migrated database with `db/schema.ts`, so forgetting the migration fails before release ([ADR-011](docs/adr/011-the-engine-owns-the-schema.md)). Migrations are forward-only and applied automatically, so read the generated file before committing it: drizzle-kit renders a column rename as a drop and an add unless told otherwise, and the operator's notes and triage decisions are the part of that database no rescan can rebuild. The snapshot taken before applying is the way back.
- Regenerating from scratch (deleting `drizzle/` and running `db:generate`) rewrites history that shipped databases have already applied, and is now a hard failure rather than a warning: each applied migration is recorded with the SHA-256 of its SQL, so an edited file is refused. Add a migration instead. `.gitattributes` pins `*.sql` to LF because those bytes are the identity.
- A generated table rebuild is applied with foreign keys off and checked with `PRAGMA foreign_key_check` before committing, because SQLite ignores the pragma inside a transaction and a `DROP TABLE findings` would otherwise cascade away every assessment, draft and triage row. `test/migrate.test.ts` holds that case; do not weaken it.

## Architecture

The pipeline is discover → gate → enrich → assess → score → store, described in [`docs/architecture.md`](docs/architecture.md). Four invariants hold it together:

- **The model judges; code ranks — and code owns the hard zeros.** Assessment returns four bounded components and a verdict, never a score. `pipeline/score.ts` turns those into 0–100 and is the only place the weights appear. The product's three conditions (useful, permitted, free) are prerequisites, so `relevance: 0`, `welcome: 0`, and `disqualified` each zero the score outright — never re-express one as a weighted term. [ADR-003](docs/adr/003-model-scores-components-code-ranks.md)
- **Deterministic gates run first.** `pipeline/gate.ts` encodes facts — duplicate, settled, blocked, stale, thin, unchanged, ruled-out, in that order — never judgment of its own; `settled` and `ruled-out` honor a decision already made, by the operator and by the model respectively. `GATE_RULES` is the execution order, so a rejection count always names the first rule that matched. Do not add keyword filtering there: people describe problems in their own words, and matching the project's vocabulary selects for SEO pages over real questions. [ADR-004](docs/adr/004-deterministic-gates-before-the-model.md)
- **Snapshot, judgment, and decision are separate tables.** `findings` holds a URL's latest successfully assessed snapshot — an opportunity is not a fixed fact, so reassessment refreshes it. Gate rejections leave it unchanged. Model judgments in `assessments` are append-only; `rescore` may update their derived scores. A scan initializes `triage` for a new finding but never overwrites the operator's decision. A finding they dismissed or acted on is settled and never reassessed while that status holds. [ADR-002](docs/adr/002-evidence-judgment-decision.md)
- **Sources are adapters behind one interface.** Normalization and rate limiting live inside the adapter; the pipeline iterates a registry. Which adapters a project runs is policy, not capability: a profile's optional `sources` names its default set (absent means all, `--source` overrides), and a source belongs there only on measured evidence. `unavailable(project)` returns a reason string, not a boolean — "no results" and "no API key" must not look the same, and the same rule applies inside an adapter: a source that is being refused access must fail, not return an empty array. It takes the project because a profile that gave a source no usable queries stops it just as surely as a missing key — a field left empty, or holding only blanks — and an adapter that iterates it and returns `[]` reports that silence as a searched and quiet web; answer the configuration before the credentials, since no Reddit app fixes a profile that lists no subreddits. An adapter may also implement the optional `enrich`, which the pipeline calls on gate survivors only, for facts that cost a request per candidate; it is not a place to move ordinary discovery work, and a failure there fails the scan rather than degrading it, because silently omitting evidence hides a failed lookup as ordinary uncertainty, while substituting zero invents evidence of absence. [ADR-007](docs/adr/007-sources-are-adapters.md), [ADR-009](docs/adr/009-expensive-evidence-after-the-gate.md)

Assessment prompt provenance is recorded automatically: `assessPromptFingerprint` hashes the exact system prompt `assess` sends — the rubric and the project brief — and stores it on every assessment. Query and draft-voice edits do not change it. Neither does `candidateBlock`, which is the candidate half of the prompt: relabelling a field or changing the excerpt truncation changes how the model reads a candidate without changing this hash. That is the deliberate scope, because hashing the candidate block too would give every finding a different fingerprint and destroy the grouping the field exists for. Widen it only by adding a second column, never by folding the candidate in. It is provenance only — nothing reads it back, and it neither forces nor suppresses reassessment. A disqualification is instead trusted for a longer fixed interval (`reassessDisqualifiedAfterDays`, 30 days) than an ordinary verdict, which is what the `ruled-out` rule reports.

Five options in `agent.ts` are fixed for every call and must not be loosened without reading [ADR-008](docs/adr/008-claude-code-subscription.md):

- `tools: []` with `strictMcpConfig: true` — **the security boundary**, and it takes both. Obserf feeds untrusted text straight into the prompt, so the model must have no built-in tool and no MCP tool. `allowedTools` is the auto-approval list, not the availability list; it is not a substitute — and neither is `tools: []` on its own, which disables the built-in tools while the operator's own MCP servers keep being offered. `strictMcpConfig` permits explicitly supplied servers, including those in agent definitions; obserf passes neither `mcpServers` nor `agents`.
- `settingSources: []` — otherwise the operator's own `CLAUDE.md` leaks into obserf's prompts and assessments stop being reproducible.
- `env` minus `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` — an inherited key would silently switch obserf to API billing. Variables that configure model routing — `ANTHROPIC_BASE_URL`, `ANTHROPIC_UNIX_SOCKET`, the `CLAUDE_CODE_USE_*` provider switches, and the per-provider endpoint override each switch activates — are passed through and **reported** on the first model call instead: they describe the operator's own Claude Code, and an enterprise route should keep working, but a scan's candidate text and project brief going somewhere else must not be silent. The report names what is set, never a destination it did not resolve, and reads a switch the way the SDK does, so `CLAUDE_CODE_USE_BEDROCK=0` is not routing.
- `maxTurns: 4` — structured output needs a turn of its own; `1` fails with `error_max_turns`.

## Project Profiles

A profile under a workspace's `projects/` is read verbatim by the model. `pitch`, `solves`, and `notFor` are prompt text, so write them as a briefing, not a form.

`notFor` is the highest-leverage field: it is what stops the model producing a confident, plausible, wrong recommendation, which is the most expensive failure the tool can have. When a scan surfaces a bad match, the fix is usually a line in `notFor` rather than a prompt change.

Source selection, queries, and `blockedDomains` control retrieval; change them on measured evidence or a reason that applies independently of a sample. Drop a source from a profile when measurement shows it does not earn its model calls _for that project_. Keep the measurement and rationale in the profile. Block a domain when you can state a reason independent of the sample, such as a competing product's own marketing site having no reader participation surface at all; "everything from this host has scored zero so far" is a fact about the sample, and turning it into a permanent block recreates the suppression the finite `ruled-out` cooldown exists to avoid. A bare host blocks its subdomains too, so the reason has to hold for the whole tree: a vendor's marketing domain often carries its community forum on a subdomain, and blocking the first silently blocks the second.

**One profile means one product.** A profile carries a single `url`, `pitch`, and `voice`, so it cannot represent two offerings — a thread about the wrong one would be drafted in the other's voice and linked to the other's page. A profile stretched over two — a tool and its team edition, say — ends up searching for exactly the threads its own `notFor` then disqualifies. Two products means two files.

`venueGuidance` is where verified facts about a venue's promotion rules go. The model has no tools and cannot read a subreddit's sidebar, so without it `welcome` — the component that decides permission — is answered from possibly-stale memory. Only put things there you have actually checked; a confident wrong entry produces exactly the ban the field exists to prevent.

Both model stages consume it: the assessment is handed the whole map when scoring `welcome`, and the drafter is given the one rule for the venue it is writing into, through `venueRuleFor` in `project.ts` — since a rule about how a venue wants to be addressed matters most while something is being addressed to it. It scopes register, format and placement only — a venue that tolerates promotion still gets a comment that is useful with the link removed and that discloses the affiliation ([ADR-005](docs/adr/005-obserf-drafts-humans-post.md)). Both operator surfaces then print it with a draft, in the three states that exist: the rule recorded for that venue; an active profile that recorded none, so obserf can confirm neither permission nor cost; or no profile any more, so whatever it recorded is unreadable rather than absent.

## Design Philosophy

- Simplest correct solution. No speculative abstractions – add them only when a real second use case exists.
- No superficial work: no coverage-only tests, no redundant comments, no wrappers that just forward calls.
- Fail loudly in core logic. A scan that half-succeeded silently is worse than one that failed.
- Prefer explicit, readable code over clever or compressed patterns.
- Use precise TypeScript types. Avoid `any` and unnecessary type assertions – let the compiler enforce correctness.
- Document non-obvious trade-offs and decisions. Explain why, not what – every word must add value.
- Pure functions where the logic is worth testing: the gate, the scoring, and URL canonicalization take their inputs explicitly (including `now` and every threshold) so tests need no clock, no network, and no environment. `pipeline/gate.ts` imports no configuration — `scan.ts` reads `config.gate` and hands the policy down, which is also where the global and per-project blocklists are merged.

## Agent Tooling

- `AGENTS.md` is the canonical instruction file; `CLAUDE.md` is a symlink to it.
- `*.local.md` is gitignored. Anything specific to one operator — their workspace, their preferences, their measured results — belongs there rather than here; this file is published.

## Markdown

- Prose is not hard-wrapped: keep each paragraph on one line and use paragraphs, lists and headings for structure.
