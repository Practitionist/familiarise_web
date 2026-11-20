# 08-a · Money: checkout front doors, holds and what a charge writes

**Needs:** 01 fixtures (F-AV1, F-PL1, F-PL2, F-PL3), local `next dev` for every `[local]` case. Folder queries MQ-1…MQ-5 are in [README.md](README.md).
**Personas:** B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), B4 (Wipro, IST), H1, H2, OX, AD.
**Docs under test:** `docs/booking/` (money and lifecycle pages), `.claude/skills/booking/references/*`, `lib/payments/constants.ts` (hold windows), `lib/payments/payouts/constants.ts` (fee and hold hours).

Journeys are owned elsewhere (CO-01, SU-23, WE-19, CL-27, TR-04, CO-25). These cases assert the **money rows** each front door writes and what each money surface says about them.

## MO-01 — A mock-paid consultation writes one complete money graph `[local]`

**Why it matters:** every later refund, payout and invoice reads these rows; a missing leg or journal breaks money silently.

**Setup:** none beyond S-08 (H1 60 min, ₹500).

**Steps:**

1. As B1 (IST) book S-08 at Wed D+2 09:00 IST (03:30Z) from `/explore/experts/[H1]` and finish with **Mock Pay**.
2. Record the `POST /api/checkout` request body (`clientIdempotencyKey`, `isMockPayment`) and response (`appointmentId`, `isMockPayment`, `amount`).
3. Run R-03, R-04 and MQ-1 for the appointment.

**Expect:**

- `Payment`: one row, `paymentStatus = SUCCEEDED`, `isMockPayment = true`, `capturedAt` set, `clientIdempotencyKey` not null, `amount` = what the checkout page showed as the total, `originalAmount` = list price before discounts, `taxAmount` recorded (write down whether ₹500 is GST-inclusive or GST is added on top), `platformFeeBps` set (record; default fee is 20 %).
- MQ-1: exactly one `PaymentLeg` (`CARD`), exactly one `LedgerTransaction` with `idempotencyKey = 'booking:<paymentId>'`, one `ConsumerInvoice` whose `totalPaise = amount` and whose CGST+SGST or IGST split matches B1's state code.
- `ConsultantEarnings`: one row, `status = PENDING`, `grossAmount = originalAmount`, `platformFeePaise + consultantSharePaise = grossAmount`, `refundedShareAmount = 0`, `holdUntil = max(capturedAt, session end) + 24 h` (+7 days if H1 counts as a new expert: first paid earning younger than 30 days or lifetime share under ₹50,000; record which).
- No `Refund` row; `refundOwedKey` null.

**Cross-check:** B1 Payments page lists one charge of the same amount with "View receipt"; H1 Earnings shows the booking under the bucket described as "Clears after your sessions and the hold"; staff `/dashboard/staff/payments/[paymentId]` shows the same amount, status and legs. Convert every timestamp to IST for B1 and H1.

**Probe further:** does any surface show paise, a raw `pay_mock_…` intent or an ISO time? Does the receipt name GST correctly (GSTIN, place of supply)? Is the 20 % fee explained to H1 anywhere before the first booking?

## MO-02 — `isMockPayment: true` is ignored outside local development

**Why it matters:** a preview or production that honoured the flag would hand out free bookings.

**Setup:** deploy preview. B3 signed in.

**Steps:** from B3's signed-in page, `evaluate_script` a `POST /api/checkout` with CO-01's body shape for S-08 at Thu D+3 18:00 IST (12:30Z), `isMockPayment: true` and a fresh `clientIdempotencyKey`.

**Expect:** the response does **not** carry `isMockPayment: true` and contains a gateway order (`orderId` / `clientSecret`) instead. R-04: the payment is `PENDING`, `isMockPayment = false`, `expiresAt ≈ now + 30 min`. No `ConsultantEarnings`. Then release it with `DELETE /api/checkout/pending/[paymentId]` (the abandon door): payment `EXPIRED`, tentative occurrence released, R-05 zero rows.

**Cross-check:** H1's grid shows 18:00 Thu as free again after the release (and while PENDING, as held).

**Probe further:** what does B3's Payments page show for the PENDING row and after the release: "Payment pending", nothing, or a failed charge? An abandoned checkout should not look like a failed payment.

## MO-03 — A subscription purchase holds earnings for 7 days after the last session `[local]`

**Why it matters:** subscription earnings release late on purpose; an early release pays out money a later prorated refund needs.

**Setup:** reuse SU-23's purchase (B1, H1 weeks plan) if it exists; otherwise buy it now with Mock Pay.

**Steps:** R-04 and MQ-1 right after purchase (no sessions placed yet), then again after H1 places week 1 (SU-35).

**Expect:**

- At purchase: one `Payment` `SUCCEEDED`; one placeholder `Appointment` linked to the `Subscription`; earnings `PENDING` with `holdUntil` anchored on capture (no occurrences yet) + 168 h, or null until sessions exist (record which).
- After allocation: `holdUntil` moves to the **last live occurrence end** + 168 h (`computeHoldUntil`). Record the before and after values.

**Cross-check:** H1 Earnings and the staff Earnings tab show the same release date; convert to IST.

**Probe further:** after a session is returned (SU-68) or rescheduled later, does `holdUntil` follow the new last session? A hold that never moves is a P1 money finding.

## MO-04 — Webinar seat checkout: a 15-minute seat hold, then CONFIRMED `[local]`

**Why it matters:** seats count toward capacity while held; a hold that outlives its window blocks buyers, one that ends early oversells.

**Setup:** F-PL2a webinar (90 min, 5 seats, priced) published by WE-05.

**Steps:**

1. As B2 (London) start the seat checkout and stop before paying. R-04 + seat row (`AppointmentParticipant`).
2. Complete with Mock Pay.

**Expect:** step 1: `Payment` `PENDING` with `expiresAt ≈ now + 15 min` (12-min gateway window + 3-min capture grace, `SEAT_CHECKOUT_HOLD_MS`); seat `HELD`; capacity counter shows the seat taken. Step 2: payment `SUCCEEDED`, seat `CONFIRMED`, earnings `holdUntil = webinar end + 48 h`.

**Cross-check:** H2's webinar card count, B2's appointments (time in London), B2's Payments row.

**Probe further:** what does a third buyer see while B2's seat is `HELD` with the room at 4 of 5? Is "1 seat left" honest when one seat is only held? Deep race: CC-02.

## MO-05 — A class seat pays for the sessions it buys `[local]`

**Why it matters:** class refunds are per session; the seat must record how many sessions it bought.

**Setup:** F-PL2c class, fully scheduled (CL-14).

**Steps:** as B3 (Los Angeles) enrol with Mock Pay. R-03 participant row, R-04, MQ-1.

**Expect:** seat `CONFIRMED` with `sessionsPurchased = N` (the class total); `Payment.amount` = the price shown; earnings `holdUntil = last session end + 24 h`. For a late join, use CL-31's purchase and check `sessionsPurchased` = sessions left and `amount` = the pro-rata price CL-31 recorded.

**Cross-check:** B3's Payments row names the class (not a raw id); H2's Earnings "By offering" shows the class.

**Probe further:** does B3's receipt list sessions or just "Class"? A refund later is "per session": can B3 work out a session's value from anything shown?

## MO-06 — Approval pay link: the pre-minted payment and its window

**Why it matters:** the link's own `expiresAt` decides when the time frees; a wrong window lets the time sit held or lapse too early.

**Setup:** CO-25's approved request (`APPROVED_PENDING_PAYMENT`). Paying needs Razorpay test mode or an owner webhook replay (no Mock Pay on `/checkout/pay/[paymentId]`); this case only reads.

**Steps:** R-04 for the appointment; record `Consultation.pendingPaymentUrl` and the session start.

**Expect:** one `PENDING` payment created at approval; `expiresAt = min(approval + 24 h, session start − 15 min)` (`payWindowEnd`); the occurrence tentative. No earnings, no invoice yet.

**Cross-check:** B1's "pay to confirm" widget states a deadline equal to `expiresAt` in IST; H1's row shows "Remind" until the link lapses (CO-33/CO-34).

**Probe further:** the Booking settings copy promises "the pay link stays open for 24 hours"; with a session 10 h away, compare against `expiresAt` (FALSE-INFO P2 if it disagrees). Paying: CO-32. Lapse: CO-36 and SW-05.

## MO-07 — Trial pay link: payment row and its one deadline

**Why it matters:** one rule computes a trial's pay deadline (`payWindowEnd`: 24 hours, never later than 15 minutes before the session), for the trial row and the order alike.

**Setup:** TR-04's held paid trial (B1, ₹100).

**Steps:** read `Trial.paymentDueAt`, `Payment.expiresAt`, the occurrence `startsAt`, and the deadline sentence on `/checkout/plans/trial/[trialId]`.

**Expect:** record all three times. `Payment.expiresAt` and `paymentDueAt` should agree; if they differ, report which one the page shows and which one `expire-unpaid-trials` uses (SW-18). Amount `10000` paise plus tax as shown.

**Probe further:** is the deadline shown in B1's zone? Does the page say what happens to the held time when the deadline passes?

## MO-08 — Nothing to charge: free plans and fully covered orders never touch the gateway

**Why it matters:** gateways reject amounts ≤ 0; a ₹0 row that looks like a charge confuses users and refund logic.

**Setup:** preview OK for the free plan; `[local]` for credits.

**Steps:**

1. Reuse CO-07's free booking (B4, S-09). R-04.
2. If B1 has referral credits ≥ the S-08 price (`ReferralCredit` rows; check by SQL), book S-08 with `useReferralCredits: true`. Otherwise mark step 2 BLOCKED (no credits) and don't seed credits.

**Expect:** step 1: either no `Payment` or one with `amount = 0` (record; zero-amount orders mint a `free_…` intent). Step 2: response `isZeroAmountPayment: true`; `Payment.amount = 0`, `paymentIntent` starts `free_`, a `REFERRAL_CREDIT` leg, `SUCCEEDED` at once. Neither creates a `Refund` row, ever (MO-34 cancels them).

**Cross-check:** B4/B1 Payments page: is a ₹0 row shown, and does it say "Applied at checkout" (credits) or nothing? H1 Earnings for a credit-funded booking: record what H1 earns (credits are platform money; H1 should still be paid).

**Probe further:** does any screen say "Payment successful" for ₹0? Is "free" worded the same on the expert page, checkout and confirmation?

## MO-09 — A discount code lowers the charge, and the refund basis follows the charge `[local]`

**Why it matters:** a refund computed on the list price pays out money nobody paid.

**Setup:** find an active code: `SELECT code, "discountType", "discountValue", "maxUses", "currentUses", "expiresAt", "maxDiscount" FROM "DiscountCode" WHERE "isActive" AND ("expiresAt" IS NULL OR "expiresAt" > now()) AND ("maxUses" IS NULL OR "currentUses" < "maxUses") LIMIT 3;`. Prefer a PERCENTAGE code. If none, BLOCKED (don't create one).

**Steps:**

1. As B2 open S-08's checkout for Fri D+4 09:00 IST, enter the code, read the totals, Mock Pay.
2. R-04; re-read the `DiscountCode` row.
3. Cancel with ≥ 24 h notice (preview first, then confirm).

**Expect:** `Payment.discountCodeId` set; `originalAmount` = list; `amount` = list − discount (capped by `maxDiscount`) plus tax as shown; `currentUses` +1 exactly once. The cancel quote and the `Refund.amountPaise` equal 100 % of `amount`, not `originalAmount`. Earnings: record whether `grossAmount` uses `originalAmount` (code: it does) and whether `consultantSharePaise` is cut by the discount; then report who bears the discount (platform or expert) and whether the earnings reversal on refund is proportional to what was refunded.

**Probe further:** apply an expired or used-up code: a typed refusal with copy that names the problem. Apply the code, go back, change the time, return: is the discount still applied once? Does `currentUses` move when the checkout is abandoned?

## MO-10 — Welcome discount on a first booking `[local]`

**Why it matters:** a welcome discount is money the platform gives up; refunds must not return it as cash.

**Setup:** a buyer who has never paid (check: `SELECT count(*) FROM "Payment" WHERE "userId" = :uid AND "paymentStatus" = 'SUCCEEDED'` = 0). If none of B1–B4 qualifies, BLOCKED.

**Steps:** book S-08 with Mock Pay; R-04; cancel at ≥ 24 h.

**Expect:** `welcomeDiscountPaise` set and shown on checkout as a line; the refund equals what was charged (`amount`), not `amount + welcomeDiscountPaise`. A second booking by the same buyer gets no welcome discount.

**Probe further:** after the refund, is the welcome discount usable again? Record what the code does and whether any copy tells the buyer.

## MO-11 — Tax lines: intra-state, inter-state and an overseas buyer `[local]`

**Why it matters:** invoices and credit notes are statutory records; a wrong split can't be edited later.

**Steps:** compare three bookings already made: B1 (IST, Indian state code), B4 (record state) and B2 (London). For each: R-04 `taxAmount`, `consumerStateCode`, `isInternational`, `displayCurrencyAtCheckout`; MQ-1 invoice split.

**Expect:** a buyer in the supplier's state gets CGST + SGST; another Indian state gets IGST; B2 gets `isInternational = true` (record the tax treatment and whether a `ConsumerInvoice` exists with `needsBuyerAddress`). `cgst + sgst + igst + taxable = total` on every invoice.

**Probe further:** B2 paid in INR or a display currency? If a display currency is shown at checkout, do the Payments page and refund lines show the same currency and rate?

## MO-12 — A lapsed direct-checkout hold frees the time without a write

**Why it matters:** the hold rule is read-time; a SUCCEEDED payment must never be treated as lapsed.

**Setup:** MO-02's shape (a real PENDING checkout on a preview or local without Mock Pay) for S-08 at Thu D+3 10:00 IST.

**Steps:** owner-approved: `UPDATE "Payment" SET "expiresAt" = now() - interval '1 minute' WHERE id = :pid`. Reload H1's grid and B2's booking page for that time. Do not run any sweep.

**Expect:** the time reads free on both; the occurrence row is unchanged (still tentative, not deleted); the payment is still `PENDING` (the sweep, SW-02, makes it `EXPIRED`). Grid-level detail is HM-14; this case asserts money: no refund row, no earnings, credits (if any) not yet restored until the sweep or the abandon door runs.

**Probe further:** what does the original buyer see if they return to the payment page after the window: a clear "this checkout expired, pick a time again", or a payment form that will fail?

## MO-13 — A seat can't hold two open payments; a lapsed one is re-minted on the same row

**Why it matters:** two live orders for one seat can both capture (double charge).

**Setup:** Razorpay test mode or local without Mock Pay; F-PL2a webinar.

**Steps:**

1. As B3 start a seat checkout (PENDING). Start it again from a second tab with a new `clientIdempotencyKey`.
2. Owner-approved: age the first payment's `expiresAt` 1 hour into the past; NEEDS-OWNER-RUN `abandoned-payments` (or wait for a tick, SW-02).
3. Buy again.

**Expect:** step 1 second attempt: typed refusal `PAYMENT_ALREADY_EXISTS` with human copy, no second row. Step 3: `200`, not `500`; the same `Payment.id` reused as `PENDING` with a **new** order id; a tombstone row holds the old order (`EXPIRED`, `appointmentId` null, description starting "Order replaced by a re-mint"). Record exact rows.

**Probe further:** what does B3's Payments page show for the tombstone (nothing, or a confusing failed charge)?

## MO-14 — The checkout page and the charge agree on every number `[local]`

**Why it matters:** the totals block is the buyer's contract.

**Steps:** for each of S-08 (consultation), the weeks plan (SU-23), F-PL2a (webinar) and F-PL2c (class), screenshot the checkout totals block before paying, then compare with `Payment.amount`, `originalAmount`, `taxAmount`, `welcomeDiscountPaise` and the receipt.

**Expect:** every line on the page maps to a column, and the total equals `amount`. The cancellation policy note on the page (`CancellationPolicyNote`) states the same tiers the quote uses (100 % at ≥ 24 h, 50 % from 2 h to 24 h, 0 % under 2 h; seats: full refund up to the event window, default 24 h).

**Probe further:** list any total that rounds differently between page, receipt and DB. Is "incl. GST" or "+ GST" stated? Does the subscription page say what happens to money for sessions that can't be scheduled ("refunded" at plan end)?
