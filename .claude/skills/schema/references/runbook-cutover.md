# Runbook: the cutover to versioned migrations

This is the ordered checklist for the day the shared database stops being managed by
`prisma db push` and starts being rebuilt from `prisma/migrations/`. The path is a
**reset and rebuild**, not an in-place baseline: the owner chose it on 2026-11-09
because the database holds mock data only, so `_prisma_migrations` records real
applications from the first day and nothing is marked applied with
`migrate resolve --applied`. Steps marked **[O]** are run by the owner, or by Claude
in the session only on the owner's explicit say-so, because each one writes to or
configures the shared database. The decisions are in
`docs/decisions/2026-11-09-schema-freeze-and-migration-cutover.md`; the day-to-day
procedure after the cutover is `multi-session-workflow.md`.

## Before the window

1. **Land the in-flight schema pull requests the old way.** Every open branch that
   changes `prisma/schema.prisma` merges and is pushed with the old flow first.
2. **Announce the freeze.** From the baseline regeneration in step 3 until step 12, no
   pull request that touches `prisma/` merges.
3. **Regenerate the baseline from the final `dev` schema** on the cutover branch:
   `scripts/db/generate-baseline.sh`. It needs no database and prints the table and type
   counts (184 and 162 on 2026-11-09).
4. **Rehearse locally** (the last section of `multi-session-workflow.md`): build from
   history, `check-db-sidecars.ts`, `check-migrations.ts`, `jest.db`, the gate drills
   and the reset drill. Record the outputs in the pull request.
5. **Review and approve the cutover pull request.** CodeRabbit for the whole diff, plus
   a Codex round on the migration SQL. Do not merge yet.
6. **Add the GitHub secret `DIRECT_URL`. [O]** The Supabase **session pooler** string
   (port 5432); runners are IPv4-only and DDL needs session mode. No shadow secret is
   needed: CI's shadow is the job's container.

## The window (about an hour, owner present)

7. **Maintenance mode on. [O]** `/api/admin/maintenance`.
8. **Dump live and prove the dump restores. [O]** Use a Postgres 17 client against the
   15.8 server (`pg_dump -Fc`), restore it into the local 17 cluster, and run
   `check-db-sidecars.ts` against the restore. The Free plan takes no automatic
   backups, so this dump is the only way back.
9. **Upgrade to Postgres 17. [O]** Disable `pgjwt` in the dashboard first (unused, and
   deprecated on 17), then run the in-place upgrade. Record the downtime and run the
   md5-to-SCRAM check for custom roles. If the Free plan cannot upgrade, stay on 15 and
   pin CI's image to 15 in the same session.
10. **Drop the Prisma-owned objects in `public`. [O]** Leave `auth`, `storage`,
    `extensions` and `vault` untouched. Rehearsed on 2026-11-09: dropping views, tables,
    non-extension functions and enum types in `public` with a single-transaction
    `DO` block took 0.22 s, left the schema and its grants in place, and
    `migrate deploy` then rebuilt a catalog identical to a fresh build. Prefer this to
    `DROP SCHEMA public CASCADE`, which also removes the Supabase default grants on the
    schema. Also drop `archive._gateway_drift_backup_20260728`. Then drop
    `btree_gist` (`DROP EXTENSION IF EXISTS btree_gist`) so the extensions migration
    creates it in `extensions`; locally `ALTER EXTENSION … SET SCHEMA` moved it, but
    on Supabase the extension may be owned by a role `postgres` cannot act for.
11. **Merge the cutover pull request. [O]** `db-migrate.yml` runs on the push to `dev`:
    the gate sees every folder pending, `migrate deploy` applies `0_baseline` and the
    nineteen migrations (1.35 s locally), `migrate status` must exit 0, and
    `check-db-sidecars.ts` must report 170 objects and no Data API grants. If the
    secret is not ready, the owner runs the same four commands once by hand from the
    merged commit with `DIRECT_URL` set to the session pooler.
12. **Seed. [O]** `npm run db:seed` with `SEED_TARGET_CONFIRM` set to the live host.
13. **Verify.**
    - `npx prisma migrate status`: `Database schema is up to date!`
    - `scripts/ci/check-db-sidecars.ts`: ok.
    - No table grants to `anon` or `authenticated`:
      `SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated');` returns 0.
    - Supabase advisors: `extension_in_public` and `function_search_path_mutable` cleared.
    - Smoke tests: sign-in, a booking checkout on test keys, the dashboards.
14. **Promote `dev` to `prod` if `prod`'s code needs the reset schema, then maintenance
    mode off. [O]**
15. **Write the experiment record** in `docs/prisma/`: timings, outputs, surprises, what
    to change for the real launch. Stream, Novu, Razorpay test and Storage state that
    pointed at the old mock rows is orphaned; the go-live sandbox purge clears it, so
    add that to the go-live checklist.

## After the window

16. **Run the freeze as real migrations**, F1 to F5 in the decision record, each its own
    pull request with its own migration, expand parts on merge and `_contract` parts by
    dispatch right before the release that needs them.
17. **Remind the owner about row-level security** and test enabling it with no policies
    on the rebuilt database.

## When a migration fails

`migrate deploy` stops at the first failure and records it; every later run refuses
with `P3009` (or `P3018` mid-run). Because every file is wrapped in
`BEGIN; … COMMIT;`, a failed migration leaves nothing behind (rehearsed). The error
Prisma prints (`current transaction is aborted`) is the statement after the real
cause; reproduce with `psql -v ON_ERROR_STOP=1 --single-transaction -f <file>` on a
scratch database.

1. `npx prisma migrate status`; note the failed folder.
2. Confirm in the catalog that none of its objects exist.
3. `npx prisma migrate resolve --rolled-back <folder>` **[O]**.
4. Fix the file in a pull request (it never applied, so editing it is allowed).
5. Re-run `db-migrate.yml` (dispatch with an empty input for an expand migration).
6. `npx prisma migrate status`, then `scripts/ci/check-db-sidecars.ts`.

Never re-run `migrate deploy` hoping it passes, and never let the workflow retry on its
own. Source: [patching and hotfixing](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing).

## Deprecated & Superseded Approaches

- **Baselining live in place** (`migrate resolve --applied 0_baseline` plus a resolved
  `money_invariants` migration). Superseded by the reset, which needs no hand-marked
  history.
- **A last guarded `db push` to land the freeze shape.** The freeze now ships as real
  migrations after the cutover.
