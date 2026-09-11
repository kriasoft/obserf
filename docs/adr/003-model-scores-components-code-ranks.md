# ADR-003 The Model Scores Components, Code Computes The Rank

- **Status:** Accepted
- **Date:** 2026-09-09
- **Tags:** llm, scoring

## Problem

The obvious design asks the model for a score out of 100. That number is unstable between runs, uncalibrated across projects, impossible to tune without re-running every assessment, and unexplainable when it is wrong — "why is this a 72" has no answer.

## Decision

The model returns four bounded judgments (`relevance`, `intent`, `welcome`, `reach`, each 0–5), a disqualification flag, an opportunity type (or null), and a one-sentence reason. Code computes the score from those, with a fixed weighting and a freshness decay, in `pipeline/score.ts`.

Code also owns the **hard zeros**, which is where the split earns most of its keep. The product's three conditions — useful, permitted, free — are prerequisites, not preferences, so `relevance: 0`, `welcome: 0`, and `disqualified` each zero the score outright and no weighted term can outvote them. Left purely to the weights, relevance carries 0.35 of the total, so a candidate the model calls completely unrelated to the project still reaches 65 when the other three components are maximal — a number that would rank it above most of what a scan finds.

The split follows what each side is actually good at. Judging whether a subreddit tolerates self-promotion is a language problem; deciding that welcome is worth 20% and that a stale thread decays with a 30-day half-life is a policy choice, and policy belongs in code where it can be read, tested, and changed.

Because the components are stored and the score is derived, re-weighting re-ranks the whole database with no model calls — `obserf rescore` recomputes in place. Applying a changed prompt or assessment brief requires a new assessment, which consumes subscription quota ([ADR-008](./008-claude-code-subscription.md)). The fingerprint records provenance; it does not bypass the unchanged gate to force that assessment.

Which prompt produced a verdict is recorded as a **fingerprint**: a hash of the rubric plus that project's brief, stored on every assessment. It replaced a hand-maintained version integer, which could be forgotten — leaving two different prompts both claiming version 1 — and which, being global, changed the recorded version for every project whenever any one profile was edited.

## Alternatives (brief)

- **Ask for a 0–100 score directly** – no tuning without re-running, no explanation, and drift between batches that nothing detects.
- **Pure heuristics, no model** – keyword and domain rules cannot judge whether a mention would be welcome, which is the one question that separates an opportunity from a ban.
- **Model returns components _and_ a score** – two sources of truth that disagree, and the disagreement is invisible.

## Impact

- Positive: tunable without spend, auditable per component, testable with a pure function.
- Negative/Risks: the weights are currently a guess. Making them evidence-based needs outcome tracking, which is on the roadmap.

## Links

- Code/Docs: `pipeline/score.ts`, [Scoring](../product/scoring.md)
- Related ADRs: [ADR-002](./002-evidence-judgment-decision.md), [ADR-004](./004-deterministic-gates-before-the-model.md)
