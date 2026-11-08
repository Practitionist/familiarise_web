# Sidecars become migrations

Today the CHECK constraints, triggers, partial indexes and views live in
`prisma/sql/*.sql` and are replayed by `npm run db:sidecars` after every
`db push` (`this-repo.md`). After the cutover (`runbook-cutover.md`) `db push`
is gone, and these objects change only through Prisma migrations. This reference
says how. The migration mechanics are in `prisma-mechanics.md`.

## Rules

1. **Every change is a new, idempotent migration.** Never edit an applied one.
   For a constraint: `ALTER TABLE ... DROP CONSTRAINT IF EXISTS "<name>"`, then
   `ADD CONSTRAINT`. For a constraint that must validate existing rows: add it
   `NOT VALID` first, then `VALIDATE CONSTRAINT` (the repo already does this for
   `occurrence_confirmed_requires_consultant_chk`). For a trigger: `DROP TRIGGER
IF EXISTS`, then `CREATE TRIGGER`. For a function: `CREATE OR REPLACE`.
2. **One object per file.** The reported per-statement commit
   (`prisma-mechanics.md`, concurrent index section) means a failed multi-object
   file can leave some objects applied. One object per migration makes a failure
   cheap to resolve.
3. **Views that pin columns are dropped and recreated in the same migration as any
   change to a column they read.** The `demand` view in
   `prisma/sql/analytics-views.sql` reads waitlist and slot-interest columns, and
   its header notes that a retyped column fails until `DROP VIEW "demand"`. A
   migration that retypes such a column must `DROP VIEW IF EXISTS "demand"`, change
   the column, then recreate the view and its `REVOKE`.
4. **Views need hand-written SQL.** Prisma Migrate does not create views, so
   generate the migration with `--create-only` and write the SQL by hand
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

`scripts/ci/check-db-sidecars.ts` reads object names from the SQL files using
`scripts/db/sidecar-objects.ts` and asserts each exists in the live catalog. After
the cutover the SQL files stop being replayed, but the assertion stays as the
post-deploy check (`ci-migrations.md`). Its input then needs a decision, because
migration folders are not the same shape as `prisma/sql/*.sql`: either keep the
files as the declared inventory and make each migration update them, or teach the
parser to read migrations. That decision is open and is part of the cutover work.

## Sources

- [Views](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/views) and [unsupported database features](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/unsupported-database-features).
- [Prisma config reference](https://www.prisma.io/docs/orm/reference/prisma-config-reference) — `tables.external`, `enums.external`.
