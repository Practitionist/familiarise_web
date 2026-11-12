# Prisma and database schema documentation

This directory holds everything about the database schema: the general reference
for Prisma Migrate, the record of the cutover from `prisma db push` to versioned
migrations, and the model-by-model map of the schema itself.

Start here rather than in an individual file, because which document applies
depends on whether you are reasoning generally or working in this repository.

The numeric prefixes are reading order, following the convention used elsewhere
under `docs/`. They run from orientation through general reference to the
cutover and freeze plan.

| Document                                    | What it is                                                                                                                                                                                                        | Read it when                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `00-schema-map.md`                          | Twenty-four domain diagrams of the Prisma schema, plus the enum reference table.                                                                                                                                  | Orienting in an unfamiliar part of the schema, or tracing how two models relate.                                                   |
| `01-migrations-guide.md`                    | The general-purpose reference for Prisma Migrate: every command, safe and dangerous operations, expand and contract, drift, rollback, troubleshooting. Written against a fictional schema so it stays portable.   | You need to know what a Prisma command does, or how a class of change is handled in general.                                       |
| `02-schema-freeze-and-migration-cutover.md` | The cutover record and plan: the reset and rebuild of the shared database from the migration history, the database split, how a schema change is made now, and the table of freeze candidates the owner accepted. | You are running or reviewing the cutover, deciding whether a column survives the freeze, or asking why `db push` no longer exists. |

The step-by-step procedure for adding a migration is the schema skill's
`.claude/skills/schema/references/multi-session-workflow.md`. The decision and its
rehearsal evidence are in
[Schema freeze and the cutover from db push to versioned migrations](../decisions/2026-11-09-schema-freeze-and-migration-cutover.md).

## The one thing to know first

This repository manages its schema with versioned Prisma migrations. `prisma/migrations/`
holds `0_baseline`, which `scripts/db/generate-baseline.sh` generates from
`prisma/schema.prisma`, followed by 19 hand-written, transaction-wrapped migrations that
create everything the schema cannot declare: CHECK and exclusion constraints, partial and
`NULLS NOT DISTINCT` unique indexes, triggers, a view and row-level security. The
`db push` command, the `prisma/sql/` sidecar files and the `db:push*`, `db:preflight`,
`db:sidecars`, `db:constraints`, `db:triggers`, `db:leg-triggers` and `db:migrate` scripts
no longer exist.

**A schema change is a migration folder in the same pull request** as the
`prisma/schema.prisma` edit and the code that uses it. No session applies a migration to
the shared database by hand:

- **Expand migrations apply on merge.** A push to `dev` that changes
  `prisma/migrations/**` starts `.github/workflows/db-migrate.yml`. Its gate
  (`scripts/ci/migrate-gate.ts`) lets the run continue only when the sole problem is
  pending migrations; then `prisma migrate deploy` runs, `prisma migrate status` must
  exit 0, and `scripts/ci/check-db-sidecars.ts` confirms every migration-declared object
  exists. The workflow connects through the Supabase session pooler on port 5432 using
  the `DIRECT_URL` secret and never retries; a failure notifies ops.
- **Contract migrations apply only by dispatch.** A destructive migration lives in a
  folder whose name ends in `_contract`. The push run refuses it, and only a
  `workflow_dispatch` run whose input names the folder exactly applies it. Write access
  to the repository is the approval, because GitHub Free has no required-reviewer
  environments on a private repository.
- **A pending contract blocks every later expand,** because `migrate deploy` applies
  pending migrations in order and cannot skip one.

Because one Postgres project serves development, every deploy preview and production,
a merge to `dev` that carries a migration changes the production database the same
minute. Only expand migrations may merge freely. The authoring loop (a local Postgres 17
scratch database, `migrate diff` against a shadow database, never `migrate dev`), the
conflict rules between worktrees and the failure recovery are in the skill reference
named above. The cutover itself, the reset and rebuild of the live database, is
described in `02-schema-freeze-and-migration-cutover.md` and has not been run yet; until
it has, the live database is still the one built by `db push`.

Agents read the live database freely through the Supabase MCP, batching
several reads into one `execute_sql` call. Every write or DDL statement needs
the owner's approval in the session: the `.claude/hooks/supabase-sql-gate.ts`
hook lets a provably read-only batch through and prompts, naming the statement
type, for anything else (in bypass-permissions mode it blocks the call until
the owner leaves that mode). Schema changes still go through
`prisma/schema.prisma` and a migration; MCP DDL is only for an owner-approved
emergency. The shared `.mcp.json.example` entry stays `--read-only` and
project-scoped. Rules: `prisma/AGENTS.md`;
decision: [Supabase MCP SQL approval hook](../decisions/2026-11-07-supabase-mcp-sql-approval-hook.md).

The same database also serves every Netlify **deploy preview**, and that is the
constraint that catches people out: a preview runs the _branch's_ code against
the _live_ database, so a branch whose schema declares a column the database
does not have deploys a preview that 500s on every read of that model. Nothing
in the build sees it, because the build only generates the Prisma client.

## How CI proves the migration history

The database steps of the `checks` job in `.github/workflows/ci.yaml` run when
database-related files change, and none of them touches the shared database:

1. **Start Postgres 17.6.** A throwaway container pinned to Supabase's minor version,
   in UTC, because naive timestamp columns make seat counts depend on the session time
   zone.
2. **Build the database from the migration history.** The Supabase roles `anon`,
   `authenticated` and `service_role` are created first so the revoke migration runs its
   real branch, then `prisma migrate deploy` builds the `ci` database from the folders.
3. **Migration history lint** (`scripts/ci/check-migrations.ts`). Folders must sort after
   the base branch's newest migration, an applied migration must not be edited, every
   file must be `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` (the exception is a
   file holding exactly one `CONCURRENTLY` statement), and the history must produce
   exactly `prisma/schema.prisma`, diffed on a `shadow` database in the same container.
4. **Database sidecar guard** (`scripts/ci/check-db-sidecars.ts`). Every constraint,
   index, trigger, view and row-level-security table that the migrations declare must
   exist (`scripts/db/sidecar-objects.ts` derives the list from the migration SQL), and
   neither `anon` nor `authenticated` may hold a table grant.
5. **The database test tier** (`jest.db.config.ts`) then runs against the same container.

## The deploy preview runs against the live database

A Netlify deploy preview for a pull request serves that branch's code from the
shared Postgres. So the branch's schema is not a proposal for the database — it
is a claim about what the database already contains, and until the database
agrees, every reader of the new object 500s with _"does not exist in the current
database"_. The preview build passes, because the build only runs
`prisma generate` and the file-only job-coverage check (`npm run cron:coverage`), which reads no database.

`scripts/ci/check-db-schema-required.ts` is the check that closes the gap. It
diffs the branch's **merge base** schema against the branch's own schema, which
is exactly what this pull request adds — a branch behind its base is not judged
on objects it never touched — and then asks the live catalog whether each of
those objects is there. Only objects whose absence makes a query fail are
checked: a column, a table, an enum type, an enum value. A table the branch
creates is also checked column by column, because an earlier push of the same
branch may have created it without a column added since. A missing index costs
a sequential scan, not a 500.

It runs as its own workflow, `.github/workflows/schema-required.yml`, on pull
requests that touch `prisma/schema.prisma`, from same-repository branches only,
and it reads the live database through `secrets.DATABASE_URL` — not
`secrets.ENV_FILE`, because a pull-request job has no business holding every
production API key.

It is its own workflow rather than a job in `ci.yaml` for one reason: `ci.yaml`
is disabled while the Actions minutes are exhausted, and a gate in a disabled
workflow is not a gate — it never appears, so a required check would read as
success. The comparison is schema-to-schema, so a pull request that adds no
schema object never reads the database at all.

**The release gate.** `check-db-schema-required.ts --live` is the same check pointed at the whole schema instead of the merge-base diff. It runs `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` (read-only, needs `DIRECT_URL`; the catalog read uses the same `DIRECT_URL`) and fails when the schema declares a table, column, enum type or enum value the live database lacks. It ignores the other direction and the objects the schema cannot declare. It runs as the "Release schema gate" job (`release-schema-gate`) in `.github/workflows/db-live-drift.yml` on pull requests into `prod` from branches of this repository; a fork's pull request gets no run. GitHub Free has no branch protection on private repositories, so it cannot be a required check: the release cutter runs `npx --no-install tsx scripts/ci/check-db-schema-required.ts --live` locally before opening the `prod` pull request and pastes the output into its body, and once Actions runs the job is the record. When it fails by listing objects the live database lacks, the migration that creates them has not been applied yet: merge it so `db-migrate.yml` applies it; when it fails because it could not compare (a missing URL, a failed diff or catalog read), fix that cause and re-run.

The other direction — the database carrying objects the schema does not want —
is deliberately **not** checked. That is a migration's business, it is
not a runtime failure, and a live-database check in both directions blocks every
schema-bearing pull request. That is what retired the earlier
`check-db-drift.ts`; see the deprecated section below.

When it fails, it lists the missing objects and says to merge the migration, never to
apply the objects by hand. A hand-applied column makes the migration fail on merge,
because `ALTER TABLE ... ADD COLUMN` carries no `IF NOT EXISTS`. Verify such a pull
request on a local scratch database until its migration merges.

## The daily live drift check

`.github/workflows/db-live-drift.yml` runs `scripts/ci/check-db-live-drift.ts` every day
and on demand. It runs `prisma migrate diff --from-config-datasource --to-schema
prisma/schema.prisma --script`, which is read-only, and fails on any planned statement
except the drops of unique indexes that `prisma/schema.prisma` cannot declare. It derives
that set from the migrations (`sidecarOwnedUniqueIndexes` in
`scripts/db/sidecar-objects.ts`): today `appointment_feedback_level_key`,
`consultant_earnings_occurrence_key` and `organization_earnings_split_key`, all
`NULLS NOT DISTINCT` uniques. There is no allowlist file: a divergence is fixed by a
migration, not tolerated. The check needs a sink outside Sentry, because a failure that
can reach only Sentry is silently dropped when the error quota is exhausted; see
[the ingest canary](../observability/sentry/06-ingest-canary.md#the-scheduled-drift-check-needs-a-sink-outside-sentry).

## Related material

The portable doctrine behind all of this (the change catalog with lock classes, the
expand and contract playbooks, the deploy ordering rules) is the `/schema` skill in
`.claude/skills/schema/`. Its `references/this-repo.md` is the short version of this page
for an agent that is about to edit the schema, and `references/multi-session-workflow.md`
is the procedure.

Keeping the seed suite in sync with a schema change is covered by the
`/maintenance` skill. The money invariants that the migrations enforce, and why
they cannot live in the Prisma schema, are covered by `/finance`.

---

## Deprecated & Superseded Approaches

- **`prisma db push` plus owner-applied sidecars** (`scripts/db/preflight-push.ts`, `scripts/db/apply-sidecars.ts`, `prisma/sql/*.sql`) as the way the shared database is changed, with `prisma/sql/known-drift.json` as the allowlist of tolerated drift. Superseded by reviewed migrations applied by `db-migrate.yml`; do not re-create a replay path or a drift allowlist.
- **Pushing before the deploy.** The earlier rule "push before, or together with, the deploy that reads the column" is replaced by "merge the migration", which applies on merge to `dev`.
- **Baselining the live database with `migrate resolve --applied`.** Superseded by a reset and rebuild from the history while the data is mock.
- **Whole-schema live-DB drift blocking feature PRs**: running `check-db-drift.ts` against the shared live database inside PR checks blocked unmerged schema PRs whenever a branch added an enum label or column not yet applied to live Postgres. Superseded by building the database from the migration history on a hermetic `postgres:17.6` container in the `checks` job of `ci.yaml`, with `.github/workflows/db-live-drift.yml` as a read-only live monitor. A narrower check, this branch's own delta against the live catalog, runs on pull requests as `scripts/ci/check-db-schema-required.ts`.
- **One-off constraint swap and migration logs** (`scripts/db/swap-occurrence-overlap-constraint.ts`, `02-pre-mvp-reset-runbook.md`, `03-cutover-to-migrations.md`, `04-prisma-7-migration.md`). Retired; the exclusion constraint `occurrence_no_confirmed_overlap` is created by a migration. Do not recreate standalone migration scripts outside `prisma/migrations/`.
