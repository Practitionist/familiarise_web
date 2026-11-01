# ADR: Retention windows for every log-like and audit table

- **Status**: Accepted on 2026-11-01 by the owner (Kaustav). Ships in the pull request that adds this record.
- **Date**: 2026-11-01
- **Author**: Platform engineering
- **Related**: [DPDP and privacy](../compliance/02-dpdp-and-privacy.md#retention-windows) (the retention table), [Job machinery catalog](../maintenance/11-job-machinery-catalog.md), [The ticker skips targets that have no work](2026-11-01-ticker-skip-idle-targets.md), [Admin background runs are durable requests](2026-11-01-admin-run-requests.md), issue #2496 (retention audit)

## Context

Before this change, most log-like tables either had no prune at all (`OpsActionLog`, `ActivityLog`, `BookingStatusHistory`, `LedgerReconciliationReport`, `OrgDataExportJob`, anonymous `CookiePreference` rows, `MeetingPresence`, `MeetingAttendance`) or a window chosen for disk rather than for the law (`SystemJobExecution` 90 days, `EmailEvent` 30 days, `WebhookEvent` 30 or 90 days, expired `Session` rows deleted at expiry). The audit measured the live database at 184 MB, so disk is not the driver for any table except `SystemJobExecution`. For every other table the driver is data minimisation and the legal duty to keep evidence.

The windows below are the owner's decision. Each has a driver. The full table, which is the single source, is in [DPDP and privacy, Retention windows](../compliance/02-dpdp-and-privacy.md#retention-windows) and is repeated for agents in the compliance skill.

## Decision

### 1. Audit tables

| Data                            | Window                                | Driver                                                                                                                                                                                | Enforced by                                                |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `OrgAuditLog`, money categories | 8 years                               | Companies Act 2013 s.128(5) keeps books for eight financial years. The categories are INVOICE, PAYOUT, WALLET, CONTRACT and CONSENT (was 7 years).                                    | `prune-audit-logs` (`scripts/cleanup/prune-audit-logs.ts`) |
| `OrgAuditLog`, other categories | 2 years                               | DPDP Rules 2025 Rule 8(3) one-year floor for logs of processing, plus a year of margin.                                                                                               | `prune-audit-logs`                                         |
| `OpsActionLog`, money surfaces  | 8 years                               | The same books horizon: a refund, payout or hold decision is audit evidence for the accounts.                                                                                         | `prune-audit-logs`, through `OPS_SURFACE_WINDOW`           |
| `OpsActionLog`, other surfaces  | 2 years                               | Rule 8(3) floor plus margin.                                                                                                                                                          | `prune-audit-logs`                                         |
| `OpsActionProposal`             | 8 years                               | Only the second-approver money doors open proposals, so every proposal is money evidence.                                                                                             | `prune-audit-logs`                                         |
| `BookingStatusHistory`          | 3 years after the booking is terminal | Consumer Protection Act 2019 s.69 (2 years to complain) and Limitation Act 1963 Articles 55 and 113 (3 years to sue). DPDP s.17(1)(a) allows keeping data to establish a legal claim. | `prune-audit-logs`, through `bookingHistoryPruneWhere`     |
| `LedgerReconciliationReport`    | 2 years by `runAt`                    | A report is a derived check, not the ledger. The ledger itself is never pruned.                                                                                                       | `prune-audit-logs`                                         |

The money-audit horizon of eight years is the owner's choice, drawn from Companies Act s.128(5). It is longer than CGST Act s.36 (72 months) and Income-tax Rules 2026 Rule 46(9) (seven tax years). **It should be confirmed with the chartered accountant.** If the CA names a shorter or longer period, only the `MONEY_AUDIT_YEARS` constant in `scripts/cleanup/prune-audit-logs.ts` changes.

The year-based windows of `prune-audit-logs` are UTC calendar years (`yearsBefore` subtracts N from the UTC year), not N times 365 days, so the 8-, 2-, 3- and 2-year windows keep their leap days. The day-based windows elsewhere (365 days, 14 and 180 days, 3 times 365 days for meeting presence) are plain day counts.

An `OpsActionLog` row's `surface` decides its window. `OPS_SURFACE_WINDOW` is a `Record<BackofficeSurface, "money" | "other">`, so adding a new back-office surface without classifying it is a compile error. A row whose `surface` string is not a known surface (a surface removed from the code later) keeps the 8-year window, because the safe default for an unclassified action is the longer one.

**BookingStatusHistory never touches a live booking.** A history row is selected only when it is linked to an appointment, and every parent of that appointment (consultation, subscription, webinar, class and trial) is terminal, and the parents and the appointment were last updated more than three years ago, and no occurrence of the appointment ended in the last three years. Rows with no `appointmentId` are never selected. The reason is that `readRescheduleOrigin` (`lib/booking/reschedule-restore.ts`) reads a live booking's `PENDING` history row at any age to restore a rescheduled session, so an age-only rule would break a long-running subscription's reschedule.

### 2. Telemetry and secondary tables

| Data                                               | Window                                        | Driver                                                                                                                             | Enforced by                                                           |
| -------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `SystemJobExecution`, no-op runs                   | 14 days                                       | Volume. 99.3 % of runs process nothing (measured over seven days), and they carry no evidence.                                     | `prune-system-job-executions`                                         |
| `SystemJobExecution`, every other finished run     | 180 days (was 90)                             | CERT-In Directions 20(3)/2022, direction (iv): ICT logs for 180 days. A run row is the record of what the platform's jobs did.     | `prune-system-job-executions`                                         |
| `SystemEvent`                                      | 400 days, except state-bearing events (below) | Operational findings; 400 days keeps one full year plus a quarter for comparison.                                                  | `prune-system-events` (`lib/observability/system-event-retention.ts`) |
| `WebhookEvent`                                     | 365 days (was 30 processed, 90 failed)        | DPDP Rules 2025 Rule 8(3): processing logs are kept at least one year **whatever their outcome**, so failed and terminal rows too. | `archive-webhook-events` (weekly, Sunday)                             |
| `OutboundWebhookDelivery`                          | 30 days                                       | Delivery attempts to a customer's endpoint; the payload is reproducible from the source rows.                                      | `archive-webhook-events`                                              |
| `EmailEvent`                                       | 365 days (was 30)                             | Rule 8(3): delivery events are logs of processing the recipient's address. Raised ahead of the 13 May 2027 commencement.           | `prune-system-job-executions`                                         |
| `OrgDataExportJob` (READY, FAILED, EXPIRED)        | 1 year by `createdAt`                         | A completed export job row is a short-lived record of an access request; one year is the Rule 8(3) one-year floor.                 | `prune-system-job-executions`                                         |
| `CookiePreference`, anonymous rows (`userId` null) | 13 months by `consentUpdatedAt`               | Minimisation. A signed-in user's row lives with the account.                                                                       | `prune-system-job-executions`                                         |
| `MeetingPresence`, `MeetingAttendance`             | 3 years after the occurrence's `endsAt`       | No-show and refund disputes: the Consumer Protection Act allows two years to complain, and three years covers a limitation period. | `prune-system-job-executions`                                         |
| `Session`, expired rows                            | 180 days after `expiresAt` (was at expiry)    | CERT-In direction (iv): the row holds the IP address and user agent.                                                               | `auth-tokens` (`lib/auth/cleanup-auth-tokens.ts`)                     |

Unchanged: a stranded `RUNNING` run is closed after 6 hours, a failed-email body is scrubbed after 7 days, a sent outbox row is deleted after 30 days, a dead-letter outbox row after 90 days, and a settled `AdminRunRequest` 30 days after it settles.

**CERT-In does not require the logs to stay in India.** The CERT-In FAQs of May 2022, question 35, say: "Is it required to store copy of logs in India only? Ans.: The logs may be stored outside India also as long as the obligation to produce logs to CERT-In is adhered to by the entities in a reasonable time." The 180-day period binds. The location does not. Question 36, which concerns records of financial transactions, is a separate point.

### 3. State-bearing `SystemEvent` rows are kept

A `SystemEvent` row is usually a finding that can age out. Some rows are state: the code reads "the newest event for this key" to decide what to do next. Pruning those at 400 days would silently flip the state back (a frozen wallet would thaw; a once-only alert would fire again). `prune-system-events` therefore keeps the newest event per `(correlationId, category)` for every correlation id starting with one of `STATE_BEARING_EVENT_PREFIXES`: `wallet-freeze:`, `class-reliability:`, `partial-credit:`, `partial-credit-closed:`, `held-paid-seat:`, `orphaned-payment:`, `orphan-escrow:`, `double-booking:`, `double-booking-blocked:` and `capture-unseated-seat:`.

The readers that depend on this are `isWalletFrozen` and `latestDriftFreezeIds` (`lib/payments/wallet-freeze.ts`), class reliability (`lib/booking/class-sessions.ts`, `lib/backoffice/class-series-read.ts` and the class-series reliability route), the needs-human lists (`lib/backoffice/needs-human.ts`), and the once-only guards in `scripts/alerts/alert-orphaned-payments.ts`, `scripts/payments/reconcile-orphaned-confirmations.ts`, `scripts/appointments/reconcile-occurrence-availability.ts`, `scripts/appointments/settle-cancelled-sessions.ts` and `lib/payments/webhooks/handlers.ts`. Expert strikes (`lib/booking/expert-reliability.ts`) read a 90-day window, standing findings a 24-hour window, and the unaccrued-earnings page a per-day key, so they need no exemption.

### 4. Ticker capacity: no new target

`MAX_TARGETS_PER_TICK` is 12 and the busiest tick holds 11, so there is room for one more target at most. Every new prune is folded into an existing job instead. The audit-class tables (tens of rows a month) go into `prune-audit-logs`, which is daily with bounded 500-row pages. Telemetry and secondary tables go into `prune-system-job-executions`, which runs every 30 minutes at +25 inside the 20:00 to 23:30 UTC window, seven runs a day, with a 16-second work budget under the ticker's 24-second timeout.

**Budget arithmetic for `SystemJobExecution`.** Inflow is about 3,100 run rows a day plus 288 tick-claim rows a day, so about 3,400 a day. The old capacity was 7 runs times 500 rows, 3,500 a day: barely above inflow and no margin to drain a backlog. The new run drains run history with raw `DELETE ... WHERE id IN (SELECT ... ORDER BY startedAt LIMIT 1000)` batches until a batch comes back short or the shared deadline passes. A 2,000-row candidate read measured 102 ms on the live table (`EXPLAIN ANALYZE`) and a statement round trip costs about 62 ms, so a 1,000-row batch costs roughly 0.15 to 0.3 seconds. After about 25 bounded page statements (about 1.6 seconds) a run has about 14 of its 16 seconds left: about 45 batches, 45,000 rows a run, about 300,000 a day, which is roughly 90 times inflow. At a pessimistic one second per batch it is still 14,000 a run and 98,000 a day, about 29 times inflow. The overrun past the deadline is at most one statement, so a run ends well inside the 24-second ticker timeout and Netlify's roughly 26-second function limit.

**The existing backlog drains in the first evening.** The live table held 175,031 rows (84 MB), about 150,000 of them already older than 14 days and almost all no-op. At 45,000 rows a run that is about three runs. Locally, 2,498 no-op rows and one aged row drained in 136 ms. The 180-day tier runs only once the no-op tier is drained, so a backlog never starves the cheap deletes.

**What counts as a no-op run.** A run is deleted at 14 days only when it is `COMPLETED`, has zero or null items and errors, has no `errorLog`, was not triggered by `admin:*`, has no `checkpoint` key in its `result`, has no non-empty `idle` array (a tick-claim row that recorded idle skips is kept for the full 180 days), and is not the newest `COMPLETED` row of its job. The newest row is kept so "when did this job last succeed" always has an answer.

### 5. `SupportCaseEvent` gets no separate prune

Events live and die with their case. `purgeEligibleWhere` in `lib/support/evidence-retention.ts` selects cases whose evidence is not yet purged with `events: { none: { kind: "EVIDENCE_PURGED" } }`. Deleting events on their own would delete that marker and make the purge re-run on the case. The personal free text on a case is scrubbed 180 days after it closes, which is the minimisation that matters.

### 6. `ActivityLog` is dropped

The `ActivityLog` model, the `ActivityType` enum, `lib/activity/` and every writer are deleted. The table had no reader (`getRecentActivities` was dead code), it copied `actorName` and `actorImage` into every row where erasure never scrubbed them, and `BookingStatusHistory` already records the same transitions. The code is gone in this change. The database table is dropped later, by the owner's `db:push` preflight, which accepts the three drop statements (the foreign key, `DROP TABLE "ActivityLog"` and `DROP TYPE "ActivityType"`) because they are listed under `destructiveStatementsAllowed` in `prisma/sql/known-drift.json` (expires 2026-12-31). Push the drop only once the release carrying this change is on production, because the previous production code still calls `logActivity`, which reports every failed insert to Sentry. The live database is also ahead of `dev` with the digital-products tables and `RecordingPurchase.reconciledAt`, which the preflight refuses to drop, so the digital-products change must merge first.

### 7. Known gap: sessions ended by sign-out or revocation

The 180-day session trail covers sessions that lapse. It does **not** cover sessions that end any other way. Sign-out and revocation (`lib/auth/session-revoke.ts` and Better Auth's sign-out) delete the row at once, and Better Auth also deletes an expired row if a browser presents it. For those sessions no IP and user-agent trail survives. Closing it would need a new column or table to keep a revoked session's row; that is outside this change and is left for the owner to decide.

Keeping an expired row is safe for logins. Better Auth 1.7.7 `getSession` returns null for a row whose `expiresAt` is in the past, and the cookie cache is off (`lib/auth.ts`). The app's own readers (`app/api/user/sessions/route.ts` and `app/api/admin/users/[userId]/sessions/route.ts`) filter on `expiresAt > now`.

### 8. Never pruned

Invoices, credit notes, the ledger, `Payment`, `Refund` and TDS records are never pruned. They are the books (Companies Act s.128(5), CGST Act s.36, Income-tax Rules 2026 Rule 46) and Razorpay's terms, clause 2.18, treat transaction records as ten-year records. `ConsentArtifact` rows are held 7 years (`auditRetainedUntil`) and the consent sweeper only counts them.

## Citations

- DPDP Act 2023, s.8(7) and s.17(1)(a): <https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf>
- DPDP Rules 2025 (G.S.R. 846(E)), Rule 8(3): personal data, associated traffic data and other processing logs kept at least one year, commencing 13 May 2027: <https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf>
- CERT-In Directions 20(3)/2022 of 28 April 2022, direction (iv), ICT logs for 180 days: <https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf>
- CERT-In FAQs, May 2022, questions 35 and 36: <https://www.cert-in.org.in/PDF/FAQs_on_CyberSecurityDirections_May2022.pdf>
- CGST Act s.36, 72 months: <https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter8/section36_v1.00.html>
- Companies Act 2013 s.128(5), eight financial years: <https://www.indiacode.nic.in/bitstream/123456789/2114/5/A2013-18.pdf>
- Income-tax Rules 2026 Rule 46 (46(8) India backup, 46(9) seven tax years): <https://wm.incometaxindia.gov.in/web/guest/w/rule-46-5>
- Consumer Protection Act 2019 s.69, two years: <https://consumeraffairs.gov.in/public/upload/files/CP%20Act%202019_1732700731.pdf>
- Limitation Act 1963 Articles 55 and 113, three years: <https://upload.indiacode.nic.in/schedulefile?aid=AC_CEN_3_20_00005_196336_1517807319297&rid=33>
- Razorpay terms, clause 2.18: <https://razorpay.com/terms/>

## Options considered

| Option                                      | Verdict      | Reason                                                                                                       |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| Fold every new prune into two existing jobs | **Selected** | The ticker is at 11 of 12 targets on its busiest tick; the new volumes are tiny.                             |
| One new ticker target per table             | Rejected     | It would push the busiest tick over the cap and add an invocation for tables that gain tens of rows a month. |
| Age-only rule for `BookingStatusHistory`    | Rejected     | It would delete the `PENDING` row a live booking's reschedule restore reads.                                 |
| Keep `WebhookEvent` failed rows at 90 days  | Rejected     | Rule 8(3) covers processing logs of every outcome.                                                           |
| A separate prune for `SupportCaseEvent`     | Rejected     | It would delete the `EVIDENCE_PURGED` marker and re-trigger the evidence purge.                              |
| Keep `ActivityLog` with a one-year prune    | Rejected     | It has no reader and holds copied personal data that erasure never scrubbed.                                 |

## Consequences

- **Schema.** Removing the `ActivityLog` model leaves the table in the database until the owner's `db:push` preflight drops it. Nothing reads or writes it in the meantime.
- **First run after deploy.** The first evening's `prune-system-job-executions` runs delete the backlog described above.
- **Storage.** Longer windows (`SystemJobExecution` 180 days, `EmailEvent` and `WebhookEvent` 365 days) grow the tables. No-op rows, the bulk of the inflow, still go after 14 days, and the audit measured the whole database at 184 MB.
- **Confirm with the CA.** The 8-year money-audit horizon is the owner's choice and awaits the chartered accountant's confirmation.

## Deprecated & Superseded Approaches

- A 7-year window for money `OrgAuditLog` categories, a 90-day `SystemJobExecution` window, a 30-day `EmailEvent` window and 30- or 90-day `WebhookEvent` windows are superseded by the table above. Delete any doc or test that still states them.
- Deleting an expired `Session` row at the moment it expires is superseded by the 180-day trail.
- The `ActivityLog` table, `ActivityType` enum and `lib/activity/` are gone. Do not reintroduce a per-user activity feed table; `BookingStatusHistory` is the record of booking transitions.
- The wording "180 days inside India" for CERT-In logs was wrong and is corrected in the compliance docs. Do not restore it.
