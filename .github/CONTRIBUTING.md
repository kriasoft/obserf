# Contributing

Obserf is a single-maintainer project, so open an issue before a large change. Small fixes can go straight to a pull request.

Two rules decline most proposals before any review of the code, and [the product overview](../docs/product/overview.md) explains both: Obserf never posts, and an opportunity must be useful, permitted and free.

[AGENTS.md](../AGENTS.md) is the working brief for people and coding agents alike: structure, invariants, and how to verify a change. In short:

- `bun install`, then `bun test`, `bun run typecheck` and `bun run fmt`.
- A change to `db/schema.ts` needs `bun run db:generate` and the SQL it writes. Never edit a committed migration: shipped databases record its hash and refuse an edited one.
- `obserf scan` and `obserf draft` spend your Claude Code quota and call third-party APIs; `scan --dry-run` makes no model calls, SQL writes or migrations, though its source requests still count against those APIs' quotas.
- Commit titles are short and [conventional](https://www.conventionalcommits.org/); the body says why. Pull requests are squash-merged, so the pull request's title and description become the commit.

Nothing personal belongs in this repository: no workspace, profiles or measured results of your own.
