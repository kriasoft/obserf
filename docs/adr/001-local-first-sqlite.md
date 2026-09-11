# ADR-001 Obserf Is One SQLite File On One Machine

- **Status:** Accepted
- **Date:** 2026-09-09
- **Tags:** architecture, storage

## Problem

Obserf accumulates findings, model assessments, human decisions, and drafts, and needs them to survive between runs. Every storage choice past a local file also brings a deployment, a connection string, and a second thing to keep running.

## Decision

State is a single SQLite file, `obserf.db` by default, addressed through Drizzle ORM and `bun:sqlite`. There is no server, no auth, and no network dependency for anything except reaching the public web — the source adapters during a scan, `pipeline/draft-context.ts` when a draft is written — and the model calls. The review inbox is `Bun.serve()` bound to localhost, and it trusts whoever can reach it because that is the operator.

The whole database is one file, and inspecting it is `sqlite3 obserf.db`. WAL mode is on, so committed data can be sitting in `obserf.db-wal` — back up with `sqlite3 obserf.db ".backup obserf.backup.db"` rather than `cp`, and reset by removing `obserf.db` together with its `-wal` and `-shm` siblings while nothing is connected.

## Alternatives (brief)

- **Hosted Postgres** – buys concurrent writers, network access, and a real type system, none of which a single-writer CLI on a laptop has a use for. It also puts one person's findings on someone else's server and makes the tool unusable offline.
- **JSON files on disk** – no schema, no indexes, no transactions, and dedupe becomes a full scan. Cheaper only until the first thousand findings.
- **No persistence, re-scan each time** – throws away the human triage decisions, which are the most expensive data in the system.

## Impact

- Positive: zero setup, trivial backup, fast local queries, no credentials for storage.
- Negative/Risks: one machine only. Two laptops means two disconnected databases; syncing is out of scope and the fix, if it ever matters, is to sync the file, not to add a server.

## Links

- Code/Docs: `db/`, `drizzle.config.ts`, [Overview](../product/overview.md)
- Related ADRs: [ADR-002](./002-evidence-judgment-decision.md)
