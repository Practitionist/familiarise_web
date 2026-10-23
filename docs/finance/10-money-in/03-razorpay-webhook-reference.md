---
title: Razorpay and RazorpayX webhook reference
type: reference
audience: engineers reading or extending webhook handlers
status: live
last-reviewed: 2026-10-23
---

# Razorpay and RazorpayX webhook reference

This page lists what the platform accepts from Razorpay and RazorpayX: which events the dispatcher handles, the payload fields the handlers read, the wire quirks the Zod schemas normalise, and the ordering rules that make out-of-order delivery safe. How the inbox deduplicates and recovers is in [capture confirmation and webhooks](02-capture-confirmation-and-webhooks.md); this page does not repeat it.

The contract lives in `schemas/webhooks/razorpay.ts` (shapes), `app/api/webhooks/razorpay/signature.ts` (secrets) and `app/api/webhooks/razorpay-dispatch.ts` (routing). The dispatcher has a `default` branch that logs and ignores any other event. A new money event Razorpay starts sending is therefore dropped, and local state can go stale until a sweep or a new case catches it, so review the dashboard's subscribed events against the dispatcher whenever either changes.

## 1. Events the dispatcher handles

| Event                                                                                                                  | Meaning for the platform                                                | Handler                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `payment.captured`                                                                                                     | Money for an order is held by Razorpay                                  | `routeCapturedPayment`                                            |
| `order.paid`                                                                                                           | The order is fully paid; the nested payment entity is optional          | `routeCapturedPayment`                                            |
| `payment.failed`                                                                                                       | One attempt failed; the order may still be paid by a retry              | `handlePaymentFailure` and its org variants                       |
| `refund.created`, `refund.processed`                                                                                   | A refund exists or finished                                             | `handleRefundCreated`                                             |
| `refund.failed`                                                                                                        | A refund did not complete                                               | `handleRefundCreated` with status `failed`                        |
| `refund.speed_changed`                                                                                                 | A fast refund fell back to normal speed                                 | Writes `speedRequested` and `speedProcessed` to `Refund.metadata` |
| `payment.dispute.created`                                                                                              | A chargeback or early fraud warning opened                              | `handleDisputeCreated`                                            |
| `payment.dispute.under_review`                                                                                         | Evidence is with the bank                                               | `handleDisputeUpdated`                                            |
| `payment.dispute.action_required`                                                                                      | Razorpay needs a response, including a pre-arbitration phase            | `handleDisputeUpdated`                                            |
| `payment.dispute.won`, `.lost`                                                                                         | Verdict                                                                 | `handleDisputeUpdated` with the verdict status                    |
| `payment.dispute.closed`                                                                                               | Proceedings ended; the entity's own status and `amount_deducted` decide | `handleDisputeUpdated`                                            |
| `payout.initiated`, `.updated`, `.queued`, `.pending`, `.processed`, `.reversed`, `.rejected`, `.failed`, `.cancelled` | RazorpayX payout lifecycle                                              | `handleRazorpayPayoutWebhook`                                     |
| `fund_account.validation.completed`, `.failed`                                                                         | Penny-drop or reverse-penny-drop result                                 | `handleFundAccountValidationWebhook`                              |
| `settlement.processed`                                                                                                 | Razorpay settled a batch                                                | Logged only                                                       |

`payment.authorized` and `settlement.failed` are not handled. Nothing in the code captures manually, and an order minted with a hold deadline carries `capture: automatic` and a capture window (`holdCaptureSettings`), so a payment left authorised is refunded by Razorpay when that window closes.

Payout events are signed with the RazorpayX secret when they are not signed with the payment secret; see [the webhook inbox](02-capture-confirmation-and-webhooks.md#2-the-webhook-inbox). Their handling is documented in [RazorpayX](../40-payouts/04-razorpayx.md).

## 2. Payload fields the handlers read

| Entity                  | Fields read                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment                 | `id` (`pay_…`), `order_id`, `amount` in paise, `currency`, `status`, `notes`, `error_description`, `fee` (GST included), `tax` (the GST on the fee) |
| Order (`order.paid`)    | `id`, `amount`, `currency`, `status`, `notes`; the order total is not what was settled, so it is not used as a captured amount                      |
| Refund                  | `id`, `payment_id`, `amount`, `currency`, `status`, `notes` (carries `reservationId`), `speed_requested`, `speed_processed`                         |
| Dispute                 | `id`, `payment_id`, `amount`, `currency`, `reason_code`, `reason_description`, `status`, `respond_by` in Unix seconds, `phase`, `amount_deducted`   |
| Payout                  | `id`, `status`, `failure_reason`, `status_details`, `error`, `utr`, `reference_id`                                                                  |
| Fund account validation | `id`, `reference_id`, `fund_account`, `status`, `results` or `validation_results`, `status_details`                                                 |

## 3. Wire quirks and how they are normalised

- **Empty notes arrive as a JSON array.** When an order, payment, refund or payout has no notes, Razorpay serialises `"notes": []`, and may echo numbers or booleans unquoted. `razorpayNotesSchema` turns an array, `null` or a missing value into `{}` and every primitive into a string, so handlers always see a `Record<string, string>`. Outbound orders keep within Razorpay's own limits through `sanitizeRazorpayNotes`: at most 15 keys and 256 characters per value, so the first key written is the one that must matter (`familiarisePaymentId`).
- **Times are seconds.** `respond_by` and `created_at` are Unix seconds; handlers multiply by 1,000 before building a `Date`.
- **No `comments` on a dispute.** Dispute text comes from `reason_code`, `reason_description` and the evidence summary the platform submits.
- **`failure_reason` is deprecated** and often null on payouts. Handlers read `failure_reason`, then `status_details.description`, then `status_details.reason`, then `error.description`, then `error.reason`.
- **Refund speed.** `speed_requested` is `normal` or `optimum`, never `instant`; `speed_processed` may be `normal`, `instant` or `optimum`.
- **Validation entities contain nulls.** `fundAccountValidationEntitySchema` normalises null `fund_account`, `results`, `validation_results` and `status_details` to absent.
- **An unparseable body is permanent.** A Zod failure inside a handler records `permanent: schema mismatch` on the event and is never retried, and the route answers 400 for a body that is not even a valid envelope.

## 4. Ordering rules

Razorpay does not guarantee order, so each handler states what it does when its subject is missing.

- A **refund** event for a payment still `PENDING` returns `DeferSignal`. A refund for an unknown payment falls through to the organisation branches (wallet top-up, then invoice) before being logged.
- A **refund** whose `notes.reservationId` names a `pending_` placeholder is bound to that row in place (`refundId` replaced by the real `rfnd_…`), so the webhook winning the race against the application's own bind does not create a duplicate. A `refund.failed` for a refund the platform never recorded is ignored, because no money moved. Status moves other than from `PENDING` are ignored, with one exception: a late success on a locally `FAILED` row settles it once, guarded by `Refund.cascadedAt`.
- A **dispute** event before the payment is captured, or an update before the creation event, returns `DeferSignal` and is re-driven by `sweep-stuck-webhook-events`. Updates are accepted only along the legal transitions of `isLegalDisputeTransition`, and the update itself is a CAS on the prior status.
- A **`payment.failed`** after the payment is `SUCCEEDED` or `EXPIRED` is ignored. While the hold is still open it preserves the slot, the description and applied credits, because one checkout session shares one `order_id` across several attempts; it records the failed attempt's `gatewayPaymentId` only if none is set.
- A **verdict** for one dispute releases only that dispute's `DISPUTE` earnings hold. Holds owned by moderation, an operator, an overage or a support case, and holds belonging to another open dispute, stay in place.

## Where in code

- `schemas/webhooks/razorpay.ts`, `schemas/webhooks/metadata.ts`.
- `app/api/webhooks/razorpay-dispatch.ts`, `app/api/webhooks/utils.ts` (`handleRefundCreated`, `handleDisputeCreated`, `handleDisputeUpdated`).
- `lib/payments/dispute-status.ts`, `lib/payments/refund-status.ts`.

## Related

- [Capture confirmation and webhooks](02-capture-confirmation-and-webhooks.md).
- [Chargebacks](../30-refunds-disputes/02-chargebacks.md) for what a verdict does to money.
- [Webhook recovery](../70-operations/04-webhook-recovery.md) for replaying an event.

## Deprecated & Superseded Approaches

A `RazorpayEventTypeSchema` enum listing `payment.authorized` and `settlement.failed` was documented here and is not in the code; the dispatcher is a plain switch. A strict `z.record(z.string())` for notes failed on the PHP empty-array quirk and was replaced by `razorpayNotesSchema`. An earlier rule released earnings after a dispute win only when no other dispute was open, by counting disputes; holds are now reason-scoped rows, so each dispute releases only its own. Dropping `fund_account.validation.*` and `payout.cancelled` events was once the default; both are now handled.
