# ADR: Schema freeze and the cutover from `db push` to versioned Prisma migrations

- **Status**: Accepted (owner decisions, 2026-11-09). Items marked **(shipped)** land in the cutover pull request (`feat/migration-cutover`); **(planned)** items are later steps of the Session F tracker, issue #2700 "Session F tracker: migration cutover, live practice reset, and the pre-launch schema freeze"; **(deferred)** items wait for the owner.
- **Date**: 2026-11-09
- **Author**: Platform engineering
- **Related**: [Schema freeze and migration cutover](../prisma/02-schema-freeze-and-migration-cutover.md), [Prisma docs index](../prisma/README.md), the schema skill's `references/multi-session-workflow.md` and `references/runbook-cutover.md`

## Context

One Supabase project serves development, every deploy preview and production. Until
this decision its schema was managed with `prisma db push` plus hand-applied SQL
sidecars in `prisma/sql/`, so there was no migration history, no review surface for
generated SQL, and every push was a production write. The database holds mock data
only (pre-MVP: 94 users, 254 payments, 184 tables, 190 MB, no `_prisma_migrations`
table), which makes this the cheapest moment to freeze the long-term shape and to
practise every live mechanic before real customers exist.

## Decisions

### How the database is managed

1. **Every schema change is a reviewed migration (shipped).** `prisma/migrations/`
   holds `0_baseline` (generated from `prisma/schema.prisma` by
   `scripts/db/generate-baseline.sh`) and hand-written migrations for every object the
   schema cannot declare. `db:push`, `db:push:schema`, `db:preflight`, `db:sidecars`,
   `db:constraints`, `db:triggers`, `db:leg-triggers`, `db:migrate`,
   `scripts/db/preflight-push.ts`, `scripts/db/apply-sidecars.ts` and `prisma/sql/` are
   deleted.
2. **Reset and rebuild, not baseline in place (planned, Phase 2).** Because the data is
   mock, the live database is dumped, upgraded to Postgres 17, its Prisma-owned objects
   in `public` dropped, and rebuilt by `migrate deploy` from the history, then seeded.
   No `migrate resolve --applied`: `_prisma_migrations` records real applications from
   the first day.
3. **CI applies migrations; Netlify is unchanged (shipped).** `.github/workflows/db-migrate.yml`
   runs `migrate deploy` on a push to `dev` that changes `prisma/migrations/**`, through
   the Supabase session pooler. Expand migrations apply on merge.
4. **Contracts apply only by dispatch (shipped).** A destructive migration's folder ends
   in `_contract`; the push run refuses it, and only a `workflow_dispatch` whose input
   names the folder exactly applies it. GitHub Free has no environments with required
   reviewers on a private repository, so dispatch (write access) is the approval.
5. **Every migration is transaction-wrapped (shipped).** `BEGIN; SET LOCAL
lock_timeout = '3s'; … COMMIT;`, except a file holding one `CONCURRENTLY` statement.
   Rehearsed on 2026-11-09: Prisma 7.10.1 `migrate deploy` commits each statement on its
   own (prisma/orm#30640), the wrapper restores atomicity, `SET LOCAL` needs the wrapper,
   and a plain `SET` leaks into later migrations. `scripts/ci/check-migrations.ts`
   enforces it.
6. **The Data API roles get nothing (shipped, P0).** `20261109000001_revoke_data_api_grants`
   replays the `anon`/`authenticated` REVOKE and default-privileges block straight after
   the baseline, so a rebuilt table is never readable with the anon key. It is guarded by
   a `pg_roles` check so it also runs on hosts without those roles; CI creates the roles
   first so the real branch runs there. `check-db-sidecars.ts` fails on any table grant
   to either role.
7. **`btree_gist` lives in the `extensions` schema (shipped).** Clears the Supabase
   advisor `extension_in_public`; the exclusion constraints still resolve the operator
   class. The 13 trigger functions pin `SET search_path = public`
   (`function_search_path_mutable`).
8. **The shadow database is CI-only (shipped).** `prisma.config.ts` reads
   `SHADOW_DATABASE_URL`; it is never a Supabase project.
9. **Postgres 17 (planned, Phase 2; CI shipped).** Live is 15.8 with an unused `pgjwt`.
   The owner dumps live, disables `pgjwt`, and upgrades to the latest 17 in the dashboard
   before the reset; if the Free-plan upgrade is unavailable, stay on 15 and pin CI to 15. CI's database steps run `postgres:17.6` (Supabase's minor) in UTC; local
   rehearsals use Homebrew 17.11 with `timezone = 'UTC'`.
10. **Stay on Prisma 7.10.1, pinned exactly.** Prisma 8 (release candidate, drops
    `schema.prisma`, `db push` and `migrate dev`) is evaluated after it reaches GA, as a
    P3 issue.
11. **pgfence is not adopted yet.** It was optional; its `--max-risk` behaviour was not
    rehearsed, so the `_contract` folder gate is the only destructive-change control.

### The freeze (planned, Phase 3, each PR a real migration)

12. **Accept every DROP and KEEP row of the freeze table** in
    `docs/prisma/02-schema-freeze-and-migration-cutover.md` section 9, re-audited for
    schema added since 2026-10-23, plus the extra drops `Subscription.lastRolledAt` and
    `rollPausedAt`, `OrganizationInvoice.fxRateUsed`, `Meeting.passcode` and `hostKeys`,
    `OrgWorkspaceProfile.notificationRoutingMode`, `OrganizationPayout.dtaaRateApplied`,
    and the `RegularTime` and `PlanEndChoice` models.
13. **Clean slate inside the freeze.** `Timestamptz` on every naive `DateTime` (the
    `jest.db` seat tests fail under a non-UTC session time zone, which is the evidence);
    single-direction foreign keys (drop the five `User.*ProfileId` mirrors while
    `session.user.xProfileId` keeps its shape through better-auth `customSession`; drop
    `Organization.billingAccountId` and keep `BillingAccount.ownerOrgId` as a real FK);
    money and rate renames to `*Paise` and `*Bps`. No uuid v7 primary-key conversion;
    new models may use `uuid(7)`.
14. **From the full-schema audit:** a `PaymentMethod` enum for the instrument;
    `onDelete: Restrict` on every money or compliance child FK, with purchases added to
    the user-deletion guard; drop `PaymentGateway.DODO_PAYMENTS` and `CARD` (keep
    `STRIPE` as a historical label); `LedgerTransaction.paymentId` becomes a real FK;
    about twenty integral FKs, actor and audit ids stay soft; a nullable
    `RecordingPurchase.paymentId` FK; the dead organisation and profile columns,
    write-only stamps and dead enums go; `Organization.defaultRefundPolicy` goes unless a
    reader is found; `creditBudgetPaise`; honest nullability; placeholder defaults out;
    about 48 redundant indexes removed; `DiscountCode.discountValue` splits into
    `percentBps` and `amountPaise`.
15. **The Referral contract drill** drops `ReferralCode.referrerReward` and
    `refereeReward` and the `ReferralStatus` values `QUALIFIED`, `REWARDED` and
    `FRAUDULENT` over four steps: stop reading, `@ignore`, a dispatched `_contract`
    migration that remaps `QUALIFIED` to `QUALIFYING` and `REWARDED` to `VESTED`,
    recreates the enum and drops the columns in one transaction, then
    `migrate diff --exit-code` exits 0.
16. **Packing:** five pull requests (F1 drops, F2 relations and types, F3 payment
    renames, F4 plan and billing renames, F5 the referral drill), each under 150 files,
    none stacked, merged one after another.

### Deferred

17. **Row-level security (deferred; the owner asked to be reminded at the end).** The
    app connects as `postgres`, which has `BYPASSRLS`, so enabling RLS with no policies
    cannot break it; the test on the rebuilt database decides.

## Consequences

- A merge to `dev` that carries a migration changes the production database the same
  minute, so only expand migrations may merge freely. A dispatched contract breaks
  `prod`'s older code until promotion; pre-launch that window is accepted and recorded.
- `migrate status` does not notice an edited applied migration or migrations present
  only in the database (rehearsed), so the git-based `check-migrations.ts` is the guard
  for history integrity.
- The baseline is regenerated from the final `dev` schema after the in-flight schema
  pull requests land, then frozen once the live database has applied it.
- The GitHub secret `DIRECT_URL` (the session pooler) must exist before the cutover
  merges, or the owner runs the first `migrate deploy` by hand from the merged commit.

## Evidence (rehearsal, 2026-11-09, Postgres 17.11, TimeZone UTC)

| Check                                                                           | Result                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `migrate deploy` of 20 migrations on an empty database                          | All applied, 1.35 s                                                                                                                                                |
| `check-db-sidecars.ts`                                                          | 170 objects present (113 constraints, 44 indexes, 11 triggers, 1 view, 1 RLS table); no Data API table grants                                                      |
| `CI=true jest -c jest.db.config.ts`                                             | 56 suites, 246 tests passed, 126 s                                                                                                                                 |
| `migrate diff --from-migrations … --to-schema …`                                | Only the three `NULLS NOT DISTINCT` index drops the schema cannot declare                                                                                          |
| Catalog diff against a database built the old way                               | Constraints, indexes, triggers, views, enums, columns and grants identical; intended deltas only (search_path pins, extension schema, one RLS flag, history table) |
| Gate: pending-only, failed, unreachable, contract with no / wrong / exact input | proceed, stop, stop, refuse / refuse / proceed                                                                                                                     |
| Wrapped failing migration                                                       | Fully rolled back; `P3009` on redeploy; `resolve --rolled-back` then redeploy succeeded                                                                            |
| Drop the app objects of an old-style database, then `migrate deploy`            | 0.22 s drop; `btree_gist` moved to `extensions`; catalog identical to a fresh build                                                                                |
| `@ignore` on a column                                                           | Field gone from the client; no drop proposed                                                                                                                       |

## Deprecated & Superseded Approaches

- **`db push` plus owner-applied sidecars** as the way the shared database is changed,
  with `prisma/sql/known-drift.json` as the allowlist of tolerated drift.
- **Baselining live with `migrate resolve --applied`**, the plan before this decision;
  superseded by the reset and rebuild while the data is mock.
