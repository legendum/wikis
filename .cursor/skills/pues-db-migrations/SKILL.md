---
name: pues-db-migrations
description: Evolve a Pues SQLite schema without breaking fresh or existing DBs. Use when adding columns, indexes, or seed data via config/schema.sql or config/migrations/, or when a local DB is missing columns after a schema change.
---
# Pues DB Migrations

## Essential rule

**Migrations are additive to `schema.sql`.** `getDb()` always runs both, in order:

1. `config/schema.sql`
2. `config/migrations/*.sql` (pending files only, recorded in a `migrations` table)

On a **fresh** database, both run. A migration that does `ALTER TABLE … ADD COLUMN foo` must **not** also list `foo` in `schema.sql`'s `CREATE TABLE` for that table — SQLite throws `duplicate column name` and the service won't boot (including every test DB).

## Where each change goes

| Change | Put it in |
|--------|-----------|
| **New table** (table does not exist yet on any shipped DB) | `schema.sql` — `CREATE TABLE IF NOT EXISTS` is fine |
| Table/column that existed from the first ship | `schema.sql` only |
| **New column** on a table that already shipped | `config/migrations/NNN_*.sql` only |
| Index or backfill on an existing table | migration file |
| Idempotent seed data | migration file |

**New tables → `schema.sql` directly.** `CREATE TABLE IF NOT EXISTS` creates the table on every DB that does not have it yet — fresh installs and existing local files alike. No migration needed unless you also need a backfill into that table on old DBs.

**New columns on existing tables → migration only.** `CREATE TABLE IF NOT EXISTS` does *not* reshape a table that already exists, so a column added only to `schema.sql` never lands on old DB files.

**Wrong:** migration `003` adds `position`, and you also add `position` to the `CREATE TABLE` in `schema.sql`.

**Right:** ttys `001_source_container_id.sql` — `source_container_id` lives **only** in the migration, not in `schema.sql`.

Number migrations zero-padded (`001_`, `002_`, …). Lexicographic order is the contract.

## `schema.sql` edits do not upgrade existing *tables*

`CREATE TABLE IF NOT EXISTS` skips tables that already exist — it will not add new columns to them. A column added **only** to `schema.sql` does not appear on `data/*.db` files created earlier.

New **tables** in `schema.sql` are the exception: they are created on first boot after the change, on both fresh and existing DB files.

For a new column on an existing table: add a migration, run the `ALTER` manually once, or delete the DB and restart (fine for dev). Tests use throwaway DBs via `bootTestService` — they pick up schema + migrations on every run.

## Checklist

- [ ] New table → `CREATE TABLE IF NOT EXISTS` in `schema.sql` (no migration required).
- [ ] New column on a table that already shipped → **only** a numbered migration.
- [ ] That column is **not** duplicated in `schema.sql`'s `CREATE TABLE`.
- [ ] `bun test` passes (fresh DBs exercise the full schema → migrations path).
