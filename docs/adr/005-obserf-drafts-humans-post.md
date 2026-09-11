# ADR-005 Obserf Drafts, Humans Post

- **Status:** Accepted
- **Date:** 2026-09-09
- **Tags:** product, safety

## Problem

The pipeline ends one API call short of posting the comment itself. That call would remove the last manual step, and it is the step the whole tool exists to support.

## Decision

Obserf writes drafts. It never posts, submits, opens a pull request, or otherwise performs a venue write. No posting operation exists in the system, which makes the boundary structural — a missing code path rather than a policy a future flag can relax.

It is not a credential boundary, and the distinction matters. `sources/github.ts` borrows `GITHUB_TOKEN` or the operator's `gh` token for search without constraining its scopes, so a credential obserf holds may well be capable of writing. What guarantees obserf does not write is that nothing in obserf asks it to.

The asymmetry decides it. A missed opportunity costs one comment nobody read. A wrong comment — posted into a thread the model misread, or a venue that bans self-promotion — costs the project's standing in the exact community it was trying to reach, permanently and publicly, under the maintainer's own name. The upside is bounded and the downside is not.

The same reasoning shapes the drafts. Every draft must be useful with the link removed, and must disclose the affiliation in the operator's own voice, because a draft that only works when nobody notices who wrote it is one the operator should not be posting either.

## Alternatives (brief)

- **Auto-post above a score threshold** – the threshold is a guess, the scores are uncalibrated, and the failure is public and unrecoverable. Revisit only with outcome data, and probably not then.
- **Auto-post to venues that explicitly invite it** (`awesome-list` PRs) – the narrowest version, and still wrong: a submission is a maintainer's first impression of the project, and it is cheap to press the button yourself.
- **Queue posts for one-click approval** – the click is not the cost. Reading the thread is, and that reading is exactly what must not be skipped.

## Impact

- Positive: no posting path to audit, misconfigure, or trigger accidentally; no class of failure where obserf embarrasses the operator unattended; drafting can be aggressive because a human reads every one.
- Negative/Risks: the loop needs a person, so it does not scale past the attention of one operator. That is the intended scale. And the guarantee rests on obserf's code, not on its credentials — the borrowed `gh` token is unconstrained, so narrowing it to read-only scopes is worth doing and is the operator's to do.

## Links

- Code/Docs: `pipeline/draft.ts`, [What Counts As An Opportunity](../product/opportunities.md)
- Related ADRs: [ADR-001](./001-local-first-sqlite.md)
