# Roadmap

## v1 — the loop closes

The discovery, review, and drafting loop is implemented. The operator posts in the venue itself.

- [x] SQLite schema, snapshot/restore, and the project profile format
- [x] Four source adapters: Brave, Hacker News, Reddit, GitHub
- [x] Deterministic gates: duplicate, settled, blocked, stale, thin, unchanged, ruled-out
- [x] Model assessment with the four components and structured output
- [x] `obserf scan`, `list`, `show`, `draft`, `triage`, `rescore`
- [x] Local review inbox (`obserf serve`)

Implementation alone does not establish useful results. The definition of done remains one real posted comment that came out of the tool, for each project; that validation is not recorded here yet.

**How to tell if it is working, before any outcome tracking exists.** Triage statuses are already labels: of the top ten results, how many survive human review? Aim for **at least 5 of the top 10 shortlisted**, and **no embarrassing false positive in the top 3**. That is measurable today from `triage` alone, needs no attribution or analytics, and is a far more useful target than modelling marketing ROI.

## Next — the parts v1 defers

**Directories and listings catalog.** A seeded list of `awesome-*` lists, dev-tool directories, and newsletter tip lines, checked for whether the project is already present. Different shape from search: a catalog with freshness checks, not a query.

**Scheduled scans.** A cron entry and a digest. Deliberately after v1 — a schedule on a pipeline whose precision is unproven just generates unread noise on a timer.

**Outcome tracking.** Record what was posted and what came back. This is what turns the weights in [Scoring](./scoring.md) from a guess into something fitted to evidence, and it is the highest-value item here once the loop runs.

It needs its own record rather than a join onto `drafts`. A draft is what obserf generated; what gets posted is what the operator edited it into, which may differ substantially or never have been posted at all. Treating the two as the same thing would quietly fit the weights to text nobody published.

**Assessment eval set.** Fifty hand-labelled findings, so a prompt change can be measured rather than eyeballed. Blocked on having fifty findings worth labelling.

## Not planned

**Auto-posting.** See [ADR-005](../adr/005-obserf-drafts-humans-post.md).

**Hosting it for other people.** A different product with a different architecture — auth, multi-tenancy, per-tenant quotas, and abuse handling. If it happens it is a rewrite, not a migration, and the local tool stays what it is.

**Browser automation (Playwright or similar).** Obserf never posts. `pipeline/draft-context.ts` fetches thread context at draft time over plain HTTP; when retrieval fails, drafting falls back to the stored excerpt with a warning. Pages requiring JavaScript remain a retrieval limitation.

**A general-purpose "social listening" mode.** Obserf answers "where should I show up?" Brand monitoring answers "what are people saying?" They share a search step and nothing else; merging them makes both worse.
