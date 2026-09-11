# Evaluation

Obserf is useful only if the top of the ranked inbox is worth reading. Every question here is about the first ten findings, never about how many candidates discovery produced.

See [opportunities.md](./opportunities.md) for what qualifies, [scoring.md](./scoring.md) for the components and the formula, [sources.md](./sources.md) for source behavior, and the [ADRs](../adr/) for the decisions that constrain the pipeline.

## The bar

For a representative scan: **at least 5 of the top 10** survive review as `shortlisted`, and **no embarrassing false positive in the top 3**. A finding later moved from `shortlisted` to `acted` still counts as having survived.

```bash
obserf list --project <key> --limit 10                     # today's inbox
obserf list --project <key> --status new,shortlisted,acted,dismissed --min 0 --limit 10
```

`--status` defaults to `new` and accepts a comma-separated list. That default matters twice: it hides everything already labelled, and labelling a finding removes it from the next default list — so a cohort changes under you as you work through it. Save the finding ids before labelling.

Top-heavy on purpose. With one operator reading a few dozen findings, a bad result near the top costs more trust than a good one buried lower, and missing opportunities is cheaper than repeatedly recommending inappropriate ones. Five of ten is a target, not a measured baseline: demanding enough that half the first page must justify attention, without pretending ten findings are a sample. Fewer than ten eligible findings is inconclusive, not a pass.

Passing means the ranking produced a useful inbox. It does not mean Obserf created marketing value, that the drafts work, or that discovery found everything worth finding. Nothing tracks those.

## Diagnosing a bad finding

`obserf show <id>` prints the score, the four components, `disqualified`, and the model's one-sentence reason. Read them before guessing — the component that is wrong names the layer that failed.

| What went wrong | Where it shows | First fix |
| --- | --- | --- |
| The project cannot solve the stated problem | `relevance` high | profile `pitch` and `notFor` → prompt |
| Shared vocabulary only: terms match, the need does not | `relevance` high | `notFor`, then queries |
| No public way to participate | `disqualified` false | evidence → prompt |
| The venue forbids it | `welcome` high | `venueGuidance` → prompt |
| Paid placement presented as free | `disqualified` false | evidence → prompt |
| The conversation has already concluded | `intent` high | evidence → prompt |
| Nobody will read it | `reach` high | source selection |

For the vocabulary trap, the question to ask is: strip the overlapping product names, technologies and category words — would a knowledgeable maintainer still mention the project after reading the whole thread? Repeated failures of this kind belong in `notFor`, queries or `venueGuidance`, not in scoring weights.

**"Already concluded" is not the `settled` gate.** `settled` checks only whether the operator already dismissed or acted on a finding. No gate detects that a discussion has run its course, so that failure belongs to the evidence and the prompt. A false positive outside this table is still a failure; the table exists to make recurring ones comparable.

## What to run, by change type

| Change | Run | Spends | Decided by |
| --- | --- | --- | --- |
| Query | `obserf scan --dry-run`, then a real scan | source quota, then model quota | the bar — never candidate count |
| Assessment prompt | representative scans | model quota | the targeted failure is gone, no top-3 regression |
| Scoring | `obserf rescore` | nothing | movement against existing labels |
| Source | `--dry-run`, then scans and triage | source quota, then model quota | distinct shortlisted findings it alone contributed |

**Query.** Record date, projects, candidate count, gate survivors and survivor _hosts_. A dry run reports each survivor as a title and URL with no source id, so per-source attribution needs separate `--source <id>` runs — and those are gated independently, so their counts do not add up to the combined scan's. Reject immediately if a source collapses or a known mismatch returns; otherwise the decision needs a real scan, because more candidates is not better opportunities.

**Prompt.** `assessments.promptFingerprint` groups results by prompt version, but nothing reads it back: no command prints it, so query the database (`bun run db:studio`). It hashes the rubric and the project brief only. It therefore differs between projects, and does **not** change when `candidateBlock` changes — edits to candidate formatting or excerpt truncation alter how the model reads a candidate while leaving the fingerprint identical. Record the code revision and the project alongside it. A fingerprint change neither forces nor suppresses reassessment. Give each prompt version one named failure to correct; there is no frozen corpus yet, so conclusions are judgments from observed scans, not item-for-item measurements.

**Scoring.** The cheapest to evaluate, because stored components do not change — but `rescore` scores with the current clock. A baseline computed weeks ago decays against a rescore run today, and `listing` findings do not decay at all, so listings reorder against threads with no weight change whatsoever. Run `obserf rescore` on the unchanged code first, save that ranking, then change the weights and rescore again. Compare the positions of `shortlisted`, `acted` and `dismissed` findings across as much labelled history as is relevant. Reject when dismissed findings systematically rise, or known good ones fall for no defensible reason.

**Source.** The efficiency question is shortlisted findings per actual model call. Use the run's real call count or do not cite the ratio — inferring calls from candidate or survivor count and presenting it as measurement is worse than saying nothing. An `acted` finding is stronger evidence than a shortlist, but it still only records that the operator chose to participate.

## A representative scan

Three active projects when available, two minimum: the one that motivated the change, plus at least one with a meaningfully different audience, query set or source mix. Run them within seven days of one another, and prefer the same day for before/after retrieval comparisons, because search results, thread activity, cooldowns and rediscovery all move on their own. One project can justify a project-specific change, never a pipeline one.

A scan is not representative evidence when the profile was being rewritten during it, an important source was unavailable or quota-limited, the project was chosen because its results already looked favorable, or external conditions moved between the before and the after. Record the result; do not claim an improvement from it.

## Labelling

The operator labels, because usefulness is relative to their project — which is also the source of confirmation and anchoring bias: the person who made the change wants it to work, and the model's explanation is persuasive.

Inspect the underlying evidence and form a judgment **before** reading the score or the reason. Then:

```bash
obserf triage <id> shortlisted|dismissed --note "<category>: <one line>"
```

Carry the false-positive category in the note for any dismissal relevant to the experiment. Move to `acted` only if something was actually posted. Never relabel a borderline finding because the aggregate would otherwise miss the target. When the model's reason changed your initial judgment, record that — it is evidence about the prompt, even though it does not remove the bias.

## What to record

With the change, in the commit or PR: date, what changed, project count, before/after revision, prompt fingerprint where relevant, the bar result, the false-positive categories seen, and the decision — keep, revert, or inconclusive. Concrete findings, URLs and private project details belong in a local note; only the aggregate belongs in this repository. Do not build a dashboard for this; the record exists to make today's reasoning legible months from now.

## Eval set

Deferred until ordinary use has produced **50 findings worth labelling** — a planned target, not a measurement. Build it from real accumulated findings, not invented ones: clear positives, clear dismissals, borderline cases, several sources, and the recurring false-positive categories. Freeze the evidence each judgment used, keep the human disposition and a short rationale, and store the model's previous answer separately from the human label.

Its purpose is narrow — comparing assessment-prompt behavior on the same cases and catching regressions memory would miss. It cannot measure discovery coverage, whether a new source earns its calls, ranking quality on future distributions, or whether posting created value, and it goes stale as venues change. Until it exists and can actually be run, do not produce an eval-set number.

## How to fool yourself

More candidates described as better quality. One unusually good project generalized to the whole pipeline. The bar revised after seeing the result. Two discovery runs treated as one experiment when time, cooldowns, rediscovery and thread activity moved between them. A favorite finding rising cited as a scoring win. A prompt called better because its explanations read more persuasively.

At this scale comparisons stay small and noisy, and one operator cannot remove their own judgment from the product. Prefer the cheap repeatable measurements — rescoring, recurring false-positive categories, eventually the eval set — and use repeated representative scans only where a change affects live retrieval or assessment. Stop when another run is unlikely to resolve the decision: if two configurations both clear the bar and the remainder is a handful of ambiguous findings, take the simpler behavior and write down the judgment. When the instrument measures a proxy, name the proxy. Never turn missing evidence into a number.
