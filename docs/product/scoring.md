# Scoring

Every assessed finding gets a score from 0 to 100. The model does not produce that number. It produces four judgments; code turns them into the number. See [ADR-003](../adr/003-model-scores-components-code-ranks.md) for why.

## The four components

The model rates each on an integer scale of 0–5, and must give a one-sentence reason for the overall verdict.

| Component | Question it answers | A 5 looks like | A 0 looks like |
| --- | --- | --- | --- |
| `relevance` | Is this actually about the problem the project solves? | Someone describing the exact problem in their own words | The keyword appears; the subject does not |
| `intent` | Is someone looking for a solution now? | "What should I use for X?", unanswered | A retrospective essay with no open question |
| `welcome` | Would a mention be welcome here, under this venue's norms? | An invitation _and_ a venue where maintainers answering is established practice | A subreddit that bans self-promotion |
| `reach` | Will anyone actually read it? | Front-page HN thread, active subreddit | A dead comment on a dead blog |

`reach` is judged at the place a reply would actually appear, not at the platform. Where a finding is one comment inside a thread, a reply sits under that comment and is read by a fraction of the thread's audience however large the thread is. When the source reports no engagement for that comment, silence is not evidence of a wide readership. See [Sources](./sources.md) on `isThreadComment`.

## The formula

```
relevance == 0               → score 0   (not useful)
welcome == 0                 → score 0   (not permitted)
disqualified                 → score 0   (categorically ineligible: notFor, paid, no way in)

weighted  = 0.35·relevance + 0.30·intent + 0.20·welcome + 0.15·reach   (each /5)
freshness = 0.5 ^ (ageInDays / 30)   floor 0.15   —   listings: always 1
score     = round(100 · weighted · freshness)
```

Four properties of this shape are deliberate.

**The three hard zeros are the product's three conditions.** Useful, permitted, and free are prerequisites, not preferences ([Opportunities](./opportunities.md)), so each ends the matter on its own rather than trading against the others. Without the `relevance` gate, relevance is only 0.35 of the weighted total, so a candidate the model calls completely unrelated still reaches 65 when intent, welcome, and reach are maximal — arithmetic that contradicts the product definition.

**`welcome` is both a gate and a term.** Zero means "a mention here is spam" and no amount of relevance rescues it. Above zero it still contributes, because a venue that merely tolerates self-promotion is worth less than one that invites it.

Permission must be grounded in supplied evidence. The model has no tools: it receives candidate text, engagement or repository facts when available, and any verified `venueGuidance` from the profile. It cannot fetch the venue’s rules itself. An unqualified "5 = an explicit request for recommendations" let it turn a guess into the score that clears the hard gate. Permission is a prerequisite for an opportunity, not a preference ([Opportunities](./opportunities.md)), so the rubric now caps an unevidenced venue at 3 and requires the `reason` to name what made a 4 or 5 permitted. Most findings should sit at 3; that is the intended shape, not a calibration failure.

**Freshness multiplies rather than adds, and listings are exempt.** A stale thread is not a good opportunity with a penalty; it is worth less on every dimension at once, because nobody is reading it any more. The 30-day half-life means a year-old thread scores a fraction of its fresh value.

Listings do not decay at all. A curated list is the opposite of a thread: an eight-year-old `awesome-*` repository merging pull requests this week is a live opportunity, and its publication date says nothing about whether it accepts submissions today. The 0.15 floor was originally there to stop evergreen listings vanishing — a single curve compensating for two opposite lifecycles. Exempting `listing` addresses the mismatch directly; the floor stays for everything else.

**Weights favour fit over audience size.** `relevance` and `intent` together are 65%. A small thread where the project is the right answer beats a large one where it is merely on-topic, which is the judgment a human would make and the one a naive "reach" ranking gets wrong.

## Tuning

The weights live in one constant in `pipeline/score.ts`. After changing them, run `obserf rescore` to recompute stored scores from the saved components without model calls. The score column caches the arithmetic; changing the weights alone does not update it. Whether the new weights actually improved the inbox is a separate question with its own procedure — and one trap, since `rescore` scores against the current clock, so a baseline saved earlier decays against a ranking recomputed today. See [Evaluation](./evaluation.md).

Re-assessment consumes model quota. On rediscovery, a known finding can pass the gate when its title, excerpt, or engagement has materially changed or its reassessment interval has passed; dismissed and acted-on findings remain settled ([ADR-002](../adr/002-evidence-judgment-decision.md)). The other gates still apply. Repository stars and pull-request activity do not trigger this change detection: stars are separate from discussion engagement, and PR activity is fetched only after the gate. A change in merge behavior alone therefore waits for the cooldown to expire and the repository to be rediscovered and pass the other gates.

Assessments record `model` and a `promptFingerprint` hashed from the exact system prompt that produced them for provenance; the fingerprint does not affect gating. An unchanged candidate the model disqualified waits `reassessDisqualifiedAfterDays` (30 days by default) rather than the ordinary interval before becoming eligible for reassessment on rediscovery. Material changes bypass either cooldown; the other gates still apply. See [ADR-004](../adr/004-deterministic-gates-before-the-model.md) for the rationale.
