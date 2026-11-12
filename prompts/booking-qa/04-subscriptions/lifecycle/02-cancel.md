# 04-g · Subscriptions: cancelling a whole plan

**Needs:** purchases from 04-c/04-d. **[local]** for refunds to complete (mock payments); on a preview the cancel commits and the refund row stays `PENDING` or fails at the gateway (record which). Owner-approved clock shifts.
**Personas:** B1 (IST), B2 (London), B3 (LA), B4/DR (Wipro), H1 (IST), ST.
**Docs under test:** `docs/booking/08-cancellation-flow.md` ("How the amount is computed", "Refund Quote Binding and Durability"), `lib/payments/operations/cancellation-policy.ts` (`quoteBookingRefund`, subscription arm `quoteUnusedSessions`), `lib/booking/session-window.ts`.

Money depth (credit notes, GST, earnings reversal maths, gateway failures) is 08's (`MO-`). Here we check that each cancel journey quotes the right number, charges the number it quoted, and that every dashboard agrees.

**The subscription refund rule (code):** every session the plan sold is in one of four groups: delivered (refunds 0), scheduled (refunds at its own notice tier), never scheduled (infinite notice → 100%), or removed by a support refund (already paid back). Platform tiers: ≥ 24 h → 100%, 2–24 h → 50%, < 2 h → 0%; an expert or platform cancel → 100% for every undelivered session.

refund = Σ over tiers ⌊ P × n_tier × pct_tier ÷ (sessionsTotal × 100) ⌋, minus anything already refunded on single sessions, clamped to the refundable balance. The dialog's percentage is that refund ÷ the undelivered share.

> [!NOTE]
> `docs/booking/08-cancellation-flow.md` "How the amount is computed" still describes the older rule (prorate by slots, then one tier from the next session). The code tiers each session. Report this as **DOC-DRIFT** once, quoting both.

The cancel journey: plan menu → cancel → `CancelConfirmationDialog` (it calls `GET /api/appointments/[aid]/cancel/preview`) → confirm → `POST /api/appointments/[aid]/cancel` with `expectedRefundPaise` = the shown quote. The refund runs under `dedupeKey` `cancel:<appointmentId>:<paymentId>`, with a `refundOwedKey` stamped in the cancel transaction and cleared when the refund lands. After every cancel: R-03, R-04, money invariants.

## SU-72 — Cancel a paid plan before any session is scheduled

**Why it matters:** a buyer who changes their mind before the expert schedules anything must get everything back.

**Setup:** a fresh purchase: B1 buys SU-01's plan starting in 3 days [local]. Price P. Nobody allocates.

**Steps:**

1. As B1, open the booking. Open the cancel dialog. Read every line.
2. Confirm.
3. As H1, open Requests and Home.

**Expect:**

- Preview: refund = P (all 12 sessions never scheduled → 100%), `refundPct` 100.
- Dialog: "You paid ₹<P>" and a refund line naming the card rail and the full amount (record exact text). Buttons "Keep booking" / "Cancel and refund".
- API: cancel → 200 with a `refund` object (record fields). DB: `Subscription.status = CANCELLED`, `cancelledAt`, `cancelledBy` = B1; placeholder appointment kept (never deleted); R-04: one `Refund` for P, reason naming the cancel, `dedupeKey = cancel:<aid>:<pid>`; `Payment.refundOwedKey` cleared after the refund lands; earnings `REFUNDED` or reversed in full.
- Toast: "A refund of ₹<P> (100%) is on its way back to you."
- H1: the request disappears from Requests; a bell and an email that B1 cancelled (R-07).

**Cross-check:** consultee Payments (refund row), consultant Earnings (reversal), staff refunds console. Both parties see `Cancelled`.

**Probe further:**

- Does H1's notice say whether H1 is affected (no strike for a buyer cancel)?
- Cancel twice (double click): one cancel, one refund. Depth in 09.

## SU-73 — Cancel mid-plan: each session at its own tier

**Why it matters:** the quote mixes tiers; it must be exact and equal to the charge.

**Setup:** B3's plan (SU-37) or a fresh 12-session purchase at price P. Place weeks 1 and 2 (6 sessions). Then ask the owner to approve:

```sql
BEGIN;
-- two week-1 sessions delivered: move into the past and complete
UPDATE "AppointmentOccurrence" SET "startsAt" = now() - interval '48 hours', "endsAt" = now() - interval '47 hours',
  "completionStatus" = 'COMPLETED' WHERE id IN (:occ1, :occ2) RETURNING id;
-- third week-1 session 10 hours away (50% tier); keep it on a UTC half hour
UPDATE "AppointmentOccurrence" SET "startsAt" = :tenHoursAheadOnHalfHour, "endsAt" = :tenHoursAheadOnHalfHour + interval '1 hour'
  WHERE id = :occ3 RETURNING id;
COMMIT;
```

The other 3 sessions stay more than 24 h away; 6 sessions were never scheduled.

**Steps:**

1. As B3, open the cancel dialog. Read the quote and the percentage.
2. Compute the expected number yourself.
3. Confirm.

**Expect:**

- Groups: delivered 2; scheduled 1 at 50% + 3 at 100%; never scheduled 6 at 100%.
- refund = ⌊P × (6 × 100 + 3 × 100 + 1 × 50) ÷ 1200⌋ = ⌊P × 950 ÷ 1200⌋ (per-tier floors may make it 1–2 paise lower). For P = 120000 paise (₹1,200): ₹950.00. The undelivered share is P × 10 ÷ 12 = ₹1,000, so the dialog shows 95%.
- The `Refund.amountPaise` equals the dialog's number exactly. All 4 future occurrences `CANCELLED`; the 2 completed stay `COMPLETED`.

**Cross-check:** B3's Payments shows the refund in rupees; H1's Earnings shows the reversal; the plan reads `Cancelled` on both sides; H1's calendar frees the 4 times (R-05, and the heat map shows them free).

**Probe further:**

- Does the dialog explain the mix ("1 session inside 24 hours refunds 50%")? A single "95%" with no reason is **MISSED-OPPORTUNITY**.
- Is "You paid" the full P even though 2 sessions were delivered?

## SU-74 — The expert cancels the whole plan

**Why it matters:** the buyer did nothing wrong; every undelivered session refunds in full, and the expert gets a strike.

**Setup:** same state as SU-73 on a fresh purchase by B2 (or B1), price P.

**Steps:**

1. As H1, open the appointment menu → **Cancel booking**. Read the dialog.
2. Confirm.

**Expect:**

- Dialog: "<client> gets a full refund of ₹<amount>. Cancelling a paid booking counts against your reliability." with amount = ⌊P × 10 ÷ 12⌋ (all 10 undelivered at 100%).
- DB: refund as quoted; `Subscription` `CANCELLED`, `cancelledBy` = H1. A strike for H1: `SystemEvent` with `correlationId = 'expert-reliability:<H1 cid>'`, one new row (record `context.strike`).
- The buyer gets a bell and an email.

**Cross-check:** buyer's Payments and booking; H1's Earnings; staff. The buyer's copy says the expert cancelled (not "you cancelled").

**Probe further:** if H1's real goal was to skip one session, this was their only door (SU-71). Does the dialog say the whole plan ends?

## SU-75 — Quote changed between opening the dialog and confirming

**Why it matters:** the refund charged must be the refund shown.

**Setup:** a plan in SU-73's state, dialog not yet confirmed.

**Steps:**

1. As the buyer, open the cancel dialog; note the quote Q1 (with the 50% session at 10 h).
2. Owner-approved: move that session to 1.5 h from now (crosses into the 0% tier).
3. Click confirm in the still-open dialog.
4. Read what happens. Confirm again.

**Expect:**

- Step 3: 409 `REFUND_QUOTE_CHANGED` with the current quote Q2 (lower by ⌊P × 50 ÷ 1200⌋); nothing committed.
- The dialog re-quotes and shows Q2 (`applyRefundRequote`).
- Step 4: refund = Q2 exactly.

**Probe further:** does the dialog say *why* the number changed? A silent swap of the amount is **MISSED-OPPORTUNITY** (P2).

## SU-76 — Cancel an org-funded plan: the refund returns to the org

**Why it matters:** org money reverses in-ledger; a gateway call on an `org_` intent reverses nothing.

**Setup:** SU-31's plan (Wipro-funded) with week 1 placed.

**Steps:**

1. As the learner, open the cancel dialog. Read the payer sentence and the refund line.
2. Confirm.
3. As OS, open the org's money view.

**Expect:**

- Dialog: "You paid" is replaced by a sentence naming Wipro as the payer (record it); the refund line says the money goes back to the organisation.
- DB: `Refund` row(s) on the `org_` payment; no gateway refund id; the wallet credited (WALLET) or the accrual reversed (INVOICE); `refundOwedKey` cleared.
- UI (OS): the spend drops by the refund.

**Cross-check:** learner's Payments shows no card refund; staff sees an internal-rail refund.

**Probe further:** does the learner's toast say "on its way back to you" for money that goes to Wipro? **FALSE-INFO** (P2) if so.

## SU-77 — No cancel inside 15 minutes or during a session

**Why it matters:** a session under way is settled from what happened, not by cancelling.

**Setup:** a plan with one session shifted (owner-approved) to start 10 minutes from now, others later.

**Steps:**

1. As the buyer, open the cancel dialog.
2. Try to confirm (or replay the POST).
3. As H1, try **Cancel booking**.

**Expect:**

- Buyer: 409 `SESSION_IN_PROGRESS`, "This session starts in less than 15 minutes or is already under way, so it can't be cancelled now. If something goes wrong, report a problem from the booking after it ends." The dialog shows it before confirm (from the preview) or after.
- Expert: same code, host copy "This session is in progress — end the call and we'll settle it from what happened."
- DB: nothing changed.

**Probe further:** after the session ends (shift it into the past), cancel works and that session counts as delivered (or `UNVERIFIED`) in the quote, never refunded.
