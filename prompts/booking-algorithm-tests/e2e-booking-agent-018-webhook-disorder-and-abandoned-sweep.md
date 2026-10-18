# E2E Booking Algorithm Test — Agent 018: Webhook Retry and Reorder, Unknown-Order Recovery, Abandoned Sweep vs Capture

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000` (Razorpay **test mode** keys and `RAZORPAY_WEBHOOK_SECRET` set)
**Read first:** [`wave0-shared-setup.md`](./wave0-shared-setup.md) and
`.claude/skills/finance/references/verification.md` ("Replaying a webhook")

> **Coverage marker:** the payment confirmation pipeline (`handlePaymentSuccess` in
> `lib/payments/webhooks/handlers.ts`) is the only writer of
> `Payment.paymentStatus = SUCCEEDED`. This case proves it survives a duplicated
> and a reordered delivery, recovers a capture whose order has no row yet (the
> approval pay-link's pre-mint marker in the order notes), and that the abandoned
> sweep releases only the lapsed buyer's seat and never beats a capture to a
> paid booking. Fixture suffix `-018`.

You are a senior QA engineer. Every webhook you post is **synthetic**, so every
`WebhookEvent` you create is retired with the `permanent:` prefix in the cleanup
phase.

## Critical Rules

1. Sign the exact bytes you post (HMAC-SHA256, `x-razorpay-signature`) and give
   each delivery a unique `x-razorpay-event-id` of the form `qa-018-<n>`. Reusing an
   id is a retry, on purpose, only where a phase says so.
2. The bar for every phase: **no SUCCEEDED payment ends up without a booking or a
   refund**, no booking is confirmed twice, the ledger posts once.
3. Read the Netlify function logs for the deploy when Sentry shows nothing (see the
   shared setup); a successful money path is quiet.

---

## Phase 0 — Data seeding

With suffix `-018`: consultant `testconsultant018@…` (profile
`test-consultant-profile-018`, `WEEKLY`, Mon–Fri 09:30–17:00 IST with local
columns), consultees `testconsultee018a@…`, `…b@…`, `…c@…`, a 0.5 h consultation
plan `test-consultation-plan-018` (₹1,000 = 100000 paise, GST included in the
derived amount: read the real figure from the first checkout response and reuse it)
and a webinar `test-webinar-018` (capacity 5, ₹500). Pin `D` to the coming **Monday**.

## Phase 1 — The same delivery twice, and a retry with a new event id

1. As consultee A start a non-mock consultation checkout for `D+7` 05:00Z. Record
   `<PAYMENT_ID>`, the order `<ORDER_ID>` (`Payment.paymentIntent`) and the amount.
2. Post a signed `payment.captured` for `<ORDER_ID>` with event id `qa-018-1`.
   **Expected:** `200`; `Payment` is `SUCCEEDED` with `gatewayPaymentId` set; the
   occurrence is no longer tentative.
3. Post the **identical** delivery again (same event id, same bytes).
   **Expected:** `200`, absorbed by the `WebhookEvent` inbox; nothing changes.
4. Post the same capture once more under a **new** event id (`qa-018-2`). Razorpay
   retries a delivery under the same id, so this is a separate event-id
   idempotency case: a second event naming an already-captured payment.
   **Expected:** `200`, handled as already confirmed.

```sql
SELECT (SELECT COUNT(*) FROM "LedgerTransaction" WHERE "idempotencyKey" = 'booking:<PAYMENT_ID>') AS journals,
       (SELECT COUNT(*) FROM "ConsultantEarnings" WHERE "paymentId" = '<PAYMENT_ID>') AS earnings,
       (SELECT COUNT(*) FROM "PaymentLeg" WHERE "paymentId" = '<PAYMENT_ID>') AS legs,
       (SELECT "paymentStatus" FROM "Payment" WHERE id = '<PAYMENT_ID>') AS status;
-- Expected: journals = 1, earnings = 1, legs = 1 (one CARD leg), status = SUCCEEDED
```

## Phase 2 — Reorder: `order.paid` before `payment.captured`, a failure after success

1. Start a second checkout (consultee B, `D+8`). Post `order.paid` first, then
   `payment.captured` (both new event ids). **Expected:** one confirmation; the
   second delivery is a no-op; one ledger journal.
2. Then post `payment.failed` for the same order (event id new). **Expected:** `200`
   and `paymentStatus` **stays** `SUCCEEDED` (a failure after success must never
   flip a paid booking back).

## Phase 3 — A capture on an order that has no row yet

This reproduces the approval pay-link whose database writes both failed after the
gateway order was minted. It needs a real Razorpay test order whose `notes` carry
the row id the server wrote first (`familiarisePaymentId`).

1. Have consultee C request a booking and the expert approve it so a pay-link is
   minted (`APPROVED_PENDING_PAYMENT`). Record the row `<PM_PAYMENT_ID>`.
2. Put the row back to its pre-mint shape to simulate the lost fill write:

   ```sql
   SELECT id, "paymentIntent", "paymentStatus" FROM "Payment" WHERE id = '<PM_PAYMENT_ID>';
   -- Record <ORDER_ID_3> = paymentIntent (an order_ id). Then, in a QA-only step:
   UPDATE "Payment" SET "paymentIntent" = 'premint_qa018-' || id WHERE id = '<PM_PAYMENT_ID>';
   UPDATE "PaymentLeg" SET "sourceRef" = 'premint_qa018-' || "paymentId"
   WHERE "paymentId" = '<PM_PAYMENT_ID>' AND source = 'CARD';
   ```

   The Razorpay order `<ORDER_ID_3>` still names `familiarisePaymentId =
<PM_PAYMENT_ID>` in its `notes`.

3. Post a signed `payment.captured` for `<ORDER_ID_3>` at the order's exact amount.
   **Expected:** the server fetches the order from Razorpay, reads the notes
   (never the webhook's own notes), swaps the placeholder for the order id by CAS,
   and confirms. `Payment.paymentIntent = <ORDER_ID_3>`, status `SUCCEEDED`, the
   CARD leg's `sourceRef = <ORDER_ID_3>`, the booking confirmed.
4. Negative: repeat on a second pre-mint row but post the capture at the **wrong
   amount**. **Expected:** not adopted (amount/currency must match the order); the
   delivery is left for the sweep and nothing is confirmed.
5. Negative: a capture for an order id that exists nowhere (no row, no notes).
   **Expected:** non-2xx / recorded error on the `WebhookEvent`, retried by
   `sweep-stuck-webhook-events` until it gives up; no booking, no phantom payment.

If the server has no Razorpay test keys, mark Phase 3 SKIPPED and say why.

## Phase 4 — The abandoned sweep touches only the lapsed buyer

On `test-webinar-018` (capacity 5): consultee A holds a **CONFIRMED** seat (mock
payment); consultee B has a **live** PENDING checkout (hold 30 minutes ahead);
consultee C has a PENDING checkout whose hold has lapsed:

```sql
UPDATE "Payment" SET "expiresAt" = NOW() - INTERVAL '1 hour' WHERE id = '<C_PAYMENT_ID>';
```

Run `GET /api/cleanup/abandoned-payments?limit=50` with the cron secret.

**Expected:** only C's payment becomes `EXPIRED` and only C's seat is released
(`HELD` to `CANCELLED`); A's seat is still `CONFIRMED` and B's checkout is still
`PENDING` with its HELD seat.

```sql
SELECT p."userId", p."paymentStatus", ap.status AS seat
FROM "Payment" p
LEFT JOIN "AppointmentParticipant" ap ON ap."appointmentId" = p."appointmentId" AND ap."userId" = p."userId"
WHERE p."appointmentId" = '<WEBINAR_APPT_ID>';
```

Run the sweep a second time. **Expected:** no change (idempotent), and the response
counts show nothing further to do.

## Phase 5 — Sweep versus capture on the same payment

Prepare a fresh lapsed PENDING payment (as C's in Phase 4) and start, at the same
instant, the sweep and the signed `payment.captured` for it (`Promise.all` from
two contexts). Repeat three times with fresh payments. For each run the final
state must be **exactly one** of:

| Who won            | Payment     | Seat                                   | Money                                        |
| ------------------ | ----------- | -------------------------------------- | -------------------------------------------- |
| The capture        | `SUCCEEDED` | `CONFIRMED`                            | one ledger journal, no refund                |
| The sweep          | `SUCCEEDED` (late capture recorded) | released, not resold | `Auto-refund pending:` then `Auto-refunded:` in `description`, one `Refund` row |

Never: `SUCCEEDED` with a released seat and no refund marker, `EXPIRED` with a
confirmed seat, or two `Refund` rows. Drive `GET /api/cleanup/retry-auto-refunds` if
a pending marker remains.

## Phase 6 — Cleanup

Retire every synthetic delivery so the stuck-event sweep ignores it:

```sql
UPDATE "WebhookEvent"
SET error = 'permanent: qa fixture', processed = true, "processedAt" = NOW()
WHERE "eventId" LIKE 'qa-018-%';
```

Then cancel the bookings through the cancel route, delete QA rows in the order in
the shared setup (payments last, legs and earnings first), and record the refund
ids you leave behind.

## Pass/fail table

| #   | Check                                          | Expected                                  |
| --- | ---------------------------------------------- | ----------------------------------------- |
| 1   | Same delivery twice / a second event, same payment | one confirmation, one journal             |
| 2   | `order.paid` before `payment.captured`; failure after success | one confirmation; stays SUCCEEDED |
| 3   | Capture on a pre-mint row                      | adopted by order notes, confirmed         |
| 4   | Wrong amount / unknown order                   | not adopted; retried, no phantom booking  |
| 5   | Sweep scope                                    | only the lapsed buyer's payment and seat  |
| 6   | Sweep vs capture                               | one legal outcome, never paid-and-lost    |
