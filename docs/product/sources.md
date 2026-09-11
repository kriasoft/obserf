# Sources

A source adapter turns a project profile into candidates. All four implement the same interface and are registered in one array; the pipeline knows nothing else about them. See [ADR-007](../adr/007-sources-are-adapters.md).

In registry order, which is also precedence:

| Source | Auth | Cost | Rate limit | What it is good for |
| --- | --- | --- | --- | --- |
| `hn` | none | Free, unmetered | Courtesy 1 rps | Algolia exposes full-text search over stories and comments |
| `reddit` | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | Free | 100 queries/min | Where "what should I use" questions actually get asked |
| `github` | `gh` CLI, or `GITHUB_TOKEN` | Free | 10/min unauthenticated, 30/min with a token | Issue search for "alternatives to X" threads; repository search for `awesome-*` lists |
| `brave` | `BRAVE_API_KEY` | Free tier: 2,000 queries/month, 1 query/sec | 1 rps, enforced by the adapter | Search-index coverage beyond the direct adapters, including pages on venues whose own API is unavailable |

Brave is the only source that can exhaust a paid quota, so it is also the only one with a monthly budget worth watching. The other three are free and rate-limited by politeness rather than cost.

## Which sources a project runs

A profile's `sources` decides which adapters run; `queries.brave` decides what Brave asks. They are different levers and the second is finer: measurement can show that a source is not earning its model calls at one job while doing another well, and dropping the adapter would lose both.

A profile's `sources` lists the ids that project scans by default; absent, every registered source runs. An empty list is rejected rather than read as "all", which is the one confusion the field cannot afford. `--source` overrides either, so a source a project has stopped running is still one flag away for an experiment.

Selection preserves registry order. The first snapshot of a URL to reach the gate's history checks owns it for that scan. A snapshot rejected for what it is — blocked, too old, too little text — leaves the URL open to a better-described duplicate; one rejected by comparison with what is already stored does not, because a second source's description of the same unchanged thread is not new evidence about it. Specialized adapters precede Brave because they can supply thread text and engagement that Brave’s search descriptions lack. This is a fixed preference, not a comparison of individual candidates’ quality: GitHub repository results contain descriptions, and some HN stories have no body text.

Choose a project's default sources from measured results, and record the measurement in the profile beside the choice — that is the only place it stays attached to the queries it was measured against. Dropping a source is a statement about the queries that were tested, not proof that the source can never help; a retry should test whether different queries reach pages with a useful, permitted, free participation path. A dry run establishes retrieval coverage, not opportunity quality, and the two are easy to confuse when a change looks like an improvement because it returned more.

## Reddit access

The adapter uses the `client_credentials` grant with app credentials registered under a Reddit account. It needs no user authorization at runtime. A 403 or 404 from one subreddit is reported and skipped; if every configured subreddit returns either status, the source fails rather than reporting an empty result.

Reddit's [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) requires explicit approval for API access; registering an app alone is insufficient. The policy links to requests for uses outside Devvit. Checked 2026-09-09; possession of older credentials does not establish approval.

Two alternatives were considered:

- **Anonymous RSS:** Reddit throttles unauthenticated feed requests aggressively and does not document a rate a client can rely on. Obserf has no RSS adapter; introducing one would require access stable enough to distinguish throttling from an empty result, because throttling must fail the source rather than silently shorten it.
- **Devvit:** a platform for apps running on Reddit, rather than credentials for this external CLI. Adopting it would change Obserf's local architecture.

Without approved API access, Brave reaches Reddit as a proxy. `queries.brave` exists for that: `queries.search` is shared by Brave, Hacker News, and Reddit, so a `site:` operator placed there is also sent to Algolia and to Reddit's own API, where it matches nothing. Brave uses `queries.brave` when a profile sets it and falls back to `queries.search` otherwise. Evaluate new ones with a Brave-only dry run before changing a profile's defaults.

What this reaches is public search results about Reddit threads, not the Reddit API, so it neither needs nor implies the approval the API requires. Obserf still never posts.

## Other adapter behavior

**Every adapter normalizes through `plainText`.** Tags are removed, common named and numeric character references are decoded, and whitespace collapses to one line. Unknown, malformed, control and bidirectional references remain literal rather than being guessed or turned into terminal control characters. The result becomes the stored excerpt: evidence for assessment, input to the `thin` and `unchanged` gates, and the text shown to the operator.

**Hacker News returns comments as well as stories, and says which.** The adapter searches `tags=(story,comment)`, so a hit may be one comment inside a thread rather than the thread itself. Those hits carry the comment's URL and text but the enclosing story's title, which makes them easy to mistake for the thread. Algolia reports no points or comment count for an individual comment either, so without an explicit classification the model has only the excerpt's voice to distinguish them.

A candidate carries `isThreadComment`, which is stored on the finding. Assessment uses it to judge `reach` where the reply would appear; drafting uses it to address the commenter rather than the thread; and the default draft kind becomes `reply` except for a listing submission. Absent means the source did not classify the shape, not that the URL names a thread: it stays null on first sighting, while a rediscovery inherits any stored classification before assessment so the prompt and refreshed row agree.

**Hacker News search is ranked by relevance across all of HN's history.** The adapter therefore sends a `created_at_i` filter matching the gate's age cutoff. Without it, a popular 2015 thread outranks a live one, fills the result page, and is then discarded by the stale gate — so the request is spent and the live discussion below the cap is never seen, scan after scan.

**GitHub borrows the `gh` CLI's token.** Precedence is `GITHUB_TOKEN`, then `gh auth token`, then unauthenticated. An explicit environment variable wins, because a variable set for this command should not be quietly overridden by ambient CLI state — but with it unset, a machine where `gh auth login` has already run needs no GitHub configuration at all, and there is no second copy of a credential to rotate twice. `OBSERF_GITHUB_USER` names the account on a machine with several; without it `gh` picks its own active one, which is fine until the day it changes. Failure to obtain a token from `gh` falls back to unauthenticated search with a warning. Once a token is selected, a rejected token or failed search fails the source; obserf does not retry anonymously. Request pacing is shared by discovery and enrichment across projects.

**GitHub enriches surviving repositories.** A search result says how many stars a curated list has and when it was last pushed, and neither answers the only question that matters for a `listing`: does this maintainer merge what strangers send? A daily-pushed list can still close almost everything it is sent. So `github` implements `enrich` ([ADR-009](../adr/009-expensive-evidence-after-the-gate.md)) and asks, per surviving repository, for pull requests merged in the last year, closed unmerged in the same period, and currently open. Read together those separate the live lists from the dead ones far better than stars or recency do. The counts are facts and the inference is the model's: closing a pull request without merging it does not by itself establish that the maintainer refused it, since one can be withdrawn, superseded, duplicated, or spam. The queries count all pull requests, including maintainers’ own work; they do not establish an outside contributor’s chance of acceptance.

This costs three requests per surviving repository, which is why it runs after the gate rather than during discovery, and why broad `githubRepos` queries are now more expensive than they were. It is evidence for the model, not a gate rule: a careful list may accept one excellent submission a year and still be the best opportunity on offer.

**GitHub search is two endpoints.** `queries.github` goes to issue search — the "what should I use" and comparison threads. `queries.githubRepos` goes to repository search, which is the only way to find `awesome-*` lists: repository qualifiers like `in:name,description,readme` match nothing against issues, so mixing them silently returns zero. Archived repositories are dropped, since a frozen list accepts no submissions.

## Adding a source

Add its id to `SOURCE_IDS` in `vocabulary.ts`, implement `Source` in `sources/`, add it to the registry in `sources/index.ts`, and give project profiles whatever query shape it needs under `queries`. The id goes in the shared vocabulary rather than being derived from the registry because profiles and the browser both name it, and `vocabulary.ts` may import nothing. `enrich` is optional and most adapters should not have one — add it only when a fact worth having costs a request per candidate, and keep it after the gate to avoid requests for rejected candidates ([ADR-009](../adr/009-expensive-evidence-after-the-gate.md)). The pipeline requires nothing further — a new source reports itself as skipped, with a reason, when its credentials are missing or when the profile gave it no usable queries. It joins a project's scans automatically unless that profile lists `sources`, in which case add it there too; an explicit list is the price of having measured one out.

`unavailable(project)` returns a human-readable reason string rather than a boolean so a scan can say _why_ it ran three sources instead of four, which is the difference between a missing key and a silently degraded scan. The reason is printed as the source is skipped. When every selected source is unavailable the scan fails instead of reporting zero candidates.

It answers about the profile as well as about credentials, and about the profile first. Each adapter reads different fields — Hacker News needs `queries.search`, Reddit needs both that and `queries.subreddits`, GitHub needs either `queries.github` or `queries.githubRepos`, and Brave needs `queries.brave` or, only when that field is absent entirely, `queries.search` — so a project reaching its audience through one source is told which of the others it never gave anything to ask. An explicit `brave: []` means ask nothing and does not fall back, which is what `search` does and therefore what this reports.

This is also why a profile that configures no queries at all now fails rather than completing: every source is unavailable, which the scan already treats as nothing having been searched.

## Deliberately not in v1

**Directories and newsletters.** Repository search surfaces candidate `awesome-*` lists, but checking whether the project is _already in_ one, and tracking non-GitHub directories and newsletter tip lines, is a hand-curated catalog with freshness checks rather than a search problem. On the roadmap.

**X / LinkedIn / Discord.** Authenticated, aggressively rate-limited, and hostile to automated reading. The signal does not justify the maintenance.

**Google / Bing.** Brave covers the same ground with a workable free tier and no scraping.
