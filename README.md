# Obserf

Obserf ([obserf.com](https://obserf.com)) finds public conversations and listings where mentioning your project could help someone, ranks them, and drafts what to say. **It never posts.**

Maintaining a project leaves little time to promote it. Search turns up hundreds of loosely related pages, and deciding which are active, relevant, and open to a maintainer's contribution takes longer than writing the replies. Obserf narrows that reading to a ranked inbox, with a reason for each finding:

```
 78 #42   Looking for a local way to tail and filter JSON logs
     example · question · 2 drafts · https://news.ycombinator.com/item?id=44444444
     The author is describing the exact problem the project solves and is asking
     for recommendations; HN tolerates a maintainer answering with disclosure.
```

<sup>Illustrative, not a recorded run.</sup>

It needs **Bun 1.4 or later** and **Claude Code signed in with a subscription** — see [Quick start](#quick-start).

## How it works

1. **Discover** — your profile's queries go to Hacker News, Reddit, GitHub and Brave.
2. **Gate** — deterministic rules drop duplicates, findings you skipped, dismissed or acted on, blocked domains, stale or thin pages, and anything assessed recently that has not changed. None of this costs a model call.
3. **Assess** — Claude rates each survivor and gives a reason, with extra evidence where a source can fetch it, such as a GitHub list's merge activity. Code turns the ratings into a 0–100 score.
4. **Review** — in the terminal or a local web inbox: shortlist, skip, dismiss, or mark as acted on.
5. **Draft** — on request, from the thread's current text where Obserf can fetch it, otherwise the stored excerpt. You edit it and post it yourself.

An opportunity must be **useful, permitted, and free**, with a public way to take part: a comment, a reply, or a submission. The model has no tools and cannot read a venue's rules or pricing, so a finding is only not known to be forbidden and not known to cost money. Read the thread and the venue's rules before you post.

## What stays on your machine

Obserf is a personal tool for one operator and a handful of projects. There is no account and no Obserf service. This repository ships no projects and no data: your profiles, your database and your `.env` live in a **workspace** you own, and your triage decisions and notes never leave it. The only server Obserf runs is `obserf serve`, on loopback.

What does leave: your queries go to the search providers you configure. Gate survivors go to Claude with the evidence gathered about them and your profile text, and again when you ask for a draft, with the thread's current text where Obserf can fetch it or the stored excerpt otherwise. Credentials authenticate only their own provider and never enter a prompt. Model calls go through Claude Code; if your environment routes them elsewhere, for example with `ANTHROPIC_BASE_URL` or a `CLAUDE_CODE_USE_*` switch, the first model call names the variables.

## Status

The discover, review and draft loop works end to end. Whether it finds enough worth posting is not yet measured: there is no outcome tracking or eval set, so treat the ranking as a reading order. See the [roadmap](docs/product/roadmap.md).

## Quick start

You need:

- **Bun 1.4 or later.**
- **Claude Code, installed and signed in with a subscription.** Obserf calls it through the Claude Agent SDK with tools disabled. No Anthropic API key is needed, and the calls use the same quota as your interactive Claude Code sessions ([ADR-008](docs/adr/008-claude-code-subscription.md)).

```bash
bunx @obserf/cli init ~/dev/marketing    # create a workspace
cd ~/dev/marketing
bun install
$EDITOR projects/example.ts              # describe your project, write real queries
bun run obserf scan --dry-run            # discover and gate only: no model calls
bun run obserf scan                      # assess the survivors with Claude
bun run obserf serve                     # review at http://127.0.0.1:4000
```

Edit the profile before the first scan. The scaffold's queries are placeholders describing what to write, and Obserf skips a project that still carries them. Replace each with what someone who has your project's problem would actually type (`subreddits` takes community names, without `r/`), and set the lists for sources you do not use to `[]`: a leftover placeholder blocks the project even for a source that is not running. Queries decide what gets found, while `pitch`, `solves` and especially `notFor` tell Claude what the project fits and what it does not — see [Project profiles](#project-profiles).

Hacker News and GitHub work without credentials, GitHub at a lower rate. For the others, `cp .env.example .env` and fill in the ones you use (see [Sources](#sources)).

## Workspace

A workspace is a directory you own, marked by `obserf.config.ts`:

```
~/dev/marketing/
  obserf.config.ts      the marker; almost empty by design
  projects/*.ts         your profiles — author these, commit these
  package.json          the Obserf version, and the `obserf` script
  tsconfig.json         typechecks the profiles
  .env.example          the variables; copy it to .env to set any
  .env                  credentials, read by Bun
  .obserf/obserf.db     everything Obserf learns
  .obserf/backups/      database snapshots
```

Obserf finds it by walking up from the current directory, the way `git` does. Credentials are the exception: Bun reads `.env` from the directory you run the command in, so run `scan`, `draft` and `serve` from the workspace root unless the variables are already in your environment. Keep the workspace in its own private git repository; the `.gitignore` that `init` writes keeps `.env` and `.obserf/` out of it.

Obserf creates and migrates the database itself, so upgrading the package is the whole upgrade ([ADR-011](docs/adr/011-the-engine-owns-the-schema.md)). To run against a checkout of this repository instead of the published package, run `bun link` in the checkout and `bun link @obserf/cli` in the workspace.

## Sources

| Source | Credentials | Queries it reads |
| --- | --- | --- |
| `hn` | None. Searches Hacker News through Algolia. | `queries.search` |
| `reddit` | `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` for a script app with API access. New clients need Reddit's approval; see [Sources](docs/product/sources.md) if you cannot get it. | `queries.search` within `queries.subreddits` |
| `github` | `GITHUB_TOKEN`, or the signed-in `gh` CLI (`OBSERF_GITHUB_USER` picks the account). Without either, unauthenticated search at a lower rate. | `queries.github` and `queries.githubRepos` |
| `brave` | `BRAVE_API_KEY` from a [Brave Search API account](https://brave.com/search/api/). Check its current pricing and quota. | `queries.brave`, or `queries.search` when `brave` is absent; `brave: []` sends nothing |

A source that cannot run, whether for missing credentials or because the profile gave it no queries, is skipped with a reason rather than reported as having found nothing. A failing source fails the scan, except that Reddit skips an individual inaccessible subreddit with a warning. A profile's optional `sources` field names which sources it runs by default. See [Sources](docs/product/sources.md) for how each adapter behaves.

## Daily workflow

Check queries and source access first, without spending model quota:

```bash
bun run obserf scan --project example --source hn --dry-run
```

`example` is the scaffold's project key; use yours if you renamed it. A dry run makes no model calls and changes no stored data. It lists each gate survivor's host and title, and gates against your history exactly as a real scan would. Source requests still count against their providers' quotas. `--source` takes one or several sources (`--source hn,github`) and overrides the profile's `sources`, so it also works for trying a source the profile leaves out.

Then assess and review:

```bash
bun run obserf scan --project example
bun run obserf list --project example
bun run obserf show 42
```

Use a finding ID from `list` in place of `42`. `list` shows the top 20 findings with status `new` and a score of at least 1. `--limit` changes the count, `--status` the status, and `--min 0` includes zero-scored findings. Each row shows the thread's age, and `new` or `reassessed` when the project's latest scan first stored it or judged it again, which is where a review picks up; the inbox shows the same. Piped or redirected, output is plain text with one line per reason, so `obserf list | grep` and `obserf show 42 | pbcopy` work. `show` prints a finding in full:

- its reason, score components and excerpt;
- the author, and whether it is one comment inside a thread;
- repository activity where there is some;
- its drafts;
- every verdict it has received, each with the model and the fingerprint of the rubric and brief behind it.

Read the linked thread and the venue's rules, then shortlist and draft:

```bash
bun run obserf triage 42 shortlisted
bun run obserf draft 42
```

Drafting fetches the thread's current text first: Hacker News items and GitHub issues, pull requests and repositories (by their README) through their APIs, and any other page, a GitHub discussion included, as plain text. When it cannot read the thread it falls back to the stored excerpt; either way it reports anything it left out, and `obserf show` and the inbox print that with the draft. It writes nothing when the fetch shows the thread is gone or locked: a Hacker News item deleted or killed, or a comment under a killed story; a GitHub issue or pull request deleted, locked or answering 404, or a repository answering 404. A closed but unlocked GitHub issue still takes comments, so it is drafted. The draft's kind follows the opportunity type, and a finding that is one comment inside a thread gets a reply. Override it with `--kind comment|reply|submission`.

<!-- prettier-ignore -->
> [!IMPORTANT]
> The draft is where Obserf stops. Review it for accuracy, usefulness and affiliation disclosure, check the venue's rules and what taking part actually costs, then post it yourself. There is no posting code path to turn on ([ADR-005](docs/adr/005-obserf-drafts-humans-post.md)).

After posting:

```bash
bun run obserf triage 42 acted --note "Posted a reply"
```

Use `skipped` for a good finding you will not pursue, and `dismissed` for one Obserf should not have shown you, with `--category` saying why (`obserf help` lists them) — it names what to fix, usually a line in `notFor`. The difference matters: only dismissals count against the ranking. Scans keep your triage decisions and do not reassess a finding while it is skipped, dismissed or acted on; set it back to `new` to reopen it.

### Review inbox

`bun run obserf serve` starts the inbox at **http://127.0.0.1:4000** (`--port` for another). There you can review findings, change their status, write notes, and generate and copy drafts. **Hide judgment** keeps the model's score and reason off a new finding until you have judged it yourself. It is unauthenticated and bound to the local machine. It picks up an edited profile when you return to it; if the edit does not load, it keeps the last version that did and turns drafting off until you fix it. A module the config or a profile imports is not reloaded, so restart it after editing one of those.

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> <kbd>k</kbd> or <kbd>↓</kbd> <kbd>↑</kbd> | Move through the list |
| <kbd>o</kbd> | Open the selected page |
| <kbd>n</kbd> <kbd>s</kbd> <kbd>a</kbd> | Set the status to new, shortlisted or acted |
| <kbd>x</kbd> | Skipped: a good finding you will not pursue. Counts as Obserf being right |
| <kbd>d</kbd> | Dismissed: Obserf should not have shown it. Counts against it |
| <kbd>u</kbd> | Undo the last status change in this tab |
| <kbd>1</kbd>–<kbd>8</kbd> | Right after <kbd>d</kbd>: why it was dismissed, which names what to fix |
| After <kbd>a</kbd> | A field asks where it was posted; <kbd>Enter</kbd> adds it to the note, <kbd>Esc</kbd> skips |
| <kbd>r</kbd> | Reveal the model's judgment while **Hide judgment** is on |
| <kbd>W</kbd> | Write the suggested draft (Shift+W; it uses model quota) |
| <kbd>c</kbd> | Copy the newest draft |

Shortcuts are off while you edit a note or use a filter. Notes save when the editor loses focus. Under the filters, the inbox shows the latest scan for each project in view, and says when one skipped a source, never finished, or failed. A short list isn't a quiet week unless the latest scan actually ran. The list stops at 200 results; `200+` means narrow the filters.

## Ranking and rescans

Claude rates `relevance`, `intent`, `welcome` and `reach` from 0 to 5, and code computes the 0–100 score. Zero relevance, zero welcome, or a disqualification makes the score zero. Threads lose score with age and listings do not. No score is stored with a verdict: `list`, `show` and the inbox compute it from the stored ratings and the thread's age today. The exception is a scan's frozen top 10 (`list --run`), which keeps the scores it had when the scan finished. A score is a review priority, not proof that promotion is allowed. See [Scoring](docs/product/scoring.md).

When a scan rediscovers a finding you have not skipped, dismissed or acted on, it reassesses it if its title, excerpt or engagement changed materially, or once the reassessment interval has passed: 7 days by default, and 30 for one the model disqualified. The other gates still apply.

```bash
bun run obserf runs [--project <key>]       # what recent scans ran, dropped and spent
```

```
#12   Sep 12 2026 09:14  acme       1m42s
     ran hn, reddit, github · skipped brave (BRAVE_API_KEY is not set)
     76 candidates → 12 assessed (dropped: 2 settled, 18 stale, 6 thin, 38 unchanged)
     18421 in (12106 cached) / 3244 out tokens · ~$0.084 at list price
```

The dollar figure is the SDK's list-price estimate, useful for comparing scans; nothing is billed per call, but scans and drafts use Claude Code quota. A scan in which no source could run fails, rather than being recorded as a quiet week.

## Project profiles

Copy `projects/example.ts`, give it a unique `key`, and it is registered: Obserf loads every `.ts` file in `projects/`. `obserf projects` lists them.

```ts
import { defineProject } from "@obserf/cli";

export default defineProject({
  key: "your-project",
  // …
});
```

`pitch`, `solves` and `notFor` go to the model verbatim, so write them as a briefing. `notFor` matters most: be specific about what the project cannot do, because that is what stops a plausible but wrong recommendation. `voice` sets the drafting style. Add `venueGuidance` only for venue rules you have checked yourself, with the source and the date. That rule then informs the `welcome` rating and the draft, and is shown under the draft as the thing to re-confirm. Without one, the draft says Obserf could not check whether a mention is permitted or what taking part costs.

`bun run typecheck`, a script `init` writes, checks profiles against the types `@obserf/cli` exports. `defineProject` and `defineConfig` are the whole public API. The pipeline, gate rules, scoring weights and source registry are deliberately not configurable; fork the repository to change them.

## Commands

Run them from the workspace as `bun run obserf <command>`. Each accepts only its own flags, and one meant for another command is an error rather than being ignored.

| Command | What it does |
| --- | --- |
| `scan [--project k] [--source id] [--dry-run]` | Discover, gate, enrich, assess; every project unless `--project` |
| `list [--project k] [--status s] [--min n] [--limit n]` | The ranked findings |
| `list --run n` | The top 10 as scan `n` left them, frozen for review, and the bar result |
| `show <id>` | One finding in full, with its drafts |
| `draft <id> [--kind comment\|reply\|submission]` | Write a draft for it |
| `triage <id> <new\|shortlisted\|skipped\|dismissed\|acted> [--note "…"] [--category c]` | Record what you decided, and why a dismissal |
| `runs [--project k] [--limit n]` | Recent scans: what ran, what the gate dropped, what it spent |
| `projects` | The workspace's projects |
| `serve [--port n]` | The local review inbox |
| `init [dir]` | Create a workspace |
| `backup` · `backups` · `restore [file]` | Snapshot the database, list snapshots, restore one |

An unknown `--project` key is an error that lists the known ones. A retired profile's findings stay readable under its key.

## Configuration

Credentials are covered in [Sources](#sources). Everything else has a working default:

| Variable | Default | What it changes |
| --- | --- | --- |
| `OBSERF_HOME` | the nearest directory at or above the current one holding `obserf.config.ts` | Which workspace a command acts on (the directory, not the file) |
| `OBSERF_DB` | `.obserf/obserf.db` in the workspace | Which database; relative paths resolve against the workspace. A path with nothing at it is an error, not a new empty database |
| `OBSERF_MODEL` | `claude-opus-5` | The model that assesses and drafts |
| `OBSERF_ASSESS_CONCURRENCY` | `4` | Assessments in flight at once |
| `OBSERF_RESULTS_PER_QUERY` | `10` | Results per source request; Brave caps it at 20 |
| `OBSERF_MAX_AGE_DAYS` | `365` | The `stale` gate's cutoff |
| `OBSERF_REASSESS_AFTER_DAYS` | `7` | How long a finding waits before it may be reassessed |
| `OBSERF_REASSESS_DISQUALIFIED_AFTER_DAYS` | `30` | The same for one the model disqualified |
| `OBSERF_USER_AGENT` | `obserf/0.2 (+https://obserf.com)` | What Reddit and GitHub are told; both refuse requests without one |
| `NO_COLOR` | unset | Any non-empty value turns colour off |

The thresholds no variable reaches, such as the gate's minimum text length and the blocked domains, are in [config.ts](config.ts).

## Database maintenance

Before migrating a database that already has data, Obserf takes a snapshot and says where it put it.

```bash
bun run obserf backup            # snapshot now
bun run obserf backups           # list snapshots, oldest first
bun run obserf restore           # replace the database with the newest
bun run obserf restore <file>    # or with a specific one
```

Snapshots go to `.obserf/backups/`. Each name records why it was taken: `manual`, `upgrade` (just before a migration) or `replaced` (what a restore overwrote). A restore snapshots what it replaces, so it can be undone. A bare filename resolves inside the backup directory; use `./file.db` for one in the current directory. Nothing is pruned automatically.

<!-- prettier-ignore -->
> [!WARNING]
> Stop `obserf serve` and any scan before restoring or upgrading. Nothing coordinates processes: a restore replaces the file under a running server, and a note written during an upgrade may miss the snapshot taken before it.

## Development

In a checkout: `bun install`, then `bun test`, `bun run typecheck` and `bun run fmt` (`fmt:check` to check without writing). A checkout has no workspace of its own, so point commands at one with `OBSERF_HOME=~/dev/marketing`, and add `--env-file` for anything that needs its credentials. [AGENTS.md](AGENTS.md) is the working brief: structure, invariants, and what `scan` and `draft` cost the operator.

## Documentation

- [Overview](docs/product/overview.md) — product purpose and scope
- [What counts as an opportunity](docs/product/opportunities.md) — eligibility and draft standards
- [Scoring](docs/product/scoring.md) · [Sources](docs/product/sources.md) · [Evaluation](docs/product/evaluation.md) · [Roadmap](docs/product/roadmap.md)
- [Architecture](docs/architecture.md) and [ADRs](docs/adr/)
- [Security](.github/SECURITY.md) — what to report privately, and what is a quality problem rather than a vulnerability

## License

Copyright 2026 Konstantin Tarkus. Licensed under the [Apache License, Version 2.0](LICENSE). Third-party dependencies retain their own licenses.
