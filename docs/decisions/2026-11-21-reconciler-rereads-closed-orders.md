# ADR: The payment reconciler re-reads orders we closed

- **Status**: Accepted by the owner on 2026-11-21 ("option B, 72 h, separate PR"), recorded on issue #2925 ([booking][P1] An unverified expert can still get sessions). Ships in the pull request that adds this record.
- **Date**: 2026-11-21
- **Author**: Platform engineering
- **Related**: ["Request again" closes the old order first](2026-11-20-request-again-closes-the-old-order.md), [Pause the scheduled jobs before launch](2026-11-06-pause-scheduled-jobs-prelaunch.md), [Capture confirmation and webhooks](../finance/10-money-in/02-capture-confirmation-and-webhooks.md), [Scheduled jobs](../finance/70-operations/01-scheduled-jobs.md)

## Context

Our app closes a Razorpay order by moving its `Payment` row from `PENDING` to `EXPIRED`. The abandoned-payment sweep does it when a hold lapses, "Request again" does it before a new request starts, an approved request that lapses or is withdrawn does it through `expirePendingPaymentsInTx`, and a re-mint or an aborted checkout leaves an `EXPIRED` tombstone that keeps the old order id. Razorpay has no order cancel, so a buyer's bank can still capture money on that order afterwards. When the capture's webhook arrives, `handlePaymentSuccess` (`lib/payments/webhooks/handlers.ts`) takes its `EXPIRED` arm: it records the capture as `SUCCEEDED` with "Auto-refund pending", confirms nothing and refunds it in full through `refundBookingPayment`.

That refund depended on the webhook alone. `reconcile-payment-status` read only `PENDING` orders, so a capture on a closed order whose webhook was lost stayed at the gateway with no row recording it. Razorpay retries a failed webhook for 24 hours and then disables the endpoint, so a long outage loses every event in it. The Request-again decision left one report per click (`REQUEST_AGAIN_RECHECK_FAILED`) and a refund by hand for that case. The owner chose instead to have the reconciler re-read recently closed orders, for every closing path, for 72 hours.

## Worked example

Charlotte Brown's ₹1,000.00 (100,000 paise) consultation with Hannah Anderson was approved, and its pay window closed at 10:15 IST. At 10:20 she clicks **Book again**. The click moves her order `order_Q2x8…` from `PENDING` to `EXPIRED`, and Prisma stamps the row's `updatedAt` with 10:20. The re-check after the commit times out at the gateway, so the click is reported once and the close stands.

1. Her bank captures the payment at 10:21 as `pay_Q2xA…`. Our webhook endpoint is failing that morning, and Razorpay's retries run out the next day, so `payment.captured` never arrives.
2. The 10:35 `reconcile-payment-status` run finds the row in its closed-order cohort: a real `order_` id, `EXPIRED`, no `capturedAt`, `updatedAt` 15 minutes ago. It calls `GET /v1/orders/order_Q2x8…/payments` once and finds the captured payment for 100,000 paise.
3. The run hands it to `routeCapturedPayment`, which calls `handlePaymentSuccess`. The `EXPIRED` arm moves the row to `SUCCEEDED` by compare-and-set, stamps `pay_Q2xA…` and `capturedAt`, parks the 100,000 paise in `UNAPPLIED_RECEIPTS`, and confirms nothing. After the commit, `refundBookingPayment` reserves one refund of 100,000 paise under `Refund.dedupeKey` `late-capture:pay_Q2xA…` and calls Razorpay with the reservation id as `X-Refund-Idempotency` and `late_capture_pay_Q2xA…` as the refund `receipt`.
4. Had the webhook arrived at 11:00 after all, `handlePaymentSuccess` would find the row already `SUCCEEDED` at the same amount and payment id and return at once. No second refund is reserved.
5. The row is `SUCCEEDED` now, so it has left the cohort, and the 10:50 run does not read the order again.

Had the bank only authorised the payment, the run would have found an `authorized` payment and done nothing. Our orders capture automatically within the window set by `capture_options` (`holdCaptureSettings` in `lib/payments/core/razorpay.ts`), and Razorpay refunds an authorisation it never captured by itself. If the authorisation is captured later, a later run within the 72 hours finds the capture and refunds it.

## Decisions

1. **The cohort is every order we closed in the last 72 hours with no capture recorded.** `closedOrderRereadWhere` (`scripts/payments/reconcile-payment-status.ts`) selects `Payment` rows on `RAZORPAY` with `paymentStatus = EXPIRED`, a real order id (`order_`, so no `premint_` placeholder, mock or blank intent), `capturedAt` null, no manual-recovery marker, and `updatedAt` at most 72 hours ago (`CLOSED_ORDER_REREAD_MS`). There is no `CANCELLED` payment status; every closing path writes `EXPIRED`. The cohort is defined by the row's state, not by the writer, so a new closing path (the moderation rejection of an expert included) is covered without a change here.
2. **`updatedAt` is the close time, and no column is added.** Every writer of `EXPIRED` is a Prisma `update`, `updateMany` or `create`, all of which stamp `@updatedAt`; no raw SQL writes the status. The poll stamp `lastReconciledAt` is raw SQL, so reading an order never moves its `updatedAt`. A later write can only move `updatedAt` later, which can widen the window for that row but never hide a close. The schema is frozen, and the fact is already recorded.
3. **The read is bounded and ordered by the existing run.** The closed cohort is a third query beside the two `PENDING` cohorts. All three take at most `limit` rows (50 by default), are merged with duplicates removed, sorted least recently read first (`LEAST_RECENTLY_RECONCILED`), and cut to `limit`. The run holds the job's `withCronLock` lease (fail-closed), stops at its start deadline and does not start a gateway read with less than 3 seconds left. Each row is read at most once per run and is stamped `lastReconciledAt` after its read, so an order is never read more often than the job runs. The ticker's idle probe (`hasPaymentStatusReconcileWork`) counts the closed cohort too.
4. **One gateway read per order, and the single confirmer acts on it.** `readClosedOrder` calls `GET /v1/orders/:id/payments` and parses the answer with zod. A captured payment goes through `routeCapturedPayment`, which picks the handler from the payment's `notes.type`: `handlePaymentSuccess` for a booking, or the overage handler for a replaced overage order. Both record the capture and refund it; neither confirms a booking. The `EXPIRED` arm needs no booking context, so the "missing booking context" guard of the `PENDING` cohort does not apply. An authorisation alone, an empty order, or an order Razorpay does not know is left as it is.
5. **One refund per capture, at every layer.**
   - The `EXPIRED → SUCCEEDED` compare-and-set in `handlePaymentSuccess` lets only one caller reach the refund. The webhook, this run, the Request-again re-check and the stuck-webhook sweep all go through it.
   - `lateCaptureRefundKeys` gives the late-capture refund the `Refund.dedupeKey` `late-capture:<pay_id>`. A repeat call returns the first refund; a refund that failed definitively moved no money and releases the key for a retry.
   - The same refund carries the Razorpay refund `receipt` `late_capture_<pay_id>` (31 characters, under the 40-character limit). Razorpay refuses a second refund on the same payment with that receipt (`400 BAD_REQUEST_ERROR`), so even a second reservation could not move money twice.
   - `X-Refund-Idempotency` stays the reservation id. Keyed on the payment id instead, a retry after a definitive refusal would send the same key with a different body (a new reservation id in its notes), which Razorpay answers with `409` "Different request with the same idempotency key has already been processed". The capture could then never be refunded automatically.
6. **Failures are reported once per run.** A gateway error on a closed order adds one line to the run's `errors`, which makes the run's outcome a failure once, as for the `PENDING` cohorts. Nothing in the new code captures to Sentry per row. A late capture found sets the run's 207 needs-attention flag and is listed in `lateCaptures`.
7. **No new environment variable, flag or schedule.** The window is a constant, the cohort rides the existing job and its lock, and the registry entry is unchanged apart from its summary fields.

## Evidence

- Razorpay retries a failed webhook for 24 hours and then disables it: [webhook best practices](https://razorpay.com/docs/webhooks/best-practices/).
- Razorpay recommends fetching an order's payments by id as reconciliation alongside webhooks: [webhooks and fetch APIs](https://razorpay.com/docs/payments/payment-gateway/s2s-integration/test-s2s/best-practices/webhooks-and-fetch-apis).
- A late authorisation is polled from the bank for up to 3 days: [late authorisation](https://razorpay.com/docs/payments/payments/late-authorisation/). That sets the 72-hour window.
- Razorpay refunds an authorised payment it never captured, but never refunds a captured one by itself: [auto-refunds](https://razorpay.com/docs/payments/refunds/auto-refunds). A captured payment on a closed order is therefore ours to refund.
- A refund carries `X-Refund-Idempotency`, and its `receipt` is treated as an idempotency key per payment: [create a normal refund](https://razorpay.com/docs/api/refunds/create-normal/).
- Paytm advises checking a transaction's status for up to 72 hours when its notification is late: [late notification](https://paytmpayments.com/docs/late-notification/).

## Consequences

- **The protection runs only while the job fleet runs.** The fleet has been paused before launch since 2026-11-05 (`ops:active_cron_platform`). Until the go-live checklist resumes it, a capture on a closed order whose webhook is lost still needs the refund by hand from the order ids in `REQUEST_AGAIN_RECHECK_FAILED` or the gateway dashboard.
- **A capture more than 72 hours after the close is not found.** Razorpay's own capture window and its auto-refund of uncaptured authorisations make one unlikely; the webhook still refunds it if it arrives.
- **`FAILED` orders are not re-read.** `FAILED` is the gateway's own report of a failed attempt, not a close by our app, and `handlePaymentSuccess` still refunds a capture on one when its webhook arrives. Adding them would be a separate decision.
- **Gateway calls grow with closed orders.** Each order closed in the last 72 hours can be read up to once per run, within the run's shared limit of 50 rows. Razorpay does not charge for the read.
- `__tests__/db/booking/reconcile-rereads-closed-orders.db.test.ts` pins the behaviour on Postgres: a capture on an order the expiry sweep closed is refunded once and confirms nothing, a later webhook refunds nothing more, an order closed 80 hours ago and a pre-mint placeholder are never read, an authorisation is left alone, and the run respects the job's lock and limit. `__tests__/payments/razorpay-refund-idempotency.test.ts` and `__tests__/payments/refund-operation.test.ts` pin that the receipt reaches the refund request.

## Deprecated & Superseded Approaches

- **A refund by hand as the only recovery for a lost webhook on a closed order.** Recorded in decision 4 of the Request-again record on 2026-11-20; superseded by this record once the job fleet runs.
- **A retry marker re-read by its own sweep.** The other option the owner weighed. It needed a new column or row per closed order, and a second job, where the existing reconciler already reads Razorpay orders.
