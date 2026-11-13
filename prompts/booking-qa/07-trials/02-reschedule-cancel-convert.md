# 07-b · Trials: reschedule once per side, cancel by either side, completion and conversion

**Needs:** 07-a (TR-01's free trial for B4; TR-06's paid trial for B1, or fresh ones). Paid-trial money cases need a captured trial (gateway or owner webhook replay). Sweeps are `[sweep]`.
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B4 (IST), ST.
**Docs under test:** `docs/booking/09-trials.md` ("Rescheduling a trial", "Cancellation behaviour", "Auto-Completion", "Conversion to Subscription"), `lib/booking/trial-reschedule.ts`, `lib/trials/cancellation.ts`, `lib/trials/conversion.ts`, `app/api/appointments/[appointmentId]/reschedule/route.ts` (trial branch).

Rules under test: each side moves a trial **once** (learner's second → 422 `MAX_RESCHEDULES_EXCEEDED` "You can move a trial once. If this time doesn't work either, cancel the trial."; expert's second → 409 `EXPERT_RESCHEDULE_CAP` "You've already moved this trial once. If the time no longer works, cancel it — the learner gets a full refund."); a trial move must name a time (400 `PROPOSAL_REQUIRED` "Pick the new time for the trial."); the session moves **in place** and `Trial.status` stays `SCHEDULED`; restores (decline, withdraw, expiry) cost nothing. Cancel goes through `DELETE /api/trials/[trialId]` only; an expert cancel is 100 % plus a strike, also for a free trial.

Fixtures: **T-1** = B4's free trial (TR-01, Tue D+8 09:00 IST). **T-2** = a free trial for B2 on S-11 at Wed D+9 10:00 IST (book it now). **T-3** = B1's paid captured trial (TR-06). After every case: R-03, R-04, R-05, R-07 and the 07-a trial query.

## TR-19 — The learner moves a trial once; it confirms in place

**Steps:**

1. As B4 open T-1 → **Reschedule** (`/dashboard/consultee/[B4 uid]/appointments/[aid]/reschedule`). The page shows the zone switch and the light single-time picker (`SingleTimePicker`, buyer audience: a month, then the day's free 30-min times, 24-h lead; taken times behind "Show N taken times").
2. Pick Thu D+10 10:00 IST (free, published). Submit.

**Expect:** `RescheduleRequest` `AUTO_ACCEPTED` (`initiatorRole = 'CONSULTEE'`); the **same** occurrence id now at Thu D+10 04:30Z; `Trial.status` still `SCHEDULED`; payment untouched; the other party (H1) is notified through the outbox (`appointment-rescheduled` family naming the trial's parties) and B4, who moved it, is not.

**Cross-check:** B4 and H1 appointments; H1's grid moved the block; reminders re-timed.

**Probe further:** does the page tell B4 "you can move this trial only once" before the submit? MISSED-OPPORTUNITY if not.

## TR-20 — The learner's second move is refused

**Steps:** as B4 try to move T-1 again (UI, then POST).

**Expect:** 422 `MAX_RESCHEDULES_EXCEEDED` with the trial copy above; the page should show that instead of a picker. Nothing changes.

## TR-21 — A trial move must name a time

**Steps:** as B2, POST `/api/appointments/[T-2 aid]/reschedule` with no `proposedSlots` (the "Any time works" shape). Check whether the trial reschedule page even offers "Any time works".

**Expect:** 400 `PROPOSAL_REQUIRED` "Pick the new time for the trial."; no request row; the UI doesn't offer "Any time works" for a trial (record).

## TR-22 — Taken or unbookable new times: the trial keeps its time, the move isn't used

**Steps (as B2 on T-2):**

1. `[two-browser]`: pick a free time; before submitting, have B3 book that time (consultation); submit.
2. POST a window outside H1's hours (Sun D+13 10:00 IST).

**Expect:** 1: 409 `TIMES_TAKEN` "That time was just taken. Your trial keeps its original time — pick another time." 2: 409 `TIME_NOT_BOOKABLE` "That time can't be booked: it isn't in the expert's open hours or it's too soon. Your trial keeps its original time — pick another time." Both requests withdrawn on the spot; T-2 unchanged; B2 can still move once.

## TR-23 — The 24-hour rule on trials

**Steps:** owner-approved: shift T-2's occurrence to start in 20 h. As B2 open Reschedule; POST anyway. Restore T-2. Then POST a new time 10 h away.

**Expect:** 409 `RESCHEDULE_WINDOW` ("Cannot reschedule within 24 hours of the meeting. …"); then 400 `PROPOSAL_TOO_SOON`. No requests created.

## TR-24 — The expert proposes; the learner accepts; the expert's second move is refused

**Steps:**

1. As H1 open T-2 → reschedule ("Propose a new trial time", the light single-time picker inside H1's published hours). In the network panel, check the availability fetch sends `consulteeUserId` (B2). B2's own busy times are not among the free times (they sit under "Show N taken times"), and nothing inside 24 h is listed.
2. Propose Thu D+10 17:00 IST. Submit.
3. As B2 read the `RescheduleProposalCard` ("Your consultant proposed new times", "Needs an answer by <London time>") and **Accept new times**.
4. As H1 propose again.

**Expect:** 2: `PENDING_REVIEW` (never auto, even though the time is free); session released (`RESCHEDULED`, tentative); `Trial` still `SCHEDULED`. 3: `ACCEPTED`; the same occurrence at 11:30Z. 4: 409 `EXPERT_RESCHEDULE_CAP` with the trial copy.

**Probe further:** B2 has a booking elsewhere (create one if needed): is that time missing from H1's free times and listed as taken? If it is offered as free, the consultee-busy feature is broken (FAIL).

## TR-25 — The learner declines the expert's proposal; the expert may propose again

**Steps:** on T-1 (B4's move is used, H1's isn't): as H1 propose Fri D+11 10:00 IST; as B4 decline. Then as H1 propose again.

**Expect:** decline → `DECLINED`, session back to its time, `restoredAt` set; H1's second proposal is allowed (the restored one didn't count). Withdraw it afterwards (`WITHDRAWN`, restored).

## TR-26 — An unanswered trial proposal expires and restores `[sweep]`

**Steps:** H1 proposes on T-1; owner-approved: set its `expiresAt` to 1 minute ago. B4 tries to accept. Then NEEDS-OWNER-RUN the reschedule-proposal expiry job.

**Expect:** accept → 409 `PROPOSAL_EXPIRED`; after the job, `EXPIRED`, restored, not counted. Completion never runs on a released (tentative) session.

## TR-27 — Only the trial's two parties may move it

**Steps:** as ST, POST the reschedule route on T-2.

**Expect:** 403 `TRIAL_PARTY_ONLY` "Only the trial's expert or learner can move it. Cancel it from the back office instead."

## TR-28 — An unpaid hold can't be moved

**Steps:** on an `AWAITING_PAYMENT` trial (fresh paid hold), as the learner POST the reschedule route.

**Expect:** a typed 409: `NOT_RESCHEDULABLE` first, because a trial moves only from `SCHEDULED` and the status check runs before the payment check (`PAY_LINK_LIVE`, "This booking is still waiting for payment. Pay for it or cancel it first, then reschedule.", is the answer for any other booking with a live pending payment; record which one comes back). The trial page shows no Reschedule for an unpaid hold.

## TR-29 — The expert cancels a paid trial inside the learner's 0 % tier: full refund and a strike

**Why it matters:** the doc's worked example; the client is made whole and the expert's record grows.

**Setup:** T-3 (paid, captured). Owner-approved: shift its occurrence to start in 30 min.

**Steps:** as H1 open T-3 → **Cancel trial**. Read the quote (`GET /api/trials/[trialId]/cancel/preview`). Confirm.

**Expect:** preview 100 % of 10000 paise (+ tax as charged); `DELETE /api/trials/[id]` with `confirmedRefundPaise` = quote → 200; `Trial` `CANCELLED`; session `CANCELLED` + `deletedAt`, appointment `deletedAt` (nothing hard-deleted); `Payment.refundOwedKey = 'trial-cancel:<trialId>:<paymentId>'` stamped in the commit and cleared after the refund; `Refund` row = quote; one `EXPERT_CANCEL` strike for H1 (strike query in 03-consultations/cancel/06); B1 gets `trial-session-cancelled` and, once money moved, the `trial-refunded` bell.

**Probe further:** at 10 min before start the same cancel → 409 `SESSION_IN_PROGRESS`. Does H1's dialog warn about the strike, as the consultation dialog does?

## TR-30 — The expert cancels a free trial: no money, but a strike

**Steps:** as H1 cancel T-2 (free, ≥ 24 h away).

**Expect:** `CANCELLED`, no refund, **one strike** for H1. A free confirmed consultation cancelled by the expert records one strike too (CO-82; decision 6 of the trial and public booking surfaces record), so the two agree.

**Probe further:** B2's pair with H1 is freed (CANCELLED frees it): B2 may request a new trial. Is that the intended outcome after an expert cancel? Record.

## TR-31 — Staff cancels a trial: full refund, no strike

**Steps:** as ST cancel a scheduled trial from the back office.

**Expect:** consultant-side quote (100 %), no strike, history actor = ST.

## TR-32 — The learner cancels a paid trial at each tier, with the quote bound

**Setup:** three captured paid trials (or re-use one with time shifts): ≥ 24 h, 10 h and 90 min before start.

**Steps:** as the learner open "Cancel trial", read the quote, confirm. On one of them, call `DELETE` without `confirmedRefundPaise`; on another, change the notice between preview and confirm (shift across 24 h).

**Expect:** 100 % / 50 % / 0 % on the booking-time policy tiers; refund = quote; no strike. Missing confirmation → 409 `REFUND_QUOTE_REQUIRED` with the current quote; stale → 409 `REFUND_QUOTE_CHANGED` with the new quote; nothing committed on either.

## TR-33 — The learner cancels a free trial

**Steps:** as B4 cancel T-1.

**Expect:** `CANCELLED`, no money, no strike; the dialog doesn't mention a refund amount. The pair is freed (B4 may request again).

**Probe further:** "cancel then re-request" lets a learner hold H1's time repeatedly: note it under the documented abuse trade-off.

## TR-34 — Frozen and delivered trials can't be cancelled

**Steps:** shift a scheduled trial to start in 10 min → cancel. Shift it to have ended → cancel.

**Expect:** 409 `SESSION_IN_PROGRESS`; then 409 `SESSION_ALREADY_DELIVERED`. Copy readable.

## TR-35 — PATCH can't cancel a scheduled or paid trial

**Steps:** `PATCH /api/trials/[id]` `{ status: "CANCELLED" }` on a `SCHEDULED` trial; same on an unpaid paid trial (`PENDING`/`AWAITING_PAYMENT`).

**Expect:** 409 `USE_CANCEL_ENDPOINT` for `SCHEDULED`; 409 `REFUND_QUOTE_REQUIRED` for a paid one; nothing changes.

## TR-36 — Cancelling a trial with an open proposal declines it in the same commit

**Steps:** H1 proposes on a scheduled trial; then the learner cancels the trial.

**Expect:** proposal `DECLINED`, `openForAppointmentId` NULL; trial `CANCELLED`; no dangling "Accept new times" on either side.

## TR-37 — Completion `[sweep]`

**Steps:** on a scheduled trial, owner-approved: shift its occurrence to have ended 2 h ago. Open `GET /api/trials` as the learner (inline completion, no buffer). Then NEEDS-OWNER-RUN `auto-complete-appointments` (1-h buffer) for a second trial shifted to 70 min ago.

**Expect:** `COMPLETED` with `completedAt`; `trial-session-completed` to both; dashboards show "completed" with a next step (subscribe to the plan). A trial with a released session (open proposal) is not completed.

**Probe further:** does the learner get a clear "subscribe" call to action after the trial? MISSED-OPPORTUNITY if not. Review prompt?

## TR-38 — Converting to a subscription: at payment, not at checkout start `[local]`

**Why it matters:** conversion is a metric and a link; it must reflect money actually paid.

**Setup:** B4's trial `COMPLETED` (TR-37 shape; re-book T-1 first if TR-33 cancelled it).

**Steps:**

1. As B4 open H1's S-11 checkout and leave without paying (or start a gateway payment and close it).
2. Read the trial row.
3. Buy S-11 with Mock Pay. Read the trial row and the subscription.
4. Compare the price charged with the plan price.

**Expect:** 2: still `COMPLETED`. 3: `CONVERTED`, `convertedToSubscriptionId` = the new subscription (the subscription's `convertedFromTrial` points back); activity `TRIAL_CONVERTED`. 4: full plan price: the code has no trial credit. Record what checkout said; if any copy promises the trial fee "counts toward" the plan, that's FALSE-INFO. Report "does the paid trial fee credit the plan?" as an open question for the owner.

**Probe further:** the doc says a plan with the **same expert** (any plan, not only the trial's plan) converts; the PATCH `CONVERTED` handler requires the **same plan**. Buy S-12 (other plan) instead in a variant and record whether it converts. That's a doc/code disagreement to report.

## TR-39 — No conversion after 30 days

**Steps:** owner-approved: set a completed trial's `completedAt` to 31 days ago; the learner buys a plan from the same expert `[local]`.

**Expect:** the trial stays `COMPLETED` (conversion window 30 days, judged at capture).

## TR-40 — The expert's view of trials and conversion

**Steps:** as H1 open Requests → Trials, appointments filtered to trials, and any trial stats (`GET /api/trials/stats` for H1's own profile; then for H2's profile id as H1).

**Expect:** each trial's state in plain words (booked, awaiting payment, completed, converted, cancelled); stats for H1's own profile 200 and for another profile 403. Conversion visible on H1's side.

**Probe further:** raw `AWAITING_PAYMENT` or `CONVERTED` on screen is a COPY finding.

## TR-41 — Trial lengths off the 30-minute grid

**Why it matters:** a new trial is 30 or 60 minutes (the editor's two radio buttons; the plan routes refuse any other length with "A trial is 30 or 60 minutes."). A plan saved earlier at another length (45 minutes exists in practice data) keeps booking at it.

**Steps:**

1. As H1 try to create "qa-TR-41" with a 45-minute trial (via `evaluate_script`, since the editor offers only 30 and 60), then try to change an existing plan's trial to 45.
2. Find a legacy plan stored at 45 minutes (`SELECT id, "trialDurationMinutes" FROM "SubscriptionPlan" WHERE "trialDurationMinutes" NOT IN (30, 60);`). As B2 book its trial, look at H1's grid (HM-26) and try a learner move.

**Expect:** step 1 is refused with "A trial is 30 or 60 minutes." both times; nothing is saved. Step 2 books a 45-minute session (its second half hour paints "Partly booked") and the move offers 45-minute windows. Archive any plan you created.
