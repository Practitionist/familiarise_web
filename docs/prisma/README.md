# Prisma and database schema documentation

This directory holds everything about the database schema: the general reference
for Prisma Migrate, the two runbooks that take this database from its current
`db push` posture to versioned migrations, the record of the Prisma 6 to 7
upgrade, and the model-by-model map of the schema itself.

Start here rather than in an individual file, because which document applies
depends on whether you are reasoning generally or working in this repository.

The numeric prefixes are reading order, following the convention used elsewhere
under `docs/`. They run from orientation through general reference to the two
runbooks in the order those runbooks actually execute — the reset finalises the
schema, and the cutover then puts it under versioned migrations — with the
completed Prisma 7 upgrade last because it is history rather than instruction.

| Document               | What it is                                                                                                                                                                                                       | Read it when                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `00-schema-map.md`     | Twenty-four domain diagrams of the Prisma schema, plus the enum reference table.                                                                                                                                 | Orienting in an unfamiliar part of the schema, or tracing how two models relate.             |
| `01-migrations-guide.md` | The general-purpose reference for Prisma Migrate — every command, safe and dangerous operations, expand and contract, drift, rollback, troubleshooting. Written against a fictional schema so it stays portable. | You need to know what a Prisma command does, or how a class of change is handled in general. |

## The one thing to know first

This repository does not use versioned migrations yet. There is no
`prisma/migrations` directory, no `_prisma_migrations` table, and nothing for
`prisma migrate deploy` to apply. The schema is managed with `prisma db push`,
and the constraints and triggers that `db push` cannot express are applied
separately from `prisma/sql/` and asserted by `npm run db:assert-sidecars`.

That means `01-migrations-guide.md` describes the world this repository is moving
towards rather than the one it is in. Its command reference and its treatment of
safe and dangerous operations apply in full; its workflow chapters apply after
the cutover.

Because one Postgres project serves both development and production, every push,
seed and data script is a production operation. The current schema is also
frozen: additive changes only, with renames, drops and type changes deferred to
launch cutover. Both rules are stated at the top of `prisma/schema.prisma` and
enforced in review.

## Related material

The portable doctrine behind all of this — the change catalog with lock classes,
the expand and contract playbooks, the deploy ordering rules — is the `/schema`
skill in `.claude/skills/schema/`. Its `references/this-repo.md` is the short
version of this page for an agent that is about to edit the schema.

Keeping the seed suite in sync with a schema change is covered by the
`/maintenance` skill. The money invariants that the sidecars enforce, and why
they cannot live in the Prisma schema, are covered by `/finance`.

---

## Deprecated & Superseded Approaches

- **Two-copy SQL sidecar duplication (`apply-sidecars.ts` inline regex arrays + `prisma/sql/*.sql`)**: Previously, sidecar constraint names were hardcoded in multiple verification scripts while SQL definitions lived in `prisma/sql/*.sql`. Superseded by a single parser (`scripts/db/sidecar-objects.ts`) that derives all expected `CHECK` constraints, partial unique indexes, exclusion constraints, and triggers directly from `prisma/sql/*.sql`.
- **Live-DB CI drift blocking feature PRs**: Running `check-db-drift.ts` against the shared live database inside PR checks blocked unmerged schema/auth PRs whenever a branch added an enum label or column not yet pushed to live Postgres. Superseded by running `prisma db push` + `apply-sidecars.ts` + `check-db-drift.ts` against a hermetic `postgres:17` service container in `ci.yaml` on PRs, while keeping `.github/workflows/db-live-drift.yml` as a read-only live-DB monitor on `dev`/cron.
- **One-off constraint swap & migration logs (`scripts/db/swap-occurrence-overlap-constraint.ts`, `02-pre-mvp-reset-runbook.md`, `03-cutover-to-migrations.md`, `04-prisma-7-migration.md`)**: Retired after the Prisma 7 adapter cutover (`@prisma/adapter-pg` in `lib/prisma.ts`) and `slot_no_confirmed_overlap` GiST constraint were finalized in `prisma/sql/slot-exclusion.sql`. Do not recreate standalone migration scripts outside `prisma/sql/*.sql`.
