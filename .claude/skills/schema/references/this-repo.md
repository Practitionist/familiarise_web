# This repository

Everything else in this skill is portable. This file is not: it records what
this repository actually does, which differs from the generic advice in ways
that matter, and it is the file to read before touching `prisma/schema.prisma`.

## The posture, stated plainly

There is no `prisma/migrations` directory. The schema is managed with
`prisma db push`, which reconciles the database to the schema file and writes no
migration history, and there is therefore no `_prisma_migrations` table, no
baseline, and nothing for `prisma migrate deploy` to apply. This is a deliberate
pre-launch choice rather than an oversight: the shape is still being finalised,
the live database is baselined at the freeze rather than reset, and versioned
migrations before the shape settles would be maintenance with no payoff.

Three consequences follow, and they are the reason this file exists.

The first is that **`npm run db:push` is a production operation**. One Postgres
project serves both development and production, and every `fw-*` worktree's
environment points at it. A push, a seed and the data scripts all write
rows that production reads. Pushes happen once per merged pull request, run by
the orchestrator, never for two schema-bearing pull requests at once, and never
to make a local test pass. DDL reaches the database through the human-run push above. Supabase MCP reads run freely; every MCP write or DDL needs the owner's approval in the session, and MCP DDL is only for an owner-approved emergency (rules in `prisma/AGENTS.md`). In Claude Code only, the `.claude/hooks/supabase-sql-gate.ts` hook enforces this for `execute_sql`, and `permissions.ask` rules in `.claude/settings.json` cover the migration, branch, project and edge-function tools; other agents follow the prose.

The second is that **`db push` drops whatever the schema file does not mention**.
It has already removed capture tables that were created to survive it. Anything
that must outlive a push has to be either in the schema file or in the sidecars
described below.

The third is that **the schema is frozen**. The banner at the top of
`prisma/schema.prisma` records the freeze from #705: additive changes are
allowed, so new nullable columns and new models are fine, while renames, drops
of live columns and type changes are not. A change that needs one of those is a
freeze-table decision for the owner, not a pull request.

## The sidecars

`prisma db push` only knows about objects the Prisma schema can express, so
every trigger, `CHECK` constraint and partial index in this database is applied
separately and would otherwise be silently dropped by the next push. Those
objects live in checked-in SQL and are applied and asserted by scripts.

| File                                   | Contents                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/sql/check-constraints.sql`     | Every `CHECK` constraint and partial index, including `occurrence_no_confirmed_overlap` and the money invariants. Its final section mixes applied statements with commented-out staged ones; a staged statement needs review and is never applied by `db push` or the sidecar replay. |
| `prisma/sql/ledger-triggers.sql`       | The double-entry ledger constraint triggers.                                                                                                                                                                                                                                          |
| `prisma/sql/payment-legs-triggers.sql` | The trigger asserting that payment legs sum to the payment amount.                                                                                                                                                                                                                    |
| `prisma/sql/known-drift.json`          | The reviewed allowlist of divergences the drift guard tolerates. Every entry carries an owner, a reason and an expiry.                                                                                                                                                                |

The push command chains all of this together, so the schema and the sidecars can
no longer separate:

```sh
npm run db:push
# = preflight, prisma db push, npm run db:sidecars, then scripts/ci/check-db-sidecars.ts
```

`npm run db:sidecars` applies the three SQL files. `scripts/ci/check-db-sidecars.ts`
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
whole-column `\copy` is exactly what it is worst at. Use
`psql "$DIRECT_URL"` for that reason.

The runtime also runs with `PG_POOL_MAX=1` in the deployed environment, which
serialises Prisma queries. That has no bearing on DDL, but it does mean a
migration-adjacent script that assumes concurrency will not get it.

## Making a schema change today

The procedure until the cutover is short, and the ordering is what matters.

Edit `prisma/schema.prisma`, keeping to the freeze: additive only, money columns
as `BigInt` paise, and enums declared below the models that use them. Add any
constraint or trigger the change needs to the appropriate file in `prisma/sql/`
rather than assuming `db push` will carry it. Update the seed suite so it
populates the new shape from the first day, because new tables are written from every code path rather than backfilled. Run the type-check and the affected
jest suites locally. Then let the orchestrator run `npm run db:push` once, at
merge. That script runs the preflight, `prisma db push`, `npm run db:sidecars`
and finally `scripts/ci/check-db-sidecars.ts`, which fails when a sidecar object
is missing.

**When the sidecar step times out.** `prisma db push` drops the sidecar-owned
uniques `appointment_feedback_level_key`, `consultant_earnings_occurrence_key`
and `organization_earnings_split_key`, and `db:sidecars` re-creates them. On the
shared Supabase pooler, `check-constraints.sql` is one atomic transaction of
about 292 statements and can exceed the client query timeout
`PG_QUERY_TIMEOUT_MS` (6000 ms by default, `lib/prisma.ts`). The step then fails
with "Query read timeout" and leaves those three uniques missing. Rerun with
`PG_QUERY_TIMEOUT_MS=60000 npx tsx -r dotenv/config scripts/db/apply-sidecars.ts --all && npx tsx -r dotenv/config scripts/ci/check-db-sidecars.ts`.
That is safe because every sidecar file is one transaction written with
`IF EXISTS` and `IF NOT EXISTS`. Then confirm the three indexes exist.

Until the cutover, do not write a data migration for existing rows. Do not push from a worktree to
prove a test passes. If a change genuinely requires a rename, a drop or a type
change, say so and stop; that is a freeze-table decision.

## Live-database drift (2026-10-02)

On 2026-10-02 the Subscriptions tab of the Requests inbox returned 500 on production and on previews, because the live enum `RescheduleRequestStatus` lacked the value `COUNTERED`, which has been in the schema since #1060. It was fixed with `ALTER TYPE "RescheduleRequestStatus" ADD VALUE IF NOT EXISTS 'COUNTERED' AFTER 'PENDING_REVIEW'`. The additive auth columns from #1878 were applied the same day: `twoFactor` `failedVerificationCount`, `lockedUntil` and `verified`, `ssoProvider` `createdAt`, `domainVerified` and `updatedAt`, and the unique index `twoFactor_userId_key`. The rest of the drift waits for the freeze-table push in the cutover plan, and `check-db-drift` has been non-required since `ed876981e`, so CI will not flag it.

A read-only drift check with Prisma 7 is `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, because `--from-url` no longer exists. That diff proposes dropping the three hand-applied sidecar unique indexes `appointment_feedback_level_key`, `consultant_earnings_occurrence_key` and `organization_earnings_split_key`, so never fix drift with a plain `db push`, and run `npm run db:sidecars` after any push.

To reproduce a `lib/data` reader locally and see the real Prisma error, run `NODE_OPTIONS="--conditions=react-server" npx tsx --env-file=.env --tsconfig tsconfig.json <script>`. Without `--env-file`, Prisma silently connects to localhost.

## The deploy preview runs the branch's code (2026-10-22)

The Netlify deploy preview for a pull request serves that branch's code from the
shared Postgres, so a branch's schema is not a proposal for the database — it is
a claim about what the database already contains. A column the branch declares
and the database lacks is a 500 on every read of that model, and the preview
BUILD still passes, because the build only runs `prisma generate` and the file-only `npm run cron:coverage` (`checkJobCoverage`), which reads no database.

This has now happened three times: the #1997 columns (#2027), the
`RescheduleRequestStatus.COUNTERED` enum value (2026-10-02), and
`ConsultationPlan.sortOrder` (#2229, Sentry `FAMILIARISE_WEB-7A`).

So the rule from `docs/prisma/README.md` — _push before, or together with, the
deploy that reads the column_ — has a precedent rather than a procedure: the
2026-10-02 enum value and the #1878 columns were applied directly with
`ALTER TYPE … ADD VALUE` and `ALTER TABLE … ADD COLUMN` rather than through a
push. An additive change is safe to apply before the deploy that reads it,
because the running code ignores a column it does not know about.

`scripts/ci/check-db-schema-required.ts` enforces it on pull requests, from
`.github/workflows/schema-required.yml` — a workflow of its own, because
`ci.yaml` is disabled while the Actions minutes are exhausted and a gate in a
disabled workflow never appears. It diffs the branch's MERGE BASE schema
against the branch's own schema — schema to schema, so a branch behind its base
is not judged on objects it never touched — and then asks the live catalog
whether each of those objects is there. Only objects whose absence makes a
query fail are checked: a column, a table, an enum type, an enum value. A
recreated enum is checked label by label, because the plan that replaces an
enum carries no `ADD VALUE` of its own. A created table is checked column by
column, because an earlier push of the same branch may have created the table
without a column added since. The plan is split into statements on `;` only
outside quoted literals, identifiers and comments, so a default such as
`'alpha;beta'` cannot cut a `CREATE TABLE` short and hide its later columns.

Two things it deliberately does NOT do. It does not read the other direction of
the drift (the database carrying objects the schema does not want): that is the
reconcile push's business, and reading it is what made the earlier
`check-db-drift.ts` block every schema-bearing pull request until it was
removed from PR CI. And it does not run on pushes, because a push to `dev`
legitimately leads the live database until the orchestrator pushes the merge;
`db-live-drift.yml` covers the merged state.

Release gate: `npx --no-install tsx scripts/ci/check-db-schema-required.ts --live` diffs the whole schema against the live database (`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`; `DIRECT_URL` for both the diff and the catalog read) and fails when the schema declares a table, column, enum type or enum value the database lacks. It is read-only and ignores database-ahead objects and the sidecar objects. It is the "Release schema gate" job in `.github/workflows/db-live-drift.yml` on pull requests into `prod` from branches of this repository (a fork's pull request gets no run). The release cutter runs it locally before opening the `prod` pull request and pastes the output into the body (GitHub Free has no branch protection, so it cannot be required); once Actions runs, the job is the record. If it fails by listing missing objects the human runs the preflight and push, never an agent; if it could not compare (a missing URL, a failed diff or catalog read), fix that cause and re-run.

Database ahead of the schema on 2026-10-31 (ignored by the gate, so do not "fix" it with a push): tables `DigitalProduct`, `DigitalProductAsset`, `DigitalProductDownload`, `DigitalProductPurchase`, `DigitalProductReport`; enums `DigitalProductStatus`, `DigitalProductPurchaseStatus`, `DigitalProductCategory`, `DigitalProductAssetStatus`; the column `RecordingPurchase.reconciledAt` (with `RecordingPurchase_status_reconciledAt_idx`); and the sidecar-owned indexes `organization_earnings_split_key`, `consultant_earnings_occurrence_key` and `appointment_feedback_level_key`.

The live drift carried today is in `prisma/sql/known-drift.json`, in two
lists. `destructiveStatementsAllowed` is what a push MAY run, and
`knownDivergences` is what the daily drift check tolerates but a push must NOT
remove yet — tolerating a divergence and permitting its removal are not the
same decision. The legacy support-ticket tables are in the second list: NOT
dead, because `origin/prod` does not carry #2257 yet and still queries them,
so they are re-created empty as a stop-gap and the reconcile push waits for
`dev` to be promoted to `prod`. The pre-#2041 recording-storage columns and the
six orphan indexes ARE dead, and a push may remove them.

## A schema change merged to `dev` reaches production immediately

One Postgres project serves `dev`, previews and production, so a schema change
is live for production the moment the owner pushes it, and under the planned
migration workflow the moment a migration merges (`ci-migrations.md`). Only
additive (expand) changes are acceptable at that point; anything destructive waits
for the release that stopped using the object. Treat "merged to `dev`" and "live
in production" as the same event for the database.

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

The full ordered plan, including the freeze table it depends on, is
`docs/prisma/02-schema-freeze-and-migration-cutover.md`. The operational
checklist, with the owner-only steps and the rehearsal, is
`references/runbook-cutover.md`. Those are the files to open on launch day, not
this one.

## Related skills and documents

`/maintenance` covers keeping the seed suite in sync with the schema, and the
serverless failure modes that a schema change can trigger. `/booking` carries the
standing prohibition on pushing against the shared project and the verification
recipes to use instead. `/finance` covers the money invariants that the sidecars
enforce, which is the reason those invariants are not expressible in the Prisma
schema in the first place.

Under `docs/prisma/`, the general reference is `01-migrations-guide.md`, the
freeze and cutover plan is `02-schema-freeze-and-migration-cutover.md`, and the
model-by-model diagrams are in `00-schema-map.md`.
