# ADR-002 A Current Snapshot, Append-Only Judgment, And A Human Decision

- **Status:** Accepted
- **Date:** 2026-09-09
- **Tags:** architecture, schema

## Problem

A finding has three kinds of fact attached to it, and they change for different reasons and at different rates: what the source currently reports, what the model concluded, and what the operator decided. Flattening them into one row means every re-assessment overwrites history, and a prompt experiment destroys the triage decisions it was supposed to be evaluated against.

## Decision

Three tables, one concern each.

**`findings`** is the latest _successfully assessed_ snapshot of a URL: title, excerpt, publication date, engagement metrics, and the raw payload as the source reported them at that moment. A gate survivor refreshes it in the same transaction that appends its assessment; a rediscovery the gate rejects changes nothing. `discoveredAt` records the first persisted assessment and never changes. There is no separate "last seen" timestamp: the refresh shares a transaction with the assessment that caused it, so `max(assessments.createdAt)` already dates the snapshot, and a second column could only drift from it. Deduped on `(project, url)` after canonicalization.

**`assessments`** is judgment: the four score components, the verdict, the reason, and the `model` and `promptFingerprint` that produced them. Append-only — many per finding. The newest wins for display; the older ones are what a prompt change is evaluated against. One column is exempt: `score` is arithmetic derived from the components ([ADR-003](./003-model-scores-components-code-ranks.md)), so `obserf rescore` recomputes it in place. Nothing the model _said_ is ever overwritten, which is what append-only protects.

**`triage`** is the operator's decision: one row per finding, holding the current status and an optional note. Freely updated by the operator. A scan creates it with status `new` when absent and never overwrites a decision.

`drafts` hangs off findings the same way assessments do, for the same reason: regenerating a draft must not destroy the one that was already posted.

### Why findings are mutable

This is a correction. Findings were originally insert-only "evidence, exactly as the source reported it", on the reasoning that observations are facts and facts do not change.

The reasoning was sound and the conclusion was wrong, because it modelled the wrong thing. A finding is not an observation; it is an _opportunity_, and opportunities change. A Hacker News post with 5 points and no comments in the morning is not the same opportunity as the same post with 150 points and 60 comments that afternoon — the second is the moment worth acting on, and freezing the first meant obserf could never see it. An unanswered Reddit question becomes active; a GitHub issue gains discussion; an ambiguous thread turns into exactly the question the project answers. A tool whose first sentence is "watches the public web" cannot look at each URL once, forever.

The alternative — keeping findings immutable and adding an `observations` table — buys a history nothing in the product asks for, at the cost of a join on every read and a growing table of rows nobody looks at. Conceptual purity is not worth that here. What must survive rescans is the operator's decisions and the model's judgments, and both of those live in their own tables already.

The gate enforces the boundary: a finding the operator has `dismissed` or `acted` on is settled and never revisited, whatever the source now reports.

## Alternatives (brief)

- **One wide `findings` table with score columns** – simplest until the first re-assessment, which then silently overwrites the evidence a human already acted on.
- **Immutable findings plus an `observations` event log** – full history, real complexity, and no question the product actually asks. Revisit only if "how did this thread evolve?" becomes something the operator needs answered.
- **Assessments as a mutable one-per-finding row** – keeps the schema small and makes prompt changes unevaluable, since the previous verdict is gone by the time you want to compare.

## Impact

- Positive: obserf behaves like a monitor rather than a one-shot finder; re-assessment is safe; prompt versions stay comparable; human decisions survive every pipeline change.
- Negative/Risks: earlier snapshots are lost on refresh. Assessment history preserves the judgments and the prompt provenance behind them, but not the candidate text or raw payload each assessment actually saw, so a past verdict cannot be replayed against its exact input. Draft history likewise preserves generated copy, not the operator's edits or any proof of posting.
- Reads need a join and a "latest assessment" predicate, contained in `latestFindings()` rather than spread across callers.

## Links

- Code/Docs: `db/schema.ts`, `pipeline/gate.ts`, `db/index.ts` (`knownFindings`)
- Related ADRs: [ADR-003](./003-model-scores-components-code-ranks.md), [ADR-004](./004-deterministic-gates-before-the-model.md)
