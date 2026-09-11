# ADR-009 Expensive Evidence Is Gathered After the Gate

- **Status:** Accepted
- **Date:** 2026-09-09
- **Tags:** architecture, sources, cost

## Problem

Some facts that decide an opportunity are not in any search result. Whether an `awesome-*` list still accepts outside submissions is the clearest case. A list can be topically perfect, well starred, and pushed daily while closing almost everything strangers send it — and every signal a search result carries reads that as health. The model scores it well and a human wastes an afternoon on a pull request that was never going to be merged. The model cannot recover a fact it was never given, and no amount of prompt work substitutes for it.

Fetching that evidence costs a request per candidate, which rules out gathering it during discovery. A scan in steady state mostly rediscovers what it already knows: nearly every GitHub candidate is one the gate has already settled, aged out, seen unchanged, or ruled out. Enriching inside `search()` would spend several requests each on candidates that are then discarded before any of that evidence is read, and that is the ordinary case rather than the bad one.

## Decision

`Source` gains an optional enrichment method, `enrich(candidates)`, and the pipeline becomes **discover → gate → enrich → assess**. Only survivors are enriched, so the cost falls on candidates obserf has already decided to spend a model call on.

The measure is a proxy and is described as one everywhere it appears. GitHub's search counts pull requests by state, not by who wrote them, so merged-against-closed-unmerged cannot be reported as an outsider's chance of acceptance; an earlier version counted authorship through `author_association` and was removed, because separating outside contributions from maintainers' own costs another request per repository to split a population that a curated list, whose purpose is accepting outside submissions, has little of either way. The counts are evidence, and the inference stays with the model.

Adapters return the same candidates, enriched; the pipeline matches them back by URL, so an adapter may reorder them but must not drop or add candidates, or change their URLs or source ids. `pipeline/enrich.ts` checks that rather than trusting it, because silently assessing a dropped candidate without enrichment would hide an adapter failure as ordinary uncertainty. Pacing stays inside the adapter, as it is for `search`. Sources without an `enrich` are skipped, which is most of them — their discovery responses already supply the evidence those adapters currently use.

Enrichment failures fail the scan rather than degrading quietly. A repository that reports no merges because the request failed is indistinguishable, in the prompt, from one that merges nothing, and that confusion is the exact error this exists to prevent.

The evidence is **evidence, not a gate rule**. "Merges nothing" does not become a deterministic rejection, because that is judgment about a spectrum rather than a fact of the kind ADR-004 admits — a careful list may accept one excellent submission a year and still be the best opportunity available. Measure how the model handles it before promoting any part of it to policy.

## Alternatives (brief)

- **Enrich inside `search()`** – keeps evidence gathering in one method, and spends its requests on the candidates the gate is about to discard, which in steady state is nearly all of them.
- **A generic enrichment stage the pipeline owns** – would put GitHub's pull-request queries in `pipeline/`, which is exactly the leak ADR-007 exists to prevent.
- **Gate on merge behaviour** – converts a judgment into policy before measuring whether the model needed help making it.
- **Ask the model to infer receptiveness from stars and push date** – what it was already doing, and the reason a list that merges nothing can rank near the top.

## Impact

- Positive: the facts that decide a listing reach both the model and the operator; `obserf show` prints them, replacing a manual trip to github.com per candidate.
- Positive: enrichment cost is proportional to gate survivors, and zero when the gate keeps none.
- Negative/Risks: a first scan of a new project pays three requests per repository candidate, so broad `githubRepos` queries are more expensive than they were. Narrow them on measured results.
- Negative/Risks: an optional enrichment method adds a contract an adapter author must understand. It is optional and unused by three of four adapters, which is the price of not putting source-specific fetching in the pipeline.
