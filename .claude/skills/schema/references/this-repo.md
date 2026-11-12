# This repository

Everything else in this skill is portable. This file is not: it records what this
repository actually does, and it is the file to read before touching
`prisma/schema.prisma` or `prisma/migrations/`. The step-by-step for adding a
migration from a session or a worktree is `multi-session-workflow.md`.

## The posture, stated plainly

The schema is managed by versioned Prisma migrations. `prisma/migrations/` holds
`0_baseline` (generated from `prisma/schema.prisma` by `scripts/db/generate-baseline.sh`)
followed by hand-written migrations for everything the schema cannot declare, and
every later change is a new folder in the pull request that needs it. `prisma db push`
is gone, and so are the SQL sidecars in `prisma/sql/` and their replay scripts.

Three consequences follow, and they are the reason this file exists.

The first is that **one database serves dev, every preview and production**, so a
migration that merges to `dev` is live for production the moment
`.github/workflows/db-migrate.yml` applies it. Only expand migrations may merge freely;
a contract waits in a `_contract` folder until the owner dispatches it by name after
the release that stopped using the object. No session applies a migration to the
shared database: not with `migrate deploy`, not with `migrate dev`, not with MCP DDL.
Supabase MCP reads run freely; every MCP write or DDL needs the owner's approval in the
session, and MCP DDL is only for an owner-approved emergency that is mirrored by a
migration in the same pull request (rules in `prisma/AGENTS.md`). In Claude Code the
`.claude/hooks/supabase-sql-gate.ts` hook enforces this for `execute_sql`, and the
`.claude/settings.json` deny rules block the bare `prisma migrate deploy`, `resolve` and
`reset` forms and any `prisma migrate` command naming a Supabase host; local commands
that set `DIRECT_URL` to `localhost` are not blocked.

The second is that **every migration file is a transaction**:
`BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;`, except a file holding one
`CONCURRENTLY` statement. Prisma 7.10.1 commits each statement of an unwrapped file on
its own, so an unwrapped failure would leave a half-applied migration.
`scripts/ci/check-migrations.ts` fails any file that is not wrapped.

The third is that **the history is the source of truth**. A database is built by
`prisma migrate deploy` on an empty database, never by copying another one, and a
catalog that differs from the history is drift to be fixed by a new migration.

## Where the hand-written objects live

`prisma migrate diff` and the baseline see only what `prisma/schema.prisma` can
declare. Every CHECK, exclusion constraint, partial or `NULLS NOT DISTINCT` unique,
trigger and trigger function, view and row-level-security flag is written by hand into
a migration after the baseline:

| Migration                                 | Holds                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261109000001_revoke_data_api_grants`   | No table, sequence or function grants to `anon` or `authenticated`, now or later                                                                         |
| `20261109000002_btree_gist_extension`     | `btree_gist` in the `extensions` schema                                                                                                                  |
| `20261109000003_booking_guards`           | `occurrence_no_confirmed_overlap` and the other booking invariants                                                                                       |
| `20261109000004` to `…000017` (by domain) | Plans, payments, payment legs, earnings and payouts, TDS, billing, referrals, the ledger, reviews, collaborators, accounts, support, content, operations |
| `20261109000018_analytics_views`          | The `demand` view, kept off the Data API                                                                                                                 |
| `20261109000019_org_data_export_rls`      | Row-level security on `OrgDataExportArtifact`                                                                                                            |

Trigger functions pin `SET search_path = public`. `scripts/db/sidecar-objects.ts`
replays every migration after the baseline in order (a later `DROP` or `RENAME` removes
an object) and is the one inventory both `scripts/ci/check-db-sidecars.ts` and the tests
read. `check-db-sidecars.ts` asserts that inventory against the catalog and fails on
any table grant to `anon` or `authenticated`, so "the migrations are applied" and "the
invariants exist" are checked separately: `migrate status` alone would stay green after
a hand-dropped trigger.

Three of those objects are unique indexes the schema cannot declare
(`appointment_feedback_level_key`, `consultant_earnings_occurrence_key`,
`organization_earnings_split_key`, all `NULLS NOT DISTINCT`), so every
`migrate diff` against the schema proposes dropping them.
`sidecarOwnedUniqueIndexes` derives that set from the migrations, and the history check
and the live drift check filter exactly it; anything else in a diff is a missing migration.

## The guards

- **Pull requests (`ci.yaml`, database steps).** A `postgres:17.6` container in UTC
  with the three Supabase roles; `prisma migrate deploy` from the history;
  `scripts/ci/check-migrations.ts` (wrapping, folders sort after the base's newest, no
  applied file edited, history equals schema on the shadow database);
  `scripts/ci/check-db-sidecars.ts`; the `jest.db` tier.
- **Merge to `dev` (`db-migrate.yml`).** `scripts/ci/migrate-gate.ts` (pending-only,
  and no `_contract` unless dispatched by name), `migrate deploy`, `migrate status`,
  `check-db-sidecars.ts`, ops notified on failure, never retried.
- **Daily (`db-live-drift.yml`).** `scripts/ci/check-db-live-drift.ts` (live versus the
  schema, filtering only the three indexes) and `check-db-sidecars.ts`.
- **Previews (`schema-required.yml`).** `scripts/ci/check-db-schema-required.ts` fails a
  pull request whose schema adds an object the shared database lacks, and says to merge
  the migration rather than apply the objects by hand.
- **Release into `prod`.** The release cutter runs
  `npx --no-install tsx scripts/ci/check-db-schema-required.ts --live` (read-only) and
  pastes its output into the pull request body; it is the "Release schema gate" job in
  `db-live-drift.yml`.

## Connections

`prisma.config.ts` gives the CLI `process.env.DIRECT_URL`, falling back to a
placeholder so `prisma generate` works with no database, and
`process.env.SHADOW_DATABASE_URL` as the shadow database, which is set only in CI and
in local rehearsals and is never a Supabase project. The runtime uses the pooled
`DATABASE_URL`.

`DIRECT_URL` here is the provider's **session-mode** pooler on port 5432, not an
unmediated connection to the database host. Session mode is sufficient for DDL, which
transaction mode is not, and it is what `db-migrate.yml` uses. The deployed runtime runs
with `PG_POOL_MAX=1`, which serialises Prisma queries; that has no bearing on a
migration.

Seeding is guarded: `prisma/seed.ts` exits non-zero unless `SEED_TARGET_CONFIRM`
equals the `DATABASE_URL` host, because a seed against the wrong URL would write test
data into production.

## Deploy previews run the branch's code against the shared database

A preview of a pull request that adds a column runs against a database that does not
have it until the migration merges, so every read of that model returns a 500 while
the build still passes (the build only runs `prisma generate` and the file-only
`npm run cron:coverage`). This bit three times under `db push` (a column set, the
`RescheduleRequestStatus.COUNTERED` enum value, and `ConsultationPlan.sortOrder`). The
schema-required gate makes it a loud failure; verify such a pull request on a scratch
database. Never apply the objects by hand to make the preview work: the migration's
`ADD COLUMN` would then fail on merge.

To reproduce a `lib/data` reader against the live database and see the real Prisma
error, run `NODE_OPTIONS="--conditions=react-server" npx tsx --env-file=.env --tsconfig tsconfig.json <script>`
from the main checkout (read-only code only). Without `--env-file`, Prisma silently
connects to localhost.

## Related skills and documents

`/maintenance` covers the seed suite. `/booking` and `/finance` cover the invariants the
hand-written migrations enforce and why they are not expressible in the Prisma schema.
Under `docs/prisma/`, `01-migrations-guide.md` is the general reference,
`02-schema-freeze-and-migration-cutover.md` the freeze and cutover plan, and
`00-schema-map.md` the model diagrams. The decision record is
`docs/decisions/2026-11-09-schema-freeze-and-migration-cutover.md`.

## Deprecated & Superseded Approaches

- **`npm run db:push`** (preflight, `prisma db push`, `npm run db:sidecars`, then the
  assertion), the `prisma/sql/*.sql` sidecars and `prisma/sql/known-drift.json`.
  Removed at the cutover; a divergence is now a migration, never an allowlist entry.
- **Hand-applied additive SQL files** beside the sidecars (the reconciliation cursors,
  the support auto-close index, the org data-export table). Each object is in the
  baseline or a migration now.
- **The `db-reset` label in `ci.yaml`**, which chose a rehearsal database for the guards.
  Removed; CI always builds from the history.
