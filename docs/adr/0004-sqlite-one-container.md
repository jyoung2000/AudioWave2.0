# ADR-0004: SQLite (WAL) in one container; repository layer keeps PostgreSQL possible

**Status:** accepted · **Date:** 2026-09-03

## Context
The hub must start with one Compose command and persist everything under `/data`. The discovery-engine specification suggests PostgreSQL/Redis, which would weaken the one-container default.

## Decision
`better-sqlite3` in WAL mode with numbered SQL migrations, `schema_migrations`, pre-migration backups, and a repository layer per aggregate. Job queues (downloads, transfers, discovery), the discovery cache and the realtime replay log live in SQLite tables. The rate-limit manager and metrics are in-process with periodic persistence.

## Consequences
- Zero external services; backup is a file copy via `db.backup()`.
- A PostgreSQL adapter can be added behind the repository interfaces without touching services; Redis is unnecessary at the suite's scale.
- Concurrency is bounded by SQLite's single writer; writes are short transactions and the job workers use bounded concurrency.
