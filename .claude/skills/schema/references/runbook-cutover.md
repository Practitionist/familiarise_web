# Runbook: the cutover to versioned migrations

This is the ordered checklist for the day this repository stops using
`prisma db push` and starts using Prisma Migrate. It is **(planned)**: none of it
has been run. Steps marked **[O]** are owner-only; an agent never runs them,
because every one of them writes to or configures the shared database
(root `AGENTS.md` section 2.3). The decision and the freeze table behind it are in
`docs/prisma/02-schema-freeze-and-migration-cutover.md`; this file is the
operational order.

## The checklist

1. **Sign the freeze table. [O]** The owner accepts or rejects each drop, rename
   and type change in `docs/prisma/02-schema-freeze-and-migration-cutover.md`.
2. **Take a manual dump and prove it restores, before any shape change. [O]**
   On the Free plan there are no automatic backups (`supabase.md`), and the
   freeze table can approve drops and type changes, so the push in step 3 has no
   other way back. Confirm the plan, run `pg_dump`, and restore the dump into a
   scratch container to prove it is usable.
3. **Land the shape changes with the last guarded `db push`. [O]** Run
   `npm run db:push` once, through its preflight, so the live database matches the
   frozen `prisma/schema.prisma`.
4. **Push freeze and zero-drift proof. [O]** Stop all pushes. Run
   `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
   and `npx tsx scripts/ci/check-db-live-drift.ts`; the only differences allowed
   are the reviewed sidecar entries in `prisma/sql/known-drift.json`.
5. **Rehearse in a scratch container.** Never against the shared database.
   - Build a database from the migration history alone (steps 7 onward, run
     locally) and catalog-diff it against a fresh restore of the live
     database taken after step 3.
   - Atomicity test: apply a migration whose second statement fails and record
     whether the first statement stayed committed. This settles the reported
     per-statement commit (`prisma-mechanics.md`). Then repeat it with the two
     statements wrapped in `BEGIN;` and `COMMIT;` and confirm the first is rolled
     back, which is what the constraint replacements in
     `sidecars-as-migrations.md` rely on.
   - `SET` versus `SET LOCAL` test: apply a migration that sets `lock_timeout`
     each way and read the setting from a second statement in the same file.
   - Partial-index test: declare one partial unique index in the schema and see
     whether `migrate diff` stays clean (`sidecars-as-migrations.md`).
   - `@ignore` test: see how Migrate treats an `@ignore`d column
     (`expand-contract.md`).
   - CI gate test: record the `migrate status` output for a pending-only history
     and for a failed one, and confirm that pgfence passes a `DROP COLUMN` at
     `--max-risk high` and fails it at `--max-risk medium` (`ci-migrations.md`).
6. **Pin the Prisma version and add the guards.** `prisma` and every `@prisma/*`
   package are already pinned exactly to 7.10.1 in `package.json`. Add pgfence
   (`ci-migrations.md`) and the linear-history check (`conflicts.md`). Re-run this
   rehearsal on every Prisma bump.
7. **Generate `0_baseline` plus `migration_lock.toml`, and fold the sidecars into
   an idempotent migration.** Baseline with `migrate diff --from-empty --to-schema`
   (`prisma-mechanics.md`). Add one migration per sidecar object group after it
   (`sidecars-as-migrations.md`), each idempotent, so a rebuilt database has the
   money invariants and the overlap constraint.
8. **`prisma migrate resolve --applied 0_baseline` on live, then
   `prisma migrate status`. [O]** The baseline must be marked applied, not run.
   Do the same for each sidecar migration whose objects already exist.
9. **Create the dev project, deploy and seed. [O]** Follow
   `docs/deployment/db-split-plan.md`: `migrate deploy` builds the dev schema from
   history, then the guarded seed runs against it.
10. **Add the GitHub secrets and merge `db-migrate.yml`. [O]** The design is
    `ci-migrations.md`.
11. **Decide the Netlify ordering. [O]** Pick one of the options in
    `ci-migrations.md`.
12. **Point previews, local and CI at the dev project. [O]** Per the table in
    `docs/deployment/db-split-plan.md`.
13. **Remove `db:push` and rewrite the rules.** Delete the `db:push` scripts and
    the sidecar replay, rewrite root `AGENTS.md` section 2.3 and
    `prisma/AGENTS.md`, and rewrite `this-repo.md` in this skill, in the same
    pull request.
14. **Run the first contract rehearsal.** Use the Referral contract in
    `expand-contract.md` as the first real destructive change.

## When a migration fails

`migrate deploy` stops on the first failure, records the migration as failed, and
every later `migrate deploy` then refuses with `P3009`. If a statement failed
partway, the error is `P3018`. Do not re-run `migrate deploy` hoping it passes.

1. Run `npx prisma migrate status` and note the failed migration's name.
2. Inspect the database to see which of its statements committed. Because of the
   reported per-statement commit, assume some did until the rehearsal proves
   otherwise.
3. Choose the direction:
   - Most of it applied: finish the rest by hand with `psql "$DIRECT_URL"`, then
     `npx prisma migrate resolve --applied <name>`.
   - Little of it applied: undo the committed part by hand, then
     `npx prisma migrate resolve --rolled-back <name>`, fix the file and deploy
     again.
4. Run `npx prisma migrate status`, then `scripts/ci/check-db-sidecars.ts`.

A migration written idempotently with one object per file (`sidecars-as-migrations.md`)
usually needs only the rolled-back path followed by a plain re-run. The CI job
does not retry on its own (`ci-migrations.md`). Source:
[patching and hotfixing](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing).
