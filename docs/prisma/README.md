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

| Document                 | What it is                                                                                                                                                                                                       | Read it when                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `00-schema-map.md`       | Twenty-four domain diagrams of the Prisma schema, plus the enum reference table.                                                                                                                                 | Orienting in an unfamiliar part of the schema, or tracing how two models relate.             |
| `01-migrations-guide.md` | The general-purpose reference for Prisma Migrate — every command, safe and dangerous operations, expand and contract, drift, rollback, troubleshooting. Written against a fictional schema so it stays portable. | You need to know what a Prisma command does, or how a class of change is handled in general. |

## The one thing to know first

This repository does not use versioned migrations yet. There is no
`prisma/migrations` directory, no `_prisma_migrations` table, and nothing for
`prisma migrate deploy` to apply. The schema is managed with `prisma db push`,
and the constraints and triggers that `db push` cannot express are applied
separately from `prisma/sql/` and asserted by `scripts/ci/check-db-sidecars.ts`.

That means `01-migrations-guide.md` describes the world this repository is moving
towards rather than the one it is in. Its command reference and its treatment of
safe and dangerous operations apply in full; its workflow chapters apply after
the cutover.

Because one Postgres project serves both development and production, every push,
seed and data script is a production operation. The current schema is also
frozen: additive changes only, with renames, drops and type changes deferred to
launch cutover. Both rules are stated at the top of `prisma/schema.prisma` and
enforced in review.

## Pushing schema to the shared database: lessons from the catch-up push

The live database once fell several changes behind `prisma/schema.prisma` and stayed there for days: a whole earlier schema change (new columns, foreign-key `Restrict` swaps, partial uniques, a CHECK) was merged but never pushed, and production readers that selected a missing column returned 500. The catch-up push of 2026-10-09 closed it, and its lessons now bind every push.

1. **The order is fixed: preflight, push, sidecars, assert.** `npm run db:preflight -- --print` shows the plan Prisma is about to run, `db:push:schema` chains the preflight ahead of `prisma db push` and then applies the sidecars, and `npm run db:push` finishes by running `scripts/ci/check-db-sidecars.ts`, which confirms every named sidecar object exists. A plain `prisma db push` skips all of this and drops the sidecar partial uniques, because the schema omits them by design. These are human-run commands; an agent never runs them.
2. **Prisma's own AI-consent guard is a feature.** The Prisma CLI detects that it is being driven by an AI agent and refuses destructive actions unless the human explicitly consents to that specific action. Do not work around it: the destructive statements (dropped columns, foreign-key swaps, unique replacements) are exactly the ones a person must read and approve.
3. **Destructive statements are allowlisted per push, then removed.** The preflight refuses any plan statement that destroys or re-points an existing object unless that exact statement is listed in `prisma/sql/known-drift.json` under `destructiveStatementsAllowed` with an owner and expiry. After the push the list is emptied again, so a populated list always means a push is pending.
4. **Check drift read-only before and after.** `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` lists what a push would do. After a clean push the only statements left are the three sidecar-owned partial-unique drops (`appointment_feedback_level_key`, `consultant_earnings_occurrence_key`, `organization_earnings_split_key`), which are expected.
5. **The daily drift check needs a sink outside Sentry.** `db-live-drift.yml` compares the live database to the schema every day, but a failure that can reach only Sentry is silently dropped when the error quota is exhausted. See [the ingest canary](../observability/sentry/06-ingest-canary.md#the-scheduled-drift-check-needs-a-sink-outside-sentry).
6. **Pending schema in a merged PR breaks readers invisibly.** A column the code selects but the database lacks fails every full-row read of that model (a `P2022`), and nothing in `tsc` or the unit tests sees it. Push before, or together with, the deploy that reads the column, and smoke-test one full-row reader of each changed model.

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
