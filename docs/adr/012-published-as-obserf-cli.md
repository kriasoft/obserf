# ADR-012 Published as `@obserf/cli`, One Package

- **Status:** Accepted
- **Date:** 2026-09-11
- **Tags:** packaging, naming

## Problem

The package had to be published before anyone could install it, and the obvious name was not available. `obserf` is unregistered on npm, but npm refuses to publish it: the registry's similarity filter rejects unscoped names within a short edit distance of an existing package, and `bser` — watchman's binary serialization codec — is close enough. The filter applies only to unscoped names, and it cannot be tested without attempting a publish, since `npm view` reports an unregistered-but-refused name exactly as it reports a free one.

That forced two decisions at once: what the published name is, and whether the CLI and the configuration API a workspace imports are one package or several.

## Decision

**One package, published as `@obserf/cli`, with `bin: obserf`.** The command an operator types is unchanged; only the install coordinate carries the scope.

The scope is the brand rather than the publisher — `@obserf`, not `@kriasoft` — so the npm namespace travels with `obserf.com` rather than with whoever publishes it.

`cli` rather than `engine`, despite `engine` being this repository's own word for the shipped half (ADR-010, ADR-011). That word is accurate internally and misleading externally: in npm convention `@scope/engine` promises an embeddable runtime, which is precisely the surface `index.ts` refuses to expose. `cli` names what a user installs and runs. The configuration helpers are exported from it directly — `import { defineProject } from "@obserf/cli"` — following `drizzle-kit`, `vite` and `astro`, where a config helper comes from the tool's own package. A `@obserf/cli/config` subpath would buy a shade of precision at the cost of a second export path for two functions.

**One package, because there is no independent consumer.** `defineProject` and `defineConfig` exist solely to configure the runtime the same user is installing; a profile is inert without the engine that reads it. Splitting would partition `drizzle`, the Agent SDK and React across packages that must always be at the same version — the engine owns the schema and carries the migrations (ADR-011), so a workspace holding a CLI and a library one minor apart applies migrations that the other half does not expect, against the triage decisions and notes no rescan can rebuild. Two packages pinned to each other are one package with more publishes.

## Alternatives (brief)

- **Rename the product** to something with a free unscoped name – the npm coordinate is one field; the brand is `obserf.com`, the workspace marker, `OBSERF_HOME`, and the command itself. Short pronounceable `.com` domains are near-exhausted, so a rename trades an owned exact-match domain for an abundant npm string.
- **`@kriasoft/obserf`** – correct and available, but subordinates the product to the publisher and strands the brand's own npm scope.
- **`@obserf/engine`** – matches this repository's vocabulary and overpromises a programmatic API that `index.ts` deliberately withholds.
- **`@obserf/sdk`** – implies a service to be a client for. There is none.
- **`@obserf/monitor`** – wrong twice: obserf scans when asked rather than watching continuously, and the word places it in the observability category it is not in.
- **Split into `@obserf/cli` plus a config package** – a boundary with no product boundary behind it. Revisit when a real second consumer exists: a third party publishing source adapters, or a host embedding the pipeline without the CLI.

## Impact

- Positive: the published name is available without a rename, and `@obserf` remains open for a second package if one is ever earned.
- Positive: `bin: obserf` keeps every documented command identical, so the scope appears only at install and import.
- Negative/Risks: scoped packages default to restricted, so `publishConfig.access` is load-bearing — without it the first publish is private.
- Negative/Risks: `bunx @obserf/cli init` is longer than `bunx obserf init`, and the scope recurs in install instructions and dependency declarations. It buys back nothing at runtime.
