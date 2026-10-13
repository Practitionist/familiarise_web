# Razorpay Debugging Runbooks (Familiarise Platform)

Production and staging troubleshooting runbooks for our Razorpay + RazorpayX integration.

---

## Runbook 1: Webhook Signature Verification Failing (`400 Invalid signature`)

### Symptoms
- Razorpay Dashboard (**Developers → Webhooks → Logs**) shows HTTP `400` responses with `{"error":"Invalid signature"}`.
- `SystemEvent` table shows `WARN` rows with `"Razorpay webhook HMAC verification failed"` or `"Razorpay webhook HMAC verification failed (RazorpayX secret)"`.

### Checklist
1. **Which event family is failing?**
   - If `event` starts with `payout.` (`isPayoutEventName(body) === true`), `app/api/webhooks/razorpay/route.ts` tries `RAZORPAY_WEBHOOK_SECRET` (and `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`) first, then falls back to `RAZORPAYX_WEBHOOK_SECRET`. Check that `RAZORPAYX_WEBHOOK_SECRET` matches the secret configured in **RazorpayX Dashboard → Settings → Webhooks**.
   - If `event` is `payment.*`, `order.paid`, `refund.*`, or `payment.dispute.*`, **only** `RAZORPAY_WEBHOOK_SECRET` and `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` are tried (`RAZORPAYX_WEBHOOK_SECRET` is never accepted for non-payout events).
2. **Did someone recently rotate `RAZORPAY_WEBHOOK_SECRET`?**
   - Razorpay signs retried webhook events with the secret that was active **when the event originally fired**. Set `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` to the old secret for 24 hours so in-flight retries verify cleanly (#1377).
3. **Did someone paste `RAZORPAY_SECRET` (API Key Secret) into `RAZORPAY_WEBHOOK_SECRET`?**
   - Webhook signatures use the Webhook Secret configured on the webhook endpoint, **not** `RAZORPAY_SECRET`.
4. **Was the webhook auto-disabled after 24h of failures?**
   - If an endpoint returns non-2xx or times out (>5s) for 24 consecutive hours, Razorpay disables the webhook and emails the Alert Email Address. Re-enable it in **Razorpay Dashboard → Developers → Webhooks** and run `scripts/payments/reconcile-payment-status.ts`, `scripts/refunds/reconcile-pending-refunds.ts`, and `scripts/disputes/reconcile-disputes.ts` to catch up on missed events.

---

## Runbook 2: Payment Succeeded in Modal, Booking Stuck in `"Confirming..."`

### Symptoms
- Buyer completed payment in `RazorpayCheckout.tsx`, landed on the confirmation poll screen, and `Payment.paymentStatus` is still `PENDING`.

### Diagnosis Steps
1. **Check `/api/checkout/verify-signature` outcome**:
   - In [`app/api/checkout/verify-signature/route.ts`](../../../../../app/api/checkout/verify-signature/route.ts), after verifying `HMAC-SHA256(order_id|payment_id, RAZORPAY_SECRET)`, the route calls `razorpayClient.payments.fetch(razorpay_payment_id)`.
   - If `gatewayPayment.status !== "captured"` (e.g., still `"authorized"` because of a capture delay), the route intentionally logs `"not captured — deferring to the webhook"` and returns `{ verified: true, pendingConfirmation: true }` without confirming the booking.
2. **Check `WebhookEvent` table for `payment.captured:<pay_id>` or `order.paid:<order_id>`**:
   - Look up `SELECT "eventId", "eventType", processed, error, "deferCount", "createdAt" FROM "WebhookEvent" WHERE "eventId" LIKE '%<order_id_or_pay_id>%';`
   - If `processed = false` and `error` is non-null (and not prefixed with `permanent:`), `scripts/cleanup/sweep-stuck-webhook-events.ts` will re-drive `processRazorpayWebhookEvent`.
3. **Check for Capture-Amount Parity Mismatch**:
   - In `handlePaymentSuccess` (`lib/payments/webhooks/handlers.ts`), if `capturedAmountPaise !== payment.amount`, the booking is refused and flagged for review/auto-refund.
4. **Run the Payment Status Reconciler**:
   - `scripts/payments/reconcile-payment-status.ts` polls `GET /v1/orders/:id` and `GET /v1/orders/:id/payments` for `PENDING` payments older than 5 minutes and drives `routeCapturedPayment` directly.

---

## Runbook 3: Refund Stuck in `PENDING` or Deferred (`DeferSignal`)

### Symptoms
- `Refund.status` remains `PENDING` (either with `refundId = "pending_<uuid>"` or `refundId = "rfnd_..."`), or `WebhookEvent` shows `deferCount > 0` for `refund.created:<rfnd_id>`.

### Diagnosis Steps
1. **Case A — `WebhookEvent.deferCount > 0` (`DeferSignal`)**:
   - `refund.created` or `refund.processed` arrived before `payment.captured` finished writing `Payment.gatewayPaymentId` / `Payment.paymentStatus = SUCCEEDED`, or `razorpayClient.payments.fetch(payment_id)` failed transiently.
   - `scripts/cleanup/sweep-stuck-webhook-events.ts` automatically re-drives deferred events every tick until the parent `Payment` row is ready.
2. **Case B — `Refund.refundId` starts with `pending_` (Phase 2 crash/timeout)**:
   - Phase 1 reserved the `Refund` row, and `Refund.id` was sent as `X-Refund-Idempotency` and `notes.reservationId` in `postRefund` (`lib/payments/core/razorpay.ts`).
   - `scripts/refunds/reconcile-pending-refunds.ts` (Pass 1) lists gateway refunds on the order, matches `metadata.reservationId === refund.id`, and binds the real `rfnd_...` ID (or retires the placeholder to `FAILED` after 24 hours if no gateway refund exists).
3. **Case C — `Refund.refundId` is `rfnd_...` and `status = PENDING`**:
   - Normal-speed Razorpay refunds (`speed: "normal"`) legitimately take **5–7 business days** to move from `"pending"` to `"processed"`.
   - Pass 2 of `reconcile-pending-refunds.ts` polls `getRazorpayRefund(rfnd_id)` and **never** ages out a refund while Razorpay still reports `"pending"`.
4. **Case D — `Refund.status = SUCCEEDED` but `cascadedAt IS NULL`**:
   - Pass 3 (`redriveStrandedRefunds` in `reconcile-pending-refunds.ts`) automatically re-drives `applyRefundCascade` (up to 3 attempts) for any `SUCCEEDED` refund whose cascade transaction did not commit within 10 minutes.

---

## Runbook 4: Payout Stuck in `PROCESSING` or Failed With `RAZORPAYX_REQUEST_FAILED`

### Symptoms
- `ConsultantPayout` or `OrganizationPayout` is stuck in `APPROVED` / `PROCESSING`, or `providerPayoutId` is `null` after a submission timeout.

### Diagnosis Steps
1. **Why didn't a timeout mark the payout `FAILED`? (`#1846 N1`)**:
   - In [`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts), `isDefinitiveGatewayRejection(error)` returns `true` **only** for HTTP `4xx` responses other than `408`, `409`, and `429`.
   - On a socket timeout, DNS error, `409`, `429`, or `5xx`, the payout may have been accepted by RazorpayX. Marking it `FAILED` immediately would release the earnings into the next batch under a new idempotency key and **pay the consultant twice**.
2. **How the system recovers a lost submit reply**:
   - Every `createPayout` call passes our internal payout row ID as `reference_id` and `boundPayoutIdempotencyKey(idempotencyKey)` (4–36 chars) in `X-Payout-Idempotency`.
   - Either an inbound `payout.initiated` / `payout.processed` webhook matches via `reference_id`, or `findRazorpayPayoutByReference(payout.id)` (`GET /v1/payouts?account_number=...&reference_id=...`) in `scripts/payouts/handle-stuck-payouts.ts` links `providerPayoutId` (`pout_...`) and adopts its status.
3. **Why did a payout stay in `processing` for days?**:
   - Official RazorpayX docs note that `IMPS` and `UPI` payouts marked as **Deemed Success** by NPCI can stay in `processing` for up to **T+3 working days** before settling to `processed` or `reversed`.

---

## Runbook 5: Razorpay Circuit Breaker Open (`razorpay`)

### Symptoms
- Calls wrapped in `withRazorpaySdkTimeout` fail fast because the `razorpay` circuit breaker in [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts) is `OPEN`.

### Key Facts
- `shouldTripRazorpayCircuitBreaker` (`#697 INF-3`) **ignores all HTTP 4xx errors except `429`** (`BAD_REQUEST_ERROR` on an invalid order/refund ID or contact proves Razorpay is reachable and never trips the breaker).
- The circuit breaker only trips on **HTTP 5xx**, **HTTP 429 (rate limit)**, or **30-second SDK timeouts / network errors**.
- Check `await getRazorpayCircuitStatus()` or `https://status.razorpay.com` to confirm whether `api.razorpay.com` is experiencing an outage or rate-limiting our account.
