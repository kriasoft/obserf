# Evaluation

Obserf is useful only if the top of the ranked inbox is worth reading. Every question here is about the first ten findings, never about how many candidates discovery produced.

See [opportunities.md](./opportunities.md) for what qualifies, [scoring.md](./scoring.md) for the components and the formula, [sources.md](./sources.md) for source behavior, and the [ADRs](../adr/) for the decisions that constrain the pipeline.

## The bar

For a representative scan: **at least 5 of the top 10** are worth surfacing, and **no embarrassing false positive in the top 3**. Worth surfacing means `shortlisted`, `skipped` or `acted`: the bar measures whether Obserf recommended well, not whether you had time to act, so a good finding you passed on counts. Only `dismissed` — Obserf should not have shown it — counts against.

In this order, so you judge each finding before reading the model's reasons:

1. `obserf scan --project <key>`. Its last line names the run: `inbox top 10 frozen: obserf list --run <id>` (`obserf runs --project <key>` lists it later).
2. `obserf serve`, turn on **hide reasons**, select the scanned project, and triage the top ten with the other filters at their defaults. That live view is a convenience: it ranks by the score now, so decay can swap a finding at the boundary. The frozen ten are the record. Give every dismissal a category.
3. `obserf list --run <id>`: it prints each of the frozen ten with its score and reason, then the bar. Decide any it reports still `new` with `obserf triage`, which records the decision as made with the reason shown — as it now was — and run it again. Paste the block that ends it into the commit that records the result.

The ten are frozen when the scan finishes cleanly: the project's `new` findings scoring above zero, ranked by their score at that moment — the top of the inbox's default view. Only undecided findings, so a scan cannot pass on judgments made in an earlier review. It includes findings an earlier scan stored that this one passed over as `unchanged`, since nobody has decided them yet, and not only what this scan assessed. `list --run` keeps that order and those scores while the findings are labelled, so the cohort cannot shrink or reorder under the review. It ends with the bar worked out: worth surfacing out of ten, `inconclusive` while any of the ten is still `new`, gone, missing, or reassessed since the scan (a decision made after a newer verdict may answer that verdict rather than the ranked one), each dismissal's category, and the model and rubric/brief fingerprints the ten were ranked on. So review a run before scanning that project again. The bar measures whether the inbox was worth reading right after the scan, not whether this scan's own findings were good: older undecided findings can hold places in the ten. For a query or source change, compare the findings each scan first stored (`new` in `list`, or `firstRunId`) as well. Only the count is settled there. A dismissal in the top 3 is named for you to judge, because whether it was embarrassing is not something the tool can know. A failed or unfinished scan freezes nothing; nor did any scan before frozen inboxes existed, and for those the live list is all there is, with the trap it carries: its `--status new` default drops each finding as it is labelled, so save the ids first.

Top-heavy on purpose. With one operator reading a few dozen findings, a bad result near the top costs more trust than a good one buried lower, and missing opportunities is cheaper than repeatedly recommending inappropriate ones. Five of ten is a target, not a measured baseline: demanding enough that half the first page must justify attention, without pretending ten findings are a sample. Fewer than ten eligible findings is inconclusive, not a pass.

Passing means the ranking produced a useful inbox. It does not mean Obserf created marketing value, that the drafts work, or that discovery found everything worth finding. Nothing tracks those.

## Diagnosing a bad finding

`obserf show <id>` prints the score, the four components, `disqualified`, and the model's one-sentence reason. It also prints any author or comment-shape facts supplied to the model. Both bear on a component — `reach` is judged at the place a reply would actually appear, and `welcome` on whom it would be addressed to — so a score you disagree with is read against them. Read all of it before guessing; the component that is wrong names the layer that failed.

| What went wrong | Category | Where it shows | First fix |
| --- | --- | --- | --- |
| The project cannot solve the stated problem | `cannot-solve` | `relevance` high | profile `pitch` and `notFor` → prompt |
| Shared vocabulary only: terms match, the need does not | `vocabulary-only` | `relevance` high | `notFor`, then queries |
| No public way to participate | `no-participation` | `disqualified` false | evidence → prompt |
| The venue forbids it | `venue-forbids` | `welcome` high | `venueGuidance` → prompt |
| Paid placement presented as free | `paid` | `disqualified` false | evidence → prompt |
| The conversation has already concluded | `concluded` | `intent` high | evidence → prompt |
| Nobody will read it | `no-audience` | `reach` high | source selection |

The category column is what a dismissal records (`vocabulary.ts` holds the list), plus `other`, a failure outside this table, which points at no fix. A valid opportunity you choose not to pursue is not a dismissal: mark it `skipped`, which records that Obserf was right. A dismissal recorded before `skipped` existed can mean either, and has no category; relabel those (`obserf list --status dismissed --min 0`) before counting them against the ranking.

For the vocabulary trap, the question to ask is: strip the overlapping product names, technologies and category words — would a knowledgeable maintainer still mention the project after reading the whole thread? Repeated failures of this kind belong in `notFor`, queries or `venueGuidance`, not in scoring weights.

**"Already concluded" is not the `settled` gate.** `settled` checks only whether the operator already skipped, dismissed or acted on a finding. No gate detects that a discussion has run its course, so that failure belongs to the evidence and the prompt. A false positive outside this table is still a failure; the table exists to make recurring ones comparable.

## What to run, by change type

| Change | Run | Spends | Decided by |
| --- | --- | --- | --- |
| Query | `obserf scan --dry-run`, then a real scan | source quota, then model quota | the bar — never candidate count |
| Assessment prompt | representative scans | model quota | the targeted failure is gone, no top-3 regression |
| Scoring | `obserf list` before and after | nothing | movement against existing labels |
| Source | `--dry-run`, then scans and triage | source quota, then model quota | distinct shortlisted findings it alone contributed |

`obserf runs` prints the stored record of each scan other than a dry run, which stores nothing — which sources ran, which were skipped and why, the gate breakdown, what was assessed, and the tokens it took — so the numbers below come from the run rather than from memory of what scrolled past.

**Query.** Record date, projects, candidate count, gate survivors and survivor _hosts_. A dry run reports each survivor as a title and URL with no source id, so per-source attribution needs separate `--source <id>` runs — and those are gated independently, so their counts do not add up to the combined scan's. Reject immediately if a source collapses or a known mismatch returns; otherwise the decision needs a real scan, because more candidates is not better opportunities.

**Prompt.** `assessments.promptFingerprint` groups results by prompt version. `obserf show <id>` and the inbox's detail pane print it beside the model and the date for the current verdict, and for every earlier one, so a reassessed finding shows whether the rubric or brief changed between verdicts — not whether the whole prompt did, since the fingerprint leaves out the candidate block. Earlier finding snapshots are not kept, so it cannot show whether the evidence changed too. Grouping a whole project's findings by fingerprint is still a database question (`bun run db:studio`). It hashes the rubric and the project brief only. It therefore differs between projects, and does **not** change when `candidateBlock` changes — edits to candidate formatting or excerpt truncation alter how the model reads a candidate while leaving the fingerprint identical. Record the code revision and the project alongside it. A fingerprint change neither forces nor suppresses reassessment. Give each prompt version one named failure to correct; there is no frozen corpus yet, so conclusions are judgments from observed scans, not item-for-item measurements.

**Scoring.** The cheapest to evaluate, because stored components do not change and every read scores them again. The clock moves too, though: a ranking saved weeks ago has decayed against one listed today, and `listing` findings do not decay at all, so listings reorder against threads with no weight change whatsoever. List the labelled history on the unchanged code (`obserf list --status shortlisted,skipped,acted,dismissed --min 0 --limit 500`), change the weights, and list again straight after. Compare the positions of `shortlisted`, `acted` and `dismissed` findings across as much labelled history as is relevant. Reject when dismissed findings systematically rise, or known good ones fall for no defensible reason.

**Source.** The efficiency question is shortlisted findings per unit of model work. `obserf runs` prints what a scan assessed and what it spent in tokens; neither is a call count, because `assessed` counts the findings a scan stored and the SDK makes auxiliary calls of its own. Cite the tokens, which are recorded, or the assessed count as what it is — inferring calls from candidate or survivor count and presenting that as measurement is worse than saying nothing. An `acted` finding is stronger evidence than a shortlist, but it still only records that the operator chose to participate.

Counting a stored finding's `sourceId` is not the same question, and answering the first with the second overstates what is known. That field names the adapter whose snapshot the row currently holds — a thread Brave found and the Hacker News adapter later refreshed reads as `hn` — so in a scan that ran several sources it attributes the refresh, not the discovery. `firstRunId` names the scan a finding was first stored by, so discovery is attributable only where that scan had a single effective source — a profile whose `sources` names one adapter, or a `--source <id>` run. `--source hn,brave` isolates neither of them.

## A representative scan

Three active projects when available, two minimum: the one that motivated the change, plus at least one with a meaningfully different audience, query set or source mix. Run them within seven days of one another, and prefer the same day for before/after retrieval comparisons, because search results, thread activity, cooldowns and rediscovery all move on their own. One project can justify a project-specific change, never a pipeline one.

A scan is not representative evidence when the profile was being rewritten during it, an important source was unavailable or quota-limited, the project was chosen because its results already looked favorable, or external conditions moved between the before and the after. Record the result; do not claim an improvement from it. Of those, source availability is what `obserf runs` can check after the fact, since the run stores the reason each skipped source gave.

## Labelling

The operator labels, because usefulness is relative to their project — which is also the source of confirmation and anchoring bias: the person who made the change wants it to work, and the model's explanation is persuasive.

Inspect the underlying evidence and form a judgment **before** reading the score or the reason. The inbox's **hide reasons** toggle does this for you: a `new` finding shows its evidence and age but no score, components, opportunity type or reason until you triage it or press `r`. Each finding records whether its first decision out of `new` was made that way, and `list --run` reports the count. The inbox knows only what it showed in the session that decided: a reason read in an earlier session, or in the terminal, does not count against it. It is reason-hidden, not blind — the rank order still says what the model rated highest. Decisions made from the CLI count as shown, since `list` and `show` print the reason. Then:

```bash
obserf triage <id> shortlisted            # or skipped: worth surfacing, not pursuing it
obserf triage <id> dismissed --category <category> --note "<one line>"
```

Give every dismissal relevant to the experiment a category — in the inbox, a digit right after `d`, or the picker on the finding. It is stored on the triage row, so the categories seen can be counted rather than read out of notes, and it is cleared if the finding is reopened. Move to `acted` only if something was actually posted. Never relabel a borderline finding because the aggregate would otherwise miss the target. When the model's reason changed your initial judgment, record that — it is evidence about the prompt, even though it does not remove the bias.

## What to record

With the change, in the commit or PR: date, what changed, project count, before/after revision, prompt fingerprint where relevant, the bar result, the false-positive categories seen, and the decision — keep, revert, or inconclusive. The block `obserf list --run` ends with covers the bar, the categories and the fingerprints for one project; paste one per project, and add the revision, which it cannot know. Concrete findings, URLs and private project details belong in a local note; only the aggregate belongs in this repository. Do not build a dashboard for this; the record exists to make today's reasoning legible months from now.

## Eval set

Deferred until ordinary use has produced **50 findings worth labelling** — a planned target, not a measurement. Build it from real accumulated findings, not invented ones: clear positives, clear dismissals, borderline cases, several sources, and the recurring false-positive categories. Freeze the evidence each judgment used, keep the human disposition and a short rationale, and store the model's previous answer separately from the human label.

Its purpose is narrow — comparing assessment-prompt behavior on the same cases and catching regressions memory would miss. It cannot measure discovery coverage, whether a new source earns its calls, ranking quality on future distributions, or whether posting created value, and it goes stale as venues change. Until it exists and can actually be run, do not produce an eval-set number.

## How to fool yourself

More candidates described as better quality. One unusually good project generalized to the whole pipeline. The bar revised after seeing the result. Two discovery runs treated as one experiment when time, cooldowns, rediscovery and thread activity moved between them. A favorite finding rising cited as a scoring win. A prompt called better because its explanations read more persuasively.

At this scale comparisons stay small and noisy, and one operator cannot remove their own judgment from the product. Prefer the cheap repeatable measurements — re-ranking labelled history, recurring false-positive categories, eventually the eval set — and use repeated representative scans only where a change affects live retrieval or assessment. Stop when another run is unlikely to resolve the decision: if two configurations both clear the bar and the remainder is a handful of ambiguous findings, take the simpler behavior and write down the judgment. When the instrument measures a proxy, name the proxy. Never turn missing evidence into a number.
