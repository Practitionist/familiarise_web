# Cron Jobs Reference

All 28 scheduled jobs run as GitHub Actions workflows, executing standalone Node.js scripts that connect directly to PostgreSQL via Prisma. They bypass the Next.js middleware entirely, but **all jobs call `abortIfMaintenance()` at startup** (`lib/maintenance-cron.ts`) — a clean exit (0) on OFFLINE mode, a logged warning on DEGRADED. The middleware bypass means they must check Redis themselves, which is exactly what this guard does.

## Summary by Category

| Category     | Count | Most Critical                                        |
| ------------ | ----- | ---------------------------------------------------- |
| Appointments | 7     | Reconcile Slot Availability, Cleanup Tentative Slots |
| Payments     | 3     | Cleanup Abandoned Payments, Reconcile Payment Status |
| Payouts      | 4     | Process Payouts, Create Payout Batch                 |
| Disputes     | 3     | Handle Lost Disputes                                 |
| Refunds      | 2     | Reconcile Pending Refunds                            |
| Earnings     | 2     | Sync Payment-Earning                                 |
| Cleanup      | 4     | Document Storage Reconciliation                      |
| Stream       | 1     | Stream User Sync                                     |

## Appointments

### 1. Auto-Complete Appointments

| Field                | Value                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Schedule**         | `0 * * * *` (hourly, at :00)                                                                           |
| **Script**           | `jobs/appointments/auto-complete-appointments.ts`                                                      |
| **Description**      | Marks webinars, classes, consultations, and subscriptions as COMPLETED when their end time has passed. |
| **DB Connection**    | Yes (Prisma)                                                                                           |
| **External APIs**    | None                                                                                                   |
| **Maintenance Risk** | MEDIUM -- Running during migration could mark incomplete events as completed                           |
| **Safe to skip?**    | Yes -- catch-up on next run. Events will be completed on the next hourly cycle.                        |

### 2. Cleanup Invalid Appointments

| Field                | Value                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Schedule**         | `0 * * * *` (hourly, at :00)                                                                                                         |
| **Script**           | `jobs/appointments/cleanup-invalid-appointments.ts`                                                                                  |
| **Description**      | Cancels duplicate appointments and appointments with invalid durations (consultations/subscriptions). Cleans up conflicting records. |
| **DB Connection**    | Yes (Prisma)                                                                                                                         |
| **External APIs**    | None                                                                                                                                 |
| **Maintenance Risk** | HIGH -- Could incorrectly identify valid records as invalid if schema is changing                                                    |
| **Safe to skip?**    | Yes -- duplicates accumulate but don't cause harm until next run.                                                                    |

### 3. Cleanup Stale Pending Consultations

| Field                | Value                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Schedule**         | `30 * * * *` (hourly, at :30)                                                               |
| **Script**           | `jobs/appointments/cleanup-stale-pending-consultations.ts`                                  |
| **Description**      | Cancels consultations stuck in PENDING state for >24 hours. Releases their reserved slots.  |
| **DB Connection**    | Yes (Prisma)                                                                                |
| **External APIs**    | None                                                                                        |
| **Maintenance Risk** | MEDIUM -- May release slots that are legitimately pending due to delayed webhook processing |
| **Safe to skip?**    | Yes -- stale consultations will be caught on next run. 24-hour window provides buffer.      |

### 4. Cleanup Tentative Slots

| Field                | Value                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 */2 * * *` (every 2 hours)                                                                     |
| **Script**           | `jobs/appointments/cleanup-tentative-slots.ts`                                                    |
| **Description**      | Releases tentative (reserved but unconfirmed) slot reservations older than 30 minutes.            |
| **DB Connection**    | Yes (Prisma)                                                                                      |
| **External APIs**    | None                                                                                              |
| **Maintenance Risk** | MEDIUM -- Could release slots that are tentative due to in-flight payments delayed by maintenance |
| **Safe to skip?**    | Yes -- tentative slots will accumulate but next run catches up.                                   |

### 5. Expire Stale Requests

| Field                | Value                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 1 * * *` (daily at 1 AM UTC)                                                                                      |
| **Script**           | `jobs/appointments/expire-stale-requests.ts`                                                                         |
| **Description**      | Expires old consultation/subscription requests and payment-pending requests that have exceeded their timeout period. |
| **DB Connection**    | Yes (Prisma)                                                                                                         |
| **External APIs**    | None                                                                                                                 |
| **Maintenance Risk** | LOW -- Daily job, unlikely to conflict with short maintenance windows                                                |
| **Safe to skip?**    | Yes -- stale requests persist one extra day.                                                                         |

### 6. Reconcile Slot Availability

| Field                | Value                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `15 * * * *` (hourly, at :15)                                                                                        |
| **Script**           | `jobs/appointments/reconcile-slot-availability.ts`                                                                   |
| **Description**      | Clears tentative flags on confirmed slots and detects double bookings. Critical for maintaining slot data integrity. |
| **DB Connection**    | Yes (Prisma)                                                                                                         |
| **External APIs**    | None                                                                                                                 |
| **Maintenance Risk** | **CRITICAL** -- Running during migration may detect false anomalies and "fix" them, corrupting slot state            |
| **Safe to skip?**    | Yes, but run manually post-maintenance. Slot integrity depends on this job.                                          |

### 7. Detect Consultant No-Shows

| Field                | Value                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `17 * * * *` (hourly, at :17)                                                                                        |
| **Script**           | `jobs/appointments/detect-consultant-no-shows.ts`                                                                    |
| **Description**      | Detects confirmed CONSULTATION sessions where the consultant did not attend (past a 120-minute grace window), auto-refunds the consultee via `refundPayment`, marks the booking cancelled, and notifies both parties. Subscriptions are not yet covered. |
| **DB Connection**    | Yes (Prisma)                                                                                                         |
| **External APIs**    | Payment gateway (refunds), Novu (notifications)                                                                      |
| **Maintenance Risk** | HIGH -- This job moves money (auto-refund). It runs under a fail-closed cron lock and refuses to run without a real Redis lock. |
| **Safe to skip?**    | Yes -- catch-up on next run. No-shows are detected on the next hourly cycle.                                         |

## Payments

### 8. Alert Orphaned Payments

| Field                | Value                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `30 */6 * * *` (every 6 hours, at :30)                                                                                           |
| **Script**           | `jobs/alerts/alert-orphaned-payments.ts`                                                                                         |
| **Description**      | Detects payments recorded in payment gateways but with no corresponding appointment created. Sends alerts for orphaned payments. |
| **DB Connection**    | Yes (Prisma)                                                                                                                     |
| **External APIs**    | Stripe, Razorpay                                                                                                                  |
| **Maintenance Risk** | LOW -- Read-only detection, but may generate false alerts during maintenance                                                     |
| **Safe to skip?**    | Yes -- alerts delayed but no data corruption.                                                                                    |

### 9. Cleanup Abandoned Payments

| Field                | Value                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `*/15 * * * *` (every 15 minutes)                                                                                            |
| **Script**           | `jobs/payments/cleanup-abandoned-payments.ts`                                                                                |
| **Description**      | Cancels payment intents abandoned >30 min with no confirmed appointment. Also resets approval-pending consultation requests. |
| **DB Connection**    | Yes (Prisma)                                                                                                                 |
| **External APIs**    | Stripe, Razorpay                                                                                                              |
| **Maintenance Risk** | **CRITICAL** -- May cancel valid payment intents where appointment creation was delayed by maintenance downtime              |
| **Safe to skip?**    | Must skip during maintenance. Run post-maintenance catch-up after confirming no in-flight payments.                          |

### 10. Reconcile Payment Status

| Field                | Value                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Schedule**         | `*/30 * * * *` (every 30 minutes)                                                                    |
| **Script**           | `jobs/payments/reconcile-payment-status.ts`                                                          |
| **Description**      | Checks payment gateways for status updates. Flags succeeded payments that need appointment creation. |
| **DB Connection**    | Yes (Prisma)                                                                                         |
| **External APIs**    | Stripe, Razorpay                                                                                     |
| **Maintenance Risk** | HIGH -- May attempt to create appointments against a migrating schema                                |
| **Safe to skip?**    | Yes, but run manually post-maintenance to catch missed payments.                                     |

## Payouts

### 11. Create Payout Batch

| Field                | Value                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 20 * * 1` (Monday 8 PM UTC)                                                                          |
| **Script**           | `jobs/payouts/create-payout-batch.ts`                                                                   |
| **Description**      | Creates weekly payout batch from available consultant earnings. Auto-approves small payouts (<INR 10K). |
| **DB Connection**    | Yes (Prisma)                                                                                            |
| **External APIs**    | None                                                                                                    |
| **Maintenance Risk** | HIGH -- May create batch from incomplete/corrupted earnings data                                        |
| **Safe to skip?**    | Yes -- batch creation can be triggered manually. Payouts delayed by one week if missed.                 |

### 12. Process Payouts

| Field                | Value                                                                                |
| -------------------- | ------------------------------------------------------------------------------------ |
| **Schedule**         | `0 21 * * 1` (Monday 9 PM UTC)                                                       |
| **Script**           | `jobs/payouts/process-payouts.ts`                                                    |
| **Description**      | Processes approved payouts to consultants via Razorpay and Stripe Connect.           |
| **DB Connection**    | Yes (Prisma)                                                                         |
| **External APIs**    | Razorpay, Stripe Connect                                                             |
| **Maintenance Risk** | **CRITICAL** -- May send incorrect amounts or process payouts based on stale data    |
| **Safe to skip?**    | Must skip during maintenance. Payouts are irreversible once sent to payment gateway. |

### 13. Handle Stuck Payouts

| Field                | Value                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 */4 * * *` (every 4 hours)                                                                         |
| **Script**           | `jobs/payouts/handle-stuck-payouts.ts`                                                                |
| **Description**      | Retries failed payouts and checks gateway status. Flags permanently failed payouts after max retries. |
| **DB Connection**    | Yes (Prisma)                                                                                          |
| **External APIs**    | Stripe, Razorpay                                                                                      |
| **Maintenance Risk** | MEDIUM -- May retry payouts that should remain paused during maintenance                              |
| **Safe to skip?**    | Yes -- stuck payouts will be retried on next cycle.                                                   |

### 14. Reconcile Payout Status

| Field                | Value                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 */6 * * *` (every 6 hours)                                                                |
| **Script**           | `jobs/payouts/reconcile-payout-status.ts`                                                    |
| **Description**      | Syncs payout status from gateways. Detects discrepancies between DB state and gateway state. |
| **DB Connection**    | Yes (Prisma)                                                                                 |
| **External APIs**    | Stripe, Razorpay                                                                             |
| **Maintenance Risk** | LOW -- Read-heavy reconciliation, but may flag false discrepancies                           |
| **Safe to skip?**    | Yes -- reconciliation delayed but no data corruption.                                        |

## Disputes

### 15. Alert Dispute Deadlines

| Field                | Value                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Schedule**         | `0 * * * *` (hourly)                                                                                         |
| **Script**           | `jobs/disputes/alert-dispute-deadlines.ts`                                                                   |
| **Description**      | Identifies disputes approaching response deadline. Sends alerts for urgent (>48h) and critical (<12h) cases. |
| **DB Connection**    | Yes (Prisma)                                                                                                 |
| **External APIs**    | Stripe (optional)                                                                                            |
| **Maintenance Risk** | LOW -- Alert-only, no state changes                                                                          |
| **Safe to skip?**    | Yes -- alerts delayed but dispute deadlines are external.                                                    |

### 16. Handle Lost Disputes

| Field                | Value                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 */6 * * *` (every 6 hours)                                                                                  |
| **Script**           | `jobs/disputes/handle-lost-disputes.ts`                                                                        |
| **Description**      | Processes disputes marked as lost. Now uses canonical `refundEarnings(paymentId, { forceRefund: true })` instead of manual logic (Mar 2026). Correctly creates TDS reversal records and decrements `totalRevenue` for PAID earnings. |
| **DB Connection**    | Yes (Prisma)                                                                                                   |
| **External APIs**    | Stripe                                                                                                         |
| **Maintenance Risk** | HIGH -- May incorrectly process earnings if data is in flux                                                    |
| **Safe to skip?**    | Yes -- lost disputes can wait 6 hours. Run manually if urgent.                                                 |

### 17. Reconcile Disputes

| Field                | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Schedule**         | `0 */6 * * *` (every 6 hours)                                                         |
| **Script**           | `jobs/disputes/reconcile-disputes.ts`                                                 |
| **Description**      | Syncs dispute status from payment gateways. Flags urgent cases needing manual review. |
| **DB Connection**    | Yes (Prisma)                                                                          |
| **External APIs**    | Stripe                                                                                |
| **Maintenance Risk** | LOW -- Read-heavy reconciliation                                                      |
| **Safe to skip?**    | Yes -- reconciliation delayed but no data corruption.                                 |

## Refunds

### 18. Cascade Refund to Earnings

| Field                | Value                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `*/15 * * * *` (every 15 minutes)                                                                              |
| **Script**           | `jobs/refunds/cascade-refund-earnings.ts`                                                                      |
| **Description**      | Cascades completed refunds to consultant earnings records. Updates earnings status when refunds are processed. |
| **DB Connection**    | Yes (Prisma)                                                                                                   |
| **External APIs**    | None                                                                                                           |
| **Maintenance Risk** | HIGH -- May incorrectly adjust earnings if refund/earnings tables are being migrated                           |
| **Safe to skip?**    | Yes -- earnings adjustments delayed but caught on next run.                                                    |

### 19. Reconcile Pending Refunds

| Field                | Value                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| **Schedule**         | `*/15 * * * *` (every 15 minutes)                                                              |
| **Script**           | `jobs/refunds/reconcile-pending-refunds.ts`                                                    |
| **Description**      | Checks payment gateways for refund status updates. Syncs refund completion status to database. |
| **DB Connection**    | Yes (Prisma)                                                                                   |
| **External APIs**    | Stripe, Razorpay                                                                               |
| **Maintenance Risk** | MEDIUM -- May sync incorrect status if DB schema has changed                                   |
| **Safe to skip?**    | Yes -- pending refunds will be reconciled on next run.                                         |

## Earnings

### 20. Sync Payment-Earning

| Field                | Value                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 * * * *` (hourly)                                                                           |
| **Script**           | `jobs/earnings/sync-payment-earnings.ts`                                                       |
| **Description**      | Matches confirmed payments with consultant earnings records. Creates missing earnings entries. Uses cursor-based pagination (Mar 2026, replacing skip-based). For WEBINAR/CLASS payments, calls `calculateRevenueSplit()` to create multi-party earnings with proper role/sharePercentage for collaborators. |
| **DB Connection**    | Yes (Prisma)                                                                                   |
| **External APIs**    | None                                                                                           |
| **Maintenance Risk** | HIGH -- May create incorrect earnings if payment/earnings tables are being migrated            |
| **Safe to skip?**    | Yes -- earnings sync delayed but caught on next run.                                           |

### 21. Release Earnings from Hold

| Field                | Value                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 * * * *` (hourly)                                                                                  |
| **Script**           | `jobs/earnings/release-earnings.ts`                                                                   |
| **Description**      | Releases consultant earnings from dispute/refund hold after the hold period expires (7 days default). |
| **DB Connection**    | Yes (Prisma)                                                                                          |
| **External APIs**    | None                                                                                                  |
| **Maintenance Risk** | MEDIUM -- May release earnings prematurely if hold dates are corrupted during migration               |
| **Safe to skip?**    | Yes -- hold period provides buffer. Earnings released on next cycle.                                  |

## Cleanup

### 22. Deactivate Expired Discounts

| Field                | Value                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **Schedule**         | `0 0 * * *` (daily at midnight UTC)                                                        |
| **Script**           | `jobs/cleanup/deactivate-expired-discounts.ts`                                             |
| **Description**      | Deactivates discount codes that have expired by date or reached their maximum usage limit. |
| **DB Connection**    | Yes (Prisma)                                                                               |
| **External APIs**    | None                                                                                       |
| **Maintenance Risk** | LOW -- Simple status update, unlikely to conflict                                          |
| **Safe to skip?**    | Yes -- expired discounts persist one extra day. Minimal impact.                            |

### 23. Document Storage Reconciliation

| Field                | Value                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 2 * * *` (daily at 2 AM UTC)                                                                         |
| **Script**           | `jobs/cleanup/reconcile-document-storage.ts`                                                            |
| **Description**      | Reconciles Supabase storage with database records. Deletes orphaned files and identifies missing files. |
| **DB Connection**    | Yes (Prisma)                                                                                            |
| **External APIs**    | Supabase Storage API                                                                                    |
| **Maintenance Risk** | MEDIUM -- May incorrectly identify files as orphaned if document table is being migrated                |
| **Safe to skip?**    | Yes -- orphaned files persist one extra day. Run manually post-maintenance.                             |

### 24. Archive Webhook Events

| Field                | Value                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 0 * * 0` (weekly, Sunday midnight UTC)                                                         |
| **Script**           | `jobs/cleanup/archive-webhook-events.ts`                                                          |
| **Description**      | Removes old webhook events from database. Deletes processed and failed events older than 30 days. |
| **DB Connection**    | Yes (Prisma)                                                                                      |
| **External APIs**    | None                                                                                              |
| **Maintenance Risk** | LOW -- Cleanup of old data, not time-sensitive                                                    |
| **Safe to skip?**    | Yes -- old events persist one extra week.                                                         |

### 25. Cleanup Auth Tokens

| Field                | Value                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 0 * * *` (daily at midnight UTC)                                                                |
| **Script**           | `jobs/cleanup/cleanup-auth-tokens.ts`                                                              |
| **Description**      | Cleans up expired verification tokens, sessions, and password reset tokens from BetterAuth tables. |
| **DB Connection**    | Yes (Prisma)                                                                                       |
| **External APIs**    | None                                                                                               |
| **Maintenance Risk** | LOW -- Cleanup of expired tokens, minimal risk                                                     |
| **Safe to skip?**    | Yes -- expired tokens accumulate but don't affect functionality.                                   |

## Stream

### 26. Stream User Sync

| Field                | Value                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Schedule**         | `0 3 * * 0` (weekly, Sunday 3 AM UTC)                                                                                         |
| **Script**           | `jobs/stream/stream-sync.ts`                                                                                                  |
| **Description**      | Cleans up Stream.io users. Identifies and deletes stale users not associated with active consultations, classes, or webinars. |
| **DB Connection**    | Yes (Prisma)                                                                                                                  |
| **External APIs**    | Stream.io API                                                                                                                 |
| **Maintenance Risk** | MEDIUM -- May incorrectly identify active users as stale if appointment tables are being migrated                             |
| **Safe to skip?**    | Yes -- stale users persist one extra week. Run manually post-maintenance if concerned.                                        |

## Post-Maintenance Catch-Up Priority

After ending maintenance, manually trigger these jobs in order:

1. **Reconcile Payment Status** -- Catch any payments that succeeded during downtime
2. **Reconcile Slot Availability** -- Fix any slot inconsistencies
3. **Sync Payment-Earning** -- Ensure earnings match payments
4. **Cleanup Tentative Slots** -- Release any stale tentative reservations
5. **Reconcile Pending Refunds** -- Sync refund statuses
6. **Reconcile Payout Status** -- Sync payout statuses (if payout window passed)
