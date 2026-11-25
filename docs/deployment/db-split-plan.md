---
type: how-to
---

# Splitting the preview and dev database from production

**Status: not done.** Production, deploy previews, branch deploys and local development all use one Supabase project today. This page is the plan for separating them. The split is gated on two events: the upgrade of the Supabase project to the Pro plan, and the arrival of real customers (owner decision of 2026-10-31, recorded in [the ticker scale-path decision](../decisions/2026-10-31-ticker-scale-path-and-queue.md)). Until both have happened, nobody should follow the steps below.

The [load-test plan](../enterprise/50-operations/11-load-test-plan.md) can only run after this split.

## Why the split exists

A preview runs the branch's code against production's database. The code now stands down where it can: previews refuse every background job, skip the production-only Redis writes, and refuse maintenance changes (see the decision record). The database itself is still shared, so a preview that reads or writes a table still touches production rows, and a load test would load production's connection pooler. The split removes the shared database as a risk instead of managing it in code.

## The two options

| Option                                                        | What it is                                                                                                                             | Cost per month                                                                                                                                                                                                                                                                                | Fit for this repository                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A second Supabase project for previews and dev (preferred) | A new, empty project that holds only synthetic data. Previews, branch deploys and every local `.env` point at it.                      | About $10 for a Micro compute instance. The Pro plan's $10 compute credit covers one Micro instance, and production already uses it, so the second project pays its own compute. A second project in a separate organisation on the Free plan costs $0 but pauses after a week of inactivity. | Works today. The schema is applied with `npm run db:push`, which also applies the `prisma/sql` sidecars, exactly as for production.                                                                                                                                                                                                                                         |
| 2. Supabase branching                                         | A persistent branch of the production project, created and migrated by Supabase, with its own database and its own connection strings. | About $0.01344 per branch-hour, which is about $9.81 for a 730-hour month, for a branch on Micro compute. Compute credits do not apply to branches, and the Spend Cap does not cover them.                                                                                                    | Does not fit yet. A GitHub-connected branch builds its schema from versioned migrations in the repository, and this repository has none: it uses `db push` plus hand-applied sidecars (see the schema freeze document). A dashboard-created branch can start from a schema dump instead, but dashboard branching is in public alpha and gives no per-pull-request database. |

The two options cost about the same, so cost does not decide it. Branching through GitHub needs the migration cutover first, which the owner has deferred until real customer data exists. The second project works now. **Choose option 1.** Revisit branching after the cutover to versioned migrations, because branching then also gives per-pull-request databases.

Sources, read on 2026-10-31:

- Branching billing, including the $0.01344 hourly figure and "Compute Credits do not apply to Branching Compute": <https://supabase.com/docs/guides/platform/manage-your-usage/branching>
- How branching builds a schema from repository migrations, and persistent branches: <https://supabase.com/docs/guides/deployment/branching>
- Micro at about $10 a month with 200 pooler clients and 60 direct connections; Small at about $15 with 400 and 90: <https://supabase.com/docs/guides/platform/compute-and-disk>
- Pro from $25 a month with a $10 compute credit, and branching at $0.01344 per branch-hour: <https://supabase.com/pricing>

One figure disagrees with itself on Supabase's own page: the billing example for branching appears to subtract the $10 credit from a total that includes branch compute, while the FAQ says credits do not apply. Treat the FAQ as authoritative, and confirm with Supabase support before relying on either if the choice ever turns on it.

## Steps for option 1

The owner or a human operator runs every step that writes to a database. No agent runs `db push`, a seed or any DDL (`AGENTS.md` section 2.3).

1. **Create the project.** In the same Supabase organisation as production, create a project in the same region (Mumbai, `ap-south-1`) so a preview's latency to its database matches production's. Choose Micro compute. Name it so nobody mistakes it for production (for example `familiarise-dev`). A Supabase project's region is chosen at creation, and whether production stays in Mumbai is an open decision (issue #2751): if the answer is Singapore, production needs a new project too, and this one should be created in the same region as it.
2. **Create the storage buckets.** Storage keys belong to a project, so the new project needs the same bucket names and policies that production uses (read in `lib/supabase-storage-core.ts`). Without this, previews would keep writing files to production storage.
3. **Record the new connection strings.** Copy the pooled connection string (for `DATABASE_URL`) and the session-mode pooler string (for `DIRECT_URL`) from the new project. `prisma.config.ts` binds the Prisma CLI to `DIRECT_URL`.
4. **Apply the schema and the sidecars.** With only the new project's strings in the shell, run `npm run db:push`. That script runs the push preflight (`scripts/db/preflight-push.ts`), `prisma db push`, then `npm run db:sidecars` (`scripts/db/apply-sidecars.ts --all`), which applies `check-constraints.sql`, `ledger-triggers.sql` and `payment-legs-triggers.sql`, and finally `scripts/ci/check-db-sidecars.ts`, which asserts every named sidecar object exists. Read the Prisma output first: on a database that is empty, the push creates every table.
5. **Check the operator-applied SQL files.** `prisma/sql` also holds `org-data-export-artifacts.sql`, `reconciliation-cursors.sql` and `support-auto-close-progress.sql`. `scripts/db/apply-sidecars.ts` does not run them. The cutover plan says the reconciliation file adds only columns and indexes that `prisma/schema.prisma` already declares, so a fresh `db push` creates those objects. Read `org-data-export-artifacts.sql` and `support-auto-close-progress.sql` against the freshly pushed project and apply any statement whose object is still missing. This plan could not verify that no such statement is missing.
6. **Seed.** Set `DATABASE_URL` to the new project, set `SEED_TARGET_CONFIRM` to the host in that `DATABASE_URL` (`prisma/seed.ts` refuses to run otherwise). The pooler host is shared by every project in the region, so first confirm the project reference in the pooler username (`postgres.<project-ref>`) is the dev project's, not production's, and run `npm run db:seed` (or `db:seed:small` for a lighter set). The seed uses the cast in `prisma/seedFiles/` and takes passwords from `SEED_OPERATOR_PASSWORD` and the other seed variables in `.env.sample`.
7. **Change the environment variables** as the next table says.
8. **Verify** with the checks in the section after the table.

## Environment changes by place

| Place                          | Variables                                                                                             | Change                                                                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Netlify, production context    | `DATABASE_URL`, `DIRECT_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | No change. They stay on the existing project.                                                                                                                                                                                                                          |
| Netlify, deploy-preview        | The same five                                                                                         | New values for the dev project. Netlify scopes each variable by context, so no code changes. Keep `NEXT_PUBLIC_SENTRY_ENVIRONMENT=preview` and a separate `CRON_SECRET` (see [Netlify environment contexts](./netlify.md#environment-variables--whats-there-and-why)). |
| Netlify, branch-deploy         | The same five                                                                                         | New values for the dev project, same as deploy-preview. `dev.familiarisenow.com` is a branch deploy, so it moves to the dev project too.                                                                                                                               |
| Local `.env` in every worktree | `DATABASE_URL`, `DIRECT_URL`, `SEED_TARGET_CONFIRM`, and the Supabase storage variables               | Point at the dev project. Local `next dev` still runs jobs (it is not a deploy), now against the dev database.                                                                                                                                                         |
| GitHub Actions secrets         | `DATABASE_URL`, `DIRECT_URL`                                                                          | The scheduled drift check and the release schema gate must keep reading production. The race-condition suite should move to the dev project, which needs a second secret pair.                                                                                         |
| Upstash Redis                  | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                                  | Optional and separate from this split. Rate-limit buckets, slot locks and the payout and checkout mutexes stay shared between production and previews unless previews get their own Redis database.                                                                    |
| Vendors                        | Razorpay, Stream, Resend, Novu keys                                                                   | The split adds no endpoint. Whether previews use sandbox vendor keys is set in the Netlify UI and cannot be verified from the repository; confirm it before pointing previews at a database that holds test data.                                                      |

Two ordering rules apply. The build prerenders static pages against the database (the `P2022` entry in the Netlify troubleshooting table), so apply the schema to the dev project before the first preview build that reads it. And a build never runs `db push`.

## Verification

1. In the Netlify UI, list the variables per context and confirm that the production and deploy-preview `DATABASE_URL` values name different Supabase projects: the project reference in the pooler username (`postgres.<project-ref>`) and in the `DIRECT_URL` host (`db.<project-ref>.supabase.co`). The pooler host itself is shared by every project in the region, so a matching host proves nothing. Print the references only, never the values.
2. Run `npx tsx scripts/ci/check-db-sidecars.ts` with the dev project's strings. It must pass.
3. Run `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` with the dev project's `DIRECT_URL`. A freshly pushed project should show no difference apart from the sidecar indexes that `db push` would drop.
4. Open a preview, sign in as a seeded user, and book one session. Then check that production's `Appointment` count did not change (read-only query on production).
5. Open `/api/health` on the preview and confirm the database is connected.
6. Confirm that a preview still refuses jobs: `POST /api/cleanup/<job>` with the preview's own `CRON_SECRET` answers 409 `JOB_RUN_PRODUCTION_ONLY`.

## Rollback

The split changes only environment variables, so the rollback restores today's shared posture: set the preview and branch-deploy contexts' variables back to production's values and redeploy. The code refusals (no jobs, no production-only writes off production) still hold while shared; if that posture is not acceptable at the time, turn deploy previews off in Netlify instead and fix the dev project. Do not delete the dev project until a week after the split, so a revert never has to repeat the seed. Production is untouched throughout, so no production rollback exists to perform.

## Related

Issues #2466 and #2460. The migration cutover and its own database-split section are in [the schema freeze and cutover plan](../prisma/02-schema-freeze-and-migration-cutover.md).

## Deprecated & Superseded Approaches

- **Split before launch (2026-10-30).** The earlier decision split the database ahead of launch. It was superseded on 2026-10-31 by the timing above: the shared database stays until customers arrive.
- **Refusing writes in code as the only protection.** The refusals shipped in the preview-isolation change are a mitigation for the shared database, not a substitute for the split. Delete none of them when the split lands: a preview that is mis-pointed at production still needs them.
