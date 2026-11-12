# Sidecars become migrations

The CHECK constraints, triggers, partial indexes, views and row-level-security flags
live in the hand-written migrations after `0_baseline` (`this-repo.md` lists them), and
they change only through new migrations. This reference says how. The migration
mechanics are in `prisma-mechanics.md`; the session procedure is
`multi-session-workflow.md`.

## Rules

1. **Every change is a new, idempotent migration, and a replacement is atomic.**
   Never edit an applied one. Because Prisma 7.10.1 commits each statement of an
   unwrapped file on its own (rehearsed 2026-11-09, `multi-session-workflow.md`), a
   `DROP` followed by its replacement must sit inside an explicit `BEGIN;` and
   `COMMIT;` in the migration file. Otherwise a failed `ADD CONSTRAINT` or
   `CREATE TRIGGER` leaves the guard absent, and concurrent writes can pass in the
   gap between the two statements. Prisma's 2022 Migrate announcement describes
   the explicit `BEGIN;` and `COMMIT;` opt-in for PostgreSQL
   ([Migrate DX primitives](https://www.prisma.io/blog/prisma-migrate-dx-primitives)),
   and the rehearsal in `runbook-cutover.md` must confirm it on the pinned
   version.
   - Constraint: `ALTER TABLE ... DROP CONSTRAINT IF EXISTS "<name>"`, then
     `ADD CONSTRAINT`, both inside the transaction. For a constraint that must
     validate existing rows, add it `NOT VALID` inside the transaction, then
     `VALIDATE CONSTRAINT` after `COMMIT` (the repo already does this for
     `occurrence_confirmed_requires_consultant_chk`).
   - Constraint trigger (`ledger_txn_balanced`, `payment_legs_sum_to_amount` and
     the other money backstops): `DROP TRIGGER IF EXISTS`, then
     `CREATE CONSTRAINT TRIGGER`, inside the transaction, because PostgreSQL does
     not support `OR REPLACE` for constraint triggers.
   - Ordinary trigger: `CREATE OR REPLACE TRIGGER`, which replaces it in one
     statement with no gap
     ([CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html)).
   - Function: `CREATE OR REPLACE FUNCTION`.
2. **One object group per file, wrapped.** Inside `BEGIN; … COMMIT;` a failed file
   leaves nothing behind, so a migration may hold one domain's group of objects (as the
   cutover's `*_guards` migrations do). Keep each group small enough that a failure is
   cheap to diagnose.
3. **Views that pin columns are dropped and recreated in the same migration as any
   change to a column they read.** The `demand` view in
   `20261109000018_analytics_views` reads waitlist and slot-interest columns, and
   a retyped column fails until `DROP VIEW "demand"`. A
   migration that retypes such a column must `DROP VIEW IF EXISTS "demand"`, change
   the column, then recreate the view and its `REVOKE`.
4. **Views need hand-written SQL.** Prisma Migrate does not create views, so
   write the SQL by hand into the migration folder
   ([views](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/views)).
5. **Unsupported features go through customised migrations**
   ([unsupported database features](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/unsupported-database-features)).
   That covers triggers, exclusion constraints and CHECKs.

## What Prisma can and cannot ignore

- `prisma.config.ts` has `tables.external` and `enums.external` for objects Prisma
  should leave alone, but nothing equivalent for CHECK constraints or triggers.
  Both are therefore invisible to `migrate diff`, and only `check-db-sidecars.ts`
  sees them.
- Partial indexes can be declared with `where` in the schema, but the schema
  comment near the unique-index notes in `prisma/schema.prisma` records that the
  `partialIndexes` preview was buggy at 7.7.0. The pinned version is 7.10.1, so
  rehearse before adopting it, and until then keep partial indexes in migrations.

## Keep the assertion

`scripts/ci/check-db-sidecars.ts` asserts the inventory that
`scripts/db/sidecar-objects.ts` builds by replaying every migration after the baseline
in order: a `CREATE` adds an object, a later `DROP` or `RENAME` removes or renames it,
so a migration that retires a CHECK needs no other file edited. It runs after every
CI build, after every `db-migrate.yml` deploy and daily against the live database.

## Sources

- [Views](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/views) and [unsupported database features](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/unsupported-database-features).
- [Migrate DX primitives](https://www.prisma.io/blog/prisma-migrate-dx-primitives) — explicit `BEGIN;` and `COMMIT;` on PostgreSQL, and [CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html) — `OR REPLACE` and its constraint-trigger limit.
- [Prisma config reference](https://www.prisma.io/docs/orm/reference/prisma-config-reference) — `tables.external`, `enums.external`.
