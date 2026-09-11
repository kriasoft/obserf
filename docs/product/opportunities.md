# What Counts As An Opportunity

A **free marketing opportunity** is a public moment where mentioning the project is useful to the reader, permitted by the venue, and costs nothing but the time to write it.

All three conditions are load-bearing. Drop _useful_ and you have spam. Drop _permitted_ and you have a ban. Drop _free_ and it is an ads budget, which is a different tool.

Because they are prerequisites rather than preferences, each maps to a hard zero in scoring rather than a weighted term: `relevance: 0`, `welcome: 0`, and `disqualified` (which covers paid placements) each end the matter on their own. See [Scoring](./scoring.md).

**Obserf establishes one of the three, and rejects on the other two.** Whether a mention would be useful to the reader is legible in the thread itself, and that is what `relevance` and `intent` judge.

Permission and cost are different: both are facts about the venue's rules, and the model has no tools, so it cannot open a subreddit's sidebar or a directory's submission page. It rejects what the evidence shows — a venue that forbids promotion is `welcome: 0`, a listing that charges for placement is disqualified, and `venueGuidance` carries rules the operator has verified themselves. It cannot do the reverse. Silence in a search snippet is not evidence that promotion is allowed or that submission is free, and the rubric does not read it as either: an unevidenced venue sits in the middle of the `welcome` scale rather than at the top.

So what reaches the inbox is **not known to be forbidden and not known to cost money** — which is a weaker claim than permitted and free, and deliberately so. Establishing both is the operator's step, in the venue, before posting: read the rules, and check what a submission actually requires. It is one of the reasons Obserf never posts ([ADR-005](../adr/005-obserf-drafts-humans-post.md)).

The CLI and inbox show a venue reminder with every new or stored draft: the profile's verified `venueGuidance` rule to recheck; a warning that no rule was recorded and permission and cost remain unconfirmed; or a warning that the profile is gone and its guidance is unreadable. The drafter receives the exact venue's rule too. The reminder reflects the loaded profile, not the rule used when a stored draft was written. The inbox loads profiles at startup, so restart it after editing guidance.

There is a fourth condition implied by "public moment", and it is the one easiest to miss: **there has to be a way in.** Relevant content is not an opportunity unless there is an evident, free, public way for the maintainer to participate — a comment or reply, a submission or pull request, or another explicitly invited mechanism. A listicle with no comments, an immutable blog post, a closed thread, or a directory whose only route is a sales email are things to read, not places to act. The assessment rubric disqualifies a candidate where no such path is in evidence.

## The taxonomy

Obserf classifies each opportunity into one of these types. The type drives what a draft looks like — `defaultKindFor` in `vocabulary.ts` maps it to a comment, a reply, or a submission — so the list is deliberately short: a type that does not change the draft is not worth distinguishing.

A comment URL normally outranks the opportunity type because it decides where the text goes: the draft replies to that person rather than becoming a top-level comment detached from the remark that made the finding useful. A `listing` remains a submission, because its destination is the list itself.

| Type | Shape | Example |
| --- | --- | --- |
| `question` | Someone is stuck and the project is a genuine answer | "What do people use to tail and filter JSON logs locally?" |
| `discussion` | An active thread on the project's subject where a comment adds something | HN thread on debugging production incidents |
| `comparison` | A post or thread listing alternatives that omits the project, **and** a way to respond to it | A "Top 10 log viewers" post with an open comment section |
| `listing` | A curated index accepting submissions | `awesome-cli-tools`, a dev-tool directory |
| `mention` | Someone already referenced the project and a reply is owed | A thread that got a detail wrong, where a correction can be posted |

## What does not count

These look like opportunities to a keyword search and are not. They are the main thing the assessment step exists to reject.

**Venues where self-promotion is against the rules.** Most subreddits, many forums. A model that cannot tell these apart will confidently generate a ban. This is why `welcome` is a hard gate rather than one weighted term among several — see [Scoring](./scoring.md).

**Threads that are over.** A question answered and accepted two years ago is not a place to add a link. Freshness multiplies the whole score for this reason.

**SEO filler.** Content-marketing listicles with no comments, no audience, and no way to contribute. High keyword match, zero reach.

**Places where the project genuinely does not fit.** The most expensive failure mode is a plausible-looking mention that is wrong on the merits — it costs credibility rather than just time. Every project profile carries a `notFor` list precisely to make the model reject its own best guess.

**Anything that costs money.** A paid listing, a sponsorship, a "featured" placement, a paid review. These can score well on every other dimension, which is exactly why _free_ has to be an eligibility check rather than something the ranking weighs.

**Relevant content with nowhere to reply.** See above — this is the condition that a keyword search cannot see at all, because the page looks identical either way.

## The standard a draft has to meet

A draft is written to be posted as-is by someone who is not hiding what they are. Three rules, enforced in the drafting prompt:

- **Answer first, mention second.** If the comment is not useful with the link removed, it is not useful with it.
- **Disclose the affiliation.** "I maintain X" costs one clause and is the difference between a contribution and an ad.
- **No enthusiasm the project has not earned.** Read as a peer's recommendation, not as copy.

See [ADR-005](../adr/005-obserf-drafts-humans-post.md) for why obserf stops at the draft.
