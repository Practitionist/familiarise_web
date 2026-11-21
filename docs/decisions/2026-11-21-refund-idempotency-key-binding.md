# ADR: A refund key replays a refund only for the request it was spent on

- **Status**: Accepted by the owner on 2026-11-21. Ships in the pull request that adds this record.
- **Date**: 2026-11-21
- **Author**: Platform engineering
- **Related**: [Refunds](../finance/30-refunds-disputes/01-refunds.md), [Money remedies](../support/05-money-remedies.md), [Request again closes the old order first](2026-11-20-request-again-closes-the-old-order.md)

## Context

Every refund can carry a dedupe key, stored in `Refund.dedupeKey`, which the database keeps unique across all refunds. The key exists so that a retried click, a retried job or a lost network response never refunds twice. The writers honour it before any balance check: `refundPayment` (`lib/payments/operations/refund.ts`) and the in-ledger rails behind `refundBookingPayment` (`withDedupe` in `lib/payments/operations/booking-refund.ts`) both start by asking `findDedupedRefund`, which looks the key up and, when it finds a refund that moved money or is still in flight, hands that refund back as the answer. A `FAILED` or `CANCELLED` refund moved no money, so its key is released for a retry.

The lookup used the key alone. It never asked whether the new request was about the same payment. An external review found the consequence. A caller who reused the key of payment A's completed refund on a full-refund request for a different card payment B got A's refund back as the answer. The booking wrapper then took that answer as proof that B's refund had happened and stamped B's seat `REFUNDED` and revoked its chat and call access, although no money had moved for B.

## Worked example

Charlotte Brown paid ₹2,000.00 (200,000 paise) for payment A, a consultation with Hannah Anderson. On Saturday 21 Nov 2026 at 11:00 IST an operator refunds A in full with the key `K`. The refund for ₹2,000.00 is recorded under `K`. Charlotte also holds payment B, ₹1,500.00 (150,000 paise) for a different booking with Hannah.

| Request                                                   | Answer                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Payment A, no amount (a full refund), key `K`, again      | A's refund of ₹2,000.00 is returned. No second refund exists, and nothing is sent to the gateway.       |
| Payment B, no amount, key `K`                             | Refused with HTTP 422 and code `IDEMPOTENCY_KEY_REUSED`. B's seat is untouched and B's money is intact. |
| Payment A, an explicit ₹1,000.00 (100,000 paise), key `K` | Refused the same way, because the stored refund is ₹2,000.00 and the request names another amount.      |
| Payment A, an explicit ₹2,000.00 (200,000 paise), key `K` | A's refund is returned, because payment and amount both match.                                          |
| Payment B, no amount, a fresh key `K2`                    | A new refund of up to B's refundable ₹1,500.00, as before.                                              |

Before this decision, the second row returned A's refund and the booking wrapper stamped B's seat refunded.

## Decisions

1. **A key replays only a matching refund.** `findDedupedRefund` still looks the refund up by key alone, because the key is the unique column. It now also compares what the request asked for with what the stored refund is. The request matches when it names the same `paymentId` as the stored refund and, if it names an explicit amount, the same `amountPaise`. A full-refund request has no amount, because it asks for whatever is left to refund, and that resolves to the stored refund's own amount. It therefore matches on the payment alone. Any other reuse of a spent key is refused, never replayed.
2. **The refusal is HTTP 422 with code `IDEMPOTENCY_KEY_REUSED`.** The code is the one this repository already uses for a reused key with different details: `withIdempotency` (`lib/api/idempotency.ts`) and the approval-request route (`app/api/scheduling/request-for-approval/route.ts`) answer 422 with it, and the Support door words it as "This action was already submitted with different details" (`lib/support/error-copy.ts`). The refund doors surface it through their usual refusal path rather than as a generic failure. A caller sees what it did wrong, and a retry with the same inputs still succeeds.
3. **Every writer and door applies the same rule.** The check lives with the lookup, so the writers do not each restate it. Three callers sit above it. The in-ledger rails wrap their run in `withDedupe` (`lib/payments/operations/booking-refund.ts`). The back-office doors call `assertRefundDoorOpen` (`lib/backoffice/refund-eligibility.ts`), which lets a spent key through so the writer can answer it, and `refundInFlightOr` (`lib/backoffice/refund-doors.ts`), which answers the in-flight refund after a gateway error. Those doors are `app/api/admin/refunds/issue`, `app/api/admin/refunds/credits` and `app/api/admin/refunds`, and Support enters through `lib/support/case-actions.ts`. The session-link door keeps its stricter check, `assertSessionRefundable` (`lib/backoffice/refund-doors.ts`): there a key refunds once, and a retry that resolves to the first refund's amount replays it, while any other amount is refused with `SESSION_ALREADY_REFUNDED`.
4. **Seat effects follow the persisted refund, never the request.** After a refund is returned from a replay, the participant `REFUNDED` stamp and the Stream chat and call access revocation (`markParticipantsRefunded` and `revokeRefundedSeatAccess`, called from `refundBookingPayment`) act on the payment of the refund that was returned. A request that names another payment cannot reach them, because decision 1 refuses it first, and a replay never reads the payment id from the request to decide whose seat to end.
5. **No schema change.** `Refund.dedupeKey` and `Refund.paymentId` and `Refund.amountPaise` already hold everything the comparison needs. The schema is close to its pre-launch freeze, and this decision adds no column and no index.

## Why this shape

The comparison is limited to the fields that move money: the payment and the amount. The reason, free text, initiator and rail are not compared. A retry from another tab or another job run may word the reason differently, and refusing it would turn a harmless retry into an error. This is the same behaviour the payment industry settled on. Stripe compares the incoming parameters with those of the original request and returns an error when they differ, a rule it introduced as a breaking change in its 2015-09-03 API version ([idempotent requests](https://docs.stripe.com/api/idempotent_requests), [the changelog entry](https://docs.stripe.com/changelog/2015-09-03/reuse-idempotency-tokens-alter-error), [retrying idempotent requests](https://docs.stripe.com/error-low-level)). Razorpay's refund API, which is the gateway behind our refunds, accepts an `X-Refund-Idempotency` header and documents a 409 when a different request with the same key was already processed, and a 409 while the first is still in progress ([idempotent refunds](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent); the same page's tips section also mentions a 400 for a changed payload, so the two statuses are not consistent there). The IETF `Idempotency-Key` header draft lets a server pair the key with a fingerprint of the whole payload, of selected fields or of each field in turn ([the draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header)). Its first revision says a reused key with a different payload should get 422, and a request that arrives while the first is still running should get 409 ([draft 01](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-01)). Later revisions of the draft are less explicit about the 422.

Our choice is therefore the Stripe and Razorpay semantics, applied to the money-moving fields, with the 422 of the IETF draft and of our own `withIdempotency` and approval-request routes.

One door does not follow the 422 precedent, and the difference is deliberate. The checkout door compares a request fingerprint of the priced inputs (`replayByIdempotencyKey` in `lib/payments/operations/checkout-replay.ts`) but, on a mismatch, mints a fresh attempt instead of refusing, because a changed price input is legitimately a new checkout under the page's generated key. A refund has no such reading: the same key with another payment or another amount is always a caller mistake, and refusing it is the only safe answer.

## Consequences

- A caller that reuses a key across payments now gets an explicit refusal, not a silent replay. Keys that embed the payment id, such as `admin-refund:<adminId>:<paymentId>:<key>` and `case-recommendation:<id>`, cannot collide across payments and are unaffected. Keys the caller chooses freely, such as the `ops:<uuid>` key on the issue door, are where the refusal can fire.
- A retry that sends the same payment and the same amount keeps working exactly as before, including after a gateway error, through `refundInFlightOr`.
- No data repair is needed. No refund row changes shape, and a refund that was wrongly replayed before this decision was never recorded as one for payment B.
- The refund domain doc ([Refunds](../finance/30-refunds-disputes/01-refunds.md)) says a repeat call with a spent key returns the first refund. That sentence is true only for a matching request, as described here.

## Deprecated & Superseded Approaches

- **Key-only lookup.** `findDedupedRefund` used to return whatever refund held the key, whichever payment or amount the request named. It is replaced by decision 1, and no caller should compare the key alone.
- **A request-fingerprint column on `Refund`** (a SHA-256 of every input, as `Payment.requestFingerprint` does at checkout). It is the strictest option, since it catches any changed input. It was not chosen because it needs a new column while the schema is nearly frozen, and because the reason, initiator and rail are not worth refusing a retry over. The payment and the amount, read from columns that already exist, close the finding.
- **Matching on the payment alone.** It is the simplest rule, but a different amount on the same payment would silently replay the first refund, and the caller would believe the new amount was sent. The explicit amount is therefore compared whenever the request names one.
