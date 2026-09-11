# ADR-011 The Engine Owns The Database's Schema

- **Status:** Accepted
- **Date:** 2026-09-10
- **Tags:** database, distribution, dx

## Problem

`db/schema.ts` described the schema and `drizzle-kit push` synced a database to it. There were no migration files, deliberately — a decision that was never written down as an ADR because at the time it was not one: for a single operator with a single file, a diff computed against the live database was simpler than a history to keep in step, and a snapshot before every push made a bad one recoverable.

[ADR-010](010-engine-and-workspace.md) moved the database out of the repository and made the engine a package. That broke the premise. `obserf init` created a workspace and then printed _"next, from this obserf checkout: `OBSERF_HOME=… bun run db:push`"_ — so a workspace was not usable without a source checkout and a development dependency, which is not a thing an installed application may require. Worse is the second version: someone on Obserf 0.2 runs `bun update`, gets 0.3, and nothing in what they installed knows how to bring their database along. Their findings can be rescanned; their triage decisions, notes and drafts cannot.

## Decision

The installed engine owns the database's whole lifecycle.

- `bun run db:generate` renders a change to `db/schema.ts` into a numbered SQL file under `drizzle/`. It is a maintainer command; the generated files are committed and ship with the package.
- `db/migrate.ts` applies whatever is pending every time the database is opened for writing. Opening one that does not exist creates it, so `obserf init` then `obserf scan` is the entire setup.
- `drizzle-kit push` is gone rather than kept for development. Two mechanisms would let a maintainer's database drift off the history that every shipped database follows, and the drift would surface as a migration that works locally and fails everywhere else.

The runtime needs guarantees drizzle-orm's own migrator does not provide, which is why `db/migrate.ts` is its own small apply loop rather than a call to it:

- **The decision to apply is made inside the lock.** Drizzle reads the applied list before opening its transaction, so two Obserf processes starting together can both decide to apply. `migrate.ts` reads once outside to decide whether to snapshot at all, then re-reads inside `BEGIN EXCLUSIVE` to decide what to run.
- **Nothing is written until the database is known to be Obserf's.** `OBSERF_DB` can name any file, so the migration table is created only inside the lock, after establishing that the database is either already Obserf's or has no tables at all — and `journal_mode` stays untouched until then, because switching a rejected database to WAL is a permanent change to a file the program was told to leave alone.
- **A migration is identified by its content, not its name.** Each applied migration is recorded with the SHA-256 of the SQL that was applied, and the recorded set must be exactly a prefix of the shipped history — a gap would otherwise be filled by running the missing migration _after_ the ones that follow it. Two databases both recording `0001_change.sql` can hold different schemas if that file was ever edited or regenerated — the names line up, so the migrator declares the work done and the mismatch surfaces later as a query failure, or as no failure at all. The documentation says a published migration is immutable; the hash is what makes that enforceable. `.gitattributes` pins `*.sql` to LF so that a checkout cannot change those bytes on its own.
- **A database from a newer Obserf is refused.** Carrying migrations the running engine does not ship means its schema is ahead of the code about to write through it. Drizzle ignores that; writing anyway corrupts quietly, which is the one failure mode worth an error over.
- **A snapshot precedes the first migration applied to a database that has data**, and its path is printed. Migrations are forward-only; the way back from one that did the wrong thing is the state before it. It is taken before the lock, because `VACUUM INTO` needs its own read of the file, so it holds the state from just before the upgrade _began_ rather than the last byte committed before the first migration statement — a write from another process in that window would not be in it. That is why the answer to a concurrent writer is to stop it, not to coordinate with it.
- **Foreign keys are disabled around the transaction, not inside it.** SQLite ignores `PRAGMA foreign_keys` within a transaction, and drizzle-kit renders most schema changes as a table rebuild that drops the original — so a rebuild of `findings` applied with enforcement on cascades away every assessment, draft and triage row that referenced it, then restores the findings, leaving no error behind. `PRAGMA foreign_key_check` before the commit replaces the enforcement that was turned off.

`OBSERF_DB` keeps its old guarantee: a path given explicitly must already exist. You set it to reach a database you have, so a typo has to fail rather than quietly become an empty second one. Only the workspace's own `.obserf/obserf.db` is created on demand.

## Alternatives (brief)

- **Keep `push`, tell users to install drizzle-kit** – exposes an internal file layout as the upgrade interface and makes a development tool part of every install.
- **`CREATE TABLE IF NOT EXISTS` at startup** – handles creation and nothing else. The first changed column reinvents migrations, badly and after data exists.
- **drizzle-orm's `migrate()`** – none of the guarantees above, and the runtime would depend on drizzle-kit's journal format rather than on filenames.
- **Ship no upgrade path and version the workspace out of compatibility** – makes every release a manual data migration for the operator, which is the work this exists to avoid.

Generating the migration is a separate maintainer step, so `bun test` compares a freshly migrated database with what `db/schema.ts` declares — tables, columns and types, nullability, primary keys, indexes with their key columns, and foreign keys — in both directions. A forgotten `db:generate` then fails before release rather than quietly at a user: a declared column no migration creates was measured reading back as its own name, a truthy string, until the first write failed. Key columns matter as much as index names: `findings_project_url` being unique over `project` and `url` is what makes one snapshot per project-and-url true ([ADR-002](002-evidence-judgment-decision.md)). Foreign keys need an explicit comparison because a rebuild that drops one leaves `PRAGMA foreign_key_check` no constraint to check.

## Impact

- Positive: `bunx @obserf/cli init` produces a workspace that works, with no checkout and no drizzle-kit. Upgrading the package upgrades the database. The maintainer's database follows the same history as everyone else's.
- Negative/Risks: the migration files are load-bearing bytes, not just text — editing a published one is a hard failure by design, and anything that rewrites them in transit (line-ending normalization, a patch tool) breaks databases that already applied them. Migrations are forward-only and applied automatically, so a generated file has to be read before it is committed — drizzle-kit renders a column rename as a drop and an add unless told otherwise, and a shipped destructive migration reaches operator data that no rescan rebuilds. Snapshots are the only rollback. Regenerating `drizzle/` from scratch rewrites history that shipped databases have already applied. A long-running `obserf serve` holds a connection opened against the schema it started with, and no lock protects it from another process upgrading underneath; stop it before upgrading.

## Links

- Code/Docs: `db/migrate.ts`, `db/backup.ts`, `drizzle/`, [Architecture](../architecture.md)
- Related ADRs: [ADR-001](001-local-first-sqlite.md), [ADR-010](010-engine-and-workspace.md)
