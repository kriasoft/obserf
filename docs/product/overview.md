# Overview

Obserf watches the public web for places where a project can be mentioned usefully and for free, ranks them, and drafts what to say. It is a single-operator tool: one person maintains a handful of projects and wants the ten minutes a day they spend on marketing pointed at the right ten links.

The problem it solves is not discovery — a search box already finds threads about whatever a project does. It is triage. A useful query returns hundreds of results, of which a handful are threads where a link would genuinely help someone and be welcome, and the rest are competitors' blog spam, dead threads, and venues where self-promotion is against the rules. Reading all of them costs more time than the opportunities are worth, so in practice nobody reads any of them.

Obserf's job is to make that reading cheap enough to actually happen.

## The loop

1. **Discover.** Each source adapter runs the project's queries and returns candidates — a URL, a title, an excerpt, a venue, a date.
2. **Gate.** Deterministic filters drop what is obviously not worth a model call, in the order they are applied: a duplicate of this scan, one dismissed or acted on, a blocked domain, too old, too little text, one unchanged and recently assessed, one unchanged that the model disqualified less than a month ago. See [ADR-004](../adr/004-deterministic-gates-before-the-model.md).
3. **Enrich.** Adapters that can add facts too expensive to fetch for every search result do so, for survivors only — GitHub measures a curated list's recent pull-request outcomes and its backlog. See [ADR-009](../adr/009-expensive-evidence-after-the-gate.md).
4. **Assess.** A model scores each survivor on four components and says whether a mention would be welcome. Code turns those components into a rank. See [Scoring](./scoring.md).
5. **Triage.** The operator reads the ranked list — in the terminal or the local review inbox — and shortlists or dismisses.
6. **Draft.** For a shortlisted opportunity, obserf writes the comment, reply, or submission. The operator edits and posts it themselves. Obserf never posts. See [ADR-005](../adr/005-obserf-drafts-humans-post.md).

Steps 1–4 are automatic and can run on a schedule. Steps 5–6 are the operator's, and are the point: the tool exists to make a human's judgment cheaper to apply, not to replace it.

## Who it is for

One operator, several projects. Obserf ships pointed at none — profiles live in the operator's own workspace ([ADR-010](../adr/010-engine-and-workspace.md)).

A project is worth a profile when you can name where its audience already talks: the subreddits, the kind of Hacker News thread, the `awesome-*` lists it would belong on. If that answer is "everywhere" or "I'm not sure", the queries will be too broad to gate and the model will spend its calls on pages nobody with the problem reads. Writing the profile is where that thinking happens, which is why `pitch`, `solves` and `notFor` are prose rather than fields.

Adding a project means one more file under `projects/` in the workspace; there is nothing to register.

## What it is not

**Not an analytics or rank tracker.** Obserf looks outward for places to participate, not inward at how existing content performs.

**Not an autoposter.** The value is in the judgment, and a tool that posts unattended converts a marketing asset into a reputation liability the first time it misreads a thread.

**Not a CRM or outreach sequencer.** There is no contact record, no follow-up cadence, no pipeline. An opportunity is a link and a moment; once it is acted on or stale, it is done.

**Not multi-tenant.** One SQLite file on one laptop. See [ADR-001](../adr/001-local-first-sqlite.md).
