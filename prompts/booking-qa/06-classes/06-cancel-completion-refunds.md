# 06-f · Classes: leaving mid-series, cancelling the class, completion and class-end refunds

**Needs:** `qa-CL-51` (16 sessions, ₹1,600, B2 and B3 seated) or a fresh sold class per case; owner-approved clock shifts; **[local]** for refunds; **[sweep]** for completion (`auto-complete-appointments`, `retry-auto-refunds`).
**Personas:** H2 (IST) host; B2 (Europe/London), B3 (America/Los_Angeles), B4 (IST, late joiner) learners; ST.
**Docs under test:** `docs/decisions/2026-09-25-class-series-money-rules.md`; decision 9 of the scheduling ADR (class-end refunds); `lib/payments/operations/cancellation-policy.ts` (`quoteClassSeatRefund`); `lib/booking/class-series.ts` (`seriesCancelRefundPaise`, `classEndRefundPaise`, `CLASS_END_REFUND_KEY_PREFIX`); `lib/payments/operations/event-refunds.ts`; `docs/booking/08-cancellation-flow.md`.

Money depth (GST credit notes, collaborator splits, gateway failures) is 08's (`MO-`); sweep batching and retries are 12's (`SW-`).

**Unit:** a seat's per-session value = ⌊seat paid ÷ sessions the seat bought⌋ (`sessionsPurchased`; N for an on-time seat). For ₹1,600 / 16 that is ₹100 (10000 paise).

## CL-63 — Leave a class that is under way: each remaining session at its own tier [local]

**Why it matters:** mid-series leaves are priced session by session, not by one tier.

**Setup:** `qa-CL-51` with sessions 1–4 delivered (owner-approved: shift into the past, `COMPLETED`), session 5 at 10 h from now (50% tier), sessions 6–16 more than 24 h away, nothing refunded yet for B3, never moved.

**Steps:**

1. As B3, open the leave dialog. Read the line ("Leaving now refunds <amount> for the <n> remaining sessions." style).
2. Compute: 11 sessions × ₹100 × 100% + 1 session × ₹100 × 50% = ₹1,150.
3. Leave.

**Expect:**

- `GET …/cancel/preview?scope=seat` quotes 115000 paise; the dialog shows ₹1,150 and "12 remaining sessions".
- DB: B3's seat released/`REFUNDED`; `Refund` 115000 under `seat-leave:<participantId>`; seats left +1.

**Probe further:**

- If session 5 had been **moved** by the host after B3 bought (CL-41), it refunds at 100% (a host move waives the window): verify on a moved copy.
- Does the dialog explain why it isn't the full ₹1,200 for 12 sessions? **MISSED-OPPORTUNITY** if not.

## CL-64 — No leave after the last session has started

**Setup:** a class whose last live session started 10 minutes ago (owner-approved shift).

**Steps:** as a seated learner, try to leave.

**Expect:** refused (record status, code and copy). `docs/booking/08` says class self-leave is refused only after the last live session has started; anything earlier is allowed.

## CL-65 — The host cancels the whole class mid-series [local]

**Why it matters:** each seat gets back everything not yet delivered.

**Setup:** `qa-CL-65`: 8 sessions, ₹800, B2 and B4 seated (B4 late-joined with `sessionsPurchased = 6`, paid ₹600), sessions 1–3 delivered.

**Steps:**

1. As H2, **Cancel booking** on the class. Read the dialog.
2. Confirm.

**Expect:**

- Refund per seat = seat paid − unit × delivered sessions the seat held: B2 = 80000 − 10000 × 3 = 50000 (₹500); B4 = 60000 − 10000 × 1 = 50000 (₹500; B4 held only session 3). Via the whole-event door, one `Refund` per payment.
- DB: `Class.status = CANCELLED`; future occurrences `CANCELLED`; delivered ones stay `COMPLETED`.
- Both learners notified.

**Probe further:** the dialog copy for events is "Cancelling this event refunds all <n> attendees in full — ₹<x> in total." For a class mid-series the refund is **not** "in full". If the dialog says "in full", report **FALSE-INFO** (P1: money copy). Does ₹<x> equal ₹1,000?

## CL-66 — Cancel a free class

**Steps:** as H2, cancel a free class with one learner.

**Expect:** "Nobody has paid for a seat yet, so cancelling refunds nothing." (or the free-event variant); no `Refund`; the learner notified.

## CL-67 — A class completes normally [sweep]

**Setup:** a sold class with every session in the past and `COMPLETED` (owner-approved shifts), all N placed.

**Steps:** run `auto-complete-appointments`; then read both sides.

**Expect:** `Class.status = COMPLETED`; no refund; H2's earnings move toward release (24 h class hold per session; 12 owns the job). Learners can leave feedback (`POST /api/appointments/[aid]/feedback`, one per occurrence).

**Verification SQL:** R-03; `SELECT status FROM "Class" WHERE id = :cid;`; R-04 earnings.

## CL-68 — A class completes with sessions sold but never placed: per-seat refund [sweep] [local]

**Why it matters:** decision 9: "A class that completes with sessions sold but never placed refunds each seat for them."

**Setup:** a sold class `qa-CL-68` (8 sessions, ₹800, B2 on time, B4 late-joined with `sessionsPurchased = 6` paying ₹600). Owner-approved: tombstone the last 2 occurrences (`deletedAt = now()`) so only 6 were ever placed; shift the remaining 6 into the past, `COMPLETED`.

**Steps:**

1. Run `auto-complete-appointments` (NEEDS-OWNER-RUN on a preview).
2. Read both payments. Then run `retry-auto-refunds`.

**Expect:**

- At completion: each seat's `Payment.refundOwedKey = class-end:<classId>:pay:<paymentId>` and `refundOwedPaise` = ⌊paid × unplaced ÷ sessionsPurchased⌋ minus earlier class-end refunds: B2 = ⌊80000 × 2 ÷ 8⌋ = 20000 (₹200); B4 = ⌊60000 × 2 ÷ 6⌋ = 20000 (₹200). Earnings stay held while the marker is open.
- After the retry sweep: `Refund` rows for those amounts; markers cleared; earnings released for the delivered share.
- `Class.status = COMPLETED`.

**Verification SQL:** R-04 for the class appointment (both payments, refunds, earnings holds).

**Probe further:** what do the learners see? Is the refund explained ("2 sessions were never scheduled")? Compare with the subscription's "Plan ended · N sessions were not held." line.

## CL-69 — A legacy seat without `sessionsPurchased` gets no class-end refund

**Setup:** CL-68's setup on a fresh class; owner-approved: set B2's `AppointmentParticipant.sessionsPurchased = NULL` before completion.

**Steps:** complete the class as in CL-68.

**Expect:** no `class-end:` marker for B2 (documented: a legacy seat has no unit). B4's marker as before.

**Probe further:** is the legacy seat flagged anywhere for ops? Silent zero refunds deserve a line in the report.

## CL-70 — Completion waits for another door's refund on the same payment

**Setup:** CL-68's setup, plus a pending refund-owed marker from another door on B2's payment (owner-approved: set `refundOwedKey = 'occ:<x>:pay:<B2 payment>'`, `refundOwedPaise = 10000`).

**Steps:** run `auto-complete-appointments`.

**Expect:** the class stays uncompleted (or B2's seat holds completion) until that marker clears; no class-end marker overwrites the first. After clearing the first marker (owner-approved or via `retry-auto-refunds`), completion proceeds.

**Probe further:** report the job's output counts (waiting vs completed).

## CL-71 — Every surface agrees on a class's end state

**Steps:** after CL-67 and CL-68, visit H2's Appointments (Past), the class detail, Offerings (batch under "Past batches"), Earnings; B2's and B4's Appointments and Payments; ST's class-series view.

**Expect:** the same status and session counts everywhere; refunds visible to the right learner only; times in each viewer's zone.

## CL-72 — The host cancels a class before it starts: every seat in full [local]

**Steps:**

1. On a sold class with no session delivered (B2 and B3 seated, ₹800 each), as H2 open **Cancel booking**. Read the dialog.
2. Confirm.

**Expect:**

- Dialog "Cancelling this event refunds all 2 attendees in full — ₹1,600 in total." (here "in full" is true).
- DB: `Class.status = CANCELLED`; all occurrences `CANCELLED`; two `Refund` rows of 80000 each through the whole-event door; earnings reversed; waitlist rows expired.
- Learners notified; the public batch card disappears or shows cancelled.

**Probe further:** record whether a reliability strike or `class-reliability` event is written for a host cancelling a whole class. Compare with WE-42.

## CL-73 — A session refunded on its own is not refunded again at class end [sweep] [local]

**Why it matters:** two doors (per-session settlement and class-end) must never pay for the same session.

**Setup:** a sold class (8 sessions, ₹800, B2 seated). Cancel session 4 (no make-up) and let the 14-day settlement refund B2 one unit (CL-56; owner-approved `hostCancelledAt` shift + `settle-cancelled-sessions`). Tombstone the last occurrence (owner-approved) so one session was never placed. Shift the rest into the past, `COMPLETED`.

**Steps:** run `auto-complete-appointments`, then `retry-auto-refunds`.

**Expect:**

- B2's refunds: one `occ:<session 4>:pay:<payment>` of 10000 (earlier) and one `class-end:<classId>:pay:<payment>` of ⌊80000 × 1 ÷ 8⌋ = 10000 for the never-placed session only. Session 4 (a placed, cancelled row) is not in the class-end count.
- Σ refunds = 20000 ≤ 80000; money invariants in R-04 hold.

**Probe further:** if the class-end refund came out as 20000 (counting session 4 again), report **DATA-INTEGRITY** (P0).

## CL-74 — Folder cleanup

**Steps:** cancel through the product every `qa-CL-` class still scheduled; archive their plans; remove collaborator rows you created; R-09 for mock-payment rows only, with owner approval; restore H2/H3/H4 availability and profile zones (R-01, R-02).

**Expect:** a ledger of every id with its cleanup status. R-05 for H2, H3 and H4 → zero rows.
