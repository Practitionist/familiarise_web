# 12-e · Sweeps: maintenance gating, run doors, incidents and the day after

**Needs:** read [README.md](README.md) "How a sweep case runs". SW-33 and SW-37 need a **production** maintenance window (owner drill, as in 09-g); everything else runs with the owner's local `next dev` or reads only.
**Personas:** B1, B2, H1, H2, ST, AD.
**Docs under test:** `lib/maintenance-cron.ts`, `lib/cron/financial-jobs.ts`, `lib/cron/with-cron-lock.ts`, `app/api/admin/system-jobs/run/route.ts`, `lib/booking/platform-incidents.ts`, `lib/maintenance-remediation.ts`, `docs/maintenance/04-cron-jobs-reference.md`, `docs/maintenance/07-post-maintenance-recovery.md`.

## SW-33 — DEGRADED holds the money jobs and lets the calendar jobs run (owner drill) `[sweep]`

**Why it matters:** salvaged from old 008; a half-frozen system must not refund or release money, but sessions still end and reminders still go.

**Setup (before the owner's DEGRADED window):** a QA class about to end with a never-placed session (SW-24 shape), a QA owed marker (MO-56 shape), a QA earning past its hold (SW-29 E1), a QA booking starting in 24 h + 5 min.

**Steps (owner, during DEGRADED):** trigger `auto-complete-appointments`, `appointment-reminders`, `retry-auto-refunds`, `release-earnings`, `abandoned-payments`. After thaw, trigger the catch-up list from `docs/maintenance/07-post-maintenance-recovery.md` §4 in its order.

**Expect:** during DEGRADED: auto-complete completes the class and **stamps** the class-end markers; reminders send; the three financial jobs refuse ("Maintenance mode is DEGRADED — <job> is a financial job and is unavailable until maintenance ends"), touching nothing. After thaw: the markers drive once, the earning releases once, the reminder isn't re-sent. Run records show the refusals and the later successes.

```sql
SELECT "jobName", status, "startedAt", "itemsProcessed", "errorLog" FROM "SystemJobExecution"
WHERE "startedAt" > :windowStart ORDER BY "startedAt";
```

**Probe further:** compare the job list in `docs/maintenance/04-cron-jobs-reference.md` with `FINANCIAL_JOB_NAMES`; list any job the doc calls safe in DEGRADED that the code holds (or the reverse) as DOC-DRIFT.

## SW-34 — Run doors refuse off production, and say why

**Why it matters:** an operator on a preview must not flip shared state, and must understand the refusal.

**Steps:** as AD on a preview open the system jobs page; press **Run** on `expire-stale-requests`; as ST do the same. Read each job's row (last run, status, items, errors).

**Expect:** AD: `409` `JOB_RUN_PRODUCTION_ONLY` with human copy on the page (record); ST: refused by permission or the same 409 (record). The page lists every booking job in the README table with a last-run time that matches `SystemJobExecution` (SW-01). A job a typed confirm guards (financial) asks for it before any attempt.

**Probe further:** does the page say the database is shared with production and that runs here would act on real data? If not, MISSED-OPPORTUNITY.

## SW-35 — Two runs at once: one does the work, the other stands down `[sweep]`

**Why it matters:** two runners on one cohort could refund twice; the lock must make the loser a no-op.

**Setup:** an `expire-stale-requests` cohort with at least one QA row (SW-09 A shape).

**Steps:** the owner fires two `curl` calls to `/api/cleanup/expire-stale-requests` at the same moment (and the same for `retry-auto-refunds` with a QA marker).

**Expect:** one `200` that processed the rows; the other `409` (lock held; expected, not an error) or a `200` with nothing processed. One expiry, one refund, one notice. The run record shows the loser as a lock refusal, not a failure that pages.

## SW-36 — A declared platform incident voids and refunds the affected sessions `[sweep]`

**Why it matters:** an outage must make buyers whole without anyone cancelling by hand.

**Setup:** AD declares an incident covering a short past window that contains one QA consultation and one QA class session (owner-approved shift of the sessions into that window; declare through Money → Incidents). Don't declare an incident covering real users' sessions: keep the window narrow and check by SQL that only QA occurrences fall inside it before saving.

**Steps:** NEEDS-OWNER-RUN `settle-platform-incidents`; run again.

**Expect:** the covered sessions `VOIDED`; each seat refunded under `incident:<incidentId>:<occurrenceId>:<userId>` (or offered the free rebook remedy, HM-46/CO-92: record which applies to which type); one notice per affected user (`incident:<incidentId>:user:<userId>`); sessions outside the window untouched. Run 2: nothing new.

**Aftermath:** B1's booking shows the void with the remedy; H1's earnings for the voided session reverse; the incident page shows settled counts.

## SW-37 — Maintenance booking remediation waits for the thaw (owner drill) `[sweep]`

**Why it matters:** a booking cancellation confirmed during maintenance must run once, after maintenance.

**Setup (owner, production window):** a QA booking marked for remediation through the maintenance console (the door that queues an explicitly confirmed cancellation).

**Steps:** owner triggers `maintenance-booking-remediation` during DEGRADED and again after thaw.

**Expect:** during: held (financial job). After: exactly one cancellation with its refund (key recorded), one notice; a second run does nothing.

## SW-38 — The day after a full sweep cycle: every surface tells one story

**Why it matters:** sweeps change state while nobody is looking; the next morning each party must find a coherent account.

**Steps:** after 01–04 of this folder, sign in as each party touched (B1, B2, B3, H1, H2, OS, ST) and open their home, appointments, payments/earnings and bell. For each sweep outcome (expired request, lapsed link, expired proposal, parked cancel, no-show, plan end, class end, unanswered trial), write one line per party: what they see, in which words, in which zone.

**Expect:** one terminal word per outcome across surfaces ("expired" for lapses, "cancelled" with who and why, "refunded ₹X"); every money change visible on the Payments and Earnings pages; no item left in "Needs you" for something a sweep closed; no notification for an event that didn't happen to that user.

**Probe further:** list every sweep notice verbatim and judge it: does it say what happened, why, what money moved, and what to do next? Missing any of the four is a MISSED-OPPORTUNITY.

## SW-39 — Cleanup and clock restore

**Why it matters:** shifted clocks left behind make every later run (and production's ticker) act on QA rows.

**Steps:** from the fixture ledger, restore every shifted column to its original value or move the row out of every cohort (future times, live holds closed through the product); retire QA-ONLY markers and placeholders (08-e rules); remove H1's extra availability from SW-32; cancel live QA bookings through the product; delete mock-payment graphs in R-09 order.

**Expect:** a table in the report: row, column, original value, shifted value, restored (yes/no, why). Re-run SW-01's query: no booking job processed a QA row after this step.
