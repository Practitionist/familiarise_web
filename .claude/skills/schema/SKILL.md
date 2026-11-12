---
name: schema
description: How to evolve a live relational database schema without destroying customer data — what production teams actually do instead of resetting the database (expand and contract, dual writes, batched backfills, shadow reads, N-1 compatible deploys), which changes are free and which take an exclusive table lock, the Prisma Migrate mechanics that make or break it (migrate dev vs deploy vs db push, the shadow database, baselining an existing database, drift, recovering a failed migration, why CREATE INDEX CONCURRENTLY fails inside a migration), how to order the database change against the application deploy on any host, and this repository's own posture (versioned migrations applied by CI on merge, hand-written sidecar objects inside the migration SQL, a single Postgres project serving both environments, `_contract` folders applied only by dispatch, and how many sessions share one database). Load when the user says "migration", "migrate", "db push", "schema change", "rename a column", "rename a table", "drop a column", "add a required field", "backfill", "zero downtime", "drift", "baseline", "expand and contract", "ALTER TABLE", "table lock", "supabase", "pooler", "migrate deploy in CI", "migration conflict", "cutover", "rehearsal", "contract migration", "P3009", or is editing prisma/schema.prisma, prisma.config.ts, or anything under prisma/migrations/.
---

# Schema evolution

This is the index for changing a database schema that already holds data someone
cares about. The doctrine below is inline because every rule in it is the kind
that is only learned by breaking production once. The eleven references carry the
detail for a specific concern.

| Reference                              | Purpose                                                                                                                                                                                                              | Read it when                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `references/change-catalog.md`         | Every class of schema change, one row each — the lock it takes, whether it rewrites the table, what the ORM generates by default, and the safe recipe that replaces it.                                              | Before writing any DDL, to find out what the change you want actually costs.                                   |
| `references/expand-contract.md`        | The multi-deploy playbooks — renaming a column or table, changing a type, adding a required field, splitting a table, plus dual writes, batched backfills, shadow reads and the reverse cutover.                     | The catalog told you the change is destructive and needs more than one deploy.                                 |
| `references/prisma-mechanics.md`       | Prisma-specific machinery — `migrate dev` vs `deploy` vs `db push`, the shadow database, baselining, drift, recovering a failed migration, editing generated SQL, enum and concurrent-index quirks.                  | Running a Prisma command against a database you cannot afford to reset, or a migration has already gone wrong. |
| `references/deployment.md`             | Ordering the database change against the application deploy on any host — the N-1 compatibility rule, migrate-before-deploy, advisory locks, pooled versus direct connections, rollback, backups.                    | Wiring migrations into CI/CD, or deciding whether the schema or the code ships first.                          |
| `references/supabase.md`               | Supabase specifics — session versus transaction pooler, IPv4 for CI, timeouts, branching, free-plan limits, the dedicated role, why not to use MCP `apply_migration`.                                                | Choosing a connection string for a migration, or deciding anything about the Supabase plan or branching.       |
| `references/ci-migrations.md`          | How `.github/workflows/db-migrate.yml` works — triggers, steps, failure handling, the `_contract` folder gate, and the shared-database rule.                                                                         | Wiring migrations into GitHub Actions, or asking when a migration may run.                                     |
| `references/conflicts.md`              | Keeping the migration list linear across branches and worktrees — timestamps, rebasing, regenerating, the CI linear-history check.                                                                                   | Two pull requests both add a migration, or a rebase touched `prisma/migrations`.                               |
| `references/sidecars-as-migrations.md` | How CHECKs, triggers, partial indexes and views change as migrations, and what Prisma can and cannot ignore.                                                                                                         | Changing a CHECK, trigger, partial index, view or RLS flag.                                                    |
| `references/runbook-cutover.md`        | The ordered reset-and-rebuild cutover checklist with owner-only steps marked, and the P3009/P3018 failure recovery.                                                                                                  | Running the cutover window, or recovering a failed migration.                                                  |
| `references/this-repo.md`              | What this repository actually does — versioned migrations, the hand-written objects inside them, the guards, one Postgres project for both environments.                                                             | Making a schema change **in this repository**.                                                                 |
| `references/multi-session-workflow.md` | The observed, step-by-step procedure for adding a migration from a session or worktree, expand on merge and contract by dispatch, previews, conflicts, the transaction convention, recovery and the local rehearsal. | Before writing any migration in this repository, and after every Prisma or Postgres bump.                      |

Everything except `references/this-repo.md` is deliberately portable. It assumes
PostgreSQL and Prisma because that is the common case, it notes where MySQL
differs, and it makes no assumption about the host: the same rules hold on
Vercel, Netlify, Fly, Render, Railway, a container on ECS, or a long-lived VM.
Anything specific to this repository's hosting or database provider lives in
`references/this-repo.md` and nowhere else.

## The short answer to "do they wipe the database?"

No. A company with live customers never resets a production database to apply a
schema change, and there is no tier of company at which that becomes acceptable.
Dropping and recreating is a development-environment move, and the reason it
feels like the only option is that the ORM presents it as one: Prisma cannot
detect a rename, so a renamed model or field is emitted as a `DROP` followed by
a `CREATE`, and the destructive plan is the default plan rather than a considered
one. The entire discipline below exists to replace that default.

What production teams do instead is refuse to make any single change that is
simultaneously destructive and irreversible. A change that would be destructive
in one step is decomposed into a sequence of individually safe steps, each of
which leaves the database readable and writable by both the currently deployed
application and the one about to be deployed. The sequence takes longer in
calendar time — a rename is three deploys, not one — and that is the price of
never having a moment where the running code and the live schema disagree.

## Doctrine

**The schema and the application are deployed separately, so they must be
compatible in both directions.** There is no instant at which the database and
every running application instance change together. During a rolling deploy, old
and new instances serve traffic at the same time; a queued job or a webhook
retry can execute yesterday's code against today's schema. Every intermediate
schema state must therefore work with the code on both sides of the deploy. This
is the single rule from which everything else follows, and it is why a rename
cannot be one step: at the moment the column is renamed, the still-running old
code selects a column that no longer exists.

**Additive changes are cheap; destructive changes are expensive; there is no
third category.** Adding a nullable column, adding a table, and building a
non-unique index concurrently are all safe to ship whenever you like, because no
deployed code depends on them. A concurrent **unique** index is the exception
that proves the rule: it fails outright if duplicates already exist, and it
rejects conflicting writes while it is still being built, so it belongs with the
ordered changes and follows the recipe in `references/change-catalog.md`. Dropping a column, renaming anything, tightening a type, and
adding a `NOT NULL` constraint to a populated table are all destructive, because
each of them can break code that is still running or reject rows that already
exist. Classify the change before writing the DDL, not after.

**Never let the ORM generate destructive SQL unreviewed.** Generate the
migration without applying it, read the SQL, and replace every `DROP`/`CREATE`
pair that was meant to be a rename with the corresponding `ALTER TABLE ... RENAME`.
`prisma migrate dev --create-only` exists exactly so that this review can happen
before anything touches a database. A migration that contains `DROP COLUMN` or
`DROP TABLE` and was not consciously intended to lose that data is a bug that
has already been written.

**A lock you did not plan for is an outage.** PostgreSQL grants locks in FIFO
order, so a DDL statement waiting for an `ACCESS EXCLUSIVE` lock queues every
subsequent query behind it, including reads it does not conflict with. A
statement that would have taken five milliseconds can therefore take the site
down for as long as the oldest open transaction runs. Always set `lock_timeout`
so the migration fails fast and retries instead of forming a queue, and know
which lock class each statement takes before you run it.

**Backfill in batches, never in one transaction.** A single `UPDATE` over
millions of rows holds locks and bloats the write-ahead log for the whole of its
runtime, and if it fails at the end, all of it is rolled back. Backfills are
therefore chunked, committed per chunk, restartable from where they stopped, and
run outside the migration that added the column.

**Roll forward, do not roll back.** Once a migration has partially applied
against live data, the recovery path is almost always another migration, not a
reversal — a down migration cannot restore data that a `DROP COLUMN` already
destroyed, and it usually has to run against a schema that no longer matches
what it was written for. Backups exist for the catastrophic case; forward fixes
are for every other case.

**The schema change is not done when the column exists.** It is done when the
old column is gone, the old code paths are deleted, and the contract step has
shipped. An expand step left permanently unfinished is worse than the original
schema, because now two columns exist and nobody knows which one is true.

**A trigger that rebuilds a summary must fire once per statement, not once per row.** Every trigger in `prisma/migrations/` today is a guard: an immutability check or a deferred constraint trigger such as `ledger_txn_balanced` or `payment_legs_sum_to_amount`. Constraint triggers can only be `FOR EACH ROW` in Postgres, so they stay row-level. Each row event runs the function again: `ledger_txn_balanced`, for example, re-sums one transaction's entries. Keep that per-row work small, scoped to one transaction or entity, and never re-aggregate a growing table on every event. A trigger that recomputes an aggregate, a cache or a summary table is different. Written `FOR EACH ROW`, it reruns the whole rebuild once for every row a bulk statement touches. Write it as `FOR EACH STATEMENT` with transition tables (`REFERENCING NEW TABLE AS ...`), or mark the affected rows dirty and let a sweep rebuild them in batches. Issue #2493 records why.

**A release into `prod` passes the live schema gate first.** The release cutter runs `npx --no-install tsx scripts/ci/check-db-schema-required.ts --live` (read-only) before opening the `prod` pull request and pastes its output into the body; GitHub Free allows no required check. When it fails by listing objects the live database lacks, the migration that creates them has not been applied: check `db-migrate.yml`'s run for the merge, never apply the objects by hand; when it fails because it could not compare (a missing URL, a failed diff or catalog read), fix that cause and re-run instead. It ignores database-ahead objects and sidecar objects. The job is "Release schema gate" in `.github/workflows/db-live-drift.yml`; the current database-ahead list is in `references/this-repo.md`.

## Where to start

If you are about to change a schema, read `references/change-catalog.md` first
and find the row matching your change; it will either tell you the change is
free or send you to `references/expand-contract.md` for a playbook. If a Prisma
command has already failed or a database is already inconsistent, go straight to
`references/prisma-mechanics.md`. If you are working in this repository rather
than reasoning in general, read `references/this-repo.md` and
`references/multi-session-workflow.md` before anything else, because one database
serves every environment here and that changes when each kind of migration may run.
