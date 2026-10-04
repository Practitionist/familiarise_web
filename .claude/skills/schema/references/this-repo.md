# This repository

Everything else in this skill is portable. This file is not: it records what
this repository actually does, which differs from the generic advice in ways
that matter, and it is the file to read before touching `prisma/schema.prisma`.

## The posture, stated plainly

There is no `prisma/migrations` directory. The schema is managed with
`prisma db push`, which reconciles the database to the schema file and writes no
migration history, and there is therefore no `_prisma_migrations` table, no
baseline, and nothing for `prisma migrate deploy` to apply. This is a deliberate
pre-launch choice rather than an oversight: the data is seed data, a full reset
is scheduled before launch, and versioned migrations over data that is about to
be discarded would be maintenance with no payoff.

Three consequences follow, and they are the reason this file exists.

The first is that **`npm run db:push` is a production operation**. One Postgres
project serves both development and production, and every `fw-*` worktree's
environment points at it. A push, a seed, a reset and the data scripts all write
rows that production reads. Pushes happen once per merged pull request, run by
the orchestrator, never for two schema-bearing pull requests at once, and never
to make a local test pass.

The second is that **`db push` drops whatever the schema file does not mention**.
It has already removed capture tables that were created to survive it. Anything
that must outlive a push has to be either in the schema file or in the sidecars
described below.

The third is that **the schema is frozen**. The banner at the top of
`prisma/schema.prisma` records the freeze from #705: additive changes are
allowed, so new nullable columns and new models are fine, while renames, drops
of live columns and type changes are not. A change that needs one of those is a
reset-day decision, not a pull request.

## The sidecars

`prisma db push` only knows about objects the Prisma schema can express, so
every trigger, `CHECK` constraint and partial index in this database is applied
separately and would otherwise be silently dropped by the next push. Those
objects live in checked-in SQL and are applied and asserted by scripts.

| File                                   | Contents                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prisma/sql/check-constraints.sql`     | Every `CHECK` constraint and partial index, including `occurrence_no_confirmed_overlap` and the money invariants. Its final section is the block staged for the pre-MVP reset. |
| `prisma/sql/ledger-triggers.sql`       | The double-entry ledger constraint triggers.                                                                                                                                   |
| `prisma/sql/payment-legs-triggers.sql` | The trigger asserting that payment legs sum to the payment amount.                                                                                                             |
| `prisma/sql/known-drift.json`          | The reviewed allowlist of divergences the drift guard tolerates. Every entry carries an owner, a reason and an expiry.                                                         |

The push command chains all of this together, so the schema and the sidecars can
no longer separate:

```sh
npm run db:push
# = prisma db push && npm run db:sidecars, then npm run db:assert-sidecars
```

`npm run db:sidecars` applies the three SQL files. `npm run db:assert-sidecars`
reads the object names out of those files with the shared parser in
`scripts/db/sidecar-objects.ts` and asserts each one exists in the database, so
the assertion cannot drift from the files it checks. The script that pushed
without the sidecars has been removed, so the push-then-sidecars-then-assert
chain is the only supported path. "The Prisma schema is up to date" says nothing
at all about whether the sidecars are present.

Seeding is guarded the same way. `prisma/seed.ts` exits non-zero unless
`SEED_TARGET_CONFIRM` equals the `DATABASE_URL` host (it does not print the host), because one
shared Postgres database serves both dev and prod and a seed run against the wrong
`DATABASE_URL` would write test data into production.

CI's `db-guards` job runs `scripts/ci/check-db-sidecars.ts` on every pull request,
against a throwaway Postgres that gets the branch's `db push` + `db:sidecars`.
`db-live-drift.yml` runs `scripts/ci/check-db-live-drift.ts` and
`scripts/ci/check-db-sidecars.ts` against the live database daily and on manual
trigger.

## Connections

`prisma.config.ts` gives the CLI `process.env.DIRECT_URL`, falling back to a
placeholder so that `prisma generate` works in CI with no database. The runtime
uses the pooled string in `DATABASE_URL`.

Worth knowing precisely: `DIRECT_URL` here is the provider's **session-mode**
pooler on port 5432, not an unmediated connection to the database host. Session
mode is sufficient for DDL, which transaction mode is not, so the arrangement is
correct — but it is a pooler, and a long-running single session such as a
whole-column `\copy` is exactly what it is worst at. The reset runbook uses
`psql "$DIRECT_URL"` for that reason and says so.

The runtime also runs with `PG_POOL_MAX=1` in the deployed environment, which
serialises Prisma queries. That has no bearing on DDL, but it does mean a
migration-adjacent script that assumes concurrency will not get it.

## Making a schema change today

The procedure until the reset is short, and the ordering is what matters.

Edit `prisma/schema.prisma`, keeping to the freeze: additive only, money columns
as `BigInt` paise, and enums declared below the models that use them. Add any
constraint or trigger the change needs to the appropriate file in `prisma/sql/`
rather than assuming `db push` will carry it. Update the seed suite so it
populates the new shape from the first day, because the doctrine here is to
write new tables from every code path rather than to backfill — the reasoning is
in `docs/prisma/02-pre-mvp-reset-runbook.md`. Run the type-check and the affected
jest suites locally. Then let the orchestrator run `npm run db:push` once, at
merge, and confirm `npm run db:assert-sidecars` passes afterwards.

Do not write a data migration for pre-reset rows. Do not push from a worktree to
prove a test passes. If a change genuinely requires a rename, a drop or a type
change, say so and stop; that is a reset-day decision.

## Live-database drift (2026-10-02)

On 2026-10-02 the Subscriptions tab of the Requests inbox returned 500 on production and on previews, because the live enum `RescheduleRequestStatus` lacked the value `COUNTERED`, which has been in the schema since #1060. It was fixed with `ALTER TYPE "RescheduleRequestStatus" ADD VALUE IF NOT EXISTS 'COUNTERED' AFTER 'PENDING_REVIEW'`. The additive auth columns from #1878 were applied the same day: `twoFactor` `failedVerificationCount`, `lockedUntil` and `verified`, `ssoProvider` `createdAt`, `domainVerified` and `updatedAt`, and the unique index `twoFactor_userId_key`. The rest of the drift waits for the planned reset tracked in #1934, and `check-db-drift` has been non-required since `ed876981e`, so CI will not flag it.

A read-only drift check with Prisma 7 is `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, because `--from-url` no longer exists. That diff proposes dropping the hand-applied sidecar partial uniques `appointment_feedback_level_key` and `consultant_earnings_occurrence_key`, so never fix drift with a plain `db push`, and run `npm run db:sidecars` after any reset.

To reproduce a `lib/data` reader locally and see the real Prisma error, run `NODE_OPTIONS="--conditions=react-server" npx tsx --env-file=.env --tsconfig tsconfig.json <script>`. Without `--env-file`, Prisma silently connects to localhost.

## The cutover to versioned migrations

The current posture has an expiry date: it is coherent only while the data is
disposable. The moment real customer data lands, `db push` stops being
acceptable, because it has no history, no review surface for generated SQL, and
no way to apply a change to one environment and not another.

The cutover is the baselining procedure from `prisma-mechanics.md`, with one
addition specific to this repository: the sidecars are not in the Prisma schema,
so a baseline generated by `migrate diff --from-empty` will not contain them,
and a database rebuilt from that baseline would come up without the money
invariants or the overlap constraint. The three SQL files must be appended to
the baseline migration, or committed as a migration that immediately follows it.

The full ordered runbook, including the reset it depends on, is
`docs/prisma/03-cutover-to-migrations.md`. It is the file to open on launch day,
not this one.

## Related skills and documents

`/maintenance` covers keeping the seed suite in sync with the schema, and the
serverless failure modes that a schema change can trigger. `/booking` carries the
standing prohibition on pushing against the shared project and the verification
recipes to use instead. `/finance` covers the money invariants that the sidecars
enforce, which is the reason those invariants are not expressible in the Prisma
schema in the first place.

Under `docs/prisma/`, the general reference is `01-migrations-guide.md`, the reset
procedure is `02-pre-mvp-reset-runbook.md`, the launch cutover is
`03-cutover-to-migrations.md`, the completed Prisma 6 to 7 upgrade is recorded in
`04-prisma-7-migration.md`, and the model-by-model diagrams are in `00-schema-map.md`.
