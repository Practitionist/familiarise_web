# Cron Jobs Reference

The platform runs **61 scheduled GitHub Actions workflows**. Each one boots a bare Node process with `tsx`, connects straight to PostgreSQL through Prisma, and exits — no Next.js server, no middleware, and therefore none of the protections the request path takes for granted. Everything a cron job needs, it has to arrange for itself.

This page is the inventory of that fleet. It was regenerated on **2026-08-14** directly from `.github/workflows/`, the entrypoints those workflows execute, and `lib/maintenance-cron.ts`, replacing a hand-written version that had drifted badly: it described 28 jobs and asserted that all of them called `abortIfMaintenance()`. Both claims were wrong, and the second one was wrong in the direction that gets a database corrupted during a migration.

## What changed in #1169

Cron locking is now universal. Before PR 6 of that train, one scheduled job ran with no mutual exclusion of any kind, and nothing in the repository could tell you that. Today every scheduled workflow either takes a `withCronLock` lock or holds a documented bespoke lock, and `__tests__/maintenance/cron-lock-registry.test.ts` re-derives that claim from source on every CI run, so the next unlocked job fails the build instead of quietly double-running for a year.

The same PR gave the fleet a way to notice its own death. Every locked run refreshes a single Redis key, `cron:heartbeat:last`, and `GET /api/health` reports its age under `cron`. If that key goes stale for more than six hours the scheduled fleet has stopped — the one failure the Actions-API heartbeat below cannot report, because it would have stopped too.

## The fleet at a glance

| Property                                | Count |
| --------------------------------------- | ----- |
| Scheduled workflows                     | 61    |
| Locked via `withCronLock`               | 57    |
| — fail-closed                           | 22    |
| — fail-open                             | 35    |
| Locked by a bespoke Redis lock          | 3     |
| Deliberately unlocked                   | 1     |
| On the financial list                   | 14    |
| Without an `abortIfMaintenance()` guard | 12    |

## How to read the tables

Every scheduled workflow appears exactly once, grouped by the part of the product it serves. The columns mean the following.

**Schedule** is the raw cron expression in UTC, exactly as GitHub receives it. Treat it as an upper bound rather than a promise: GitHub throttles scheduled workflows under load, and a job asking for every minute has been measured delivering roughly every 2.75 hours. Minutes are deliberately staggered across the fleet so that simultaneous starts do not stampede the Supavisor connection pool, which `scripts/ci/check-workflow-hygiene.ts` enforces.

**Entrypoint** is the file the workflow executes. Where a second path appears beneath it, the first is a thin `jobs/**` wrapper holding the GitHub Actions plumbing — output variables, notice annotations, Sentry bootstrap — and the second is the `scripts/**` core holding the actual logic. The lock normally lives on the core so that every entry point inherits it, including the HTTP routes under `app/api/cleanup/`.

**Lock** records how the job behaves when Redis cannot be reached. A **closed** job refuses to run and pages, on the reasoning that a missed money run is recoverable and a silent unlocked double-run is not. An **open** job runs unlocked with a warning, which is correct for work whose side effects are harmless to repeat. **bespoke** means a hand-rolled `acquireLock` predating the wrapper, and **none** means deliberately unlocked; both are enumerated and justified under [Locking](#locking) below.

**Financial** reflects membership of `FINANCIAL_JOB_NAMES` in `lib/maintenance-cron.ts`. These jobs create or cancel financial objects through an external API, or mutate earnings, payouts and refunds, so a partial deployment can leave them inconsistent.

**During maintenance** is derived, not asserted. A job that calls `abortIfMaintenance()` exits cleanly when the maintenance phase is OFFLINE, and a financial job additionally exits when the phase is DEGRADED. A job that never calls it runs regardless of the phase, and is marked **Runs anyway** — see [Jobs that ignore maintenance mode](#jobs-that-ignore-maintenance-mode).

## Appointments and sessions

These jobs move bookings through their lifecycle and hand back the slots that nobody paid for. They are the fleet's most visible half: when one of them stops, consultees see availability that does not exist and consultants see sessions that never close.

| Workflow                                                                         | Schedule (UTC)  | Entrypoint                                                                                                                    | Lock   | Financial | Mutates                                                                                  | During maintenance |
| -------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | ---------------------------------------------------------------------------------------- | ------------------ |
| **Auto-Complete Appointments**<br>`auto-complete-appointments`                   | `7 * * * *`     | `jobs/appointments/auto-complete-appointments.ts`<br>→ `scripts/appointments/auto-complete-appointments.ts`                   | open   | no        | `Consultation`, `Subscription`, `Class`, `TrialSession` → COMPLETED; `ActivityLog`; Novu | Skips: OFFLINE     |
| **Cleanup Invalid Appointments**<br>`cleanup-invalid-appointments`               | `12 * * * *`    | `jobs/appointments/cleanup-invalid-appointments.ts`<br>→ `scripts/appointments/cleanup-invalid-appointments.ts`               | open   | no        | Duplicate and invalid `Consultation`/`Subscription` cancelled, their slots released      | Skips: OFFLINE     |
| **Cleanup Stale Pending Consultations**<br>`cleanup-stale-pending-consultations` | `37 * * * *`    | `jobs/appointments/cleanup-stale-pending-consultations.ts`<br>→ `scripts/appointments/cleanup-stale-pending-consultations.ts` | open   | no        | Stale PENDING `Consultation` cancelled, reserved slots released                          | Skips: OFFLINE     |
| **Cleanup Tentative Slots**<br>`cleanup-tentative-slots`                         | `38 */2 * * *`  | `jobs/appointments/cleanup-tentative-slots.ts`<br>→ `scripts/appointments/cleanup-tentative-slots.ts`                         | open   | no        | Tentative `SlotOfAppointment` reservations released                                      | Skips: OFFLINE     |
| **Detect Consultant No-Shows**<br>`detect-consultant-no-shows`                   | `57 * * * *`    | `jobs/appointments/detect-consultant-no-shows.ts`<br>→ `scripts/appointments/detect-consultant-no-shows.ts`                   | closed | no        | `Consultation` no-show status, slot release, Novu notifications                          | Skips: OFFLINE     |
| **Expire Reschedule Proposals**<br>`expire-reschedule-proposals`                 | `45 * * * *`    | `jobs/appointments/expire-reschedule-proposals.ts`<br>→ `scripts/appointments/expire-reschedule-proposals.ts`                 | open   | no        | Expired `RescheduleRequest` proposals                                                    | Skips: OFFLINE     |
| **Expire Stale Requests**<br>`expire-stale-requests`                             | `20 1 * * *`    | `jobs/appointments/expire-stale-requests.ts`<br>→ `scripts/appointments/expire-stale-requests.ts`                             | open   | no        | Stale `Consultation` and `Subscription` requests expired                                 | Skips: OFFLINE     |
| **Expire Unpaid Trials**<br>`expire-unpaid-trials`                               | `40 * * * *`    | `jobs/trials/expire-unpaid-trials.ts`<br>→ `scripts/trials/expire-unpaid-trials.ts`                                           | open   | no        | `TrialSession` expiry, which frees the held trial slot                                   | Skips: OFFLINE     |
| **Reconcile Orphaned Meeting Sessions**<br>`reconcile-orphaned-sessions`         | `25,55 * * * *` | `jobs/meetings/reconcile-orphaned-sessions.ts`                                                                                | open   | no        | `MeetingSession` closure and slot state, reconciled against Stream calls                 | Skips: OFFLINE     |
| **Reconcile Slot Availability**<br>`reconcile-slot-availability`                 | `32 * * * *`    | `jobs/appointments/reconcile-slot-availability.ts`<br>→ `scripts/appointments/reconcile-slot-availability.ts`                 | open   | no        | `SlotOfAppointment` availability re-derived from live bookings                           | Skips: OFFLINE     |
| **Send Appointment Reminders**<br>`send-appointment-reminders`                   | `47 * * * *`    | `jobs/appointments/send-appointment-reminders.ts`<br>→ `scripts/appointments/send-appointment-reminders.ts`                   | open   | no        | Reads only; sends Novu reminders behind a Redis dedup key                                | Skips: OFFLINE     |

## Money in

Everything that reconciles what a consultee paid against what the gateway believes. Every job here that changes state is fail-closed, because the gateway is the authority and acting twice on its record is how a refund gets issued twice; the deadline alerter is the one exception, and it only reads.

| Workflow                                                                   | Schedule (UTC)     | Entrypoint                                                                                                      | Lock   | Financial | Mutates                                                                                                         | During maintenance        |
| -------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- | ------ | --------- | --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Alert Dispute Deadlines**<br>`alert-dispute-deadlines`                   | `2 * * * *`        | `jobs/disputes/alert-dispute-deadlines.ts`<br>→ `scripts/disputes/alert-dispute-deadlines.ts`                   | open   | no        | Reads only; logs deadline alerts                                                                                | Skips: OFFLINE            |
| **Cascade Refund to Earnings**<br>`cascade-refund-earnings`                | `1-59/15 * * * *`  | `jobs/refunds/cascade-refund-earnings.ts`<br>→ `scripts/refunds/cascade-refund-earnings.ts`                     | closed | yes       | `Refund.cascadedAt`, `PaymentLeg`, consultant and org earnings, payout clawback, ledger                         | Skips: OFFLINE + DEGRADED |
| **Cleanup Abandoned Payments**<br>`cleanup-abandoned-payments`             | `6-59/15 * * * *`  | `jobs/payments/cleanup-abandoned-payments.ts`<br>→ `scripts/payments/cleanup-abandoned-payments.ts`             | closed | yes       | `Payment` → EXPIRED, tentative slots released, `Consultation`/`Subscription` deleted, referral credits restored | Skips: OFFLINE + DEGRADED |
| **Handle Lost Disputes**<br>`handle-lost-disputes`                         | `8 */6 * * *`      | `jobs/disputes/handle-lost-disputes.ts`<br>→ `scripts/disputes/handle-lost-disputes.ts`                         | closed | yes       | Consultant and org earnings refund amounts, `TDSRecord` reversals                                               | Skips: OFFLINE + DEGRADED |
| **Reconcile Disputes**<br>`reconcile-disputes`                             | `28 */6 * * *`     | `jobs/disputes/reconcile-disputes.ts`<br>→ `scripts/disputes/reconcile-disputes.ts`                             | closed | yes       | `Dispute` status reconciled against gateway records                                                             | Skips: OFFLINE + DEGRADED |
| **Reconcile Orphaned Confirmations**<br>`reconcile-orphaned-confirmations` | `13-59/30 * * * *` | `jobs/payments/reconcile-orphaned-confirmations.ts`<br>→ `scripts/payments/reconcile-orphaned-confirmations.ts` | closed | no        | `SlotOfAppointment.isTentative` and `Consultation`/`Subscription` approval status                               | Skips: OFFLINE            |
| **Reconcile Payment Status**<br>`reconcile-payment-status`                 | `18-59/30 * * * *` | `jobs/payments/reconcile-payment-status.ts`<br>→ `scripts/payments/reconcile-payment-status.ts`                 | closed | yes       | `Payment` status reconciled against gateway records                                                             | Skips: OFFLINE + DEGRADED |
| **Reconcile Pending Refunds**<br>`reconcile-pending-refunds`               | `11-59/15 * * * *` | `jobs/refunds/reconcile-pending-refunds.ts`<br>→ `scripts/refunds/reconcile-pending-refunds.ts`                 | closed | yes       | `Refund` status reconciled against the gateway; Novu notices                                                    | Skips: OFFLINE + DEGRADED |

## Money out

The payout and earnings pipeline, which turns completed sessions into money leaving the platform. This is the only group where a double-run can disburse the same rupee twice, which is why the two payout jobs carry their own dedicated locks on top of everything else.

| Workflow                                                               | Schedule (UTC) | Entrypoint                                                                                  | Lock    | Financial | Mutates                                                                                                           | During maintenance        |
| ---------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Create Payout Batch**<br>`create-payout-batch`                       | `0 20 * * 1`   | `jobs/payouts/create-payout-batch.ts`<br>→ `scripts/payouts/create-payout-batch.ts`         | bespoke | yes       | `ConsultantPayout` batch rows created, `ConsultantEarnings` claimed                                               | Skips: OFFLINE + DEGRADED |
| **Handle Stuck Payouts**<br>`handle-stuck-payouts`                     | `52 */4 * * *` | `jobs/payouts/handle-stuck-payouts.ts`<br>→ `scripts/payouts/handle-stuck-payouts.ts`       | closed  | yes       | `ConsultantPayout` stuck-state recovery, `SystemEvent`; queries RazorpayX and Stripe                              | Skips: OFFLINE + DEGRADED |
| **Process Payouts**<br>`process-payouts`                               | `0 21 * * 1`   | `jobs/payouts/process-payouts.ts`                                                           | bespoke | yes       | Consultant and org payout status, `ConsultantEarnings`, `TDSRecord`, ledger; submits RazorpayX and Stripe payouts | Skips: OFFLINE + DEGRADED |
| **Reconcile Payout Status**<br>`reconcile-payout-status`               | `33 */6 * * *` | `jobs/payouts/reconcile-payout-status.ts`<br>→ `scripts/payouts/reconcile-payout-status.ts` | closed  | yes       | `ConsultantPayout` status and TDS fields, `ConsultantEarnings`, `TDSRecord`, ledger entries                       | Skips: OFFLINE + DEGRADED |
| **Release Earnings from Hold**<br>`release-earnings`                   | `17 * * * *`   | `jobs/earnings/release-earnings.ts`<br>→ `scripts/earnings/release-earnings.ts`             | closed  | yes       | `ConsultantEarnings` released from hold                                                                           | Skips: OFFLINE + DEGRADED |
| **Release PENDING_TRUST Earnings**<br>`release-pending-trust-earnings` | `42 * * * *`   | `jobs/cleanup/release-pending-trust-earnings.ts`                                            | closed  | no        | Consultant and org earnings released from PENDING_TRUST                                                           | **Runs anyway**           |
| **Sync Payment to Earnings**<br>`sync-payment-earnings`                | `22 * * * *`   | `jobs/earnings/sync-payment-earnings.ts`<br>→ `scripts/earnings/sync-payment-earnings.ts`   | closed  | yes       | Creates consultant and org earnings plus the booking ledger rows                                                  | Skips: OFFLINE + DEGRADED |

## Billing and contracts

Organisation billing runs on its own cycle engine, and these jobs advance it. They are the newest part of the fleet, and it shows in the maintenance column: six of the eight are self-contained `jobs/**` entrypoints written after the `abortIfMaintenance()` convention was established, and none of them adopted it.

| Workflow                                                               | Schedule (UTC) | Entrypoint                                       | Lock   | Financial | Mutates                                                                                | During maintenance        |
| ---------------------------------------------------------------------- | -------------- | ------------------------------------------------ | ------ | --------- | -------------------------------------------------------------------------------------- | ------------------------- |
| **Advance Program Cycles**<br>`advance-program-cycles`                 | `15 2 * * *`   | `jobs/billing/advance-program-cycles.ts`         | closed | no        | `ProgramAssignment` cycle advancement, `OrgAuditLog`                                   | **Runs anyway**           |
| **Auto-Renew Contracts**<br>`auto-renew-contracts`                     | `30 2 * * *`   | `jobs/contracts/auto-renew-contracts.ts`         | open   | no        | `Contract` renewal dates, `Program` rollover, `OrgAuditLog`                            | **Runs anyway**           |
| **Dunning**<br>`dunning`                                               | `30 23 * * *`  | `jobs/billing/dunning.ts`                        | closed | no        | `OrganizationInvoice` dunning state, `OrgAuditLog`, Novu overdue notices               | **Runs anyway**           |
| **Expire Contracts**<br>`expire-contracts`                             | `10 3 * * *`   | `jobs/contracts/expire-contracts.ts`             | open   | no        | `Contract`, `Program` and `ProgramAssignment` expiry, `OrgAuditLog`                    | **Runs anyway**           |
| **Generate Subscription Invoices**<br>`generate-subscription-invoices` | `0 1 * * *`    | `jobs/billing/generate-subscription-invoices.ts` | closed | yes       | `OrganizationInvoice` creation, `OrgInvoiceCounter`, `BillingSubscription` period roll | Skips: OFFLINE + DEGRADED |
| **Settle Invoice Accruals**<br>`settle-invoice-accruals`               | `0 4 1 * *`    | `jobs/billing/settle-invoice-accruals.ts`        | closed | yes       | `OrganizationInvoice` accrual settlement, `Payment` rows                               | Skips: OFFLINE + DEGRADED |
| **Timeout Member Overages**<br>`timeout-member-overages`               | `0 23 * * *`   | `jobs/billing/timeout-member-overages.ts`        | closed | no        | `OverageEvent` timeout, `Payment`/`PaymentLeg` restore, `SystemEvent`                  | **Runs anyway**           |
| **Wallet Low Balance**<br>`wallet-low-balance`                         | `45 23 * * *`  | `jobs/billing/wallet-low-balance.ts`             | open   | no        | `BillingAccount` low-balance flag; Novu wallet alerts                                  | **Runs anyway**           |

## Compliance

These jobs exist because a statute or a regulator says they must, and their deadlines are external. Skipping one for a maintenance window is cheap; skipping one for a week is not.

| Workflow                                                                | Schedule (UTC) | Entrypoint                                      | Lock | Financial | Mutates                                                                          | During maintenance |
| ----------------------------------------------------------------------- | -------------- | ----------------------------------------------- | ---- | --------- | -------------------------------------------------------------------------------- | ------------------ |
| **Consent Retention Sweeper**<br>`consent-retention-sweeper`            | `0 21 * * 0`   | `jobs/compliance/consent-retention-sweeper.ts`  | open | no        | Expired `ConsentArtifact` rows deleted, and only when `DPDP_SWEEPER_DELETE=true` | Skips: OFFLINE     |
| **DPDP DataBreach 72h Deadline Alerts**<br>`databreach-deadline-alerts` | `27 * * * *`   | `jobs/compliance/databreach-deadline-alerts.ts` | open | no        | Reads only; emails the DPDP officer inbox                                        | **Runs anyway**    |
| **IRP IRN Uploader**<br>`irp-uploader`                                  | `50 2 * * *`   | `jobs/compliance/irp-uploader.ts`               | open | no        | `OrganizationInvoice` IRN fields; uploads invoices to the IRP                    | **Runs anyway**    |
| **MSME Section 43B(h) Payment Alerts**<br>`msme-payment-alerts`         | `30 4 * * *`   | `jobs/compliance/msme-payment-alerts.ts`        | open | no        | Reads only; emails the finance inbox                                             | **Runs anyway**    |

## Stream and recordings

Chat channels, video sessions and the recordings they produce all live in Stream's systems as well as ours, so these jobs reconcile two sources of truth and move recording files into our own storage before Stream expires them.

| Workflow                                                             | Schedule (UTC) | Entrypoint                                                                                              | Lock    | Financial | Mutates                                                          | During maintenance |
| -------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- | ------- | --------- | ---------------------------------------------------------------- | ------------------ |
| **Cleanup Old Stream Recordings**<br>`cleanup-old-stream-recordings` | `0 3 * * *`    | `jobs/cleanup/cleanup-old-stream-recordings.ts`<br>→ `scripts/cleanup/cleanup-old-stream-recordings.ts` | open    | no        | `Recording` rows and Supabase objects deleted past org retention | Skips: OFFLINE     |
| **Expire Event Chat Channels**<br>`expire-event-channels`            | `35 4 * * *`   | `jobs/stream/expire-event-channels.ts`                                                                  | open    | no        | Stream channels frozen then deleted; no DB writes                | Skips: OFFLINE     |
| **Mark Expired Recordings**<br>`mark-expired-recordings`             | `20 3 * * *`   | `jobs/stream/mark-expired-recordings.ts`                                                                | open    | no        | `Recording` → EXPIRED past retention                             | Skips: OFFLINE     |
| **Stream User Sync**<br>`stream-sync`                                | `40 3 * * *`   | `jobs/stream/stream-sync.ts`<br>→ `scripts/stream/stream-sync.ts`                                       | bespoke | no        | Stream Chat users soft-deleted; no DB writes                     | Skips: OFFLINE     |
| **Transfer Expiring Recordings**<br>`transfer-expiring-recordings`   | `58 */6 * * *` | `jobs/stream/transfer-expiring-recordings.ts`                                                           | open    | no        | `Recording` storage path; copies Stream recordings into Supabase | Skips: OFFLINE     |

## Housekeeping and platform hygiene

The long tail: janitors, sweepers, retry drains and the watchdog. Individually none of them is urgent, which is exactly why they are the ones that can stop firing for a month before anyone notices — the failure this PR's heartbeat exists to catch.

| Workflow                                                                 | Schedule (UTC)     | Entrypoint                                                                                                  | Lock   | Financial | Mutates                                                                                                | During maintenance |
| ------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------ | ------------------ |
| **Alert Orphaned Payments**<br>`alert-orphaned-payments`                 | `30 */6 * * *`     | `jobs/alerts/alert-orphaned-payments.ts`<br>→ `scripts/alerts/alert-orphaned-payments.ts`                   | open   | no        | Reads only; logs CRITICAL alerts                                                                       | Skips: OFFLINE     |
| **Archive Webhook Events**<br>`archive-webhook-events`                   | `25 0 * * 0`       | `jobs/cleanup/archive-webhook-events.ts`<br>→ `scripts/cleanup/archive-webhook-events.ts`                   | open   | no        | `WebhookEvent` rows archived and pruned                                                                | Skips: OFFLINE     |
| **Cleanup Abandoned Org Top-Ups**<br>`cleanup-abandoned-org-top-ups`     | `0 2 * * *`        | `jobs/cleanup/cleanup-abandoned-org-top-ups.ts`<br>→ `scripts/cleanup/cleanup-abandoned-org-top-ups.ts`     | closed | no        | `WalletTopUp` cancellation; cancels the Razorpay order                                                 | Skips: OFFLINE     |
| **Cleanup Auth Tokens**<br>`cleanup-auth-tokens`                         | `3 0 * * *`        | `jobs/cleanup/cleanup-auth-tokens.ts`<br>→ `scripts/cleanup/cleanup-auth-tokens.ts`                         | open   | no        | Expired `Session`, `Verification` and `IdempotencyRecord` rows deleted                                 | Skips: OFFLINE     |
| **Cleanup Empty Folders**<br>`cleanup-empty-folders`                     | `30 3 * * *`       | `scripts/utils/cleanup-empty-folders.ts`                                                                    | open   | no        | Supabase storage objects only; removes empty document folders                                          | **Runs anyway**    |
| **Cleanup Stale Invitations**<br>`cleanup-stale-invitations`             | `40 2 * * *`       | `jobs/cleanup/cleanup-stale-invitations.ts`<br>→ `scripts/cleanup/cleanup-stale-invitations.ts`             | open   | no        | Expired `Invitation` rows, `OrgAuditLog`                                                               | Skips: OFFLINE     |
| **Cron Heartbeat**<br>`cron-heartbeat`                                   | `40 4 * * *`       | `scripts/ci/check-cron-heartbeat.ts`                                                                        | none   | no        | Nothing; reads the Actions API and refreshes `cron:heartbeat:last`                                     | **Runs anyway**    |
| **Deactivate Expired Discounts**<br>`deactivate-expired-discounts`       | `15 0 * * *`       | `jobs/cleanup/deactivate-expired-discounts.ts`<br>→ `scripts/cleanup/deactivate-expired-discounts.ts`       | open   | no        | `DiscountCode` deactivated past its expiry                                                             | Skips: OFFLINE     |
| **Dispatch Outbound Webhooks**<br>`dispatch-outbound-webhooks`           | `* * * * *`        | `jobs/cleanup/dispatch-outbound-webhooks.ts`<br>→ `scripts/cleanup/dispatch-outbound-webhooks.ts`           | open   | no        | `OutboundWebhookDelivery` status and attempts, `WebhookEndpoint.lastSuccessAt`; POSTs to org endpoints | Skips: OFFLINE     |
| **Process Data Exports**<br>`process-data-exports`                       | `9-59/10 * * * *`  | `jobs/cleanup/process-data-exports.ts`<br>→ `scripts/cleanup/process-data-exports.ts`                       | open   | no        | `OrgDataExportJob` status; writes export archives to Supabase                                          | Skips: OFFLINE     |
| **Prune Audit Logs**<br>`prune-audit-logs`                               | `15 3 * * *`       | `jobs/cleanup/prune-audit-logs.ts`<br>→ `scripts/cleanup/prune-audit-logs.ts`                               | open   | no        | `OrgAuditLog` rows pruned past the retention floor                                                     | Skips: OFFLINE     |
| **Reconcile Document Storage**<br>`reconcile-document-storage`           | `35 2 * * *`       | `jobs/cleanup/reconcile-document-storage.ts`<br>→ `scripts/cleanup/reconcile-document-storage.ts`           | open   | no        | `AppointmentDocument.isStorageMissing`, reconciled against Supabase objects                            | Skips: OFFLINE     |
| **Reconcile Ledgers**<br>`reconcile-ledgers`                             | `45 3 * * *`       | `jobs/reconcile/reconcile-ledgers.ts`<br>→ `scripts/reconcile/reconcile-ledgers.ts`                         | open   | no        | Reads every financial table; writes `LedgerReconciliationReport` findings                              | Skips: OFFLINE     |
| **Retry Failed Emails**<br>`retry-failed-emails`                         | `5-59/15 * * * *`  | `jobs/email/retry-failed-emails.ts`                                                                         | open   | no        | `FailedEmail` retry state; re-sends the queued mail                                                    | Skips: OFFLINE     |
| **SSO Cert Expiry Alert**<br>`sso-cert-expiry-alert`                     | `25 3 * * *`       | `jobs/cleanup/sso-cert-expiry-alert.ts`<br>→ `scripts/cleanup/sso-cert-expiry-alert.ts`                     | open   | no        | `OrgAuditLog`; Novu alerts for expiring SSO certificates                                               | Skips: OFFLINE     |
| **Sweep Abandoned Overage Charges**<br>`sweep-abandoned-overage-charges` | `55 2 * * *`       | `jobs/cleanup/sweep-abandoned-overage-charges.ts`<br>→ `scripts/cleanup/sweep-abandoned-overage-charges.ts` | closed | no        | `OverageEvent.chargeStatus` → FAILED, parent `Payment.amount`, `PaymentLeg` restore                    | Skips: OFFLINE     |
| **Sweep Orphaned Top-up Captures**<br>`sweep-orphaned-topup-captures`    | `23-59/30 * * * *` | `jobs/cleanup/sweep-orphaned-topup-captures.ts`<br>→ `scripts/cleanup/sweep-orphaned-topup-captures.ts`     | closed | no        | `WalletTopUp` status, `BillingAccount.walletBalance`, TOPUP ledger entries                             | Skips: OFFLINE     |
| **Sweep Stuck Webhook Events**<br>`sweep-stuck-webhook-events`           | `4-59/10 * * * *`  | `jobs/cleanup/sweep-stuck-webhook-events.ts`<br>→ `scripts/cleanup/sweep-stuck-webhook-events.ts`           | closed | no        | `WebhookEvent.processed` and `error`, plus whatever the replayed events mutate                         | Skips: OFFLINE     |

## Jobs that ignore maintenance mode

12 of the 61 scheduled jobs never call `abortIfMaintenance()`, so they run straight through both DEGRADED and OFFLINE maintenance. The previous version of this page claimed the opposite for all of them, which is the kind of documentation error that gets acted on at two in the morning.

- `advance-program-cycles` — jobs/billing/advance-program-cycles.ts
- `auto-renew-contracts` — jobs/contracts/auto-renew-contracts.ts
- `cleanup-empty-folders` — scripts/utils/cleanup-empty-folders.ts
- `cron-heartbeat` — scripts/ci/check-cron-heartbeat.ts
- `databreach-deadline-alerts` — jobs/compliance/databreach-deadline-alerts.ts
- `dunning` — jobs/billing/dunning.ts
- `expire-contracts` — jobs/contracts/expire-contracts.ts
- `irp-uploader` — jobs/compliance/irp-uploader.ts
- `msme-payment-alerts` — jobs/compliance/msme-payment-alerts.ts
- `release-pending-trust-earnings` — jobs/cleanup/release-pending-trust-earnings.ts
- `timeout-member-overages` — jobs/billing/timeout-member-overages.ts
- `wallet-low-balance` — jobs/billing/wallet-low-balance.ts

None of them is on the financial list, so the DEGRADED protection is not what is missing here; the OFFLINE protection is. Until the guard is added, an OFFLINE window has to assume these jobs are live, and a migration that rewrites the models in their **Mutates** column should be scheduled against their cron minute rather than against the maintenance flag. This is tracked as follow-up work rather than fixed in #1169, because adding a guard changes when a job runs and each one deserves its own reasoning.

## Locking

`withCronLock` (`lib/cron/with-cron-lock.ts`) provides distributed mutual exclusion keyed `cron:lock:<jobName>`, with a fifteen-minute TTL by default and thirty-five minutes for the payout and reconcile family. It exists because the same job can be entered three ways — the schedule, a manual `workflow_dispatch`, and an authenticated HTTP call — and jobs whose side effects are only partially idempotent must not run twice concurrently.

It is a mutual-exclusion tool and nothing more. Data correctness comes from compare-and-set transitions and unique constraints, never from this lock, because Redis and PostgreSQL are separate failure domains and the lock can be lost without the database noticing. ADR 13 records that reasoning in full.

Four scheduled workflows do not use it, each for a stated reason.

| Workflow              | Mechanism                              | Why not `withCronLock`                                                                                                                                                        |
| --------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process-payouts`     | `lock:payout_processing`               | Predates the wrapper and additionally guards the HTTP approval path, which the `cron:lock:` key shape does not reach.                                                         |
| `create-payout-batch` | `lock:payout_batch_creation`           | Same lock family as above, held across a batch that outlives the default TTL.                                                                                                 |
| `stream-sync`         | `SYNC_LOCK_KEY` plus a circuit breaker | Fans out to Stream's API and must stop retrying when that API is itself the failure.                                                                                          |
| `cron-heartbeat`      | None, deliberately                     | Locking the dead-man switch through Redis would make the watchdog depend on the infrastructure it exists to report on. The check is read-only, so a double-run costs nothing. |

Each entry is mirrored in `LOCK_EXEMPT` in `__tests__/maintenance/cron-lock-registry.test.ts`. That test fails both when a new workflow appears without a lock and when an exempt workflow grows a real one, so the table above cannot rot without CI saying so.

## Watchdogs

Two independent mechanisms answer "is the fleet still alive", and they are independent on purpose.

The first is `cron-heartbeat`, which runs daily and queries the GitHub Actions API for the last run of every scheduled workflow, failing when any of them has gone quiet for longer than its cadence allows. It catches the common case, including GitHub automatically disabling schedules after sixty days of repository inactivity. It cannot, however, report the case where schedules stop fleet-wide, because it is itself a scheduled workflow and would stop with them.

The second closes that gap from the other side. Every locked run refreshes `cron:heartbeat:last` in Redis, the daily heartbeat check refreshes it too, and `GET /api/health` exposes its age:

```json
{
  "cron": {
    "configured": true,
    "lastRunAt": "2026-08-14T04:40:12.000Z",
    "stale": false
  }
}
```

`stale` turns true once the key is older than six hours, and is `null` before the fleet has ever written one or when Redis is not configured. Because this is an ordinary HTTP field, an external uptime monitor can watch it with no dependency on GitHub at all. Both the heartbeat write and this probe are fail-open: neither may ever be the reason a job fails or a health check errors.

## Keeping this page true

This page is generated from the repository, so it is only as current as its last regeneration. The mechanical claims — how many workflows exist, which are locked, which are fail-closed, which are financial — are additionally asserted by `__tests__/maintenance/cron-lock-registry.test.ts`, so those cannot drift silently even between regenerations. The prose, the **Mutates** column and the group headings are hand-written and need a human to revisit them when a job's purpose changes.

When adding a scheduled job, the checklist is: give it a `jobs/**` wrapper and a `scripts/**` or `lib/**` core, wrap the core in `withCronLock` with a deliberate `failMode`, call `abortIfMaintenance()` in the wrapper, add the job name to `FINANCIAL_JOB_NAMES` if it touches money, pick a cron minute no other job already uses, add the failure-notification step, and add a row here.
