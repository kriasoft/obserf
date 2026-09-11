# Obserf

Obserf ([obserf.com](https://obserf.com)) finds public conversations and listings where mentioning a project could help someone, ranks them, and drafts what to say.

Maintaining a project leaves little time to promote it. Search turns up hundreds of loosely related pages; deciding which ones are active, relevant, and open to a maintainer's contribution takes longer than writing the replies. Obserf narrows that reading to a ranked inbox, with a reason for each finding.

An opportunity must be **useful, permitted, and free**, with a public way to participate: a comment, reply, or submission. Obserf searches Hacker News, Reddit, GitHub and Brave, filters duplicates and unsuitable candidates, and uses a model to assess the survivors. The model has no tools and cannot read a venue's rules or its pricing, so what reaches the inbox is not known to be forbidden and not known to cost money — a weaker claim than permitted and free, and the reason Obserf never posts. You read the thread, check the venue's rules and whatever a submission actually requires, edit the draft, and post it yourself.

This is a personal tool for one operator and a handful of projects. Obserf ships no projects and no data: your profiles, your database and your credentials live in a **workspace** you own, and this repository never sees them. There is no Obserf service to sign up for, no account, and nothing to sync: its state is one SQLite file on your machine, and your triage decisions and notes never leave it. The one server involved is `obserf serve`, which is yours, on your loopback interface.

The work itself is not local, though. Your queries go to the search providers you configure. Candidates that survive gating go to Claude, with whatever evidence was gathered about them and your project's profile text, to be assessed — and again when you ask for a draft, along with the thread's current text where Obserf can fetch it, and the stored excerpt where it cannot. Your credentials authenticate those requests to the providers they belong to and never enter a model prompt. Model calls go through Claude Code, whose network behaviour is its own — and if your environment configures model routing, obserf names the relevant variables on the process's first model call rather than letting your candidate text and project brief go somewhere else quietly.

The discovery, review and drafting loop is implemented end to end. What is not established is that it finds enough worth posting: there is no outcome tracking and no eval set yet, so treat the ranking as a reading order rather than a measured result. See the [roadmap](docs/product/roadmap.md).

A ranked list looks like this — illustrative, not a recorded run:

```
 78 #42   Looking for a local way to tail and filter JSON logs
     example · question · 2 drafts · https://news.ycombinator.com/item?id=44444444
     The author is describing the exact problem the project solves and is asking
     for recommendations; HN tolerates a maintainer answering with disclosure.
```

## Setup

You need **Bun 1.4 or later** and **Claude Code installed and signed in with a subscription** for assessment and drafting. Obserf uses the Claude Agent SDK with tools disabled; model calls require no Anthropic API key and consume the subscription quota shared with interactive Claude Code sessions. See [ADR-008](docs/adr/008-claude-code-subscription.md).

```bash
bunx @obserf/cli init ~/dev/marketing
cd ~/dev/marketing
bun install
```

`init` writes the files a workspace needs and stops there, so `bun install` is the whole install step; the database is created by the first command that needs it. To work against a checkout instead, run `bun link` in it and `bun link @obserf/cli` in the workspace — the profiles import `@obserf/cli` either way, so nothing else changes.

A workspace is a directory you own, marked by `obserf.config.ts`:

```
~/dev/marketing/
  obserf.config.ts      the marker; almost empty by design
  projects/*.ts         your profiles — author these, commit these
  package.json          declares the Obserf version this workspace was scaffolded for
  tsconfig.json         what typechecks the profiles
  .env.example          the variables; copy it to .env to set any
  .env                  credentials, read by Bun
  .obserf/obserf.db     everything Obserf learns
  .obserf/backups/
```

Obserf finds it by walking up from wherever you run a command, the way `git` does, so a command run from a subdirectory still uses the same database and the same profiles. Credentials are the exception: Bun loads `.env` from the process's working directory and Obserf does not parse one itself, so run `scan`, `draft` and `serve` — which drafts through the same code path — from the workspace root unless those variables are already in your environment. Keep the workspace in its own private git repository; `init` writes a `.gitignore` that keeps `.env` and `.obserf/` out of it.

From then on, work from the workspace:

```bash
cd ~/dev/marketing
$EDITOR projects/example.ts
bun run obserf scan --dry-run
```

Editing first is not a suggestion: the scaffold's queries are prose describing what to write, and a scan that sent them would return a page of unrelated threads in exactly the shape real findings take. A project still carrying them is reported and skipped, and the command fails if that leaves nothing to search for — on a dry run too. Replace each query with what someone who has your project's problem would actually type, and delete the ones for sources the project does not use.

Obserf owns the database: it creates it on first use and migrates it whenever the shared connection opens, so upgrading the package is the whole upgrade and there is no schema step to run ([ADR-011](docs/adr/011-the-engine-owns-the-schema.md)). Snapshots and restores are under [Database maintenance](#database-maintenance).

`init` writes `.env.example` rather than `.env`, so copy it — `cp .env.example .env` — and configure only the sources you intend to use:

| Source | Credentials | Queries it reads |
| --- | --- | --- |
| `hn` | None. Searches Hacker News through Algolia. | `queries.search` |
| `reddit` | `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` for a script app with API access, used as app-only OAuth. New clients are approval-gated by Reddit; see [Sources](docs/product/sources.md) if you cannot get them. | `queries.search` and `queries.subreddits` |
| `github` | `GITHUB_TOKEN`, else a token from the signed-in `gh` CLI, which `OBSERF_GITHUB_USER` picks an account from. Without either, unauthenticated search at a lower request rate. | `queries.github` or `queries.githubRepos` |
| `brave` | `BRAVE_API_KEY` from a [Brave Search API account](https://brave.com/search/api/). Check the account's current pricing and quota. | `queries.brave` — or `queries.search`, but only where `brave` is absent entirely, since an explicit `brave: []` means ask nothing |

A source that cannot run is skipped with a reason rather than reported as having found nothing — missing credentials, or a profile that gave that adapter no queries to send, which applies to `hn` and `github` too even though they need no keys. Access failures are reported separately from empty results. See [Sources](docs/product/sources.md) for adapter behavior.

Everything else has a working default:

| Variable | Default | What it changes |
| --- | --- | --- |
| `OBSERF_HOME` | the nearest directory at or above the working directory holding `obserf.config.ts` | Which workspace a command acts on. Name the directory, not the marker file |
| `OBSERF_DB` | `.obserf/obserf.db` in the workspace | Which database. A relative path resolves against the workspace, so a command means the same database wherever it runs |
| `OBSERF_MODEL` | `claude-opus-5` | The model that assesses and drafts |
| `OBSERF_ASSESS_CONCURRENCY` | `4` | Assessments in flight at once |
| `OBSERF_RESULTS_PER_QUERY` | `10` | Results asked of a source per request — Brave caps it at 20, and Reddit ORs the search terms into one request per subreddit |
| `OBSERF_MAX_AGE_DAYS` | `365` | The `stale` gate's cutoff |
| `OBSERF_REASSESS_AFTER_DAYS` | `7` | How long an unsettled finding waits before it may be reassessed |
| `OBSERF_REASSESS_DISQUALIFIED_AFTER_DAYS` | `30` | The same for one the model disqualified |
| `OBSERF_USER_AGENT` | `obserf/0.1 (+https://obserf.com)` | What Reddit and GitHub are told; both refuse requests without a real one |
| `NO_COLOR` | unset | Any non-empty value drops the colour; otherwise each stream is coloured only while it is a terminal of its own |

Obserf creates the workspace's own database on demand, but not one `OBSERF_DB` points at: a path with nothing at it is an error rather than a second empty database. A dry run is the exception, reading history through a connection of its own, where a file that is not there reads as a workspace with no history yet. The thresholds no variable reaches — the gate's minimum text length, the blocked-domain list — are in [config.ts](config.ts).

## Commands

Run them from the workspace, where `init` left a script for it: `bun run obserf <command>`.

| Command | What it does |
| --- | --- |
| `scan [--project k] [--source id] [--dry-run]` | Discover, gate, enrich, assess |
| `list [--project k] [--status s] [--min n] [--limit n]` | The ranked opportunities |
| `show <id>` | One finding in full, with its drafts |
| `draft <id> [--kind comment\|reply\|submission]` | Write a draft for it |
| `triage <id> <new\|shortlisted\|dismissed\|acted> [--note "…"]` | Record what you decided |
| `rescore [--project k]` | Recompute scores from stored components; no model calls |
| `runs [--project k] [--limit n]` | Recent scans: what ran, what the gate dropped, what it spent |
| `projects` | The workspace's projects |
| `serve [--port n]` | The local review inbox |
| `init [dir]` | Create a workspace |
| `backup` · `backups` · `restore [file]` | Snapshot the database, list snapshots, replace it with one |

Every command takes only the options it uses. A flag that belongs to another one — `obserf scan --limit 3`, `obserf backup --project x` — is an error naming what that command does take, rather than being parsed and quietly dropped while the scan runs in full or the whole database is snapshotted.

## Daily workflow

Start with discovery and gating only to check the queries and source access:

```bash
bun run obserf scan --project example --source hn --dry-run
```

A dry run makes no model calls, changes no stored data and applies no migration. It lists each gate survivor’s host and title so you can check query quality before using model quota, and its counts account for what you have already seen — a URL already assessed, dismissed or acted on is gated exactly as a real scan would gate it. If that history cannot be read, the dry run fails instead of reporting counts that quietly treat everything as new. Source requests still consume their quotas.

Omit `--source` and a scan runs the sources the project’s profile lists under `sources`, or all registered sources if the field is omitted (an empty list is invalid); name several either way — `--source hn,github` or `--source hn --source github`, as `--status` also accepts both. A profile that has measured a source as not worth its model calls simply omits it, and `--source` still selects it for an experiment. See [Sources](docs/product/sources.md).

Then enrich and assess the gate survivors and review the ranked results:

```bash
bun run obserf scan --project example
bun run obserf list --project example
bun run obserf show 42
```

Use an actual finding ID from `list` in place of `42`. The list defaults to the top 20 findings with status `new` and a score of at least 1 — `--limit` changes the count, and `--min 0` is how the terminal shows the zero-scored ones; when it is not narrowed to one project each row names its own. Reasons and notes are wrapped to your terminal under a hanging indent so findings stay separate blocks, and the venue is dropped from a row when the URL already spells it out — `r/golang` stays, `github.com/owner/list` beside its own URL does not. Piped or redirected, each reason stays on one line, so `obserf list | grep` still matches a whole one, and nothing is coloured — `obserf list > today.txt` and `obserf show 42 | pbcopy` give you plain text.

`show` includes the project, URL, assessment reason, score components, the first 800 characters of the stored excerpt, saved drafts, and repository stars and pull-request activity when available. It also names the author and says when a finding is one comment inside a thread rather than the thread itself — the same two facts the model is given, and the ones `reach` and `welcome` turn on. The review inbox shows those two as well. Provenance is `show`'s alone: when the finding was first seen and in which scan, when its triage row was last written, and the model and prompt fingerprint behind each verdict. Assessments are append-only, so a finding that was reassessed shows the earlier verdicts under the current one.

Omit `--project` from `scan` to scan every registered project, and `--project` is checked wherever it appears: a key naming neither a profile in the workspace nor a project the database holds rows for is an error listing the ones that do, rather than a result that matched nothing. Findings, scan history and triage decisions belong to the database, so retiring a profile leaves them readable under its key.

Read the linked thread and its promotion rules, then shortlist or dismiss it:

```bash
bun run obserf triage 42 shortlisted
bun run obserf list --project example --status shortlisted
bun run obserf draft 42
```

Drafting fetches current thread context before calling the model: a Hacker News item and a GitHub issue, pull request or repository through their APIs, every other URL — a GitHub discussion or release included — as HTML with tags stripped. The CLI reports how the thread was read and what was left out — a truncated discussion, comments past the first page, a repository represented by its README alone, or retrieval failing entirely, in which case drafting works from the stored excerpt. The draft kind comes from the opportunity type; a finding that is one comment inside a thread defaults to a reply, while a listing remains a submission. Override it with `--kind comment`, `--kind reply`, or `--kind submission`.

<!-- prettier-ignore -->
> [!IMPORTANT]
> The draft is where Obserf stops. Review it for accuracy, usefulness and affiliation disclosure, check the venue's rules and what a submission actually costs, then post it yourself — there is no posting code path to turn on ([ADR-005](docs/adr/005-obserf-drafts-humans-post.md)).

After editing and posting in the venue yourself:

```bash
bun run obserf triage 42 acted --note "Posted a reply"
```

Use `dismissed` for findings you do not want to pursue. Scans preserve your triage decisions and do not reassess findings while they are dismissed or acted on. Set a finding back to `new` to reopen it for review. Repeated draft requests save additional drafts; Obserf does not record your final posted edits.

### Review inbox

For browser-based review:

```bash
bun run obserf serve
```

Open **http://127.0.0.1:4000** to review findings, change statuses, write notes, generate drafts, and copy them for editing and posting. Use `--port 4001` for another port. The inbox is unauthenticated and bound to the local machine. It reads the profiles once, at startup, so restart it after editing one — a draft is written against the profile the server loaded, and a profile changing under a running process is harder to explain than a restart.

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> <kbd>k</kbd> or <kbd>↓</kbd> <kbd>↑</kbd> | Move through the list |
| <kbd>o</kbd> | Open the selected page |
| <kbd>n</kbd> <kbd>s</kbd> <kbd>d</kbd> <kbd>a</kbd> | Set the selected finding to new, shortlisted, dismissed or acted. When it leaves the filtered list, selection moves to the next row — the previous one at the end |
| <kbd>u</kbd> | Undo the last status change made in this tab, keeping its note. One change deep, and lost on reload |

Shortcuts are inactive while editing a note or using a filter control.

Under the filters is the scan the list rests on: when it last ran and what it produced, one line per project when the list is not filtered to one. A scan that skipped a source, never finished, or failed says so there — a short list is not a quiet week unless the scan behind it actually ran. Nothing is shown before the first scan; a record that cannot be read is reported as that, not as silence.

Rows show saved notes and draft counts. Notes save when the editor loses focus; unsaved edits survive switching findings within the tab, but not a page reload. The **zeros** checkbox includes zero-scored findings within the selected project and status. Results are capped at 200; `200+` indicates the cap was reached, so narrow the filters to inspect more of the backlog.

The detail shows score components and current age; the score stays as last computed until assessment or rescoring. Listings are marked evergreen because they are exempt from age decay. Draft-context warnings describe the latest draft generated while that detail pane remains open; they are not saved with the draft.

## Ranking and rescans

The model rates `relevance`, `intent`, `welcome`, and `reach` from 0–5; code computes a score from 0–100. Zero relevance, zero welcome, or disqualification forces a zero score. Freshness reduces thread scores; listings are exempt from that decay. A score is a review priority, not proof that promotion is allowed. See [Scoring](docs/product/scoring.md).

On rediscovery, unsettled findings can be reassessed when their title, excerpt, or engagement changes materially, or after the reassessment interval (seven days by default).

A finding the model disqualified waits longer — 30 days by default, `OBSERF_REASSESS_DISQUALIFIED_AFTER_DAYS` — because a categorical rejection rarely stops being true. Longer, not forever: "no evident free public way to participate" describes the evidence available at the time, and a list can reopen submissions without its title, excerpt, or engagement changing at all. Material changes bypass either cooldown on rediscovery; the other gates still apply. See [ADR-004](docs/adr/004-deterministic-gates-before-the-model.md).

Refresh freshness decay, or apply changed weights, without model calls:

```bash
bun run obserf rescore [--project <key>]
```

The dollar figure printed after a scan is the SDK's list-price estimate for comparison, not a per-call model invoice. Scans and drafts still consume Claude Code quota.

Every scan that reaches the pipeline is recorded, except a dry run, which stores nothing and so cannot be read back. `obserf runs` reads that record back once the output has scrolled away:

```bash
bun run obserf runs [--project <key>] [--limit <n>]
```

```
#12   Sep 12 2026 09:14  acme       1m42s
     ran hn, reddit, github · skipped brave (BRAVE_API_KEY is not set)
     76 candidates → 12 assessed (dropped: 2 settled, 18 stale, 6 thin, 38 unchanged)
     18421 in (12106 cached) / 3244 out tokens · ~$0.084 at list price
```

A skip is stored on the run, not just printed, because "no key" and "nothing found" mean opposite things and would otherwise both read as zero candidates weeks later. A scan whose every source was unavailable — for credentials or for queries it was never given — fails outright for the same reason, so a profile that configures no queries at all is an error rather than a quiet week.

## Project profiles

Copy `projects/example.ts` in your workspace, give it a unique `key`, and that is the whole registration — Obserf loads every `.ts` file in the directory. Run `obserf projects` to list them.

```ts
import { defineProject } from "@obserf/cli";

export default defineProject({
  key: "your-project",
  // …
});
```

`defineProject` and `defineConfig` are the entire public API, with the types they take — `ProjectProfile`, `ProjectQueries`, `WorkspaceConfig`, `SourceId`. The pipeline order, the gate rules, the scoring weights and the source registry are not configuration — if you need to change those, fork the repository; it is small and meant to be read.

Write `pitch`, `solves`, and `notFor` as a briefing: they are passed to the model. Be specific about what the project cannot do; `notFor` prevents plausible but incorrect recommendations. Configure search queries and target subreddits, and use `voice` for drafting style. Add `venueGuidance` only from verified venue rules, including their source and verification date. It is worth filling in: the rule for a venue is weighed when scoring `welcome`, handed to the drafter writing the text that goes there, and shown back under every draft as the thing to confirm still holds. Without one, the draft says instead that Obserf could not check whether a mention is permitted or what taking part costs — because it cannot.

`init` writes a `tsconfig.json` covering `obserf.config.ts` and `projects/`. In a workspace whose `package.json` it also wrote, `bun run typecheck` runs it; in a directory that already had one, `init` leaves that manifest alone, so use whatever TypeScript setup is already there. That compiler check is the real validation; Obserf executes profiles rather than compiling them, and only verifies at load time the handful of fields whose absence would quietly weaken a prompt instead of failing. Use a dry run to inspect discovery counts before spending model quota.

## Database maintenance

Before applying a migration to a database that already has data, Obserf takes a snapshot and says where it put it.

```bash
bun run obserf backup            # snapshot now
bun run obserf backups           # list this database's snapshots
bun run obserf restore           # replace the database with the newest
bun run obserf restore <file>    # or with a specific one
```

Snapshots are written with SQLite's `VACUUM INTO` to `.obserf/backups/` in the workspace, named for the database they came from, the moment they were taken, and why — `manual` when you asked, `upgrade` from just before a migration, `replaced` from what a restore overwrote. `obserf backups` shows that, because they are otherwise the same name at different milliseconds and the list is read at the moment one of them is about to overwrite your database. `restore` takes the bare name it prints, or any path. A restore snapshots what it replaces, so it is itself reversible. Nothing is pruned automatically.

<!-- prettier-ignore -->
> [!WARNING]
> Stop `obserf serve` and any scan before restoring or upgrading. A restore replaces the database file and deletes its WAL with no coordination between processes, a running server holds a connection opened against the schema it started with, and the snapshot an upgrade takes for you is the state from just before it began — a note written by another process in that window would not be in it.

## Development

In a checkout rather than a workspace: `bun install`, then `bun test` and `bun run typecheck` for the pure logic — the gate, the scoring, URL canonicalization — and `bun run fmt` to format code and documentation (`bun run fmt:check` to check without writing; Oxfmt reads `.oxfmtrc.json`, which keeps Markdown paragraphs unwrapped). A checkout has no workspace of its own, so point commands at one with `OBSERF_HOME=~/dev/marketing` and pass `--env-file` for anything needing its credentials. [AGENTS.md](AGENTS.md) is the working brief: the structure, the invariants, and what the model calls in `scan` and `draft` cost the operator.

## Documentation

- [Overview](docs/product/overview.md) — product purpose and scope
- [What counts as an opportunity](docs/product/opportunities.md) — eligibility and draft standards
- [Scoring](docs/product/scoring.md) · [Sources](docs/product/sources.md) · [Evaluation](docs/product/evaluation.md) · [Roadmap](docs/product/roadmap.md)
- [Architecture](docs/architecture.md) and [ADRs](docs/adr/)
- [Security](SECURITY.md) — what to report privately, and what is a quality problem rather than a vulnerability

## License

Copyright 2026 Konstantin Tarkus. Licensed under the [Apache License, Version 2.0](LICENSE). Third-party dependencies retain their own licenses.
