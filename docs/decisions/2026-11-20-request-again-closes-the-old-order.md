# ADR: "Request again" closes the old order first

- **Status**: Accepted by the owner on 2026-11-20. Ships in the pull request that adds this record.
- **Date**: 2026-11-20
- **Author**: Platform engineering
- **Related**: [The money line says only what the rows prove](2026-11-20-money-line-says-only-what-is-provable.md), [An approved request's unpaid order returns what its checkout consumed](2026-11-20-unpaid-approval-orders-return-what-checkout-consumed.md), [Booking lifecycle](../booking/06-booking-lifecycle.md), [Approval payments](../finance/10-money-in/05-approval-payments.md#3-time-and-expiry)

## Context

A booking whose pay window has closed while its gateway order is still `PENDING` can still be confirmed. The expiry sweep has not claimed the order yet (and the job fleet is paused before launch), so a late capture goes through `confirmExistingAppointment` (`lib/payments/webhooks/handlers.ts`), which confirms the booking while its time is free. The booking page says so: "The payment window closed on … If your payment still goes through, the booking is confirmed while the time can still be booked; otherwise the money is refunded automatically."

The same booking sits in the learner's Cancelled list, where the detail page offers "Book again". A learner who followed it and booked a second time could end up with two confirmed bookings if the first payment then landed. The first design kept "Request again" as it was and, when the late capture confirmed the original, cancelled the new request on the server. That needed a column linking the new request to the original, and the schema is frozen. The owner chose instead to close the old order before the new request starts. That needs no schema change, and the old booking can no longer be confirmed behind the learner's back.

## Worked example

Charlotte Brown's ₹1,000.00 (100,000 paise) consultation with Hannah Anderson was approved. She opened the pay link at 10:00 with ₹200.00 (20,000 paise) of referral credit and a 10% code, and her organisation's seat counted one engagement. The window closed at 10:15. At 10:20 she opens the booking and clicks **Book again**.

1. A dialog asks: "Close your earlier payment link? Your earlier payment link will be closed. If it was already paid, the money is refunded automatically." She confirms.
2. `POST /api/bookings/<appointment>/request-again` runs one transaction. The order moves `PENDING → EXPIRED`. Her ₹200.00 credit, the code use and the seat's engagement come back. The request moves `APPROVED_PENDING_PAYMENT → EXPIRED` with the history reason `REQUESTED_AGAIN`, and the held time is released. The route answers `{ "closed": 1 }`, and only then does the page open Hannah's booking page.
3. Her bank had in fact captured the payment at 10:14 and the webhook arrives at 10:25. It lands on the `EXPIRED` order. `handlePaymentSuccess` records it as `SUCCEEDED` with "Auto-refund pending", confirms nothing and refunds it in full through `refundBookingPayment`. If that refund call fails, `retry-auto-refunds` re-drives it.
4. Had the webhook arrived at 10:19, before her click, the capture would have confirmed the booking. The route then answers `409 ALREADY_PAID`: "Your earlier payment went through, so that booking is confirmed. No new request was started." Nothing is closed, and the page stays on the confirmed booking.

## Decisions

1. **The control decides from the rows it shows.** `RequestAgainButton` (`components/booking/RequestAgainButton.tsx`) is the one control behind "Book again" on the learner's booking page and on the pending-checkout page. When `openOrderPastWindow` (`lib/booking/request-again-rules.ts`) finds an order still `PENDING` whose `expiresAt` has passed, it shows the warning and calls the route. Only `{ closed }` lets it navigate. Otherwise it is the plain link it was before.
2. **One transaction closes the caller's own order.** `closeOrderForRequestAgain` (`lib/booking/request-again.ts`) runs under the appointment lock in one Serializable transaction with the usual retry, for the caller's own booking only: the request's requester, the trial's learner, or a seat holder on a webinar or class (anyone else gets `404 NOT_FOUND`). Inside it:
   1. It reads the booking and the caller's `PENDING` orders.
   2. With no `PENDING` order, it answers `ALREADY_PAID` if a capture of the caller's still holds its money (`unreturnedCaptureWhere`), and `{ closed: 0 }` otherwise.
   3. An order whose window is still open (or has no `expiresAt`) is refused with `409 PAY_WINDOW_OPEN`.
   4. `expirePendingPaymentsInTx(tx, { appointmentId, userId, reason })` claims each order by compare-and-swap and returns its credit, code use and engagement. The payment goes first, which is the capture's own lock order (payment, then booking).
   5. The booking takes its lapsed state through the writer its own sweep uses, each carrying the money predicate in its `WHERE`:
      - An approved request goes through `lapseApprovedRequest` with the new reason `REQUESTED_AGAIN`, which maps to `EXPIRED`.
      - A pay-first hold (`PENDING`, `DIRECT_CHECKOUT`) ends as the abandoned-payment pass ends it: the request goes `PENDING → EXPIRED`, its occurrences are cancelled and tombstoned, its `HELD` seats are cancelled and the appointment is soft-deleted.
      - A paid trial still `AWAITING_PAYMENT` moves to `CANCELLED`, as `expire-unpaid-trials` does, and its held call is tombstoned (`softCancelTrialAppointmentInTx`).
      - A webinar or class seat releases only the caller's `HELD` seat and stages the seat-opened notices.
   6. A booking in any other status with such an order (for example a confirmed plan) is refused with `409 NOT_CLOSABLE`.
3. **A capture that won first closes nothing.** If the booking's compare-and-swap misses after the orders expired, the transaction is rolled back by throwing, so the expiries and give-backs never commit. The answer is `ALREADY_PAID` when a capture of the caller's holds its money and `NOT_CLOSABLE` otherwise. The control then shows the refusal, refreshes the page and does not navigate.
4. **Gateway cancels run after the commit**, through `cancelGatewayOrders`, as the abandon door and the trial sweep do. A Razorpay "cancel" only reads the order, and a capture that still lands on the `EXPIRED` order is refunded.
5. **The warning is true as written.** "If it was already paid, the money is refunded automatically" holds because a capture on an `EXPIRED` order takes the `captured_after_release` arm of `handlePaymentSuccess` and is refunded through the booking refund door, and `retry-auto-refunds` re-drives a refund that failed. Before the click the booking page still names both outcomes, because the order is still `PENDING`.
6. **A second click changes nothing.** The order is already `EXPIRED`, so the route answers `{ closed: 0 }` and nothing is returned twice. A refunded late capture does not count as "already paid", so a click after it still continues.
7. **The Home widget does not nudge a request the learner closed.** The lapsed pay-link list (`toLapsedPayLinks`) skips an `EXPIRED` edge whose reason is `REQUESTED_AGAIN`, because the learner has already requested again.
8. **No schema change and no notice to the learner.** The click is the learner's own act, so no "request expired" email or bell is sent. Anyone waiting on the released time still hears it is free.

## Consequences

- The Home lapsed-link row and its "Request again" action item are unchanged links. Both list only requests whose order its sweep has already expired: `expireLapsedPayLink` and `lapseApprovedRequest` expire the order in the same transaction as the request, so there is never an open order left to close. The pending-checkout page shows "Book again" only once its order is `EXPIRED` or `FAILED`, so its control never asks either.
- `__tests__/db/booking/request-again-closes-old-order.db.test.ts` pins the transaction on Postgres: one return of what the checkout consumed, the refund of a later capture, the refusal after a capture that won first, a click racing a capture, a second click, an open window, a stranger, and the hold, trial and seat arms. `__tests__/booking/request-again-control.test.tsx` and `__tests__/booking/request-again-route.test.ts` pin the control, what it sends against the route's schema, and the route's answers.

## Deprecated & Superseded Approaches

- **"Book again" as a plain link while an order could still confirm the old booking.** Replaced by decision 1.
- **Cancelling the new request when the old payment lands.** It needed a column linking the two requests (the frozen schema has none: `Subscription.renewedFromSubscriptionId` means a renewal, `Payment.parentPaymentId` an overage side-charge). It was not built.
