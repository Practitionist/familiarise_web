# 06-c · Classes: enrolling, late join, capacity and leaving before the class starts

**Needs:** `qa-CL-01` (H2, 2/week × 1 month × 60 min, 8 sessions, ₹1,000, capacity 5, `lateJoinUntilSession = 3` from CL-07) with sessions starting more than 24 h away; F-PL2's class. **[local]** for paid seats; owner-approved clock shifts for the late-join cases.
**Personas:** H2 (IST) host; B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), B4 (IST), DR (Australia/Sydney) buyers.
**Docs under test:** `docs/booking/16-recurring-events-journey.md` §3b-i (batches and late join); `lib/payments/checkout/handlers/class.ts`; `lib/booking/class-enrolment.ts` (`classEnrolmentFrom`, `sessionsBoughtLabel`); `lib/booking/seat-leave.ts`; `components/booking/CancellationPolicyNote.tsx`.

A seat is one `AppointmentParticipant` (`role = CONSULTEE`) on the class's single wrapper appointment, covering every session. `sessionsPurchased` records how many sessions the seat paid for (N for an on-time buyer, fewer for a late joiner). Seat-leave before any session is delivered follows the window rule: full refund outside the plan's free-cancellation window (default 24 h before the **next** session), refused inside it (409 `REFUND_WINDOW_CLOSED`). Once the class is under way a leave refunds by the class quote (06-f, CL-63).

**Run order inside this file:** CL-27 → CL-30, then CL-34 → CL-37, then CL-31 → CL-33 last (they shift `qa-CL-01`'s first sessions into the past, after which the class is under way and the leave rule changes).

## CL-27 — Enrol on time [local]

**Steps:**

1. As B2 (London), open H2's page → Classes → `qa-CL-01`'s batch card. Read it (start label, weekday pattern, seats left, free-cancellation line).
2. **Enrol in this batch** → checkout. Read the price, the sessions, the dates in London time, the cancellation note.
3. Pay (mock).
4. As H2, open the class's Participants.

**Expect:**

- Card: "Starts Mon <date> · Mondays…" or "Varies" (two weekdays; record), "5 seats left" style count, the free-cancellation line.
- Checkout: price ₹1,000 for all 8 sessions; note "Cancel at least 24 hours before it starts and the seat is refunded in full. Inside that window the seat cannot be refunded."
- DB: B2 `CONSULTEE` participant `CONFIRMED` (after capture), `sessionsPurchased = 8`; R-04 `Payment` `SUCCEEDED` ₹1,000 (+ tax), earnings for H2 with the class hold (24 h after each session or per the money rules; 08 checks).
- B2's Appointments lists the class with 8 sessions in London time (Mon 12:30, Thu 12:30… per CL-01's times).

**Cross-check:** H2's Participants and Offerings seats (1/5); B2's Payments; bells and outbox.

**Probe further:** does B2 see all 8 dates before paying? Which date does "Starts" use: the first session in B2's zone or H2's?

## CL-28 — Cross-zone buyers see their own calendar dates

**Steps:** as B3 (LA) and DR (Sydney), buy seats on `qa-CL-01` [local]. Compare their session lists with H2's.

**Expect:** Mon 18:00 IST = Mon 04:30 LA = Mon 23:30 Sydney; Thu 18:00 IST = Thu 04:30 LA. Each list shows the viewer's zone; no list shows IST to a non-IST buyer.

**Probe further:** the batch card says "Mondays" (host weekday). For a buyer in a zone where the session falls on another calendar day, is "Mondays" still right? (Try a Tue 07:00 IST session: Monday 17:30 in LA.)

## CL-29 — Enrolling twice; a consultant or co-host can't enrol

**Steps:**

1. As B2, enrol in `qa-CL-01` again.
2. As H2, open checkout for `qa-CL-01` and submit.

**Expect:** 1 → 409 `ALREADY_REGISTERED`, "You are already enrolled in this class". 2 → 409 `SELF_BOOKING`, "You cannot book your own plan."

## CL-30 — Capacity and the waitlist (basics)

**Setup:** set `qa-CL-01`'s Max participants to the current seat count (e.g. 3 after CL-27/28).

**Steps:**

1. As B4, open the batch card and checkout.
2. Join the waitlist (if offered).
3. Set Max participants to 2 (below 3 seated).

**Expect:**

- 1 → "Sold out" state; checkout → 409 `EVENT_FULL` ("Class is full").
- 2 → an `AppointmentWaitlist` row (rules as WE-22).
- 3 → 400 "Cannot set capacity to 2 — 3 people are already registered. Remove participants first."

**Probe further:** races on the last seat are 09's; waitlist notices as WE-23.

## CL-31 — Late join pays only for the sessions left [local]

**Why it matters:** decision #1819: a late joiner pays floor(price × remaining ÷ N) and their seat records that count.

**Setup:** `qa-CL-01` with `lateJoinUntilSession = 3`. Owner-approved: shift sessions 1 and 2 into the past (keep them on the half hour; mark them `COMPLETED`), so session 3 is next and in the future.

**Steps:**

1. As B4, open the batch card and checkout. Read the price and the sessions line.
2. Pay.

**Expect:**

- Price: ⌊100000 × 6 ÷ 8⌋ = 75000 paise = ₹750 (+ tax). A sessions line "Sessions 3–8 of 8".
- DB: B4's seat `sessionsPurchased = 6`; `Payment.amount` matches.
- B4's session list shows sessions 3–8 only (record whether 1–2 appear as "before you joined").

**Probe further:**

- Does the public page explain late join before checkout (the editor's "A late joiner pays only for the sessions left.")?
- Shift session 3 into the past while B4's checkout page is open, then pay: 409 `CLASS_PRICE_CHANGED`, "A session of this batch started while you were checking out, so its price has changed. Please review the new price and try again. You have not been charged."

## CL-32 — Enrolment closes after the cutoff

**Setup:** continue CL-31: shift session 3 into the past too (next is session 4; cutoff is 3).

**Steps:** as DR (or any buyer without a seat), open the batch and try to enrol; then try the waitlist.

**Expect:** checkout → 409 `ENROLMENT_CLOSED`, "Enrolment for this batch has closed. Please choose a batch that has not started yet." Waitlist join → the same code. The card shows the batch as running/closed (record), and "Past batches" collapse finished ones.

**Probe further:** "choose a batch that has not started yet" — is there one? If the plan has a single batch, the advice leads nowhere. **MISSED-OPPORTUNITY**.

## CL-33 — Late joiners and past recordings

**Setup:** `qa-CL-01` with recording on, session 1 recorded (if you can produce a recording; else mark BLOCKED). B4 late-joined (CL-31).

**Steps:**

1. With **Share past recordings with members who join late** off, as B4 open the class recordings.
2. Turn it on (H2's editor). Reload as B4.

**Expect:** off → B4 sees no recording from sessions 1–2; on → B4 sees them. On-time buyers always see them.

**Probe further:** does B4 see recordings of **other batches** of the same plan? (They must not.)

## CL-34 — A class that isn't fully scheduled can't be bought

**Setup:** `qa-CL-22` (partially scheduled, CL-22).

**Steps:** as B1, open its batch and checkout.

**Expect:** refused: "This class is not fully scheduled yet (<k> of 12 sessions). Enrollment opens once all sessions are scheduled." Record the HTTP status and code; a 500 is **ERROR-HANDLING** (P2).

**Probe further:** does the public page show the class as bookable while checkout refuses? **INCONSISTENCY** if so.

## CL-35 — Leave before the class starts, outside the window [local]

**Steps:**

1. As B3, open `qa-CL-01` (first session more than 24 h away, nothing delivered). Open the leave dialog; read it.
2. Leave.

**Expect:**

- Dialog: title "Leave class?" (record), a line quoting the full refund, "Stay enrolled".
- DB: seat released/`REFUNDED`; `Refund` = full seat amount under `seat-leave:<participantId>`; seats left +1; waitlisted users notified.

**Cross-check:** B3's Payments; H2's Participants and Earnings.

## CL-36 — Inside the window before the first session: can't leave

**Setup:** owner-approved: shift `qa-CL-01`'s first upcoming session to 10 h from now (no session delivered yet for this test: use a fresh class `qa-CL-36` with B1 seated if CL-31 already completed sessions).

**Steps:** as the buyer, try to leave.

**Expect:** 409 `REFUND_WINDOW_CLOSED`, "Free cancellation ended 24 h before the start — this seat can no longer be refunded." The seat stays. The note says "The free-cancellation window for this class closed; a cancellation now refunds nothing on this seat."

**Probe further:** the note implies a ₹0 cancel; the server refuses the cancel. **INCONSISTENCY** (P2), same as WE-47.

## CL-37 — A longer host window and its snapshot on the seat

**Steps:**

1. As H2, create `qa-CL-37` via `evaluate_script` with `refundWindowHours: 72` (the editor has no field). Buy a seat as B4 [local].
2. Owner-approved: set the plan's `refundWindowHours` to 24 afterwards (simulating a later edit), and shift the first session to 48 h away.
3. As B4, try to leave.

**Expect:** the seat keeps the window it was sold under (72 h), so the leave is refused ("Free cancellation ended 72 h before the start…"). Record whether the checkout note showed "3 days".

**Probe further:** the editor offers no window control for classes or webinars. Note it once (see WE-48).
