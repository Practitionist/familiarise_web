# 12-d · Sweeps: refunds owed, settlement, earnings and calendar repair

**Needs:** read [README.md](README.md) "How a sweep case runs". Fixtures from 04, 06, 08. Money detail of the owed-refund machinery is in 08-e (MO-55…MO-59); these cases cover the jobs' cohorts, order and aftermath.
**Personas:** B1, B2, B3, H1, H2, ST, AD.
**Docs under test:** `scripts/payments/retry-auto-refunds.ts`, `scripts/refunds/reconcile-pending-refunds.ts`, `scripts/appointments/settle-cancelled-sessions.ts`, `scripts/earnings/{release-earnings,sync-payment-earnings}.ts`, `scripts/appointments/reconcile-occurrence-availability.ts`.

## SW-25 — Owed refunds and pending refunds: two jobs, one owner each `[sweep]`

**Why it matters:** `retry-auto-refunds` must skip anything `reconcile-refunds` owns, or money moves twice.

**Setup:** reuse MO-56 (owed marker, no refund row), MO-59 (owed marker + `PENDING` placeholder) and a third QA payment with a `PENDING` refund and **no** marker (owner-approved status write on a QA mock refund).

**Steps:** NEEDS-OWNER-RUN `retry-auto-refunds`, then `reconcile-refunds`, then `retry-auto-refunds` again. Record each JSON result (`scanned`, `refunded`, `owed.scanned`, `owed.refunded`, `owed.settled`, `owed.failed`, `owed.stuck`, `owed.aged`).

**Expect:** run 1 drives only MO-56; MO-59 and the third are skipped (a `PENDING` refund belongs to reconcile). Reconcile: mock/test refunds settle or stay `PENDING` under 24 h (never failed early). Run 3: a marker whose refund reconcile settled is cleared, not re-driven. No payment ends with refunds above `amount` (MO-30).

**Aftermath:** staff "Refunds the bookings owe" shrinks to what's genuinely stuck.

## SW-26 — A host-cancelled class session not made up in 14 days refunds one unit per seat `[sweep]` `[local]`

**Why it matters:** learners lose a session they paid for unless it's made up.

**Setup:** H2's sold class (B2, B3 seats). H2 cancels one future session (06's per-session cancel; `hostCancelledAt` set). A second host-cancelled session that H2 makes up (live row with the same ordinal). Owner-approved: move both cancellations' miss time 15 days back (record the column the 14-day window reads; `missedAt` derives from it). Control: a third host-cancelled session 13 days back.

**Steps:** NEEDS-OWNER-RUN `settle-cancelled-sessions`; run again.

**Expect:** session 1: each seat refunded one unit under `occ:<occurrenceId>:pay:<paymentId>` (the same key as "skip make-up", so a seat that already skipped isn't paid again); `seatsSettledAt` stamped. Session 2 (made up): no refund. Control: untouched. A paid seat still `HELD` at settle time is escalated to a human (`held-paid-seat:` key) instead of refunded. Run 2: no new refunds.

**Aftermath:** each learner gets one bell with the unit amount; H2's earnings reverse by one unit per seat; the class page shows the session as "not made up, refunded".

## SW-27 — Voided sessions settle through the same machine `[sweep]`

**Why it matters:** a voided session (host absent, platform incident) must refund its seats exactly once.

**Setup:** a `VOIDED` QA session (SW-20 shape with host absent, or an incident void from SW-36) for a webinar or consultation, and one for a class. `seatsSettledAt` null.

**Steps:** NEEDS-OWNER-RUN `settle-cancelled-sessions`; run again.

**Expect:** webinar/consultation seat: its full refundable balance; class seat: one unit; `seatsSettledAt` stamped; a void on a subscription that's live waits for plan end (SW-28); a void on a cancelled/expired/rejected plan is stamped without money (its own refund paid it). Run 2: nothing new.

## SW-28 — Plan end settles once, resumes where it stopped `[sweep]` `[local]`

**Why it matters:** SU-78/SU-79 assert the pro-rata refund; the job must settle each plan exactly once and not starve others.

**Setup:** two ended QA plans (SU-78 shape): P1 with 2 undelivered sessions; P2 with one session still `UNVERIFIED` (needs human) at plan end. Owner-approved: `planEndsAt` 1 h ago on both.

**Steps:** NEEDS-OWNER-RUN `settle-cancelled-sessions`; run again; ST decides P2's session (Set outcome); run again.

**Expect:** P1: plan `COMPLETED` (history reason `PLAN_ENDED`), a `plan-end:<subscriptionId>…` marker for the undelivered share, refunded (directly or via `retry-auto-refunds`), one bell. P2: record whether it waits for the human decision (the escalation message counts plans "holding an ended plan's settlement", SW-22) and settles after ST decides. Run 2 after settling: no second refund.

**Aftermath:** B1's plan page: "Plan ended · N sessions were not held." with the refund line; H1's allocate refuses with `PERIOD_ENDED`.

## SW-29 — Earnings release after the hold, and not before `[sweep]`

**Why it matters:** releasing too early pays out money a refund may need back.

**Setup:** H1 earnings: E1 past `holdUntil`, delivered, no refund in flight (owner-approved shift of `holdUntil` only); the three blocked shapes from MO-49 (PENDING refund, owed marker, undelivered session); E5 with `holdUntil` 1 h ahead; a subscription earning whose plan has a voided session (subscription misses don't hold, `EARNINGS_HOLDING_MISS`).

**Steps:** NEEDS-OWNER-RUN `release-earnings`; run again.

**Expect:** E1 → `READY`; the subscription earning → `READY`; MO-49's three and E5 stay `PENDING`. The organisation arm (OX's LearnPro row, if past hold) follows the same rules. Run 2: nothing new.

**Aftermath:** H1's Earnings moves E1 from "Clears after your sessions and the hold" to "Cleared, less refunds, waiting for a payout".

## SW-30 — A paid booking with no earnings row gets one `[sweep]`

**Why it matters:** an expert who delivered but has no earnings row is never paid.

**Setup (QA-ONLY, owner-approved):** a fresh mock-paid QA booking; delete its `ConsultantEarnings` row (record the original values: gross, fee, share, `holdUntil`).

**Steps:** NEEDS-OWNER-RUN `sync-payment-earnings`; run again.

**Expect:** one new earnings row with the same gross, fee, share and hold rule as the original; run 2 creates nothing. A `SUCCEEDED` payment with amount 0 gets none (or a zero row; record).

## SW-31 — Calendar repair: stale tentative flags and double bookings `[sweep]`

**Why it matters:** a paid session still flagged tentative can be freed by the hold rule; an overlap is a broken promise.

**Setup (QA-ONLY, owner-approved):** on a mock-paid QA booking, set its occurrence `isTentative = true`. (Don't fabricate an overlap: R-05 should already be zero; if CC-53 found one, use it.)

**Steps:** NEEDS-OWNER-RUN `reconcile-occurrence-availability`.

**Expect:** the paid occurrence's `isTentative` back to false; the run result lists double bookings found (expect 0, or CC-53's); participant drift (an upcoming appointment with live sessions and no live seat) reported if any. Record the run's counters.

**Probe further:** between the flag write and the run, does the grid offer that time to another buyer (the hold rule treats a tentative session with a paid payment as occupied, MO-12)? It must not.

## SW-32 — A partly scheduled plan is topped up once the expert opens more hours `[sweep]`

**Why it matters:** the job auto-places the missing sessions of a partial allocation; it must keep existing sessions, respect the plan week and run only after availability changes.

**Setup:** B1's plan with a partial week (SU-45: "Schedule 2 now", one session unplaced) and no tentative rows. H1 then adds availability inside that plan week (Settings → Availability, a new window; restore it at SW-39).

**Steps:** NEEDS-OWNER-RUN `reconcile-occurrence-availability`; run again without further availability changes.

**Expect:** run 1: the missing session placed (`topUp`) inside the open plan week and H1's new hours; the two existing sessions keep their ids; R-06 per-week ≤ 3; R-05 zero rows; both parties notified of the new session (record). Run 2: nothing (no availability change since). A plan carrying a tentative row (a move in flight) is skipped.

**Aftermath:** B1 sees the third session with its time in IST; H1's tray shows 3 of 3. Does anything tell H1 the platform placed it automatically?

**Probe further:** an event that timed out once on this availability change gets one retry only (`retriedAfterTimeout`); record if visible.
