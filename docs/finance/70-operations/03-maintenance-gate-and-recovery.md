---
title: Maintenance gate and recovery for money
type: reference
band: 70-operations
audience: sde3
status: live
last-reviewed: 2026-10-23
---

# Maintenance gate and recovery for money

Maintenance mode has two blocking phases, and each treats money differently. In **DEGRADED** the site stays readable with a banner, money-moving writes on the routes listed below are refused, and only the jobs in `FINANCIAL_JOB_NAMES` are held. In **OFFLINE** every page and API except a short exempt list answers 503 and every background job is held, because the database may be mid-migration. This page lists exactly which money routes and jobs each phase stops, what stays open on purpose, and the order in which to re-drive money work once maintenance ends. The phase itself lives in Redis (`maintenance:phase`), set through `/api/admin/maintenance`; see [the maintenance architecture](../../maintenance/01-architecture.md).

## What each phase does to money

| Phase      | Buyer and organisation money writes                                                   | Admin money doors                                                                      | Background money jobs                                                      | Webhooks                                                               |
| ---------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `OFF`      | Normal.                                                                               | Normal.                                                                                | Normal.                                                                    | Processed.                                                             |
| `DEGRADED` | Blocked at the edge for the routes in the table below (503 with `phase: "DEGRADED"`). | Blocked at the edge; the support and platform-cancel doors also check inside the door. | The jobs in `FINANCIAL_JOB_NAMES` answer 503 and do nothing; the rest run. | Processed.                                                             |
| `OFFLINE`  | Every non-exempt route answers 503.                                                   | Same.                                                                                  | Every job answers 503.                                                     | Processed (exempt), but the handlers still need the database to be up. |

Webhooks, the health check, the auth routes and the maintenance admin API are exempt in every phase, so a Razorpay capture that arrives during a window is still received and acknowledged. If the database is unreachable, the Razorpay route answers 503 before storing anything, so Razorpay redelivers it. An event that was stored but whose handler failed stays unprocessed, and `sweep-stuck-webhook-events` re-drives it after maintenance.

## Who enforces it

| Layer           | What it checks                                                                                                                                                                                                                                           | Where                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The edge gate   | Every request: exempt list, OFFLINE refusal, DEGRADED write patterns, and the fail-closed list when the phase cannot be read. A request carrying the maintenance bypass secret (header `x-maintenance-bypass` or the signed cookie) passes.              | `middleware.ts` (`handleMaintenance`) using `lib/maintenance-edge.ts`              |
| The job gate    | A cleanup twin refuses with 503 and the `phase` in the body when `assertNotInMaintenance` finds OFFLINE, or DEGRADED for a job named in `FINANCIAL_JOB_NAMES`. The phase is cached for 60 seconds, and an unreadable phase lets the job run (fail open). | `lib/cron/cleanup-route.ts`, `lib/maintenance-cron.ts`                             |
| The door gate   | The support case doors, the support refund approval and the staff platform cancel call `assertMoneyDoorsOpen`, which refuses in DEGRADED, OFFLINE and when the phase cannot be read.                                                                     | `lib/backoffice/maintenance-gate.ts`                                               |
| In-route checks | The console runner for the four reconcile jobs and the system-jobs runner read the phase themselves and refuse money jobs in DEGRADED and OFFLINE.                                                                                                       | `app/api/admin/reconcile/[job]/route.ts`, `app/api/admin/system-jobs/run/route.ts` |

`FINANCIAL_JOB_NAMES` (`lib/cron/financial-jobs.ts`) deliberately leaves out `sweep-stuck-webhook-events`, `reconcile-orphaned-confirmations` and `sweep-orphaned-topup-captures`, which only re-drive webhooks DEGRADED already lets through. It includes `sweep-abandoned-overage-charges`, which restores carved overage bases, so that sweep is held in DEGRADED. It leaves out `abandoned-org-top-ups`, which runs in DEGRADED; a captured top-up it finds is confirmed through `confirmTopUp`, which claims the pending row and posts under the unique `topup:<providerOrderId>` key.

The edge gate reads the phase through a cache. A write always awaits the cached read, which is good for up to 180 seconds, so a phase change can take up to three minutes to reach a warm instance. A failed read serves the last confirmed state for up to 15 minutes, and only a cold instance with no confirmed state reports the phase as unreadable.

## Fail-closed versus open when the phase is unreadable

When Redis cannot be read and there is no recent confirmed state, the gate marks the state `unreadable`. The routes in `FAIL_CLOSED_WHEN_UNREADABLE` then answer 503 with code `MAINTENANCE_STATE_UNREADABLE` and a `Retry-After` of 30 seconds, unless the request carries the bypass. That list holds the buyer checkout paths and the few admin and organisation doors that already need Redis for their own locks (shown in the third column below), so failing them closed costs no extra availability.

The other admin money doors (organisation payout approve, hold and release; organisation invoice writes; the billing-account credit limit and overage settle; earnings hold and release; dispute updates; payout-account unfreeze; ledger reconcile; referral credits; class-series refund doors) are deliberately **not** on that list. The owner's decision is that an unreadable Redis must not lock operators out of the console, so those doors stay open when the phase is unreadable. They are still protected by the shell's checks: a required reason, one ops-log row, the second-admin approval above ₹25,000 where the door is priced, and a fresh step-up session on every one of them except earnings hold and release, dispute updates, referral credits and the class-series doors (see [admin money doors](02-admin-money-doors.md)). The doors that call `assertMoneyDoorsOpen` do fail closed on an unreadable phase.

## Which routes DEGRADED blocks

The tables below were generated from `lib/maintenance-edge.ts`. A script reads the `WRITE_BLOCKED_IN_DEGRADED`, `FAIL_CLOSED_WHEN_UNREADABLE` and `EXEMPT_PREFIXES` arrays, then confirms each pattern with the module's own `isWriteBlockedInDegraded`, `isFailClosedWhenUnreadable` and `isMaintenanceExempt` functions so a pattern that does not behave as listed stops the script. It groups the patterns by path prefix. A `*` segment matches any one non-empty segment. Reads (`GET`, `HEAD`, `OPTIONS`) pass, except `GET /api/checkout/verify?sync=true`, which drives a capture and is blocked like a write. Re-run the script after any change to those arrays instead of editing the rows.

#### Buyer checkout, payment recovery and overage

| Route pattern (writes only)       | Blocked in DEGRADED | Closed when the phase is unreadable |
| --------------------------------- | ------------------- | ----------------------------------- |
| `/api/checkout`                   | yes                 | yes                                 |
| `/api/payments/disputes`          | yes                 | no                                  |
| `/api/consultant/payouts/instant` | yes                 | yes                                 |
| `/api/payments/*/recover`         | yes                 | yes                                 |
| `/api/recordings/*/purchase`      | yes                 | yes                                 |
| `/api/overage/*/order`            | yes                 | yes                                 |

#### Admin money doors

| Route pattern (writes only)                  | Blocked in DEGRADED | Closed when the phase is unreadable |
| -------------------------------------------- | ------------------- | ----------------------------------- |
| `/api/admin/payouts`                         | yes                 | yes                                 |
| `/api/admin/refunds`                         | yes                 | yes                                 |
| `/api/admin/ops-proposals`                   | yes                 | no                                  |
| `/api/admin/tds`                             | yes                 | no                                  |
| `/api/admin/billing-accounts`                | yes                 | no                                  |
| `/api/admin/org-payouts`                     | yes                 | no                                  |
| `/api/admin/earnings`                        | yes                 | no                                  |
| `/api/admin/disputes`                        | yes                 | no                                  |
| `/api/admin/payout-accounts`                 | yes                 | no                                  |
| `/api/admin/reconcile-ledgers`               | yes                 | no                                  |
| `/api/admin/referrals/credits`               | yes                 | no                                  |
| `/api/admin/organizations/*/invoices`        | yes                 | no                                  |
| `/api/admin/organizations/*/billing-account` | yes                 | no                                  |
| `/api/admin/organizations/*/overages`        | yes                 | no                                  |
| `/api/admin/class-series/*/cancel-series`    | yes                 | no                                  |
| `/api/admin/class-series/*/cancel-session`   | yes                 | no                                  |
| `/api/admin/class-series/*/make-up`          | yes                 | no                                  |
| `/api/admin/class-series/*/skip-make-up`     | yes                 | no                                  |
| `/api/admin/class-series/sweeps`             | yes                 | no                                  |

#### Organisation money paths

| Route pattern (writes only)                            | Blocked in DEGRADED | Closed when the phase is unreadable |
| ------------------------------------------------------ | ------------------- | ----------------------------------- |
| `/api/organizations/*/billing-account/wallet/top-ups`  | yes                 | yes                                 |
| `/api/organizations/*/billing-account/invoices`        | yes                 | yes                                 |
| `/api/organizations/*/billing-account/purchase-orders` | yes                 | no                                  |
| `/api/organizations/*/programs`                        | yes                 | no                                  |
| `/api/organizations/*/contracts`                       | yes                 | no                                  |
| `/api/organizations/*/rate-cards`                      | yes                 | no                                  |
| `/api/organizations/*/payouts`                         | yes                 | yes                                 |
| `/api/organizations/*/payout-account`                  | yes                 | no                                  |

The remaining 31 blocked patterns are booking, scheduling, meeting, onboarding and membership writes. Several of them (cancel, reschedule, the booking writes, trials, seat removal) can end in a refund or a charge, so DEGRADED blocks them too; the booking documents own their behaviour: `/api/appointments/*/cancel`, `/api/appointments/*/reschedule`, `/api/appointments/*/documents`, `/api/appointments/*/feedback`, `/api/bookings/consultations`, `/api/bookings/subscriptions`, `/api/bookings/webinars`, `/api/bookings/classes`, `/api/bookings/*/allocate`, `/api/bookings/*/abandon`, `/api/trials`, `/api/plans/*/materials`, `/api/stream/meetings`, `/form/onboarding`, `/onboarding/gate`, `/api/verification/documents`, `/api/verification/submit`, `/api/verification/resubmit`, `/api/scheduling/request-for-approval`, `/api/scheduling/availability`, `/api/waitlist`, `/api/referrals`, `/api/collaborations`, `/api/participants`, `/api/meetings/*/join`, `/api/meetings/*/end`, `/api/meetings/*/extend`, `/api/appointments/*/occurrences`, `/api/organizations/*/appointments/*/allocate`, `/api/organizations/*/members`, `/api/organizations/*/invitations`.

Exempt from every maintenance phase: `/api/webhooks/`, `/api/stream/webhooks`, `/api/health`, `/api/auth/`, `/api/admin/maintenance`, `/maintenance`, `/_next/`, `/favicon`, and any path ending in a file extension.

`/api/admin/reconcile/[job]` (the Reconcile tab) and `/api/cleanup/*` are not in the DEGRADED write list; they rely on the in-route and job gates described above.

## Re-driving money after maintenance ends

Money jobs that were held resume on their own next slot, and webhook handlers that failed are re-driven by the stuck-event sweep, so nothing needs doing if you can wait for the ticker. To close the gap faster, run the jobs below by hand in this order, each as `POST /api/cleanup/<slug>?limit=10` with `Authorization: Bearer $CRON_SECRET` (or from the admin system-jobs runner). The order follows dependency: first learn what the gateway knows, then repair bookings, then money owed.

1. **Confirm the phase is `OFF`** and the health check answers healthy.
2. **`sweep-stuck-webhook-events`** re-drives every Razorpay, Stream and Novu event that was received but not processed. Also read the Razorpay dashboard's webhook delivery log for the window and note any delivery that failed outright.
3. **`reconcile-payment-status`** asks Razorpay about every `PENDING` payment, so a capture whose webhook was lost is confirmed through the single confirmer.
4. **`reconcile-orphaned-confirmations`**, **`sweep-orphaned-topup-captures`** and **`reconcile-orphaned-payments`** repair captures that never became a booking or a wallet credit.
5. **`sync-payment-earnings`** writes the earnings rows for captured payments that have none.
6. **`reconcile-refunds`** and **`retry-auto-refunds`** settle refunds that were pending or owed when the window opened.
7. **`reconcile-disputes`** syncs dispute status changes missed during the window.
8. **`reconcile-payout-status`** and **`handle-stuck-payouts`**, only if the window overlapped the Monday 20:00 to 23:00 UTC payout batch or the hourly disbursement.
9. **`reconcile-gateway-settlements`** and **`reconcile-ledgers`** run in their own morning windows; run them by hand only if you need the answer before then. A clean `reconcile-ledgers` run is the final check that the window left no drift.

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
