# Cron Jobs and Background Tasks

## Overview

The booking system relies on several cron jobs to maintain data integrity, expire stale records, and automatically transition appointment statuses. These background tasks handle situations that cannot be resolved synchronously during user interactions, such as:

- Completing appointments after sessions end
- Releasing slots held by abandoned booking flows
- Expiring unanswered requests
- Detecting and cleaning up duplicate or invalid records
- Reconciling slot availability after payment state changes

### Invocation Model

Each job follows a unified HTTP-first or GitHub Actions invocation pattern:

1. **Dynamic HTTP cleanup dispatcher (`app/api/cleanup/[job]/route.ts`)** -- Every cleanup job is registered in `lib/cron/cleanup-registry.ts` and exposed at `/api/cleanup/<job>`. `netlify/functions/cron-tick.mts` runs every five minutes and POSTs latency-sensitive targets (`auto-complete-appointments`, `detect-consultant-no-shows`, `expire-unpaid-trials`, `reschedule-proposals`, `appointment-reminders`, `tentative-occurrences`, `expire-stale-requests`, `settle-cancelled-sessions`, and financial/outbox sweeps) on their configured cadence (`TARGET_EVERY_MINUTES`).
2. **GitHub Actions** (daily, weekly and intra-day batch fleets only) -- `cron-daily.yml`, `cron-weekly.yml` and `cron-intra-day.yml` execute core scripts directly via `tsx`. They are not a backstop for ticker targets.

Both paths call the same core function exported from `scripts/appointments/` (or `scripts/payments/`, `scripts/trials/`), wrapped in `withCronLock` and `assertNotInMaintenance` / `abortIfMaintenance`.

---

## Schedule Overview

| Job                         | Cadence / Trigger                                                     | Source Script                                               | API Route (`app/api/cleanup/[job]`)              |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Auto-complete appointments  | Netlify ticker every 30 min, 25-row bites until 16 s; no Actions twin | `scripts/appointments/auto-complete-appointments.ts`        | `/api/cleanup/auto-complete-appointments`        |
| Cleanup tentative slots     | Netlify ticker every 15 min, 200 rows                                 | `scripts/appointments/cleanup-tentative-occurrences.ts`     | `/api/cleanup/tentative-occurrences`             |
| Expire stale requests       | Netlify ticker every 15 min, 20 rows per arm                          | `scripts/appointments/expire-stale-requests.ts`             | `/api/cleanup/expire-stale-requests`             |
| Cleanup abandoned payments  | Netlify ticker every 15 min, 10 payments                              | `scripts/payments/cleanup-abandoned-payments.ts`            | `/api/cleanup/abandoned-payments`                |
| Reconcile slot availability | `cron-intra-day.yml` hourly (`17 * * * *`); detects only              | `scripts/appointments/reconcile-occurrence-availability.ts` | `/api/cleanup/reconcile-occurrence-availability` |
| Detect consultant no-shows  | Netlify ticker every 30 min, 10-row bites until 16 s; no Actions twin | `scripts/appointments/detect-consultant-no-shows.ts`        | `/api/cleanup/detect-consultant-no-shows`        |
| Settle cancelled sessions   | Netlify ticker every 30 min, 10 sessions                              | `scripts/appointments/settle-cancelled-sessions.ts`         | `/api/cleanup/settle-cancelled-sessions`         |
| Settle platform incidents   | Netlify ticker hourly at :30, 10 remedies per bite; no Actions twin   | `scripts/appointments/settle-platform-incidents.ts`         | `/api/cleanup/settle-platform-incidents`         |

The repository has four scheduled workflows only (`cron-intra-day.yml`, `cron-daily.yml`, `cron-weekly.yml`, `cron-heartbeat.yml`), and of the jobs in this document only `reconcile-occurrence-availability` runs from one of them. Everything else runs on the ticker, and a ticker target that is missing from `TARGETS` in `netlify/functions/cron-tick.mts` runs nowhere.

## Throughput of the session-outcome sweeps

`auto-complete-appointments` and `detect-consultant-no-shows` run every 30 minutes (`TARGET_EVERY_MINUTES` in `cron-tick.mts`), and no workflow runs either job. The `limit` the ticker sends (25 and 10, `TARGET_LIMITS`) is a bite size, not a per-run cap. Inside one `withCronLock`, each run reads bite after bite until every pass reads a short cohort or `SWEEP_START_DEADLINE_MS` (16 seconds, `lib/cron/run-deadline.ts`) has passed since the request reached `/api/cleanup/[job]`. After the deadline no new row starts, so a Stream call report already in flight still finishes inside the ticker's 24-second abort for these two targets (`TARGET_TIMEOUTS_MS`). The extra room covers a cold boot of about 5 seconds, which happens before the job's clock starts, and still stays under Netlify's ~26-second edge cut. A row a bite read but left in the cohort (a deferred session, or a candidate Stream refused) is excluded by id from that run's later bites, so the loop always makes progress. Auto-complete runs its passes in rounds, slots first and then the five parent passes, so parents read decided sessions. Sentry reports stay once per run.

For example, a backlog of 100 ended sessions drains in one run at 25 per bite (four bites), provided the run finishes them within 16 seconds; measured on a deploy preview, about 3.3 s of setup plus about 0.31 s per session fits roughly 40 sessions in one run. A backlog it cannot finish is picked up oldest-first 30 minutes later.

Five other sweeps keep their cohorts moving past rows they cannot finish. `cleanup-abandoned-payments` loads only the lapsed PENDING payments of each appointment, releases a seat only HELD → CANCELLED and only when that payment's own PENDING → EXPIRED CAS won, and rotates a skipped or failed appointment by touching `updatedAt` (the cohort is `updatedAt asc`). `send-appointment-reminders` excludes already-staged sessions in its `WHERE`, so `take 25` reaches the window's tail. `expire-unpaid-trials` isolates each row, rotates a failed row by `updatedAt`, and runs its three arms in separate `try` blocks. `sync-payment-earnings` stamps a paged unaccruable payment with the `REQUIRES_MANUAL_RECOVERY:` prefix its cohort already excludes. `reconcile-occurrence-availability` stays detect-only and reports participant drift and double bookings once per run through `reportStandingFinding`.

---

## Scheduling policy

`scripts/ci/check-workflow-hygiene.ts` checks every workflow at build time, and today it checks one thing: every `${{ secrets.NAME }}` a workflow references must be declared in `docs/enterprise/50-operations/07-required-secrets.md`, because a missing secret interpolates an empty string and the job reports success without its credential. Start-minute load on the database pool is no longer checked by CI. Keep the few remaining Actions schedules on distinct minutes by hand, and put any latency-sensitive sweep on the ticker instead.

---

## Per-Job Documentation

### a. Auto-Complete Appointments

| Field              | Value                                                                            |
| ------------------ | -------------------------------------------------------------------------------- |
| **Schedule**       | Netlify ticker every 30 minutes (no per-job workflow)                            |
| **Source**         | `scripts/appointments/auto-complete-appointments.ts`                             |
| **API**            | `/api/cleanup/auto-complete-appointments` (via `app/api/cleanup/[job]/route.ts`) |
| **GitHub Actions** | None                                                                             |
| **HTTP Methods**   | `GET`, `POST`                                                                    |

**Purpose**: Transitions appointments to `COMPLETED` status after their session time has passed. Enables downstream processes: feedback collection, payout processing, and reporting.

**Threshold**: 1 hour buffer after the last slot's `endsAt` timestamp (`COMPLETION_BUFFER_HOURS = 1`).

**Records affected**:

| Entity       | Source Statuses            | Target Status | Criteria                                                                             |
| ------------ | -------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| Webinar      | `SCHEDULED`, `IN_PROGRESS` | `COMPLETED`   | All slots ended > 1h ago                                                             |
| Class        | `SCHEDULED`, `IN_PROGRESS` | `COMPLETED`   | All slots across all appointments ended > 1h ago                                     |
| Consultation | `APPROVED`, `SCHEDULED`    | `COMPLETED`   | All slots ended > 1h ago, unless the consultant never joined (see below)             |
| Subscription | `APPROVED`, `SCHEDULED`    | `COMPLETED`   | All slots across all appointments ended > 1h ago                                     |
| Trial        | `SCHEDULED`                | `COMPLETED`   | All slots ended > 1h ago; also sets `completedAt` and creates an `ActivityLog` entry |

**The consultant no-show handoff (#1504).** A consultation that the consultant never joined is not this job's to close. The only path that cancels such a booking and refunds the consultee in full is the no-show detector described in section g, and that detector only considers bookings that are still `APPROVED` or `SCHEDULED`. Because this job's buffer is one hour and the detector's grace window is two, this job used to reach every unattended consultation first and mark it `COMPLETED`, which removed it from the detector's candidate set permanently; the platform's promised refund could therefore never fire in production.

Both jobs now read the same predicate from `lib/booking/attendance.ts`, which classifies a booking from the `MeetingAttendance` rows as one of three shapes. When the consultant has a recorded join, this job completes the booking as it always did. When the consultee has a join and the consultant does not, this job defers: it skips the booking and leaves it live for the detector. When there is no session at all, or nobody joined, the booking is not a consultant-fault refund and this job completes it, because the detector's remedy in that case is a support ticket rather than a status change.

The deferral is bounded. The detector declines candidates it cannot decide — Stream's own call report contradicts our attendance rows, the session has no Stream call to ask about, or the run failed — and it leaves those bookings untouched. `NO_SHOW_HANDOFF_MINUTES` (the grace window plus two hours) is the point at which this job stops waiting and completes the booking anyway, so that the detector, which runs every 30 minutes, has had about four runs in which the booking was visible to it. A booking that neither job would ever claim would sit live forever, which is a worse outcome than completing it.

**Safety**: Per-record `try/catch`. A failure on one record does not prevent processing of others. All errors are collected into a result array and returned. The activity log write for trial sessions has its own nested `try/catch` so a logging failure does not block the completion update.

**Trial sessions have no separate job.** A second endpoint, `/api/cleanup/auto-complete-trials`, used to complete trials on its own. It had no `jobs/` wrapper, no GitHub Actions workflow and no Netlify schedule, so nothing ever invoked it, and it completed a trial as soon as any one of its slot rows had ended, with no buffer. It was a redundant twin of the Trial row in the table above and was deleted in #1278. Trials are completed here, by this 30-minute job, which requires the full one-hour buffer and an `every` clause over the appointment's slots, so a multi-slot trial only closes once all of its slots have ended.

---

### b. Cleanup Tentative Slots

| Field              | Value                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| **Schedule**       | Netlify ticker every 15 minutes                                             |
| **Source**         | `scripts/appointments/cleanup-tentative-occurrences.ts`                     |
| **API**            | `/api/cleanup/tentative-occurrences` (via `app/api/cleanup/[job]/route.ts`) |
| **GitHub Actions** | None                                                                        |
| **HTTP Methods**   | `GET`, `POST`                                                               |

**Purpose**: Releases slots marked `isTentative = true` that are associated with abandoned booking flows. These tentative slots block consultant availability; if not cleaned up, abandoned checkouts permanently reduce the consultant's bookable calendar.

**Threshold**: 24 hours since slot creation (`TENTATIVE_EXPIRATION_HOURS = 24`, cut from 7 days by #833).

**Criteria**: Slot has `isTentative = true`, `createdAt` older than 24 hours, AND the associated appointment has no payment with `paymentStatus = SUCCEEDED`. Users can also release their own holds immediately via `DELETE /api/checkout/pending/[paymentId]` (#849) instead of waiting for this cron.

**Action**: Deletes the stale `AppointmentOccurrence` records using `deleteMany`. This frees the time range for new bookings.

**Safety**: Single top-level `try/catch` around the entire operation. The query and delete use the same filter criteria, preventing TOCTOU race conditions. Logs user and payment information for each affected slot before deletion.

---

### c. Cleanup Stale Pending Consultations (retired)

This job was retired on 2026-09-19 (#1732, #1589 P-P1-01). It cancelled `APPROVED` / `APPROVED_PENDING_PAYMENT` consultations with no successful payment after seven days, while `expire-stale-requests` and the pay-link sweep in `cleanup-abandoned-payments` expire that same cohort, so one event had two sweeps and two terminal words. Doctrine rule 5 keeps one outcome, `EXPIRED`, and the two remaining sweeps share it.

---

### d. Cleanup Invalid Appointments (retired)

This job no longer exists: the `cleanup-invalid-appointments` script, its route and its workflow have been removed. Duplicate and wrong-duration requests are refused at the front door instead. The booked window must match the plan duration (`assertWindowMatchesPlanDuration` in `lib/booking/slot-validation.ts`), and request creation is capped and idempotent, so no sweep needs to cancel them afterwards.

---

### e. Expire Stale Requests

| Field              | Value                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| **Schedule**       | Netlify ticker every 15 minutes                                             |
| **Source**         | `scripts/appointments/expire-stale-requests.ts`                             |
| **API**            | `/api/cleanup/expire-stale-requests` (via `app/api/cleanup/[job]/route.ts`) |
| **GitHub Actions** | None                                                                        |
| **HTTP Methods**   | `GET`, `POST`                                                               |

**Purpose**: Expires stale requests through the guarded transition helpers. Thresholds and refund policy remain separate by cohort:

| Cohort                                                 | Threshold                                                       | Commit and follow-up                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PENDING` consultation                                 | 48 hours from `requestedAt`                                     | `EXPIRED` plus tentative occurrence cancellation/tombstones; captured payments are refunded after commit |
| Unpaid `PENDING` subscription                          | 30 days from `requestedAt`                                      | `EXPIRED`; the CAS repeats the absence of a live succeeded payment                                       |
| `APPROVED` subscription with no live confirmed session | 30 days from `updatedAt`                                        | `EXPIRED`; captured payments are refunded after commit                                                   |
| Paid `PENDING` subscription with no allocated session  | 48 hours from `capturedAt`, falling back to payment `createdAt` | `EXPIRED`, history, full-refund marker and bell commit atomically                                        |
| `APPROVED_PENDING_PAYMENT` request                     | 7 days from `updatedAt`                                         | Shared unpaid lapse core clears the pay link, expires pending orders and tombstones tentative holds      |

The paid 48-hour arm repeats the no-live-session, no-live-proposal, capture-age and no-unplaced-`RESCHEDULED`-occurrence guards in its CAS. Allocation or rescheduling that wins first stages neither expiry nor refund. Its Serializable transaction reads only eligible payment IDs, stages `Payment.refundOwedKey = sub-unalloc:<paymentId>` with null paise (full remaining balance), and stages the bell on the same transaction client. A marker persistence failure rolls everything back. Existing markers and their attempt counts remain owned by their original door.

After commit the arm may drive the markers through `driveRefundOwed` and the universal booking refund front door. A crash or exhausted admission budget leaves the marker for `retry-auto-refunds`; no `Refund` reservation or vendor call happens inside the expiry transaction. The single-plan admin recovery door uses the same bounded staging and persisted markers, without resetting retired attempts.

Legacy recovery selects payments whose subscription is currently `EXPIRED` with exact `UNALLOCATED_48H` history. It excludes existing markers, spent `SUCCEEDED`/`PENDING` keys and already returned balances **before** the page limit, ordered by payment `createdAt` and ID. History duplicates cannot multiply payments. There is no liability lookback cutoff. Failed/cancelled refund attempts and remaining balances after partial refunds stay eligible; zero-paise credit restorations use refund evidence rather than a positive-amount filter. The query shares the refund balance status sets and has a PostgreSQL-tested arithmetic projection; the refund front door still determines the amount and reserves it transactionally.

**Bounds and reporting.** The HTTP/ticker default is 20 requests per arm; the direct core default and maximum are 500. Within the 48-hour family, legacy staging and fresh staging each admit at most that many payment markers, and inline drives share one limit. The legacy query and each fresh-plan probe return at most the limit plus one eligible payment ID. Fresh staging shares its payment allowance across selected plans: if a plan fits the full envelope but exceeds this invocation's remaining allowance, its entire expiry transaction rolls back and the ordered page stops with remaining work, without an error. A plan exceeding the full per-plan envelope is held and reported as an error. It never expires a plan after staging only the first part of its liabilities. `unallocatedHasMore` stays true for peeks, retained markers, failures and truncation; `unallocatedRefundsDeferred` counts deferred inline work. A full-envelope capacity hold requires investigation or a bounded higher-limit run; persistent failures are not a drained backlog. The cap bounds returned IDs and marker writes, not the rows PostgreSQL examines for eligibility or refund/dispute aggregates; production query cost and throughput still require measurement.

The family shares one 16-second start budget across legacy recovery, fresh expiry and inline drives. It stops admitting work, without cancelling an in-flight transaction or provider request. This is **not an overall deadline for `expireStaleRequests`**: earlier arms run first and can consume the worker's HTTP window before this family starts. Other arms still have related-read/notification bounds and fairness work remaining. In particular, paid consultation and 30-day approved-subscription expiry still refund after their status commits without an atomic owed marker; the nudge page is capped before its outbox exclusions. These limitations prevent a whole-job drain or runtime guarantee.

**Nudges.** Paid `PENDING` subscriptions with no live confirmed sessions or open proposal receive their latest reached 12-, 24- or 36-hour stage from the capture clock. Bell and email have separate durable dedupe guards; `subscriptionNudgesSent` records the run's count.

---

### f. Reconcile Slot Availability

| Field              | Value                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **Schedule**       | `cron-intra-day.yml`, hourly at :17 (`17 * * * *`)                                                |
| **Source**         | `scripts/appointments/reconcile-occurrence-availability.ts`                                       |
| **API**            | `/api/cleanup/reconcile-occurrence-availability` (via `app/api/cleanup/[job]/route.ts`)           |
| **GitHub Actions** | `.github/workflows/cron-intra-day.yml` (`jobs/appointments/reconcile-occurrence-availability.ts`) |
| **HTTP Methods**   | `GET`, `POST`                                                                                     |

**Purpose**: Fixes slot availability inconsistencies and detects booking conflicts. Performs two operations:

**Operation 1 -- Clear stale tentative flags**: Finds slots where `isTentative = true` but the appointment has a `SUCCEEDED` payment. This happens when a payment webhook succeeds but the tentative flag was not cleared (race condition, system error). Updates `isTentative = false` via bulk `updateMany`.

**Operation 2 -- Detect double bookings**: Scans all confirmed (non-tentative) future slots with successful payments, groups them by consultant, and checks for time overlaps. Double bookings are reported but **not** auto-resolved -- they require manual intervention.

**Action**:

- Tentative flag mismatches: Automatically corrected.
- Double bookings: Logged and returned in the response. The API returns HTTP `207` when double bookings are detected (vs `200` for clean results).

**Ownership of the 207 response**: A `207` is a degraded-but-not-broken signal, not a page. The GitHub Actions workflow posts it to the ops Slack channel configured via `SLACK_OPS_WEBHOOK_URL`, and the on-call engineer owns the follow-up. That engineer is responsible for triaging the reported overlaps, manually resolving the affected bookings (the job never auto-resolves them), and confirming the next hourly run returns `200`. Treat a `207` that persists across more than one run as the trigger to escalate.

**Safety**: Two independent `try/catch` blocks. The double booking detection is read-only and does not modify data. The GitHub Actions workflow is configured to trigger a failure notification specifically for double booking scenarios, routed to the ops Slack channel (`SLACK_OPS_WEBHOOK_URL`) described above.

---

### g. Detect Consultant No-Shows

| Field              | Value                                                |
| ------------------ | ---------------------------------------------------- |
| **Schedule**       | Netlify ticker every 30 minutes                      |
| **Source**         | `scripts/appointments/detect-consultant-no-shows.ts` |
| **API**            | `/api/cleanup/detect-consultant-no-shows`            |
| **GitHub Actions** | None                                                 |
| **HTTP Methods**   | N/A                                                  |

**Purpose**: Closes the loop on the platform's promise of a full refund when the consultant fails to attend a paid session. The job scans confirmed `CONSULTATION` bookings whose session ended at least the grace window ago, uses the per-attendee `MeetingAttendance` records (stamped by the Stream session handlers) to identify the ones the consultant never joined, and for each such no-show it auto-refunds the consultee via `refundPayment`, marks the booking cancelled, and notifies both parties.

**Scope**: Consultations only. A consultation is a single-session, single-consultant exclusive booking where a full refund of the one payment is the correct remedy. Subscriptions are multi-session, so a per-session consultant no-show is a partial refund of one session out of many and needs its own design; it is not yet handled.

**Grace window**: A session must have ended at least 120 minutes ago (`NO_SHOW_GRACE_MINUTES = 120`) before a missing consultant is treated as a no-show, so a late join or a delayed Stream participant webhook cannot trigger a false-positive refund. The constant lives in `lib/booking/attendance.ts` alongside the attendance predicate, because the auto-completion job in section a has to honour the same window: it defers a booking in the no-show shape rather than completing it out from under this job (#1504).

**Safety**: The job runs under a fail-closed cron lock. Because it moves money, it refuses to run without a real Redis lock rather than risk a silent unlocked double-run, and `refundPayment`'s refundable-balance guard remains the correctness backstop. It is also in `FINANCIAL_JOB_NAMES`, so it is held during DEGRADED maintenance as well as OFFLINE (#1506).

---

### h. Cleanup Abandoned Payments (Pay-Link Reminder and Lapsed-Link Expiry)

| Field              | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| **Schedule**       | Netlify ticker every 15 minutes (`TARGET_EVERY_MINUTES`)                 |
| **Source**         | `scripts/payments/cleanup-abandoned-payments.ts`                         |
| **API**            | `/api/cleanup/abandoned-payments` (via `app/api/cleanup/[job]/route.ts`) |
| **GitHub Actions** | None                                                                     |

**Purpose**: The delivered cadence comes from the Netlify ticker (ADR 22, ADR 27), which since #1686 fires this target every third tick — every 15 minutes — because each row costs a gateway round trip. No GitHub Actions workflow runs it. It cancels an abandoned direct-checkout payment and cancels a lapsed approval pay-link.

**The pay-link reminder (#1703 D2, added 2026-09-18).** `remindApprovalPaymentsDue` sends one reminder email when half the 24-hour pay-link window is left (`APPROVAL_PAYMENT_EXPIRATION_HOURS = 24`, so the reminder fires with 12 hours left on the link). It is the existing pay-link email re-sent with a different heading, staged as a `FailedEmail` row of type `PAYMENT_LINK_REMINDER` keyed by the payment id, which is the once-guard: a second run against the same payment finds the row and sends nothing. The reminder never fires after a capture or after the link itself has lapsed, because both of those move the row out of the reminder's `APPROVED_PENDING_PAYMENT`-with-a-live-pay-link cohort.

**The lapsed-link expiry, and the single-CAS rule it shares (#1703 D2, fixed 2026-09-19).** A pay-link that nobody paid before its 24-hour deadline has to move to `EXPIRED`, and two different sweeps can reach that same row first: this job's abandoned-payment cohort (it sees the row through its expired-`PENDING`-payment read) and `expireStaleRequests`' payment-pending cohort (section e). Both now call the same helper, `expireLapsedPayLink`, which transitions the request with `fromIn: [APPROVED_PENDING_PAYMENT]` and repeats the money predicate (no `SUCCEEDED` payment on the wrapper) inside the CAS `where`, exactly as doctrine rule 5 requires of any sweep that can expire a request. Preview QA on #1724 (`qa-1724.md` case 8) found that before this fix, whichever sweep claimed the row first left the consultee un-notified, because only one of the two callers fired the `PAY_LINK_LAPSED_REASON` notice; the fix ties the notice to the CAS win itself, so it fires exactly once regardless of which pass gets there first. This is pinned by running both sweeps, in their real order, over one fixture.

**Safety**: Same doctrine-rule-5 guards as every lapsed-request sweep — the status guard alone is not sufficient, and the money predicate rides inside the CAS `where`, not just the cohort read.

---

### i. Expire Reschedule Proposals

The table below lists where this job runs and how it is invoked.

| Field              | Value                                                    |
| ------------------ | -------------------------------------------------------- |
| **Schedule**       | Netlify ticker every 15 minutes (`reschedule-proposals`) |
| **Source**         | `scripts/appointments/expire-reschedule-proposals.ts`    |
| **API**            | `/api/cleanup/reschedule-proposals`                      |
| **GitHub Actions** | None                                                     |
| **HTTP Methods**   | GET, POST                                                |

**Purpose**: The job expires reschedule proposals that nobody answered before their `expiresAt`, and since #1846 it puts the booking back exactly as it was (#1527 decision 9). Before #1846 the released slots stayed released, so a confirmed session disappeared because a consultant did not click.

**Restore**: Each lapsed proposal is handled under the appointment lock that every other lifecycle writer takes. Inside one transaction the job moves the proposal to `EXPIRED` through `transitionRescheduleRequest`, with the stale-time predicate repeated in the CAS, and restores the booking through `restoreRescheduledBooking` in `lib/booking/reschedule-restore.ts`, the same helper a withdrawal uses. The restore flips the released `RESCHEDULED` slots back to `SCHEDULED` and returns a parent request that the reschedule flipped to `PENDING` to the status it held before. When at least one slot came back, the job tells both parties through the `EXPIRED` outcome of the `appointment-rescheduled` Novu family and its email, after the transaction commits.

**Unrestored expiry**: If the consultant's original time was booked while the proposal was open, the restore meets the overlap constraint, or the parent request's CAS misses, and the whole transaction rolls back. The job reports the miss to Sentry first, then expires the proposal on its own, and the slots stay released for the consultant to re-place. The result reports `proposalsExpired`, which counts every proposal the run expired, and `proposalsExpiredUnrestored`, which counts the subset that expired without the restore; the HTTP twin summarises both fields. A proposal that was answered between the read and the write, or whose appointment lock is held by a live writer, is skipped and taken by a later tick.

**Safety**: The job runs under a fail-open cron lock, because the work is idempotent: `EXPIRED` leaves the open set, so a re-run picks up exactly what is left. It reads lapsed proposals in batches of 500 and stops after four batches per invocation, and the next tick continues where it stopped.

---

### j. Settle Platform Incidents

| Field              | Value                                               |
| ------------------ | --------------------------------------------------- |
| **Schedule**       | Netlify ticker hourly at :30                        |
| **Source**         | `scripts/appointments/settle-platform-incidents.ts` |
| **API**            | `/api/cleanup/settle-platform-incidents`            |
| **GitHub Actions** | None                                                |
| **HTTP Methods**   | N/A                                                 |

**Purpose**: Voids every session that overlaps an ops-declared platform incident and makes each learner whole. A run does four things for each unsettled incident, oldest first: the retroactive pass voids the overlapping sessions as `PLATFORM_OUTAGE` and writes their `IncidentRemedy` rows in the same transaction; due remedies are applied (consultation and paid-trial refunds 48 hours after the void, webinar refunds straight away, free-trial re-offer and subscription plan-end extension straight away, nothing for a class beyond the void); one `PLATFORM_INCIDENT_DIGEST` email goes to each learner; and one report goes to ops. The incident is stamped `settledAt` when every remedy is done or dead-lettered, every learner is notified and the report is staged. The runbook is in [the money console page](../finance/70-operations/02-admin-money-doors.md#platform-incidents).

**Cadence**: The ticker runs it hourly at :30 (`TARGET_EVERY_MINUTES` is 60 and `TARGET_OFFSET_MINUTES` is 30 in `netlify/functions/cron-tick.mts`), with a bite of ten remedies on the 20-second tier. The :30 slot is the only one with room under the eight-targets-per-tick cap every hour, and the refunds wait 48 hours anyway.

**Safety**: The job runs under a fail-closed cron lock and is in `FINANCIAL_JOB_NAMES` (`lib/cron/financial-jobs.ts`), so DEGRADED maintenance holds it. Every step is a compare-and-swap or a unique-key write (`@@unique([incidentId, occurrenceId, userId])` and `@@unique([occurrenceId, userId])` on `IncidentRemedy`), so a run killed mid-way converges on the next. A refund whose payment already owes another door's marker is never overwritten; it counts an attempt, rotates to the back of the queue, and after three attempts it is dead-lettered for an operator. Failures are reported to Sentry once per run.

---

## The Netlify ticker

`netlify/functions/cron-tick.mts` (ADR 27) is a Netlify scheduled function that runs every five minutes and POSTs a fixed list of `/api/cleanup/*` targets, because ADR 22 measured GitHub Actions delivering a sub-hourly `cron:` schedule roughly once every hundred minutes instead of on its declared cadence. As of 2026-09-19 (#1583 E-P0-04, #1589 P-P0-01 and N-P1-03, #1591 J1-P1-05, #1599 C-P1-06) it carries five booking targets, each due on every third tick — a 15-minute cadence — through the ticker's `TARGET_EVERY_MINUTES` map:

| Target directory (`app/api/cleanup/<name>`) | Job                               | Cadence on the ticker | Per-tick timeout |
| ------------------------------------------- | --------------------------------- | --------------------- | ---------------- |
| `expire-unpaid-trials`                      | Expire unpaid trials              | Every 15 minutes      | 6s (default)     |
| `reschedule-proposals`                      | Expire reschedule proposals       | Every 15 minutes      | 6s (default)     |
| `appointment-reminders`                     | Send appointment reminders        | Every 15 minutes      | 20s              |
| `tentative-occurrences`                     | Cleanup tentative slots           | Every 15 minutes      | 6s (default)     |
| `expire-stale-requests`                     | Expire stale requests (section e) | Every 15 minutes      | 20s              |
| `settle-cancelled-sessions`                 | Settle cancelled class sessions   | Every 30 minutes      | 20s              |

The ticker also drives `settle-cancelled-sessions` every 30 minutes with a batch of ten sessions on the 20-second tier, because it makes a gateway refund per seat, and it is a financial job that holds a fail-closed lock. `expire-unpaid-trials` now refunds too (a paid trial nobody answered within 48 hours), so it moved to a fail-closed lock and joined `FINANCIAL_JOB_NAMES`.

`appointment-reminders` and `expire-stale-requests` get the 20-second tier because their per-row cost does not fit the 6-second default on a cold instance: the reminder job stages an outbox row per matching booking, and the stale-request sweep routes SUCCEEDED payments through the refund front door. Both twins already wrap their core in `withCronLock` and answer 409 on overlap with a concurrent run, so overlapping ticker ticks can never double-execute the same cohort — the loser's 409 is counted as `lockHeld`, not `failed`. All five read the `limit` query parameter, and the ticker's `TARGET_LIMITS` map states each batch size: 25 reminders, 20 stale requests per arm, 25 proposals, 200 tentative slots and 25 unpaid trials. There is no Actions backstop for any of the five, nor for the pre-existing ticker targets (webhook sweeps, refund reconciliation, earnings sync).

`send-appointment-reminders.ts`, the core script behind the `appointment-reminders` target, also gained a TRIAL branch on 2026-09-19: a `SCHEDULED` trial with a live occurrence in the 24-hour or 1-hour reminder windows now gets the same reminder pair a consultation or subscription session gets, deduplicated by the same `${appointmentId}:${window}` outbox key. The ticker's 15-minute cadence is what closes the gap the trial branch fixes, because an hourly schedule was wide enough to miss a reminder window entirely.

---

## Job Architecture

All booking cron jobs follow the same layered pattern:

```
scripts/appointments/<job>.ts    -- Core logic (exported function, testable, withCronLock)
     |
     v
lib/cron/cleanup-registry.ts     -- Central cleanup job registry
     |
     v
app/api/cleanup/[job]/route.ts   -- Dynamic HTTP dispatcher (CRON_SECRET + assertNotInMaintenance)
```

The core script has no HTTP or framework dependencies. `app/api/cleanup/[job]/route.ts` dispatches to `lib/cron/cleanup-registry.ts`, which adds authentication and maintenance guards and returns JSON. `netlify/functions/cron-tick.mts` and `.github/workflows/<job>.yml` invoke the registered jobs on schedule.

```mermaid
flowchart TD
    subgraph Triggers
        GHA["GitHub Actions<br/>(schedule cron)"]
        TICK["Netlify ticker<br/>(cron-tick.mts, every 5 min)"]
        MANUAL["Manual curl<br/>(POST/GET)"]
    end

    subgraph "API Layer"
        ROUTE["app/api/cleanup/[job]/route.ts<br/>lib/cron/cleanup-registry.ts"]
    end

    subgraph "Core Logic"
        SCRIPT["scripts/appointments/*.ts<br/>- Query database<br/>- Apply business rules<br/>- Update records"]
    end

    GHA --> SCRIPT
    TICK --> ROUTE
    MANUAL --> ROUTE
    ROUTE --> SCRIPT
    SCRIPT --> DB[(Database)]
```

---

## Authentication

All API cleanup endpoints require a bearer token matching the `CRON_SECRET` (or `VERCEL_CRON_SECRET`) environment variable.

**Request format**:

```
GET /api/cleanup/<job-name>
Authorization: Bearer <CRON_SECRET>
```

**Auth check pattern** (most endpoints):

```typescript
const authHeader = req.headers.get("authorization");
const cronSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

The `invalid-appointments` endpoint uses a stronger `crypto.timingSafeEqual` comparison to prevent timing attacks.

**GitHub Actions** workflows do not use the HTTP endpoints. They execute the core script directly, authenticating to the database via `DATABASE_URL` and `DIRECT_URL` repository secrets.

---

## Response Format

All endpoints return a JSON result object with at minimum:

| Field       | Type       | Description                               |
| ----------- | ---------- | ----------------------------------------- |
| `success`   | `boolean`  | `true` if no errors occurred              |
| `errors`    | `string[]` | List of error messages (empty on success) |
| `timestamp` | `string`   | ISO 8601 timestamp of completion          |

Each job adds additional fields specific to its operation (e.g., `webinarsCompleted`, `slotsReleased`, `doubleBookingsDetected`). HTTP status codes:

| Code  | Meaning                                                                       |
| ----- | ----------------------------------------------------------------------------- |
| `200` | Job completed successfully                                                    |
| `207` | Partial success (reconcile-occurrence-availability: double bookings detected) |
| `401` | Missing or invalid `CRON_SECRET`                                              |
| `500` | Job failed or returned errors                                                 |

## Deprecated & Superseded Approaches

1. **One hourly GitHub Actions workflow per booking job.** GitHub delivered sub-hourly schedules roughly once every hundred minutes, so the latency-sensitive sweeps moved to the five-minute ticker and the per-job workflows were deleted. Do not recreate them.
2. **A separate `auto-complete-trials` endpoint.** Trials are completed by `auto-complete-appointments`.
3. **`cleanup-stale-pending-consultations` and `cleanup-invalid-appointments`.** Retired; `expire-stale-requests` and the front-door checks replace them.
4. **A start-minute pool budget in the workflow hygiene guard.** The guard once summed `# cron-runtime-minutes:` annotations per shared start-minute against a ten-minute budget. That check no longer exists; the guard now checks only declared secrets.
