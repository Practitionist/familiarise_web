# Running migrations from CI

`.github/workflows/db-migrate.yml` is the only path by which a migration reaches the
shared database. This reference explains what it does and why; the session-side
procedure is `multi-session-workflow.md`.

## Triggers

- A push to `dev`, filtered to `paths: prisma/migrations/**`. A merge that carries no
  migration does not start it.
- `workflow_dispatch` with one input, `migration`: the exact name of a pending
  `_contract` folder, or empty to apply expand migrations only (a re-run after a fix).

## Job settings

- `permissions: contents: read` and nothing else.
- One concurrency group (`db-migrate`) with `cancel-in-progress: false`, so a second
  run waits for the first instead of killing a migration midway
  ([control workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)).
- `timeout-minutes: 15`, so a stuck lock wait cannot run for the default six hours.
- `DIRECT_URL` (and `DATABASE_URL`, for the catalog check) is the GitHub secret holding
  the Supabase **session pooler** string, because GitHub-hosted runners are IPv4-only
  (`supabase.md`) and DDL needs session mode.

## Steps

1. Check out the repository.
2. `npm ci --ignore-scripts`, so no dependency install script runs with the database
   secret in the environment, then `prisma generate` for the catalog check.
3. **The gate**, `scripts/ci/migrate-gate.ts`. Prisma 7 `migrate status` exits 1 both
   when migrations are pending and when something is wrong, so the gate reads the
   output: it proceeds on exit 0 with `Database schema is up to date!` or on exit 1
   whose only content is the `Following migrations have not yet been applied:` list,
   and stops on a failed migration, an `Error:` line (for example `P1001`) or any
   output it does not recognise. Then the contract rule (below). The exact strings
   were pinned in the 2026-11-09 rehearsal and are tested in
   `__tests__/db/migration-gates.test.ts`.
4. `prisma migrate deploy`.
5. `prisma migrate status`, which must now exit 0.
6. `scripts/ci/check-db-sidecars.ts`, the post-deploy catalog assertion: every object
   the migrations after the baseline declare, and no table grant to `anon` or
   `authenticated`.

pgfence was considered as a static risk analyser for the pending files and is not
adopted: its `--max-risk` behaviour was never rehearsed, and the folder gate below is
the destructive-change control.

## On failure

`scripts/ci/notify-ops-failure.sh "db-migrate"` notifies ops. Nothing retries on its
own: a retry of a failed migration only hits `P3009`. Recovery is a person running
`prisma migrate resolve` after inspecting the database (`runbook-cutover.md`, "When a
migration fails").

## No approval environments, so the folder name is the gate

GitHub Free cannot configure deployment environments with required reviewers on a
private repository
([managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)),
and this organisation is on the free plan. So the approval for a destructive migration
is built from what Free does offer:

- A destructive (contract) migration carries the folder suffix `_contract`, for
  example `20261201090000_drop_referral_reward_columns_contract`.
- The push-triggered run **refuses** while any `_contract` folder is pending, naming it.
- Only a `workflow_dispatch` run whose input equals the pending folder name applies it.
  An input that is not a `_contract` folder, or not pending, is refused too. Dispatch
  requires write access to the repository, and that is the approval.

`migrate deploy` applies every pending migration in order and cannot skip one, so a
pending contract blocks every later expand until it is dispatched.

## One database serves dev and prod

While a single database serves every environment (`this-repo.md`), a migration merged
to `dev` reaches production immediately. So only **expand** migrations may run on the
`dev` merge, and a **contract** runs only after the release that stopped using the
object is live, dispatched right before the promotion that needs it. After the
database split, `dev` migrates the dev project and a second job migrates production at
promotion.

## Ordering against Netlify

Netlify is unchanged: the migration applies first (expand-only, so N-1 compatible) and
Netlify builds and publishes on its own. The alternatives (locking auto-publish and
publishing by hand, or triggering the build from the end of the migration job) were not
needed, because an expand migration never breaks the code already running.

## Sources

- [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) and [environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
- [Prisma CLI reference (v7)](https://www.prisma.io/docs/orm/v7/reference/prisma-cli-reference) — `migrate status` exit codes.
- [Patching and hotfixing (v7)](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing).
