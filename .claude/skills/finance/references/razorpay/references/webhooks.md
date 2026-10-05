# Razorpay Webhooks — Verification, Dedup, Dispatch & Durability

Official citations:
- [Webhooks Overview & Setup](https://razorpay.com/docs/webhooks/setup-edit-payments/)
- [Validate & Test Webhooks](https://razorpay.com/docs/webhooks/validate-test/)
- [Webhook Best Practices](https://razorpay.com/docs/webhooks/best-practices/)
- [Webhooks FAQs (Timeout, Retries, Auto-Disable, Support Replay)](https://razorpay.com/docs/webhooks/faqs/)

## Where It Lives in This Repo

| File | Responsibility |
|---|---|
| [`app/api/webhooks/razorpay/route.ts`](../../../../../app/api/webhooks/razorpay/route.ts) | `POST /api/webhooks/razorpay` (`export const runtime = "nodejs"`). Body size cap, HMAC verification, DB health check (`503`), envelope parse, tamper-proof `eventId` synthesis, `logWebhookEvent`, immediate `200 OK`, and `after()` dispatch. |
| [`app/api/webhooks/razorpay/signature.ts`](../../../../../app/api/webhooks/razorpay/signature.ts) | `verifyRazorpaySignature`, `resolveRazorpayPaymentSecrets` (`RAZORPAY_WEBHOOK_SECRET` + `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`), `matchRazorpayWebhookSecret`, `isPayoutEventName`. |
| [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts) | `processRazorpayWebhookEvent` and `routeCapturedPayment` — shared by the webhook route's `after()` callback and `scripts/cleanup/sweep-stuck-webhook-events.ts`. |
| [`app/api/webhooks/utils.ts`](../../../../../app/api/webhooks/utils.ts) | `logWebhookEvent`, `markWebhookEventProcessed`, `DeferSignal`, org payment/refund/dispute/payout handlers. |
| [`schemas/webhooks/razorpay.ts`](../../../../../schemas/webhooks/razorpay.ts) | Zod schemas for `payment.captured`, `order.paid`, `payment.failed`, and the outer `razorpayWebhookEnvelopeSchema`. |

---

## 1. Verified Official Razorpay Webhook Delivery Rules

1. **5-Second Timeout**:
   - Razorpay requires a `2XX` response within **5 seconds** (`https://razorpay.com/docs/webhooks/best-practices/`). Any non-2xx status or >5s response is marked as a delivery failure.
   - Our route completes signature check + `logWebhookEvent` synchronously and schedules `processRazorpayWebhookEvent` inside Next.js `after()` before returning `200 OK`.
2. **Exponential Backoff for 24 Hours & Auto-Disable**:
   - Failed deliveries are retried with exponential backoff for **24 hours** from `created_at`.
   - If the endpoint still fails after 24 hours, **Razorpay disables the webhook automatically** and emails the Alert Email Address configured on the webhook (or the Dashboard Account & Settings email).
3. **No Self-Serve Dashboard Replay (Support Ticket Only, ≤ 15 Days)**:
   - Missed webhooks **cannot** be replayed from the Razorpay Dashboard UI.
   - Replay requires filing a Razorpay Technical Support ticket, subject to 4 strict rules (`https://razorpay.com/docs/webhooks/faqs/`):
     1. The webhook must have been enabled on the Dashboard when the event occurred.
     2. The event must **not be older than 15 days**.
     3. Signature verification must accept the secret that was active when the event originally fired.
     4. Bulk replay is not supported.
   - Because missed webhooks cannot be replayed self-serve, our scheduled reconcilers (`reconcile-payment-status.ts`, `reconcile-pending-refunds.ts`, `reconcile-disputes.ts`, `reconcile-payout-status.ts`) poll Razorpay's REST APIs directly as a backstop.

---

## 2. Signature Verification & Zero-Downtime Secret Rotation (`signature.ts`)

Razorpay signs the **raw request body** with HMAC-SHA256 and sends the 64-character hex digest in `x-razorpay-signature`.

```ts
// app/api/webhooks/razorpay/signature.ts
const HMAC_SHA256_HEX_LENGTH = 64;

export function verifyRazorpaySignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (signature.length !== HMAC_SHA256_HEX_LENGTH) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const signatureBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}
```

### Multi-Secret Resolution Order (`route.ts` + `signature.ts`)

1. **`RAZORPAY_WEBHOOK_SECRET` (`role: "current"`)**: Tried first for all events.
2. **`RAZORPAY_WEBHOOK_SECRET_PREVIOUS` (`role: "previous"`)**: Tried second if configured (#1377). Official Razorpay docs note that when you rotate a webhook secret in the Dashboard, events triggered before the rotation that are still retrying continue to be signed with the **old** secret. When a delivery matches `"previous"`, `route.ts` logs a `WARN` `SystemEvent` so operators know when the grace window has drained.
3. **`RAZORPAYX_WEBHOOK_SECRET` (Payouts fallback)**: Tried **only** when `isPayoutEventName(body)` is `true` (`event.startsWith("payout.")`). A non-payout event (`payment.captured`, `refund.processed`, etc.) is **never** accepted under the RazorpayX secret.

---

## 3. Why We Synthesize `eventId` From the Signed Body (Not `x-razorpay-event-id`)

Razorpay sends an `x-razorpay-event-id` header that stays constant across retries of the same delivery. However, **`app/api/webhooks/razorpay/route.ts` deliberately does NOT use `x-razorpay-event-id` as the deduplication key**:

1. **`x-razorpay-signature` covers the HTTP body only — HTTP headers are unsigned.** If we keyed `WebhookEvent.eventId` on `x-razorpay-event-id`, an attacker who captured a single valid `(body, x-razorpay-signature)` pair could replay it $N$ times with $N$ invented `x-razorpay-event-id` headers.
2. **Entity-specificity (`#1132`)**: Refund webhooks carry `contains: ["refund", "payment"]` (both `payload.refund.entity` and `payload.payment.entity`), and dispute webhooks carry `contains: ["payment", "dispute"]`. Probing `payment.entity.id` first would key every partial refund or dispute on the same payment to the same `payment_id` and drop the second partial refund as a duplicate!

Therefore, `route.ts` derives `entityId` **most-specific entity first** from signature-covered body fields:

```ts
// app/api/webhooks/razorpay/route.ts
const entityId =
  event.payload?.refund?.entity?.id ||
  event.payload?.dispute?.entity?.id ||
  event.payload?.payout?.entity?.id ||
  event.payload?.payment?.entity?.id ||
  event.payload?.order?.entity?.id ||
  event.account_id ||
  `body_${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
const eventId = `${eventType}:${entityId}`;
```

---

## 4. All Handled Webhook Events (`app/api/webhooks/razorpay-dispatch.ts`)

| Category | Event Name | Payload Entities (`contains`) | Handler in `razorpay-dispatch.ts` |
|---|---|---|---|
| **Payments & Orders** | `payment.captured` | `["payment"]` | `routeCapturedPayment` (routes by `notes.type`) |
| | `order.paid` | `["payment", "order"]` | `routeCapturedPayment` (uses `payload.payment?.entity` for `pay_*` ID and captured amount) |
| | `payment.failed` | `["payment"]` | `handleOrgPaymentFailure` / `handleOverageMemberFailure` / `handleRecordingPurchaseFailure` / `handlePaymentFailure` |
| **Refunds** | `refund.created` | `["refund", "payment"]` | Resolves `payment_id` → `order_id` via `Payment.gatewayPaymentId` index (fallback: `payments.fetch`), then calls `handleRefundCreated` |
| | `refund.processed` | `["refund", "payment"]` | Same as `refund.created` → `handleRefundCreated` |
| | `refund.failed` | `["refund", "payment"]` | Same resolution → `handleRefundCreated(..., "failed", ...)` |
| | `refund.speed_changed` | `["refund", "payment"]` | Informational log (e.g., `"optimum"` instant refund fell back to `"normal"`) |
| **Disputes** | `payment.dispute.created` | `["payment", "dispute"]` | `handleDisputeCreated` (freezes earning/payout, records `respond_by` deadline and `deduct_at_onset`) |
| | `payment.dispute.under_review` | `["payment", "dispute"]` | `handleDisputeUpdated(id, status, null)` → `UNDER_REVIEW` |
| | `payment.dispute.action_required` | `["payment", "dispute"]` | `handleDisputeUpdated(id, status, null)` → `NEEDS_RESPONSE` |
| | `payment.dispute.won` | `["payment", "dispute"]` | `handleDisputeUpdated(id, "won", null)` → releases held earnings |
| | `payment.dispute.lost` | `["payment", "dispute"]` | `handleDisputeUpdated(id, "lost", null)` → `settleLostDispute` (ledger reversal + clawback) |
| | `payment.dispute.closed` | `["payment", "dispute"]` | `handleDisputeUpdated(id, status, null)` |
| **RazorpayX Payouts** | `payout.processed` | `["payout"]` | `handleRazorpayPayoutWebhook` → persists `utr`, marks org/consultant payout `COMPLETED` |
| | `payout.failed` | `["payout"]` | `handleRazorpayPayoutWebhook` → extracts `failure_reason ?? status_details.description`, marks `FAILED`, un-batches earnings to `READY` |
| | `payout.rejected` | `["payout"]` | `handleRazorpayPayoutWebhook` → marks `FAILED`, un-batches earnings |
| | `payout.reversed` | `["payout"]` | `handleRazorpayPayoutWebhook` → `markOrgPayoutReversed` / `markConsultantPayoutReversed` (posts inverse ledger journal if already `COMPLETED`) |
| | `payout.initiated` | `["payout"]` | `handleRazorpayPayoutWebhook` (fired when payout enters `processing` state; backfills `providerPayoutId` via `reference_id` if submit reply was lost) |
| | `payout.updated` | `["payout"]` | `handleRazorpayPayoutWebhook` (fired when `utr` or `status_details` updates) |
| | `payout.queued`, `payout.pending`, `payout.cancelled` | `["payout"]` | `handleRazorpayPayoutWebhook` |

> **Falsified event names to avoid:**
> - There is **no** `order.created` webhook event (`order.paid` is the only Order event).
> - There is **no** `refund.arn_updated` webhook event in Razorpay (`refund.created`, `refund.processed`, `refund.failed`, and `refund.speed_changed` are the only 4 Refund events).
> - There is **no** `payout.processing` webhook event name — RazorpayX names that event **`payout.initiated`** (with `payload.payout.entity.status === "processing"`).

---

## 5. Durability: `DeferSignal`, `permanent:` Errors & Stuck-Event Sweeper

1. **`DeferSignal` (Out-of-Order Delivery Race, `#812`/`#813`)**:
   - If `refund.created` or `refund.processed` arrives before `payment.captured` has finished writing the `Payment` row, `handleRefundCreated` returns a `DeferSignal` instead of throwing or dropping the event.
   - `processRazorpayWebhookEvent` increments `WebhookEvent.deferCount` and leaves `processed = false, error = null` so `scripts/cleanup/sweep-stuck-webhook-events.ts` re-drives it on the next tick.
2. **Schema Mismatch (`permanent:` Prefix, `FAMILIARISE_WEB-3W`)**:
   - If a webhook payload fails Zod validation (`ZodError`), retrying it will never succeed. `processRazorpayWebhookEvent` marks the `WebhookEvent.error` with `permanent: schema mismatch: ...` so the stuck-event sweeper does not re-drive it for 168 hours.
3. **Database Unreachable (`503 Service Unavailable`)**:
   - Before logging the event, `route.ts` checks `isDbHealthy()`. If Postgres is unreachable, it returns HTTP `503` before claiming the event so Razorpay's exponential backoff retries the delivery.
