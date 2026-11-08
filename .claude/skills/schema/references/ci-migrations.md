# Design: running migrations from CI

This is a design for a future workflow, `.github/workflows/db-migrate.yml`. The
workflow file does not exist and this reference does not add it. Everything below
is **(planned)**. The cutover step that adds it is in `runbook-cutover.md`.

## Triggers

- A push to the release branch, filtered to `paths: prisma/migrations/**`.
- `workflow_dispatch`, used for contract migrations (see below) and for re-runs.

## Job settings

- `permissions: contents: read` and nothing else.
- One concurrency group for the whole workflow with `cancel-in-progress: false`,
  so a second run waits for the first instead of killing a migration midway
  ([control workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)).
- An explicit `timeout-minutes`, so a stuck advisory-lock wait cannot run for the
  default six hours.
- The database URL is the Supabase **session pooler**, because GitHub-hosted
  runners are IPv4-only (`supabase.md`).

## Steps

1. Check out the repository.
2. `npm ci --ignore-scripts`, so no dependency install script runs with the
   database secret in the environment.
3. pgfence, a static analyser for risky Postgres migrations:
   `npx @flvmnt/pgfence analyze --ci --max-risk medium prisma/migrations/**/migration.sql`
   ([Prisma guide](https://www.prisma.io/docs/guides/integrations/pgfence)). It is
   third-party, so pin its exact version.
4. `npx prisma migrate status`, to stop early on a failed or unexpected history.
5. `npx prisma migrate deploy`. If it times out on the 10-second advisory lock
   wait, the run fails and a human re-runs it.
6. `npx tsx scripts/ci/check-db-sidecars.ts`, the post-deploy catalog assertion.

## On failure

Notify ops with `scripts/ci/notify-ops-failure.sh`. Do not retry automatically:
a retry of a half-applied migration can make it worse. Recovery is a human
running `prisma migrate resolve` after inspecting the database
([patching and hotfixing](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing);
the failure procedure is at the end of `runbook-cutover.md`).

## No approval environments, so the folder name is the gate

GitHub Free cannot configure deployment environments with required reviewers on
a private repository
([managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)),
and this organisation is on the free plan. So the approval for a destructive
migration is built from what Free does offer:

- A destructive (contract) migration carries the folder suffix `_contract`, for
  example `20261201090000_drop_referral_reward_columns_contract`.
- The push-triggered job **refuses** to apply a pending `_contract` migration and
  fails with a message naming it.
- Only a `workflow_dispatch` run, with the migration folder name typed into an
  input that must match, applies it. Dispatch requires write access to the
  repository, and that is the approval.

Enforcer: the first step of the job compares pending folders with the typed input
and exits non-zero on any mismatch. This check is planned with the workflow.

## One database serves dev and prod

While a single database serves both environments (`this-repo.md`), a migration
merged to `dev` reaches production immediately, because the push trigger runs on
the release branch that feeds it and the database is the same. So:

- Only **expand** migrations may run on the `dev` merge.
- A **contract** migration runs only after the release that stopped using the
  object is live and drained (`expand-contract.md`).
- After the database split (`docs/deployment/db-split-plan.md`), `dev` migrates
  the dev project and the release branch migrates production.

## Ordering against Netlify

Netlify can lock production auto-publish, so a build can finish without going
live ([deploy overview](https://docs.netlify.com/deploy/deploy-overview/)). Whether
a Netlify build can be made to wait for an Actions job is UNVERIFIED. The options
to evaluate in the rehearsal:

1. Migrate first (expand-only), then let Netlify build and publish. Safe because
   expand migrations are N-1 compatible, so the old code keeps working.
2. Lock auto-publish and publish by hand after the migration job is green.
3. Trigger the Netlify build from the end of the migration job (a build hook).
   Whether this fits the hot-standby arrangement in `docs/deployment/README.md`
   is UNVERIFIED.

Option 1 needs no Netlify change, which is why the runbook prefers it.

## Sources

- [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) and [environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
- [pgfence with Prisma](https://www.prisma.io/docs/guides/integrations/pgfence).
- [Patching and hotfixing (v7)](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing).
- [Netlify deploy overview](https://docs.netlify.com/deploy/deploy-overview/).
