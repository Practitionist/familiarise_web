---
title: Maintenance gate and recovery for money
type: reference
band: 70-operations
audience: sde3
status: live
last-reviewed: 2026-10-23
---

# Maintenance gate and recovery for money

Maintenance mode has two blocking phases, and each treats money differently. In **DEGRADED** the site stays readable with a banner, money-moving writes on the routes listed below are refused, and only the jobs in `FINANCIAL_JOB_NAMES` are held. In **OFFLINE** every page and API except a short exempt list answers 503 and every background job is held, because the database may be mid-migration. This page lists exactly which money routes and jobs each phase stops, what stays open on purpose, and the order in which to re-drive money work once maintenance ends. The maintenance window is durable in Postgres and published to the Redis edge cache (`maintenance:phase`) through `/api/admin/maintenance`; see [the maintenance architecture](../../maintenance/01-architecture.md).

Maintenance activation retries reuse the active window's reason, ETA and bypass secret while recording the new audit reason. PATCH requires a validated non-empty reason, including ETA-only changes; that reason supplies both incident and audit text. An omitted ETA preserves the stored value; a supplied ETA is normalized to ISO. OFFLINE recovery completes its database, Redis and chat checks before resolving the incident or changing phase. Stream sessions and channel batches run sequentially across admission checks; parallelism stays within a paced channel batch so later work observes the remaining deadline.

## What each phase does to money

| Phase      | Buyer and organisation money writes                                                   | Admin money doors                                                                      | Background money jobs                                                      | Webhooks                                                               |
| ---------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `OFF`      | Normal.                                                                               | Normal.                                                                                | Normal.                                                                    | Processed.                                                             |
| `DEGRADED` | Blocked at the edge for the routes in the table below (503 with `phase: "DEGRADED"`). | Blocked at the edge; the support and platform-cancel doors also check inside the door. | The jobs in `FINANCIAL_JOB_NAMES` answer 503 and do nothing; the rest run. | Processed.                                                             |
| `OFFLINE`  | Every non-exempt route answers 503.                                                   | Same.                                                                                  | Every job answers 503.                                                     | Processed (exempt), but the handlers still need the database to be up. |

Webhooks, the health check, the auth routes and the maintenance admin API are exempt in every phase, so a Razorpay capture that arrives during a window is still received and acknowledged. If the database is unreachable, the Razorpay route answers 503 before storing anything, so Razorpay redelivers it. An event that was stored but whose handler failed stays unprocessed, and `sweep-stuck-webhook-events` re-drives it after maintenance.

## Who enforces it

| Layer           | What it checks                                                                                                                                                                                                                                              | Where                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The edge gate   | Every request: exempt list, OFFLINE refusal, DEGRADED write patterns, and the fail-closed list when the phase cannot be read. A request carrying the maintenance bypass secret (header `x-maintenance-bypass` or the signed cookie) passes.                 | `middleware.ts` (`handleMaintenance`) using `lib/maintenance-edge.ts`              |
| The job gate    | A cleanup twin refuses with 503 and the `phase` in the body when `assertNotInMaintenance` finds OFFLINE, or DEGRADED for a job named in `FINANCIAL_JOB_NAMES`. The phase is cached for 60 seconds; an unreadable or missing phase refuses the job with 503. | `lib/cron/cleanup-route.ts`, `lib/maintenance-cron.ts`                             |
| The door gate   | The support case doors, the support refund approval and the staff platform cancel call `assertMoneyDoorsOpen`, which refuses in DEGRADED, OFFLINE and when the phase cannot be read.                                                                        | `lib/backoffice/maintenance-gate.ts`                                               |
| In-route checks | The console runner for the four reconcile jobs and the system-jobs runner read the phase themselves and refuse money jobs in DEGRADED and OFFLINE.                                                                                                          | `app/api/admin/reconcile/[job]/route.ts`, `app/api/admin/system-jobs/run/route.ts` |

`FINANCIAL_JOB_NAMES` (`lib/cron/financial-jobs.ts`) deliberately leaves out `sweep-stuck-webhook-events`, `reconcile-orphaned-confirmations` and `sweep-orphaned-topup-captures`, which only re-drive webhooks DEGRADED already lets through. It includes `sweep-abandoned-overage-charges`, which restores carved overage bases, so that sweep is held in DEGRADED. It includes `auto-complete-appointments` because its class-end pass stamps refund obligations in the same transaction as the completion, so the whole job, ordinary completions and earnings-hold stamping included, is held in DEGRADED and resumes on its next 30-minute slot (it needs no hand run). It leaves out `abandoned-org-top-ups`, which runs in DEGRADED; a captured top-up it finds is confirmed through `confirmTopUp`, which claims the pending row and posts under the unique `topup:<providerOrderId>` key.

The edge gate reads the phase through a cache. A write always awaits the cached read, which is good for up to 180 seconds, so a phase change can take up to three minutes to reach a warm instance. A failed refresh may preserve the last confirmed page presentation for up to 15 minutes, but marks it unreadable and denies non-exempt mutations. Failure responses are cached briefly before retrying. A cached successful phase is not an instantaneous cross-host barrier; in-flight work is not cancelled.

## Unreadable maintenance state

A missing, malformed or unreachable Redis phase is unknown. Every non-exempt mutation answers 503 with `MAINTENANCE_STATE_UNREADABLE` and `Retry-After: 30`, unless an authorized maintenance bypass applies. This includes the admin money writes; there is no separate unreadable-state allowlist. Webhooks, auth, health and maintenance control retain their explicit exemptions. Guarded cron jobs also refuse unknown state, without claiming a healthy maintenance hold. Restore readable state through the authorized control procedure before retrying writes.

## Which routes DEGRADED blocks

The tables below describe the money patterns in `WRITE_BLOCKED_IN_DEGRADED`. Validate them against `isWriteBlockedInDegraded`, `isFailClosedWhenUnreadable` and `isMaintenanceExempt` in `lib/maintenance-edge.ts` after changing admission. A `*` matches one non-empty segment. Reads pass, except `GET /api/checkout/verify?sync=true`, which can confirm a capture. All listed non-exempt writes fail closed when maintenance state is unreadable.

#### Buyer checkout, payment recovery and overage

| Route pattern (writes only)       | Blocked in DEGRADED | Closed when the phase is unreadable |
| --------------------------------- | ------------------- | ----------------------------------- |
| `/api/checkout`                   | yes                 | yes                                 |
| `/api/payments/disputes`          | yes                 | yes                                 |
| `/api/consultant/payouts/instant` | yes                 | yes                                 |
| `/api/payments/*/recover`         | yes                 | yes                                 |
| `/api/recordings/*/purchase`      | yes                 | yes                                 |
| `/api/overage/*/order`            | yes                 | yes                                 |

#### Admin money doors

| Route pattern (writes only)                  | Blocked in DEGRADED | Closed when the phase is unreadable |
| -------------------------------------------- | ------------------- | ----------------------------------- |
| `/api/admin/payouts`                         | yes                 | yes                                 |
| `/api/admin/refunds`                         | yes                 | yes                                 |
| `/api/admin/ops-proposals`                   | yes                 | yes                                 |
| `/api/admin/tds`                             | yes                 | yes                                 |
| `/api/admin/billing-accounts`                | yes                 | yes                                 |
| `/api/admin/org-payouts`                     | yes                 | yes                                 |
| `/api/admin/earnings`                        | yes                 | yes                                 |
| `/api/admin/disputes`                        | yes                 | yes                                 |
| `/api/admin/payout-accounts`                 | yes                 | yes                                 |
| `/api/admin/reconcile-ledgers`               | yes                 | yes                                 |
| `/api/admin/referrals/credits`               | yes                 | yes                                 |
| `/api/admin/organizations/*/invoices`        | yes                 | yes                                 |
| `/api/admin/organizations/*/billing-account` | yes                 | yes                                 |
| `/api/admin/organizations/*/overages`        | yes                 | yes                                 |
| `/api/admin/class-series/*/cancel-series`    | yes                 | yes                                 |
| `/api/admin/class-series/*/cancel-session`   | yes                 | yes                                 |
| `/api/admin/class-series/*/make-up`          | yes                 | yes                                 |
| `/api/admin/class-series/*/skip-make-up`     | yes                 | yes                                 |
| `/api/admin/class-series/sweeps`             | yes                 | yes                                 |

#### Organisation money paths

| Route pattern (writes only)                            | Blocked in DEGRADED | Closed when the phase is unreadable |
| ------------------------------------------------------ | ------------------- | ----------------------------------- |
| `/api/organizations/*/billing-account/wallet/top-ups`  | yes                 | yes                                 |
| `/api/organizations/*/billing-account/invoices`        | yes                 | yes                                 |
| `/api/organizations/*/billing-account/purchase-orders` | yes                 | yes                                 |
| `/api/organizations/*/programs`                        | yes                 | yes                                 |
| `/api/organizations/*/contracts`                       | yes                 | yes                                 |
| `/api/organizations/*/rate-cards`                      | yes                 | yes                                 |
| `/api/organizations/*/payouts`                         | yes                 | yes                                 |
| `/api/organizations/*/payout-account`                  | yes                 | yes                                 |

The remaining 31 blocked patterns are booking, scheduling, meeting, onboarding and membership writes. Several of them (cancel, reschedule, the booking writes, trials, seat removal) can end in a refund or a charge, so DEGRADED blocks them too; the booking documents own their behaviour: `/api/appointments/*/cancel`, `/api/appointments/*/reschedule`, `/api/appointments/*/documents`, `/api/appointments/*/feedback`, `/api/bookings/consultations`, `/api/bookings/subscriptions`, `/api/bookings/webinars`, `/api/bookings/classes`, `/api/bookings/*/allocate`, `/api/bookings/*/abandon`, `/api/trials`, `/api/plans/*/materials`, `/api/stream/meetings`, `/form/onboarding`, `/onboarding/gate`, `/api/verification/documents`, `/api/verification/submit`, `/api/verification/resubmit`, `/api/scheduling/request-for-approval`, `/api/scheduling/availability`, `/api/newsletter`, `/api/referrals`, `/api/collaborations`, `/api/participants`, `/api/meetings/*/join`, `/api/meetings/*/end`, `/api/meetings/*/extend`, `/api/appointments/*/occurrences`, `/api/organizations/*/appointments/*/allocate`, `/api/organizations/*/members`, `/api/organizations/*/invitations`.

Exempt from every maintenance phase: `/api/webhooks/`, `/api/stream/webhooks`, `/api/health`, `/api/auth/`, `/api/admin/maintenance`, `/maintenance`, `/_next/`, `/favicon`, and any path ending in a file extension.

`/api/admin/reconcile/[job]` (the Reconcile tab) and `/api/cleanup/*` are not in the DEGRADED write list; they rely on the in-route and job gates described above.

## Re-driving money after maintenance ends

Money jobs that were held resume on their own next slot, and webhook handlers that failed are re-driven by the stuck-event sweep, so nothing needs doing if you can wait for the ticker. To close the gap faster, run the jobs below by hand in this order, after confirming that core implements a bounded execution envelope, using `POST /api/cleanup/<slug>?limit=10` with `Authorization: Bearer $CRON_SECRET` (or from the admin system-jobs runner). The order follows dependency: first learn what the gateway knows, then repair bookings, then money owed.

1. **Confirm the phase is `OFF`** and the health check answers healthy.
2. **`sweep-stuck-webhook-events`** re-drives every Razorpay and Stream event that was received but not processed. Also read the Razorpay dashboard's webhook delivery log for the window and note any delivery that failed outright.
3. **`reconcile-payment-status`** asks Razorpay about every `PENDING` payment, so a capture whose webhook was lost is confirmed through the single confirmer.
4. **`reconcile-orphaned-confirmations`**, **`sweep-orphaned-topup-captures`** and **`reconcile-orphaned-payments`** repair captures that never became a booking or a wallet credit.
5. **`sync-payment-earnings`** writes the earnings rows for captured payments that have none.
6. **`reconcile-refunds`** and **`retry-auto-refunds`** settle refunds that were pending or owed when the window opened.
7. **`reconcile-disputes`** syncs dispute status changes missed during the window.
8. **`reconcile-payout-status`** and **`handle-stuck-payouts`**, only if the window overlapped the Monday 20:00 to 23:00 UTC payout batch or the hourly disbursement.
9. **`reconcile-gateway-settlements`** runs in its morning window; **`reconcile-ledgers`** advances hourly at `:55` when ticker capacity permits. Use an authenticated manual slice when an answer is needed sooner; ledger progress does not wait until morning. The ledger cleanup door advances bounded pages; wait for a COMPLETED report before reading its clean/discrepant verdict. RUNNING is continuation. The authenticated admin door advances bounded slices too; it can start a fresh audit after a completed verdict.

Then read [the money runbooks](05-money-runbooks.md) for any symptom that remains.

## Where in code

| Concern                      | File                                                    |
| ---------------------------- | ------------------------------------------------------- |
| Phase read, patterns, bypass | `lib/maintenance-edge.ts`                               |
| Edge decision                | `middleware.ts` (`handleMaintenance`)                   |
| Job hold list and gate       | `lib/cron/financial-jobs.ts`, `lib/maintenance-cron.ts` |
| Door gate                    | `lib/backoffice/maintenance-gate.ts`                    |

## Related

- [Scheduled money jobs](01-scheduled-jobs.md) shows which jobs are held in DEGRADED.
- [Webhook recovery](04-webhook-recovery.md) for events that stay unprocessed.
- The maintenance documents own the operator procedure for starting and ending a window: [DEGRADED versus OFFLINE](../../maintenance/02-degraded-vs-offline.md) and [post-maintenance recovery](../../maintenance/07-post-maintenance-recovery.md).

## Deprecated & Superseded Approaches

1. **"DEGRADED runs cron jobs normally."** Financial jobs are held in DEGRADED through `FINANCIAL_JOB_NAMES`; only non-financial jobs proceed.
2. **Admin money doors open in DEGRADED.** The org-payout, org-invoice, earnings, dispute, payout-account, ledger-reconcile, referral-credit and class-series doors were once open during DEGRADED; they are now in `WRITE_BLOCKED_IN_DEGRADED`.
3. **A Stripe dashboard step in recovery.** Razorpay is the only gateway; the recovery checks above are the whole list.

4. **A selected unreadable-state allowlist.** Unknown state now denies every non-exempt mutation, including the admin money doors; stale page presentation cannot authorize a write.
