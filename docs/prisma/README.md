# Prisma and database schema documentation

This directory holds everything about the database schema: the general reference
for Prisma Migrate, the plan that takes this database from its current `db push`
posture to versioned migrations, and the model-by-model map of the schema itself.

Start here rather than in an individual file, because which document applies
depends on whether you are reasoning generally or working in this repository.

The numeric prefixes are reading order, following the convention used elsewhere
under `docs/`. They run from orientation through general reference to the
launch plan.

| Document                                    | What it is                                                                                                                                                                                                                                      | Read it when                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `00-schema-map.md`                          | Twenty-four domain diagrams of the Prisma schema, plus the enum reference table.                                                                                                                                                                | Orienting in an unfamiliar part of the schema, or tracing how two models relate.                                           |
| `01-migrations-guide.md`                    | The general-purpose reference for Prisma Migrate — every command, safe and dangerous operations, expand and contract, drift, rollback, troubleshooting. Written against a fictional schema so it stays portable.                                | You need to know what a Prisma command does, or how a class of change is handled in general.                               |
| `02-schema-freeze-and-migration-cutover.md` | The pre-launch plan: freeze the schema shape, baseline the live database, fold the SQL sidecars into migrations, split dev from prod, the CI drift gate, post-launch expand and contract, and the table of freeze candidates the owner decides. | You are planning or running the cutover, deciding whether a column survives the freeze, or asking why `db push` is banned. |

## The one thing to know first

This repository does not use versioned migrations yet. There is no
`prisma/migrations` directory, no `_prisma_migrations` table, and nothing for
`prisma migrate deploy` to apply. The schema is managed with `prisma db push`,
and the constraints and triggers that `db push` cannot express are applied
separately from `prisma/sql/` and asserted by `scripts/ci/check-db-sidecars.ts`.

That means `01-migrations-guide.md` describes the world this repository is moving
towards rather than the one it is in. Its command reference and its treatment of
safe and dangerous operations apply in full; its workflow chapters apply after
the cutover.

Because one Postgres project serves both development and production, every push,
seed and data script is a production operation. The current schema is also
frozen: additive changes only, with renames, drops and type changes deferred to
launch cutover. Both rules are stated at the top of `prisma/schema.prisma` and
enforced in review.

Agents read the live database freely through the Supabase MCP, batching
several reads into one `execute_sql` call. Every write or DDL statement needs
the owner's approval in the session: the `.claude/hooks/supabase-sql-gate.ts`
hook lets a provably read-only batch through and prompts, naming the statement
type, for anything else (in bypass-permissions mode it blocks the call until
the owner leaves that mode). Schema changes still go through
`prisma/schema.prisma`, the human-run `db:push` preflight and the sidecars; MCP
DDL is only for an owner-approved emergency. The shared `.mcp.json.example`
entry stays `--read-only` and project-scoped. Rules: `prisma/AGENTS.md`;
decision: [Supabase MCP SQL approval hook](../decisions/2026-11-07-supabase-mcp-sql-approval-hook.md).

The same database also serves every Netlify **deploy preview**, and that is the
constraint that catches people out: a preview runs the _branch's_ code against
the _live_ database, so a branch whose schema declares a column the database
does not have deploys a preview that 500s on every read of that model. Nothing
in the build sees it, because the build only generates the Prisma client.

## Pushing schema to the shared database: lessons from the catch-up push

The live database once fell several changes behind `prisma/schema.prisma` and stayed there for days: a whole earlier schema change (new columns, foreign-key `Restrict` swaps, partial uniques, a CHECK) was merged but never pushed, and production readers that selected a missing column returned 500. The catch-up push of 2026-10-09 closed it, and its lessons now bind every push.

1. **The order is fixed: preflight, push, sidecars, assert.** `npm run db:preflight -- --print` shows the plan Prisma is about to run, `db:push:schema` chains the preflight ahead of `prisma db push` and then applies the sidecars, and `npm run db:push` finishes by running `scripts/ci/check-db-sidecars.ts`, which confirms every named sidecar object exists. A plain `prisma db push` skips all of this and drops the sidecar partial uniques, because the schema omits them by design. These are human-run commands; an agent never runs them.
2. **Prisma's own AI-consent guard is a feature.** The Prisma CLI detects that it is being driven by an AI agent and refuses destructive actions unless the human explicitly consents to that specific action. Do not work around it: the destructive statements (dropped columns, foreign-key swaps, unique replacements) are exactly the ones a person must read and approve.
3. **Destructive statements are allowlisted per push, then removed.** The preflight refuses any plan statement that destroys or re-points an existing object unless that exact statement is listed in `prisma/sql/known-drift.json` under `destructiveStatementsAllowed` with an owner and expiry. After the push the list is emptied again, so a populated list always means a push is pending. A divergence that must not be removed yet belongs under `knownDivergences` instead, which the daily drift check tolerates and the preflight does not — see [the legacy drift currently carried](#the-legacy-drift-currently-carried).
4. **Check drift read-only before and after.** `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` lists what a push would do. After a clean push the only statements left are the three sidecar-owned partial-unique drops (`appointment_feedback_level_key`, `consultant_earnings_occurrence_key`, `organization_earnings_split_key`), which are expected.
5. **The daily drift check needs a sink outside Sentry.** `db-live-drift.yml` compares the live database to the schema every day, but a failure that can reach only Sentry is silently dropped when the error quota is exhausted. See [the ingest canary](../observability/sentry/06-ingest-canary.md#the-scheduled-drift-check-needs-a-sink-outside-sentry).
6. **Pending schema in a merged PR breaks readers invisibly.** A column the code selects but the database lacks fails every full-row read of that model (a `P2022`), and nothing in `tsc` or the unit tests sees it. Push before, or together with, the deploy that reads the column, and smoke-test one full-row reader of each changed model.

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

**The release gate.** `check-db-schema-required.ts --live` is the same check pointed at the whole schema instead of the merge-base diff. It runs `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` (read-only, needs `DIRECT_URL`; the catalog read uses the same `DIRECT_URL`) and fails when the schema declares a table, column, enum type or enum value the live database lacks. It ignores the other direction and the sidecar objects in `prisma/sql/*.sql`. It runs as the "Release schema gate" job (`release-schema-gate`) in `.github/workflows/db-live-drift.yml` on pull requests into `prod` from branches of this repository; a fork's pull request gets no run. GitHub Free has no branch protection on private repositories, so it cannot be a required check: the release cutter runs `npx --no-install tsx scripts/ci/check-db-schema-required.ts --live` locally before opening the `prod` pull request and pastes the output into its body, and once Actions runs the job is the record. When it fails by listing objects the live database lacks, the human runs the push preflight and push first; when it fails because it could not compare (a missing URL, a failed diff or catalog read), fix that cause and re-run. On 2026-10-31 the live database was ahead of the schema, which the gate ignores: the `DigitalProduct*` tables and enums, and `RecordingPurchase.reconciledAt` with its index.

The other direction — the database carrying objects the schema does not want —
is deliberately **not** checked. That is the reconcile push's business, it is
not a runtime failure, and a live-database check in both directions blocks every
schema-bearing pull request. That is what retired the earlier
`check-db-drift.ts`; see the deprecated section below.

When it fails, it prints the DDL to apply. Applying it is a decision, not a
formality: the columns are additive, so applying them before the deploy that
reads them is safe, and the merge-time push then has nothing left to do.

### The legacy drift currently carried

`prisma/sql/known-drift.json` records the statements the live database and the
schema disagree about, each with an owner, a reason and an expiry. It holds
them in **two lists**, because tolerating a divergence and permitting its
removal are not the same decision.

| List                           | Read by               | Means                                                              |
| ------------------------------ | --------------------- | ------------------------------------------------------------------ |
| `destructiveStatementsAllowed` | `db:preflight`        | a statement a reconcile push **may run**                           |
| `knownDivergences`             | the daily drift check | a divergence the database carries that must **not** be dropped yet |

The daily drift check tolerates both, so the job reports what is pending
instead of failing on it every morning. The preflight honours only the first,
so a push cannot drop something that is not yet safe to drop. The two lists
currently hold:

- **`knownDivergences` — the pre-#2257 support-ticket tables** (20 statements):
  `SupportTicket`, `SupportMessage`, `SupportResponse`, `SupportTicketAttachment`,
  `AppointmentSupportThread`, `support_ticket_counters` and their enums. `dev`
  replaced them with the `SupportCase` family, but `origin/prod` does not carry
  #2257 yet and still queries them, so they were re-created empty as a
  stop-gap. **They are not dead, and dropping them before `dev` is promoted to
  `prod` re-breaks the SLA sweep, the privacy export and staff support
  metrics.** Tracked in #2271. This is why `npm run db:preflight` still refuses
  a push: correctly.
- **`knownDivergences` — the four booking enum swaps of the lifecycle PR**
  (`DROP TYPE "public"."<X>Status_old"` for `ClassStatus`, `WebinarStatus`,
  `RequestStatus` and `TrialStatus`). The branch removes `IN_PROGRESS` from
  webinars and classes, `SCHEDULED` from consultations and plans, and `PENDING`
  and `REJECTED` from trials, but `origin/prod` still filters on `IN_PROGRESS`
  and creates trials as `PENDING`, so the swap waits for the release. That pull
  request therefore merges **without a push**; until the reconcile push that
  follows the `dev` → `prod` promotion, the database keeps the extra enum values
  and the `Trial.status` default of `PENDING`. The new code must never meet a row
  holding a removed value: on 2026-11-13 no row held one (the four webinars,
  three classes and two trials that did were moved first), and the branch writes
  none. Production keeps creating trials as `PENDING` until the release, so
  the read below runs before the merge, before the promotion and before the
  push. The rest of each swap (the `BEGIN`/`COMMIT` wrapper,
  `CREATE TYPE …_new`, the column retypes and renames, and the `Trial.status`
  default drop) is listed there too, so the daily drift check stays green while
  the swap waits. Move the four `DROP TYPE` entries to
  `destructiveStatementsAllowed` once the release is on prod, then preflight,
  push, sidecars, assert, and delete every `#2746` entry.
- **`knownDivergences` — the no-show report columns of #3036** (2 statements):
  `SupportCase.flowReason`, `SupportCase.flowReasonAt` and
  `SupportCase_appointmentOccurrenceId_idx`. They are live in the shared
  database ahead of #3036's schema so its preview runs, and dropping them would
  delete its report answers. The pull request that merges that schema deletes
  both entries.
- **`destructiveStatementsAllowed` — the pre-#2041 recording-storage columns and
  their enum, plus six indexes the schema no longer declares** (13 statements).
  No schema declares them and no code reads them, so they are dead and a push
  may remove them.

#### Rows holding a removed value

Run this read (Supabase MCP `execute_sql` is read-only and needs no approval)
before the lifecycle PR merges to `dev`, before the `dev` → `prod` promotion
and before the push that drops the enum values. It names the mapped tables and
columns (`Consultation` and `Subscription` store the status as `requestStatus`):

```sql
SELECT 'Trial' AS "table", "id", "status"::text AS "value" FROM "Trial" WHERE "status"::text IN ('PENDING', 'REJECTED')
UNION ALL SELECT 'Consultation', "id", "requestStatus"::text FROM "Consultation" WHERE "requestStatus"::text = 'SCHEDULED'
UNION ALL SELECT 'Subscription', "id", "requestStatus"::text FROM "Subscription" WHERE "requestStatus"::text = 'SCHEDULED'
UNION ALL SELECT 'Webinar', "id", "status"::text FROM "Webinar" WHERE "status"::text = 'IN_PROGRESS'
UNION ALL SELECT 'Class', "id", "status"::text FROM "Class" WHERE "status"::text = 'IN_PROGRESS';
```

It returned no rows on 2026-11-13. A row is never edited by hand. A `PENDING`
trial is cancelled by an operator through `DELETE /api/trials/[trialId]` on the
production deploy, which still understands it and refunds a paid one in full
(an operator's cancel counts as the expert's side). Any other row stops the
step for the owner: a `REJECTED` trial is already ended and has no door, and no
cancel step is written for the rest
([decision 8](../decisions/2026-11-13-product-lifecycles.md#decisions)).

#### A refund the deleted retry still owed

At the same three points, run this read too. It lists a cancelled paid trial
that the old unanswered-trial sweep cancelled (history reason
`TRIAL_UNANSWERED`) and whose keyed full refund is missing or failed:

```sql
SELECT t."id", t."paymentId"
FROM "Trial" t
WHERE t."status"::text = 'CANCELLED' AND t."paymentId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "BookingStatusHistory" h WHERE h."entity"::text = 'TRIAL' AND h."entityId" = t."id" AND h."reason" = 'TRIAL_UNANSWERED' AND h."toStatus"::text = 'CANCELLED')
  AND NOT EXISTS (SELECT 1 FROM "Refund" r WHERE r."dedupeKey" = 'trial-unanswered:' || t."paymentId" AND r."status"::text NOT IN ('FAILED', 'CANCELLED'));
```

It returned no rows on 2026-11-13. If a row exists, run the old
`expire-unpaid-trials` job once on production before the promotion (System Jobs,
or its `CRON_SECRET` cleanup route); its retry sends the keyed full refund. That
retry looks back 14 days, so a row cancelled earlier goes to the owner.

The reconcile push is therefore sequenced behind the `dev` → `prod` promotion:
move the 20 entries from `knownDivergences` to `destructiveStatementsAllowed`,
preflight, push, sidecars, assert, then empty both lists again.

### Additive columns waiting for the next push

The booking and scheduling hardening added seven nullable columns and no
sidecar change. They are purely additive, so `npm run db:preflight -- --print`
should list seven `ADD COLUMN` statements for them and nothing destructive, and
they can be pushed before the deploy that reads them. No backfill is written
(doctrine: no backfill migrations); every reader treats `NULL` as a row written
before the column existed:

| Column                               | Type          | Written by                                          | Reader fallback when `NULL`                                                                                                                      |
| ------------------------------------ | ------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Subscription.planEndsAt`            | `timestamptz` | Subscription creation (the fixed plan end)          | `subscriptionPlanEnd` (`lib/booking/entitlement.ts`) derives it from `schedulingPeriodStartsAt` plus `durationInMonths` in `schedulingTimezone`. |
| `Payment.requestFingerprint`         | `varchar(64)` | Checkout's payment row (the priced inputs' hash)    | An idempotent replay skips the fingerprint comparison and replays as before (`lib/payments/operations/checkout-replay.ts`).                      |
| `RescheduleRequest.releasedSessions` | `jsonb`       | The reschedule release (ordinal and start per slot) | `countedReleases` (`lib/booking/released-sessions.ts`) skips the row, so it neither costs a reschedule nor floors a refund notice.               |
| `RescheduleRequest.originStatus`     | `varchar(32)` | The reschedule release (the parent's prior status)  | The restore reads the release's `PENDING` history row instead (`lib/booking/reschedule-restore.ts`).                                             |
| `RescheduleRequest.restoredAt`       | `timestamptz` | A withdraw, decline or expiry that restored         | Read as "not restored"; a legacy row has no release record, so it is not counted anyway.                                                         |
| `Webinar.retimeBy`                   | `timestamptz` | A webinar re-time (the end of the free leave)       | No free leave is open; seat leave applies its normal refund window (`lib/booking/retime-leave.ts`, `lib/booking/seat-leave.ts`).                 |
| `Class.retimeBy`                     | `timestamptz` | A class make-up (the end of the free leave)         | The same as `Webinar.retimeBy`.                                                                                                                  |
| `Consultation.requestFingerprint`    | `varchar(64)` | The request door (the submitted request's hash)     | A same-key retry compares the held times, as before (`app/api/scheduling/request-for-approval/route.ts`).                                        |

`Consultation.requestFingerprint` (the allocation and reschedule branch) cannot wait for a push: the four enum swaps above keep `db:push` refused, so it is applied alone with the statement `scripts/ci/check-db-schema-required.ts` prints, `ALTER TABLE "Consultation" ADD COLUMN "requestFingerprint" VARCHAR(64);`, before the branch's deploy reads it; then re-run that check and open one consultation detail page.

After the push, smoke-test one full-row reader of each of the five models
(lesson 6 above): a subscription detail, a checkout replay, a reschedule
withdraw, and a webinar and a class detail page.

## Related material

The portable doctrine behind all of this — the change catalog with lock classes,
the expand and contract playbooks, the deploy ordering rules — is the `/schema`
skill in `.claude/skills/schema/`. Its `references/this-repo.md` is the short
version of this page for an agent that is about to edit the schema.

Keeping the seed suite in sync with a schema change is covered by the
`/maintenance` skill. The money invariants that the sidecars enforce, and why
they cannot live in the Prisma schema, are covered by `/finance`.

---

## Deprecated & Superseded Approaches

- **Two-copy SQL sidecar duplication (`apply-sidecars.ts` inline regex arrays + `prisma/sql/*.sql`)**: Previously, sidecar constraint names were hardcoded in multiple verification scripts while SQL definitions lived in `prisma/sql/*.sql`. Superseded by a single parser (`scripts/db/sidecar-objects.ts`) that derives all expected `CHECK` constraints, partial unique indexes, exclusion constraints, and triggers directly from `prisma/sql/*.sql`.
- **Whole-schema live-DB drift blocking feature PRs**: Running `check-db-drift.ts` against the shared live database inside PR checks blocked unmerged schema/auth PRs whenever a branch added an enum label or column not yet pushed to live Postgres. Superseded by running `prisma db push` + `apply-sidecars.ts` + `check-db-drift.ts` against a hermetic `postgres:17` service container in `ci.yaml` on PRs, while keeping `.github/workflows/db-live-drift.yml` as a read-only live-DB monitor on `dev`/cron. What was retired is the WHOLE-schema comparison in both directions; a narrower check — this branch's own delta against the live catalog — now runs on pull requests as `scripts/ci/check-db-schema-required.ts`, because the blocking came from the database carrying objects the schema does not want, not from the branch's new objects being absent.
- **One-off constraint swap & migration logs (`scripts/db/swap-occurrence-overlap-constraint.ts`, `02-pre-mvp-reset-runbook.md`, `03-cutover-to-migrations.md`, `04-prisma-7-migration.md`)**: Retired after the Prisma 7 adapter cutover (`@prisma/adapter-pg` in `lib/prisma.ts`) and `occurrence_no_confirmed_overlap` GiST constraint were finalized in `prisma/sql/check-constraints.sql` (it covers only confirmed, non-tentative, live host rows). Do not recreate standalone migration scripts outside `prisma/sql/*.sql`.
