# ADR-007 Sources Are Adapters Behind One Interface

- **Status:** Accepted
- **Date:** 2026-09-09
- **Tags:** architecture, extensibility

## Problem

Brave, Hacker News, Reddit, and GitHub differ in auth, rate limits, pagination, response shape, and what a "date" means. Left unabstracted, those differences leak into the pipeline and every new source touches the scan code.

## Decision

Every source implements `Source`: an `id`, an `unavailable(project)` check, and a `search(project, options)` returning `Candidate[]`. Normalization to `Candidate` — source URL, title, excerpt, venue, published date, engagement metrics — happens inside the adapter; the gate canonicalizes URLs before deduplication. The pipeline iterates a registry array and knows nothing else.

`unavailable(project)` returns a **reason string or `null`**, not a boolean. A scan that ran three sources instead of four must say why, because "no results" and "no API key" look identical in the output and mean opposite things.

It takes the project because two different things stop a source and both end the same way: credentials it does not have, and usable queries the profile never gave it. An adapter asked for a field a profile left empty — or filled only with blanks — used to iterate nothing and return an empty array, so a project reaching its audience through one source reported the other three as having searched and found nothing — and a profile configuring no queries at all produced a successful, zero-candidate scan. Reporting configuration as retrieval is the same error the reason string exists to prevent, one level down. Configuration is answered before credentials, because a profile that lists no subreddits is not fixed by registering a Reddit app.

Adapters own their own rate limiting, since the limits differ by an order of magnitude and a shared limiter would have to run at the slowest one.

A profile's optional `sources` lists its default adapters; `--source` overrides it, and omitting both selects every registered source. Empty lists and unknown ids fail before discovery. Selected sources run sequentially in registry order. The first snapshot of a URL to reach the gate's history checks owns it for that scan, so specialized adapters precede Brave to favor thread text and engagement over search descriptions. Source selection is measured per project because audiences and retrieval quality differ.

## Alternatives (brief)

- **Call each API directly in the scan command** – fewer files, and every new source edits the pipeline while response-shape details spread into scoring.
- **A plugin system with dynamic loading** – solves distribution, which is not a problem here: adding a source means writing TypeScript in this repository either way.
- **`unavailable(): boolean`** – throws away the only information the operator needs to fix it.

## Impact

- Positive: a new source is one adapter file, one registry line, and one entry in `SOURCE_IDS`; the pipeline is testable against fake sources with no network. The third edit is what lets the compiler reject a typo in a profile's `sources`, and it is deliberately not derived from the registry — `vocabulary.ts` is shared with the browser and may import nothing, which is the constraint that keeps `bun:sqlite` and the Agent SDK out of the inbox bundle.
- Negative/Risks: the `Candidate` shape is a lowest common denominator. Opaque source-specific data stays in `raw`; evidence the pipeline, the model, or the operator actually reads may earn a normalized field instead, as `repository` did ([ADR-009](009-expensive-evidence-after-the-gate.md)). The test is whether something downstream depends on it, not which source produced it — a field nothing reads belongs in `raw`.
- Negative/Risks: a profile that lists `sources` does not pick up a newly registered adapter until someone edits it. Accepted deliberately — the alternative, an exclusion list, adds unmeasured sources to a scan silently, and a source nobody chose is what the field exists to prevent.

## Links

- Code/Docs: `sources/`, [Sources](../product/sources.md)
- Related ADRs: [ADR-006](./006-project-profiles-are-typescript.md)
