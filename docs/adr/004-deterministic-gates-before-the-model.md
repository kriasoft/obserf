# ADR-004 Deterministic Gates Run Before The Model

- **Status:** Accepted
- **Date:** 2026-09-09
- **Tags:** llm, pipeline, cost

## Problem

A scan across four sources and a dozen queries returns a few hundred candidates. Most are rejectable without reading them — already in the database, published years ago, from a domain that is never an opportunity, or a stub with no text to judge. Sending those to a model costs money and latency to be told what a comparison already knew.

## Decision

`pipeline/gate.ts` runs before any model call and applies seven rules in order: **duplicate** (another candidate for the canonical URL already reached the history rules in this batch, whether or not it survived them), **settled** (the operator dismissed or acted on it), **blocked** (host or path on the project's or global blocklist), **stale** (older than the age cutoff), **thin** (title plus excerpt below a minimum length), **unchanged** (known, not disqualified, materially unchanged, and assessed recently), and **ruled-out** (the latest verdict disqualified it, its longer reassessment interval has not expired, and the candidate has not materially changed).

**settled** and **ruled-out** honor an existing decision: the operator's status, or the model's latest verdict. The gate makes no new judgment.

**ruled-out** is the ordinary reassessment interval with a longer clock, not a permanent cache. A categorical disqualification — a stack mismatch, the wrong venue, no free way to participate — rarely stops being true, so repeating it weekly wastes model quota. But "no evident free public way to participate" is a statement about the evidence that was available, and a list can reopen submissions while its title, excerpt, and engagement stay identical. Suppression expires after `reassessDisqualifiedAfterDays` (30 days by default). Material changes bypass either cooldown on rediscovery; the other gates still apply.

Prompt-aware invalidation was considered as an alternative to a finite cooldown. It would require carrying prompt fingerprints through both history queries and the gate to stop reusing judgments after prompt edits. A finite cooldown allows reconsideration without that coupling, so the fingerprint remains provenance only. It does not guarantee recovery: the candidate must be rediscovered and pass the other gates.

**unchanged** replaced an earlier **seen** rule that rejected any URL already in the database, which made obserf a one-shot finder rather than a monitor ([ADR-002](./002-evidence-judgment-decision.md)). A known finding can return when its engagement has grown materially, its title or excerpt changed, or the reassessment interval has passed, subject to the other gates, including **ruled-out**. Dismissed and acted-on findings remain settled while those statuses hold; shortlisting does not prevent reassessment.

Change detection is deliberately crude: engagement up by half again or by ten interactions, or any edit to title or excerpt. Precise detection is not worth building before real use shows which changes matter.

Each gate records which rule fired, and `obserf scan` reports the counts. A gate that is silently rejecting half the candidates is a bug, and the only way to notice is to see the number.

The gates are conservative on purpose: they encode facts, not judgment. "Published in 2019" is a fact. "Not relevant to this project" is judgment, and belongs to the model — a keyword pre-filter would reject exactly the paraphrased, high-intent questions that are the most valuable findings.

## Alternatives (brief)

- **Send everything to the model** – simplest, and pays repeatedly to re-reject the same dead URLs on every scan.
- **Add keyword pre-filtering to the gates** – cheap and cuts the wrong half. People describe problems in their own words; matching the project's vocabulary selects for SEO pages over real questions.
- **A cheap model as a first pass** – a second prompt, a second calibration, and a second thing to keep in sync, to save less than the deterministic gates already do.

## Impact

- Positive: model spend scales with _new_ candidates rather than total candidates, so repeated scans get cheaper rather than costing the same each time.
- Negative/Risks: a badly chosen blocklist entry silently hides a source of opportunities. Mitigated by reporting per-rule counts on every scan.

## Links

- Code/Docs: `pipeline/gate.ts`
- Related ADRs: [ADR-003](./003-model-scores-components-code-ranks.md)
