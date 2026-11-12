# 12-sweeps-background-jobs (SW-)

Every background job that changes a booking or its money: what it picks up, what it writes, what each dashboard and notification says afterwards, and what it must leave alone. Run this folder **last**: its preconditions shift clocks on QA rows.

Journey cases elsewhere already assert the main outcome of several sweeps (CO-36, CO-40, CO-55, CO-89, CO-90, SU-78…SU-82, TR-08, TR-09, TR-26, TR-37, WE-53). SW cases don't repeat those assertions; they test the **sweep itself**: cohort edges (just inside vs just outside the cut-off), isolation (only the lapsed row moves), re-run idempotency (a second run changes nothing and notifies nobody), maintenance gating, counters in the run record, and the aftermath on every surface.

| File | Cases | What |
| --- | --- | --- |
| [01-holds-checkouts-pay-links.md](01-holds-checkouts-pay-links.md) | SW-01 – SW-08 | Preflight (who runs jobs on the shared DB), abandoned checkout scope and re-run, what a released hold looks like, legacy 35-min rows, lapsed pay links once, pay-link reminder, tentative-slot cleanup, payment status reconcile |
| [02-requests-reschedules-parked.md](02-requests-reschedules-parked.md) | SW-09 – SW-17 | 48-h request expiry edge, 30-day / 7-day backstops, paid plan never scheduled (nudges, 48-h refund), 30-day approved-unallocated edge, stale released subscription sessions, parked consultation deadlines, proposal expiry restore, waitlist and backup-interest lapse, plan-week nudges |
| [03-trials-completion-no-shows.md](03-trials-completion-no-shows.md) | SW-18 – SW-24 | Unpaid trial lapse, unanswered paid trial refund, completion at end + 1 h, consultant no-show, sessions parked for ops (72 h alert, 7-day escalation), reminders, class end refunds stamped |
| [04-refunds-settlement-earnings.md](04-refunds-settlement-earnings.md) | SW-25 – SW-32 | Refund-owed retry and reconcile in order, host-cancelled class sessions after 14 days, voided sessions, plan end settlement, earnings release, missing earnings, stale tentative flags and double-booking detection, automatic top-up of partly scheduled plans |
| [05-maintenance-and-ops.md](05-maintenance-and-ops.md) | SW-33 – SW-39 | DEGRADED gating (owner drill), production-only run doors, overlapping runs, platform incidents, maintenance remediation, the day after a full sweep cycle, cleanup |

**Count:** 39 cases.

## Booking jobs (from `lib/cron/cleanup-registry.ts`, `lib/cron/schedule.ts`, `lib/cron/financial-jobs.ts`)

| Slug (`/api/cleanup/<slug>`) | Run record `jobName` | Every | Financial (held in DEGRADED) | What it does (registry text) | Cases |
| --- | --- | --- | --- | --- | --- |
| `abandoned-payments` | `cleanup-abandoned-payments` | 15 min | yes | Expire abandoned checkouts and lapsed approval pay-links, and remind payers who owe one | SW-02…SW-06 |
| `tentative-occurrences` | `cleanup-tentative-occurrences` | 15 min | no | Release slots held for abandoned booking flows (24 h) | SW-07 |
| `reconcile-payment-status` | same | 15 min | yes | Query Razorpay for the actual status of stale pending payments | SW-08 |
| `expire-stale-requests` | same | 15 min | yes | Expire unanswered requests and refund approved requests that were never scheduled (plus parked consultations, stale released sessions, waitlists, nudges) | SW-09…SW-14, SW-16, SW-17 |
| `reschedule-proposals` | `expire-reschedule-proposals` | 15 min | no | Lapse reschedule proposals nobody answered and restore the original time | SW-15 |
| `expire-unpaid-trials` | same | 15 min | yes | Expire unpaid trials and refund paid trials nobody answered | SW-18, SW-19 |
| `auto-complete-appointments` | same | 30 min | no | Move finished sessions to completed after they end (end + 1 h); stamps class-end refunds | SW-20, SW-22, SW-24 |
| `detect-consultant-no-shows` | same | 30 min | yes | Cancel and refund sessions the consultant never joined (120-min grace) | SW-21 |
| `appointment-reminders` | `send-appointment-reminders` | 15 min | no | Send the 24-hour, 1-hour and 15-minute session reminders | SW-23 |
| `retry-auto-refunds` | same | 15 min | yes | Re-drive auto-refunds the capture webhook could not complete (and every booking door's refund-owed marker) | SW-25 (detail MO-55…MO-58) |
| `reconcile-refunds` | `reconcile-pending-refunds` | 15 min | yes | Sync pending refund status with Razorpay | SW-25 (detail MO-59) |
| `settle-cancelled-sessions` | same | 30 min | yes | Refund cancelled class sessions not made up within 14 days (plus voids and plan end) | SW-26…SW-28 |
| `release-earnings` | same | 15 min | yes | Move held earnings to ready after the hold period | SW-29 |
| `sync-payment-earnings` | same | 15 min | yes | Create missing earnings records for succeeded payments | SW-30 |
| `reconcile-occurrence-availability` | same | 60 min | no | Clear stale tentative flags and detect double bookings; also tops up partly scheduled subscriptions and classes after the expert changes availability | SW-31, SW-32 |
| `settle-platform-incidents` | same | 60 min | yes | Void and refund the sessions of a declared platform incident | SW-36 |
| `maintenance-booking-remediation` | same | 15 min | yes | Process one explicitly confirmed booking cancellation; held until maintenance ends | SW-37 |
| `alert-orphaned-payments`, `reconcile-orphaned-payments`, `reconcile-orphaned-confirmations`, `sweep-stuck-webhook-events` | same | 15–30 min | healer: yes | Find and heal captured payments with no booking; re-drive stuck webhooks | MO-65, MO-67 |

## How a sweep case runs (read before any SW case)

1. **Shared database, production ticker.** Development, previews and production share one database. Only the **production** deploy's ticker (`netlify/functions/cron-tick.mts`, every 5 minutes, when production is the active cron platform) dispatches jobs, and it runs **production's code**, not the PR's. So once you shift a QA row into a cohort, production may process it within the job's interval. Consequences:
   - Read the "before" state **in the same SQL call as the shift** (or right after), or you may miss it.
   - If production processes your row, record it as "ran on production (code at `main`/deployed commit)", not as a PR result. Find the run: `SELECT "jobName", status, "startedAt", "itemsProcessed", result, "errorLog", "triggeredBy" FROM "SystemJobExecution" WHERE "jobName" = :jobName ORDER BY "startedAt" DESC LIMIT 5;`.
   - SW-01 records whether production's ticker is active before you start.
2. **No job run from the runner.** `POST /api/admin/system-jobs/run` answers `409 JOB_RUN_PRODUCTION_ONLY` off production; `/api/cleanup/<slug>` needs `CRON_SECRET`. Never imitate a sweep with SQL. Mark the case **NEEDS-OWNER-RUN** with: the slug, the precondition rows, and the verification SQL. Owner command (local `next dev` on the PR branch): `curl -X POST -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cleanup/<slug>?limit=50"`. That run uses the PR's code against the shared database, and it selects rows by the job's own predicate, not by QA fixture: `limit` only caps the batch, so it processes every matching row, production's included. Run it only against a database with no production rows, or once the owner has confirmed with the case's predicate SQL that only QA rows match; otherwise the case stays NEEDS-OWNER-RUN.
3. **Clock shifts** (owner-approved, `_shared/personas-and-fixtures.md` §4): move only QA rows; keep session times on the UTC half hour; note every shifted column and its original value in the ledger; restore in SW-39.
4. **Every case checks:** the run record and its counters, the rows that should move, a control row that must **not** move, a second run that changes nothing, notifications (exactly one per party per event in `NotificationOutbox` and the bell), and the surfaces in "Aftermath" in each party's zone.
5. **Idle probes.** Each job skips a tick when its own "has work" probe finds nothing. If your row doesn't move, check whether it actually matches the job's cohort (the case gives the predicate) before reporting a bug.

## Fixtures and personas

QA bookings from 03–08 (each case names the one it reuses), or fresh ones made through the product first. Personas: B1 (IST), B2 (London), B3 (Los Angeles), B4, H1, H2, H3 (New York), ST, AD.

## Run order

01 → 02 → 03 → 04 → 05, after every other folder. SW-01 first. SW-39 last.

## Salvaged from `prompts/booking-algorithm-tests/`

| Old | New |
| --- | --- |
| 011 Phases 1–4 (live hold blocks, lapsed hold frees, clock alone never frees a paid slot, a live retry keeps the hold) | HM-14 (grid), MO-12 (money); the sweep that writes `EXPIRED`: SW-02 |
| 011 Phase 5 (`REQUEST_SUBMITTED` waits on a human, not a payment) | SW-07 |
| 018 Phase 4 (abandoned sweep touches only the lapsed buyer; second run idempotent) | SW-02 |
| 018 Phase 5 (sweep vs capture) | CC-12 |
| 019 Phases 2–5 (owed re-drive, grace, definitive ×3, ambiguous) | MO-56…MO-59; ordering with reconcile: SW-25 |
| 008 (financial crons abort under maintenance; post-freeze catch-up order) | SW-33 (+ CC-67…CC-70) |
