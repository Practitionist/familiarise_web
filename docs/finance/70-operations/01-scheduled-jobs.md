---
title: Scheduled money jobs
type: reference
band: 70-operations
audience: sde3
status: live
last-reviewed: 2026-10-23
---

# Scheduled money jobs

Every recovery sweep, reconciler and batch job that touches money is run by one scheduler: the Netlify scheduled function `netlify/functions/cron-tick.mts`. It wakes every five minutes, decides which jobs are due, and calls each job's HTTP twin under `/api/cleanup/<slug>`. A job has exactly one implementation function, registered in `lib/cron/cleanup-registry.ts`; the same function is what the admin console and the hand-run `curl` below reach. This page lists the money jobs, when each one runs, how large a bite it takes, and whether a DEGRADED maintenance window holds it.

## How a tick works

1. **The fleet switch.** The tick first reads the Upstash key `ops:active_cron_platform` (one REST `GET`, one-second timeout, `otherActivePlatform` in `cron-tick.mts`). If the key names a platform other than `netlify`, the tick logs `skipped` and fires nothing, so a standby Netlify never double-fires jobs while another host is active. An absent key, missing credentials, a timeout or an unreadable reply all mean "run".
2. **Selection.** `dueTargets` picks the jobs due at this minute from three tables in the same file: `TARGET_EVERY_MINUTES` (the interval), `TARGET_OFFSET_MINUTES` (the phase inside the interval) and `TARGET_WINDOWS` (the UTC calendar window a batch job may run in). At most `MAX_TARGETS_PER_TICK` jobs fire on one tick; the cadence test pins that number, and a new job must be placed on a slot that keeps every tick under it (the cap is 12 and the busiest tick has 11).
3. **The call.** Every due job is a `POST /api/cleanup/<slug>?limit=N` (plus `&windowStart=<ISO instant>` for a windowed job) with `Authorization: Bearer $CRON_SECRET`, fired in parallel, each with its own timeout. The route `app/api/cleanup/[job]/route.ts` finds the handler in `CLEANUP_JOB_BUILDERS`; `cleanupRoute` (`lib/cron/cleanup-route.ts`) checks the bearer in constant time, refuses with 503 and the maintenance `phase` when `assertNotInMaintenance` says the job is held, then runs the job.
4. **Bounded bites.** `limit` caps the rows one run takes. The route clamps an explicit `limit` to 500 and answers 400 for a malformed one. Every sweep removes a processed row from its own cohort, so a backlog drains over successive ticks instead of one run overrunning its timeout. A windowed job re-runs on every slot of its window as a claim-based slice, and `windowStart` fixes the cohort so all slices of one window agree on what is due.
5. **Mutual exclusion.** Each job wraps its core in `withCronLock` (`lib/cron/with-cron-lock.ts`), a Postgres lease: a `SystemJobExecution` row with `status = RUNNING` and a `startedAt` newer than the lease lifetime. The partial unique index `SystemJobExecution_running_jobName_key` (`prisma/sql/check-constraints.sql`) makes a second `RUNNING` row impossible. The default lease is 15 minutes and `LONG_JOB_TTL_MS` is 35 minutes; a running job renews its lease every third of its lifetime, and a crashed run's stale row is swept to `FAILED` by the next caller. The loser of a race gets `409`. Jobs that move money (payouts, dunning, invoicing, referral vesting, the refund and earnings sweeps) use the closed failure mode: if the lock table is unreachable the job refuses to run and answers 503, because an unlocked double run is worse than a missed slot. Notify-only jobs such as `wallet-low-balance`, `msme-payment-alerts` and `alert-orphaned-payments` use the open mode and run unlocked with a warning, except when the lock failure is a database connection or pool error, which refuses the run in either mode (`CronLockUnavailableError`). Redis is never part of cron locking.
6. **Reading the result.** The tick itself always answers 200, because Netlify re-invokes a scheduled function that answers 5xx. Instead, each target lands in `ok`, `lockHeld` (a 409, or a 503 that carries a maintenance `phase`) or `failed`, in the JSON line the tick logs. A `failed` target is reported to Sentry at most once an hour, on its first due tick of the hour, and the tick sends one Sentry cron check-in per run. A `207` is a failure only for `PARTIAL_FAILURE_TARGETS` (`process-payouts`, `sweep-orphaned-topup-captures` and every windowed job); for the others it means the run succeeded and flagged rows for an operator.

## The money jobs

The tables below were generated from `netlify/functions/cron-tick.mts`, `lib/cron/cleanup-registry.ts` and `lib/cron/financial-jobs.ts`; the method is at the end of this section. The last column is the only hand-written one. A job that is not in the tables (the email and Novu outbox relays, the booking reminders, the DPDP drains, the Sentry ingest canary) moves no money; read the whole target list in `cron-tick.mts`. "Held in DEGRADED" means the job's `FINANCIAL_JOB_NAMES` entry makes `assertNotInMaintenance` refuse it while the maintenance phase is DEGRADED. In OFFLINE every job is refused. See [the maintenance gate](03-maintenance-gate-and-recovery.md).

#### Every tick or every 10 to 15 minutes

| Job (slug)                         | Schedule (UTC)      | Bite (`limit`) | Timeout | Held in DEGRADED | What it does                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------- | -------------- | ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sweep-stuck-webhook-events`       | every 15 min at :00 | 50             | 15 s    | no               | Re-drives inbound Razorpay and Stream webhook events left unprocessed or transiently failed.                                                                                                                                                                                        |
| `reconcile-refunds`                | every 15 min at :05 | 10             | 20 s    | yes              | Settles `PENDING` refunds stranded after the gateway call (app crash or timeout before the database write).                                                                                                                                                                         |
| `abandoned-payments`               | every 15 min at :05 | 10             | 20 s    | yes              | Expires abandoned `PENDING` payments and their appointments after the timeout, gives back the credits, discount use and organisation engagement they consumed, and cancels the gateway order; approval-payment links ride the same run.                                             |
| `reconcile-payment-status`         | every 15 min at :05 | 50             | 15 s    | yes              | Asks Razorpay about `PENDING` payments whose webhook never arrived and confirms or fails them through the single confirmer. Also re-reads orders we moved to `EXPIRED` in the last 72 hours with no capture recorded, and refunds a capture found there through the same confirmer. |
| `reconcile-orphaned-confirmations` | every 15 min at :05 | 10             | 20 s    | no               | Re-runs slot confirmation for `SUCCEEDED` payments whose slots are still tentative, and ensures the chat channel of confirmed bookings.                                                                                                                                             |
| `sweep-orphaned-topup-captures`    | every 15 min at :00 | 50             | 15 s    | no               | Re-runs the idempotent `confirmTopUp` for wallet top-ups Razorpay captured but the wallet never received.                                                                                                                                                                           |
| `alert-orphaned-payments`          | every 15 min at :00 | 10             | 20 s    | no               | Read-only alert: a `SUCCEEDED` payment with no appointment becomes one `SystemEvent` per payment.                                                                                                                                                                                   |
| `retry-auto-refunds`               | every 15 min at :10 | 10             | 20 s    | yes              | Re-drives the capture path's owed refunds and the doors' `refundOwedKey` markers, backing off 1 h then 4 h; pages once at the attempt cap.                                                                                                                                          |
| `sync-payment-earnings`            | every 15 min at :00 | 50             | 15 s    | yes              | Creates the earnings rows for `SUCCEEDED` payments that have none.                                                                                                                                                                                                                  |
| `release-earnings`                 | every 15 min at :05 | 50             | 15 s    | yes              | Moves consultant and host-organisation earnings from their hold period to `READY`.                                                                                                                                                                                                  |
| `expire-unpaid-trials`             | every 15 min at :05 | 25             | 15 s    | yes              | Refunds a paid trial nobody answered in time and expires unpaid ones.                                                                                                                                                                                                               |
| `expire-stale-requests`            | every 15 min at :10 | 20             | 20 s    | yes              | Expires stale requests; its refund arm calls the refund front door.                                                                                                                                                                                                                 |

#### Every 30 minutes

| Job (slug)                    | Schedule (UTC)      | Bite (`limit`) | Timeout | Held in DEGRADED | What it does                                                                                           |
| ----------------------------- | ------------------- | -------------- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `reconcile-orphaned-payments` | every 30 min at :10 | 10             | 20 s    | yes              | Heals the stranded cohort: links a late appointment or refunds the payment.                            |
| `auto-complete-appointments`  | every 30 min at :15 | 25             | 24 s    | yes              | Marks finished sessions `COMPLETED`, which is what lets their earnings hold run out.                   |
| `detect-consultant-no-shows`  | every 30 min at :20 | 10             | 24 s    | yes              | Cancels a confirmed consultant no-show and refunds 100 % through `refundBookingPayment`.               |
| `settle-cancelled-sessions`   | every 30 min at :25 | 10             | 20 s    | yes              | Refunds each seat of a host-cancelled class session nobody made up in 14 days.                         |
| `vest-referral-credits`       | every 30 min at :05 | 10             | 20 s    | yes              | Vests or voids `QUALIFYING` referrals once the session is delivered and its refund window has passed.  |
| `support-sla-sweep`           | every 30 min at :10 | 20             | 15 s    | no               | Support SLA outbox alerts, 28-day `RESOLVED` auto-close and the 72 h and 24 h dispute-deadline alerts. |

#### Hourly

| Job (slug)                  | Schedule (UTC) | Bite (`limit`) | Timeout | Held in DEGRADED | What it does                                                                                                            |
| --------------------------- | -------------- | -------------- | ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `settle-platform-incidents` | hourly at :30  | 10             | 20 s    | yes              | Voids the sessions of a declared platform incident and applies each learner's remedy.                                   |
| `process-payouts`           | hourly at :00  | 5              | 24 s    | yes              | Disburses `APPROVED` consultant and organisation payouts through RazorpayX; a no-op while `ENABLE_LIVE_PAYOUTS` is off. |
| `reconcile-disputes`        | hourly at :00  | 10             | 20 s    | yes              | Polls Razorpay for open disputes whose webhook was missed.                                                              |

#### Every 2 hours

| Job (slug)                | Schedule (UTC)               | Bite (`limit`) | Timeout | Held in DEGRADED | What it does                                                                                            |
| ------------------------- | ---------------------------- | -------------- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `handle-stuck-payouts`    | every 2 h, even hours at :40 | 5              | 24 s    | yes              | Asks RazorpayX about payouts stuck in `PROCESSING` and retries or fails them.                           |
| `reconcile-payout-status` | every 2 h, odd hours at :40  | 8              | 24 s    | yes              | Reconciles `PENDING` and `PROCESSING` payouts older than 48 h with RazorpayX in three rotating cohorts. |

#### Retained invoice-order recovery

`reconcile-org-invoice-payments` runs every four hours at :55 (03:55, 07:55,
11:55, 15:55, 19:55 and 23:55 UTC), selecting at most five stored invoice order
IDs per run with a 24-second HTTP abort and a fail-closed Postgres lease. It
uses the canonical invoice settlement transaction; existing relays deliver the
staged notices. These spare phases preserve every existing cadence and the
calendar's twelve-target bound. Five candidates per slot is at most thirty reads
per day; measure cohort size and recovery age before treating this as adequate
capacity. See [worker recovery](../../maintenance/12-worker-recovery.md#invoice-captures-and-uncertain-checkout-state).

#### Calendar windows

| Job (slug)                        | Schedule (UTC)                                                    | Bite (`limit`) | Timeout | Held in DEGRADED | What it does                                                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------- | -------------- | ------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-payout-batch`             | Mondays: 12 slots 20:05–22:50 UTC (every 15 min)                  | 10             | 20 s    | yes              | Mints the weekly consultant and organisation payout batches, `limit` units per rail per slice.                                                                                                                                                             |
| `settle-invoice-accruals`         | day 1 of every month: 16 slots 04:45–19:45 UTC (every hour)       | 10             | 20 s    | yes              | Rolls each organisation's unbilled invoice-accrual bookings into one `OrganizationInvoice`.                                                                                                                                                                |
| `expire-referral-credits`         | day 1 of every month: 3 slots 03:50–05:50 UTC (every hour)        | 50             | 20 s    | yes              | Breakage: expires referral credits past their expiry and posts the liability release.                                                                                                                                                                      |
| `generate-subscription-invoices`  | daily: 17 slots 03:05–19:05 UTC (every hour)                      | 10             | 20 s    | yes              | Bills every `BillingSubscription` whose `nextInvoiceDate` is due.                                                                                                                                                                                          |
| `abandoned-org-top-ups`           | daily: 17 slots 03:10–19:10 UTC (every hour)                      | 200            | 15 s    | no               | Settles pending wallet top-ups past the grace window against the gateway: a captured one is credited, one whose order holds no payment is marked `FAILED` and kept (a late payment on it is still credited).                                               |
| `advance-program-cycles`          | daily: 17 slots 03:15–19:15 UTC (every hour)                      | 25             | 20 s    | yes              | Rolls or closes `ProgramAssignment` periods that have ended.                                                                                                                                                                                               |
| `auto-renew-contracts`            | daily: 17 slots 03:20–19:20 UTC (every hour)                      | 10             | 20 s    | yes              | Mints the renewal contract for expiring auto-renew contracts.                                                                                                                                                                                              |
| `expire-contracts`                | daily: 17 slots 03:35–19:35 UTC (every hour)                      | 10             | 20 s    | yes              | Flips `ACTIVE` contracts past `effectiveTo` to `EXPIRED` and closes their live assignments.                                                                                                                                                                |
| `sweep-abandoned-overage-charges` | daily: 17 slots 03:30–19:30 UTC (every hour)                      | 25             | 20 s    | yes              | Fails never-started member overage side-charges after 7 days to free the cycle ceiling and restores the carved base to an uninvoiced parent; an uncovered wallet part books to `ORG_RECEIVABLE`, and an invoiced parent needs a manual billing adjustment. |
| `timeout-member-overages`         | daily: 3 slots 23:35–01:35 UTC (every hour)                       | 25             | 20 s    | yes              | Fails member overages still unpaid after 14 days, restores the carved base and tells the member.                                                                                                                                                           |
| `dunning`                         | daily: 3 slots 00:10–02:10 UTC (every hour)                       | 25             | 20 s    | yes              | Moves overdue invoices `ISSUED` to `OVERDUE`, sends up to three escalating reminders and, only with `ENABLE_DUNNING_SUSPEND=true`, suspends sponsored bookings 7 days after the last.                                                                      |
| `wallet-low-balance`              | daily: 3 slots 23:45–01:45 UTC (every hour)                       | 25             | 20 s    | no               | Notify-only alert when a wallet is below its configured floor.                                                                                                                                                                                             |
| `irp-uploader`                    | daily: 17 slots 03:25–19:25 UTC (every hour)                      | 10             | 20 s    | yes              | Registers e-invoices with the IRP through ClearTax when the credentials are configured.                                                                                                                                                                    |
| `msme-payment-alerts`             | daily: one slot at 03:45 UTC                                      | none           | 20 s    | no               | One digest email of organisation payouts within 5 days of their MSME deadline.                                                                                                                                                                             |
| `gst-outward-register-export`     | day 2 of every month: 19 slots 04:45–22:45 UTC (every hour)       | 25             | 24 s    | yes              | Heals missing consumer invoices, then uploads the monthly GSTR-1 working register; an unset GSTIN is a config skip.                                                                                                                                        |
| `heal-consumer-invoices`          | daily: 4 slots 01:50–19:50 UTC (every 6 hours)                    | 25             | 20 s    | yes              | Mints the consumer tax invoice for `SUCCEEDED` payments of the last 90 days that the capture path missed; an unset GSTIN is a config skip.                                                                                                                 |
| `tds-return-draft`                | day 5 of Jan, Apr, Jul, Oct: 2 slots 01:55–02:55 UTC (every hour) | none           | 20 s    | no               | Quarterly TDS return draft (Form 26Q or 140) for the closed quarter.                                                                                                                                                                                       |
| `reconcile-gateway-settlements`   | daily: 6 slots 06:55–11:55 UTC (every hour)                       | none           | 20 s    | yes              | Matches Razorpay's settlement report to our money rows, books missing capture fees and settlement journals.                                                                                                                                                |
| `reconcile-ledgers`               | hourly at `:55`, yielding at ticker capacity                      | none           | 20 s    | no               | Advances a bounded persisted full-scope audit; reuses completed daily audit. 200 RUNNING means continuation, 207 means completed discrepancies.                                                                                                            |

### How this table was produced

The tables come from a throwaway script run from the repository root with `npx tsx`. It imports `dueTargets` and `targetRequest` from `netlify/functions/cron-tick.mts`, calls `dueTargets` for every five-minute tick of calendar year 2026, and records the UTC slots each job fires on (which yields the interval, offset, weekday, day of month, months and slot count without reading the schedule tables by eye). It reads the `limit` and the timeout from `targetRequest`. It maps each slug to its `job:` literal in `lib/cron/cleanup-registry.ts` and looks that name up in `FINANCIAL_JOB_NAMES` for the DEGRADED column; the two differ for `reconcile-refunds` (job name `reconcile-pending-refunds`), `abandoned-payments` (`cleanup-abandoned-payments`) and `tds-return-draft` (`tds-26q-draft-export`). Re-run it after any change to the schedule tables rather than editing the rows. The script and the generated gate table on the maintenance page share this method.

## Running a job by hand

An operator with the `CRON_SECRET` can run any job on demand:

```bash
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_URL/api/cleanup/reconcile-refunds?limit=10"
```

A deploy preview or branch deploy cannot be used to try it: off production every job answers 409 `JOB_RUN_PRODUCTION_ONLY` before it starts, because previews share production's database. Until the database split, local `next dev` also points at the shared database, so a money job run locally acts on production's rows: run a money job on production through the console, and use local runs only for jobs whose writes are harmless or against an isolated database. The answer is the job's own result with status 200, 207 (rows flagged), 400 (bad `limit` or `windowStart`), 401 (bad secret), 409 (already running), 503 (held by maintenance, or the lock table unreachable) or 500. The same jobs can be started from the console without the secret: the Reconcile section of the money console runs four of them (see [admin money doors](02-admin-money-doors.md)), and `POST /api/admin/system-jobs/run` runs any job in the cleanup registry by its slug, on production only (a preview answers 409 `JOB_RUN_PRODUCTION_ONLY`), (any other id answers 400) for an admin with a reason and an ops-log row, in-process under the admin's own run context, so the execution row records `admin:<userId>` as its trigger and links to the ops-log row; it refuses a financial job in DEGRADED and every job in OFFLINE, and it answers `202` and runs `process-payouts` and `create-payout-batch` after the response, because a gateway call per payout would hit the edge timeout.

## Why a missed job is not lost

Every job here is built on state-as-outbox: the work queue is the unprocessed row itself (a `PENDING` refund, a `SUCCEEDED` payment with no earnings, a payout stuck in `PROCESSING`), not a message. A skipped tick, a 409, a maintenance hold or a deploy that aborted a target therefore delays work to the next due slot and loses nothing. The cost of a missed slot is latency, which is why the 15-minute tier holds the jobs that sit on a buyer's critical path.

## Where in code

| Concern                                     | File                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| Schedule tables, fleet switch, tick         | `netlify/functions/cron-tick.mts`                       |
| Job registry and bite constants             | `lib/cron/cleanup-registry.ts`                          |
| Auth, error mapping, `limit`, `windowStart` | `lib/cron/cleanup-route.ts`                             |
| Lease                                       | `lib/cron/with-cron-lock.ts`                            |
| DEGRADED hold list                          | `lib/cron/financial-jobs.ts`, `lib/maintenance-cron.ts` |
| Console runner                              | `app/api/admin/system-jobs/run/route.ts`                |

## Related

- [Maintenance gate and recovery](03-maintenance-gate-and-recovery.md) for what OFFLINE and DEGRADED do to these jobs.
- [Webhook recovery](04-webhook-recovery.md) for the stuck-event sweep.
- [Money runbooks](05-money-runbooks.md) for the symptom-first procedures that name these jobs.
- The design record is ADR 27, [state as outbox and the scheduled ticker](../../enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).

## Deprecated & Superseded Approaches

Delete these if you find them; none is how money jobs run today.

1. **GitHub Actions as the money scheduler.** Workflows such as a daily `dunning.yml` or `irp-uploader.yml`, per-job scripts under `jobs/payouts/*`, and `GITHUB_OUTPUT` wrapper scripts no longer exist. The former housekeeping fleet workflows (`cron-daily.yml`, `cron-weekly.yml` and `cron-intra-day.yml`) are deleted too: no workflow calls `/api/cleanup`. A job missing from the ticker runs nowhere.
2. **A shared secret in `X-Cron-Secret`.** The only accepted credential is `Authorization: Bearer $CRON_SECRET`.
3. **A Redis cron lock.** Redlock-style locks were replaced by the Postgres lease; Redis serves only the fleet switch, rate limits, maintenance state and short interactive mutexes.
4. **A cascade or release cron for refunds and trust-parked earnings.** The refund cascade runs inline in the refund transaction, and trust-parked earnings leave through `releaseSponsorTrustPark` or an invoice payment. There is no `cascade-refund-earnings` or `release-pending-trust-earnings` job.
5. **An `ENABLE_IRP_UPLOADER` switch.** The IRP uploader is gated by `PLATFORM_GSTIN` and the `CLEARTAX_*` credentials, not by that flag.
