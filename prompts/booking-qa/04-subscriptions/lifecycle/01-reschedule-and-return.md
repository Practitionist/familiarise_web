# 04-f · Subscriptions: moving and returning single sessions

**Needs:** B2's plan (SU-23, weeks 1–2 placed by SU-51) and B3's plan (SU-37). Sessions must start at least 24 h ahead; shift with owner-approved SQL when needed (keep UTC half hours). Preview OK.
**Personas:** B2 (Europe/London), B3 (America/Los_Angeles), H1 (IST), B1 and ST for authz.
**Docs under test:** `docs/booking/07-rescheduling-flow.md`, `lib/booking/release-weeks.ts`, `lib/booking/reschedule-caps.ts`, `lib/booking/session-return-rules.ts`, `lib/booking/session-return.ts`, decision 9 (late release forfeits).

The reschedule mechanics shared with consultations (proposal lifecycle, expiry, idempotency replay) are 03's (`CO-`) and 09's (`CC-`). Here we test what is specific to a subscription: one plan week per release, per-session caps for the buyer, a per-booking cap for the expert, the 24-hour rule, and returning a session to the plan.

Entry points: consultee `/dashboard/consultee/[uid]/appointments/[aid]` → **Reschedule** (or `…/[aid]/reschedule`); consultant `/dashboard/consultant/[cid]/appointments/[aid]/reschedule`; consultee **Return to plan** on each upcoming session of the detail page.

After every move: R-03 (occurrences and `RescheduleRequest`), R-05, R-06.

## SU-61 — Buyer moves one session inside its week; expert accepts

**Why it matters:** the everyday move.

**Steps:**

1. As B2, open the plan detail. Click **Reschedule**. Select one week-1 session (≥ 24 h away). Read the picker's window.
2. Propose one new 60-minute time on a free day of the same plan week. Submit. Read the confirmation.
3. As H1, open Home / the appointment. Read the proposal. Accept.

**Expect:**

- Step 2: `POST /api/appointments/[aid]/reschedule` (with `slotIds` and `proposedSlots`, and an `Idempotency-Key`) → 2xx. DB: a `RescheduleRequest` `initiatorRole = CONSULTEE`, open, `openForAppointmentId` = the appointment, `releasedSessions` = `[{ ordinal, startsAt }]` of the moved session, `originStatus = APPROVED`. The old occurrence is `isTentative = true`, `completionStatus = RESCHEDULED`.
- Step 3: accept → the session sits at the new time with the same `ordinal`; the request is `ACCEPTED`, `resolvedAt` set, `openForAppointmentId` null. R-06 week counts unchanged.

**Cross-check:** H1 sees the proposal in IST, B2 in London. Both bells; R-07 outbox for both. B2's list shows the new time.

**Probe further:**

- While the proposal is open, does H1's allocate page show the released session as "being rescheduled" (tentative) rather than free?
- What does B2 see if H1 never answers? (Expiry is a sweep, 12 `SW-`.) Is the deadline shown?

## SU-62 — Buyer says "any time works"; expert places it

**Why it matters:** a preference-only release must close when the expert places the session.

**Steps:**

1. As B2, reschedule a different week-1 session with no proposed times (the "no preference" option; record its label).
2. As H1, open B2's allocate page. Read the heading. Place one session in week 1.

**Expect:**

- Step 1: `RescheduleRequest` open with no proposed times; occurrence tentative `RESCHEDULED`.
- Step 2: heading asks for 1 (rescheduling count). Saving → 200; the request closes (`resolvedAt` set) automatically. R-06 week 1 = 3.

**Probe further:** if H1 instead opens Reschedule for that booking, is it blocked by the open request (409 `RESCHEDULE_ALREADY_OPEN`, "A reschedule request is already open for this booking.")? Is that copy shown to H1 in words?

## SU-63 — Sessions from two plan weeks can't move together

**Why it matters:** a released batch is re-placed into one plan week; a two-week release could never be placed.

**Steps:**

1. As B2, open Reschedule. Try to select one week-1 and one week-2 session. Read what the picker does.
2. Replay the POST with both `slotIds` via `evaluate_script`.

**Expect:**

- UI: the picker defaults to the earliest week's sessions and won't combine weeks (or shows the refusal).
- API: 409 `RELEASE_ONE_WEEK`, "Move one week at a time: pick the sessions in a single week." Nothing released (R-03).

**Probe further:** is the refusal copy shown in the picker before submit, or only as a toast after?

## SU-64 — Inside 24 hours: agreed moves only

**Why it matters:** a session less than 24 hours away, or a new time less than 24 hours away, moves only when the other side accepts (owner decision 3, 2026-11-14).

**Setup:** shift one of B3's sessions to start 23 hours from now (owner-approved, UTC half hour).

**Steps:**

1. As B3, open Reschedule. Select the 23-hour session; read the copy; propose a time 3 days out.
2. Replay the POST for it without `proposedSlots`.
3. Pick a session ≥ 24 h away and propose a new time 20 hours from now.
4. As H1, place a released session of B3's (after B3's "any time" release of a ≥ 24 h session) at a time 20 hours from now.

**Expect:**

- Step 1: selectable; the copy says H1 must accept before the session starts; 200 `AWAITING_ANSWER` (not auto-confirmed), `expiresAt` = the session's start.
- Step 2: 409 `RESCHEDULE_WINDOW`, "This session starts within 24 hours. To move it, propose new times; the other person has to accept one before the session starts."
- Step 3: 200 `AWAITING_ANSWER` (waits for H1; never `AUTO_CONFIRMED`).
- Step 4: 409 `NEEDS_ACCEPTANCE`; the grid paints times under 24 hours as too soon.

**Probe further:** if H1 never answers step 1, the session stands at its time (restored by the expiry job, up to 15 minutes late); can B3 still return it (no, SU-69)?

## SU-65 — Buyer cap: each session moves at most twice

**Why it matters:** caps protect the expert's calendar.

**Steps:**

1. As B3, move session A (ordinal n) and have H1 accept. Repeat once more for the same session.
2. Try a third move of session A.
3. Move session B once.

**Expect:**

- Step 2: 422 `MAX_RESCHEDULES_EXCEEDED`, "You can move each session at most 2 times." Nothing released.
- Step 3: succeeds (the cap is per ordinal, counted from `RescheduleRequest.releasedSessions`).
- A move that was withdrawn or declined with its session restored (`restoredAt` set) doesn't count.

**Probe further:** does the UI show "1 move left for this session" before the cap? **MISSED-OPPORTUNITY** if the buyer only learns at the refusal.

## SU-66 — Expert cap: two reschedules per booking, for the whole plan

**Why it matters:** a subscription is one booking. The expert's cap is 2 for all 12 sessions together.

**Steps:**

1. As H1, reschedule one of B2's sessions (B2 accepts). Then another session (B2 accepts).
2. Try a third reschedule on any session of B2's plan.

**Expect:**

- Step 2: 409 `EXPERT_RESCHEDULE_CAP`, "You've already rescheduled this booking 2 times. If the time no longer works, cancel instead — the client gets a full refund."

**Probe further:**

- Is 2 moves across a 12- or 26-session plan intended? Report it as a product question for the owner, quoting the copy.
- "cancel instead — the client gets a full refund": cancelling cancels the **whole plan** (there is no single-session cancel, SU-71). Does the expert understand that? **FALSE-INFO** risk (P1) if the expert expects to cancel one session.
- Does H1's UI show the remaining expert moves anywhere?

## SU-67 — Decline and withdraw put the session back

**Why it matters:** a "no" to a new time is not a "no" to the plan.

**Steps:**

1. As B3, propose a move; as H1, **decline**. Check the session.
2. As B3, propose a move; as B3, **withdraw** it.
3. As B3, propose a move of session C. While it is open, as B1 book H1's 60-minute consultation at C's original time (03's instant booking, [local]; the released time is free on H1's grid). Then, as H1, decline B3's proposal.

**Expect:**

- Steps 1–2: the occurrence returns to `SCHEDULED`, `isTentative = false`, same time; `RescheduleRequest` `DECLINED` / `WITHDRAWN` with `restoredAt` set. The moves don't count toward SU-65.
- Step 3 (original time taken): decline still commits; the plan is parked with a released row and no live session for that ordinal. A withdraw in the same state would answer 409 `ORIGINAL_TIME_TAKEN` and leave the proposal open.

**Cross-check:** after step 3, H1's allocate page asks for 1 session in that week; B3's detail page explains the session needs a new time (record copy).

**Probe further:** does a parked subscription session escalate like a parked consultation (7 days → refund)? The parked-consultation sweep is consultation-only; record what happens to the subscription (12 `SW-` owns the sweep).

## SU-68 — Return a session to the plan

**Why it matters:** the buyer's own way to skip a week's session without losing it.

**Setup:** one of B3's sessions ≥ 24 h away, no open reschedule.

**Steps:**

1. As B3, open the plan detail. Click **Return to plan** on that session. Read the dialog.
2. Confirm.
3. As H1, open Home, the appointment and the allocate page.

**Expect:**

- Dialog title "Return this session to your plan?", body "This session goes back into your plan to book again. Your plan is extended by 7 days. You can do this twice per plan."
- API: `POST /api/appointments/[aid]/occurrences/[occ]/return` (with an `Idempotency-Key`) → 200 `{ occurrenceId, sessionsReturned: 1, planEndsAt }`.
- DB: the occurrence `CANCELLED` (not deleted), a history row with reason `RETURNED_TO_PLAN`; `Subscription.sessionsReturned = 1`; `planEndsAt` = old + 7 days. No `Refund`, no payment change (R-04 unchanged).
- H1: one bell and one email (an `APPOINTMENT_CANCELLED`-type outbox row saying the client returned it to their plan). The allocate page shows room for 1 in that week, and one more plan week in the heading.

**Cross-check:** B3's detail shows the new plan end in LA time. H1's Appointments no longer lists the session.

**Probe further:**

- The email to H1 is an "appointment cancelled" email. Does its subject say "returned to plan" or "cancelled"? **COPY** if it reads like the client cancelled.
- Replay the same request with the same `Idempotency-Key`: same 200 body, `Idempotent-Replay: true`, `sessionsReturned` still 1, end moved once.

## SU-69 — Return guards: cap, window, state, owner

**Steps:**

1. As B3, return a second session (≥ 24 h, new key) → expect success, `sessionsReturned = 2`, end + 14 days total.
2. Return a third.
3. Return a session starting in 23 hours (shift one if needed). Read the button first.
4. Return the session already returned in SU-68 (new key).
5. With a reschedule open on the plan, return another session.
6. As B2, as H1 and signed out, call the return endpoint for B3's session.

**Expect:**

- Step 2: 409 `RETURN_CAP_REACHED`, "You've already returned 2 sessions to this plan." The button is disabled with the same text as its tooltip.
- Step 3: disabled button; tooltip "This session starts in less than 24 hours, so it can't go back to your plan. If you miss it, it counts as delivered." API → 409 `RETURN_WINDOW_CLOSED`.
- Step 4: 409 `SESSION_NOT_RETURNABLE`, "This session can no longer be returned — it was moved, cancelled or already returned."
- Step 5: 409 `RETURN_RESCHEDULE_OPEN`, "A reschedule is waiting for an answer on this plan. Return a session once it's settled."
- Step 6: B2 and H1 → 403 "Only the person who booked this plan can return its sessions."; signed out → 401.
- DB: counters never exceed 2 (a CHECK backs it).

**Probe further:** two returns fired in parallel at `sessionsReturned = 1` (different sessions, different keys): exactly one wins. Depth in 09 (`CC-`); run once here if cheap.

## SU-70 — The buyer can't cancel one session; the only cancel is the whole plan

**Why it matters:** decision 9: no single-session release or cancel inside 24 h; outside 24 h the tools are reschedule and return.

**Steps:**

1. As B2, open the plan detail. List every action on a single session and on the plan.
2. Open the cancel dialog from the plan's menu. Read what it says it will cancel.

**Expect:**

- UI: per session: Reschedule, Return to plan (and Join near start). No "Cancel this session". The plan-level cancel names the whole plan and shows a refund quote (SU-72).

**Probe further:** does the cancel dialog make clear it ends **all** remaining sessions? A buyer who wants to skip one session may cancel the plan by mistake. **MISSED-OPPORTUNITY** if the dialog doesn't point to Return to plan.

## SU-71 — The expert wants to cancel one session

**Why it matters:** experts get sick; the product must give them a path that doesn't cancel the whole plan.

**Steps:**

1. As H1, open B2's appointment. List the session-level and booking-level actions.
2. Look for any single-session cancel. Try `POST /api/appointments/[aid]/occurrences/[occ]/cancel` (class door) for a subscription session.
3. Read the expert's options inside 24 hours of a session.

**Expect:**

- UI: **Reschedule** (capped at 2 per booking, SU-66) and **Cancel booking** (whole plan). No per-session cancel.
- API: the class cancel door refuses a subscription session with a typed 4xx (record it).
- Inside 24 h: Reschedule refuses (`RESCHEDULE_WINDOW`); the only remaining action is the whole-plan cancel. A missed session is handled after the fact by the session-outcome sweep (no-show, void by staff), not by the expert.

**Probe further:** is there any copy telling H1 what to do if they can't make one session ("message your client", "contact support")? Report the gap as **MISSED-OPPORTUNITY** (P1 for the expert journey), with the exact options you found.
