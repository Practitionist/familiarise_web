# ADR: The money line says only what the rows prove

- **Status**: Accepted by the owner on 2026-11-20. Ships in the pull request that adds this record.
- **Date**: 2026-11-20
- **Author**: Platform engineering
- **Related**: [The appointment detail page](../dashboard/appointment-detail-page.md#what-the-money-line-may-claim), [Booking states and demand guidance](2026-11-14-booking-states-and-demand-guidance.md)

## Context

Every screen that shows a booking's money (the booking page's Payment card, the Billing history row, the payment page, the expert's Requests row) reads it from `deriveBookingPresentation` in `lib/dashboard/money-state.ts`. Two of its sentences claimed more than the rows could show.

- **"Nothing was charged."** Every unpaid booking ended in "Nothing was charged for this booking." or "Nothing was charged — the payment link expired". A gateway order that was created can still capture after its window closed or the booking was cancelled, so the learner may well have been charged for a while. What `handlePaymentSuccess` then does depends on the rows. On an `EXPIRED` or `FAILED` order, or a booking that has ended, it records the capture as `SUCCEEDED`, confirms nothing and refunds it. On an order still `PENDING` past its window (the expiry sweep has not run yet, and the job fleet is paused before launch) it confirms the booking when its time is still free, and refunds only when another booking holds the time or the session has started.
- **"Not due yet."** The Billing row and the payment page built their input without the booking's source. A pay-first checkout hold whose pay window had passed, while its Payment row was still `PENDING`, therefore read as a submitted request: "Not due yet — you are asked to pay after the expert approves", with "Problem with this charge" beside it. Its booking page read "Nothing was charged — the payment link expired" at the same time.

## Worked example

Charlotte opens a ₹500 checkout with Hannah at 10:00. The order is created at the gateway, the pay window closes at 10:15 and the sweep has not run yet.

| Screen       | Before                                                                        | After                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking page | Not charged · "Nothing was charged — the payment link expired on Fri 20 Nov." | Not completed · "The payment window closed on Fri 20 Nov. If your payment still goes through, the booking is confirmed while the time can still be booked; otherwise the money is refunded automatically." |
| Billing row  | Not due · "Not due yet — you are asked to pay after Hannah approves."         | Same as the booking page.                                                                                                                                                                                  |
| Payment page | Not due · "Not due yet — you are asked to pay after Hannah approves."         | Same as the booking page.                                                                                                                                                                                  |

Hannah's Requests row and booking page read "If Charlotte's payment still goes through, …". Once the sweep marks the order `EXPIRED`, a late capture can only be refunded, and all of them read "The payment link expired on Fri 20 Nov. If you were charged, the money is refunded automatically." If Charlotte instead cancels the checkout at 10:05, all three read "This order was cancelled. If you were charged, the money is refunded automatically." Only when the order was never created (an approval link whose mint failed leaves a `premint_` placeholder) do they read "Nothing was charged for this booking.".

## Decisions

1. **"Nothing was charged" needs proof that no order existed.** Each reader passes `gatewayOrderMinted` per payment, false only for a pre-mint placeholder (`isPreMintIntent` in `lib/payments/pre-mint-intent.ts`). The derivation says "Nothing was charged" only when every unpaid row is such a placeholder or there is no Payment row. The gateway order id is read on the server and never shipped.
2. **A refund is promised only where a late capture is refunded.** When the order is `EXPIRED` or `FAILED`, or the booking has ended, the badge reads "Not completed" and the line names what happened (the link expired, the order was cancelled, the payment did not go through), followed by "If you were charged, the money is refunded automatically." The expert reads the learner's name in place of "you".
3. **An order still `PENDING` past its window names both outcomes.** While the booking is still open (a pending request, an approval awaiting payment or a held seat), the badge reads "Not completed" and the line says "The payment window closed on <day>. If your payment still goes through, the booking is confirmed while the time can still be booked; otherwise the money is refunded automatically." A webinar or class seat says "a place" for "the time". It never promises a refund and never says "Not due yet".
4. **An open order is never "not due".** "Not due yet" is said only for a request with no `PENDING` order. A request carrying one reads Due while its window is open and the closed-window line once it has passed, so a reader that lacks the source still tells the truth.
5. **Every screen of one payment says the same thing.** The Billing row and the payment page pass the booking's `source` and the payer's own live seat on a webinar or class, and use the booking page's hold-deadline rule (`bookingSourceOf` and `holdDeadlineOf` in `lib/appointments/presentation-input.ts`). The table is pinned through each screen's real query by `__tests__/dashboards/money-state-provable.test.ts`, and decisions 2 and 3 are paired with the real capture's outcome on Postgres by `__tests__/db/booking/late-capture-money-line.db.test.ts`.

## Consequences

- Wording and display only: no payment status, capture, refund or expiry behaviour changes. The money state kind stays `NOT_DUE`, so the checkout success page, the history filters and the "was the viewer charged" gate behave as before.
- The expert's Requests rows keep their booking stage and actions (a paid direct checkout still needs the expert's answer); only their money line follows decisions 3 and 4. This is why `lib/data/requests-inbox.ts` passes `gatewayOrderMinted` but not `source`, the one exception to decision 5: with the source, a paid direct checkout still `PENDING` would read as confirmed and lose Approve.

## Deprecated & Superseded Approaches

- **"Not charged" as the badge of every unpaid booking.** Replaced by "Not completed" whenever an order existed (decisions 2 and 3).
- **A request hold deadline on a pay-first payment row.** The Billing row added the 48-hour request hold to a pay-first checkout; it now reads only the payment's own clock, as the booking page does (decision 5).
