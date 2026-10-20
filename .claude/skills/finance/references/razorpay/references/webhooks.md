# Razorpay Webhooks — Verification, Dedup, Dispatch & Durability

Official citations:

- [Webhooks Overview & Setup](https://razorpay.com/docs/webhooks/setup-edit-payments/)
- [Validate & Test Webhooks](https://razorpay.com/docs/webhooks/validate-test/)
- [Webhook Best Practices](https://razorpay.com/docs/webhooks/best-practices/)
- [Webhooks FAQs (Timeout, Retries, Auto-Disable, Support Replay)](https://razorpay.com/docs/webhooks/faqs/)

## Where It Lives in This Repo

| File                                                                                              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`app/api/webhooks/razorpay/route.ts`](../../../../../app/api/webhooks/razorpay/route.ts)         | `POST /api/webhooks/razorpay` (`export const runtime = "nodejs"`). Body size cap, HMAC verification across payment & RazorpayX secrets, DB health check (`503`), envelope parse, `eventId` keying (`${eventType}:${entityId}:${x-razorpay-event-id}`, falling back to `sha256(rawBody).slice(0, 16)`; the id header is unsigned), `logWebhookEvent`, immediate `200 OK`, and `after()` dispatch. |
| [`app/api/webhooks/razorpay/signature.ts`](../../../../../app/api/webhooks/razorpay/signature.ts) | `verifyRazorpaySignature`, `resolveRazorpayPaymentSecrets` (`RAZORPAY_WEBHOOK_SECRET` + `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`), `matchRazorpayWebhookSecret`, `isPayoutEventName` (`payout.*` and `fund_account.*`).                                                                                                                                                                                |
| [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts)   | `processRazorpayWebhookEvent` and `routeCapturedPayment` — shared by the webhook route's `after()` callback and `scripts/cleanup/sweep-stuck-webhook-events.ts`.                                                                                                                                                                                                                                 |
| [`lib/webhooks/event-log.ts`](../../../../../lib/webhooks/event-log.ts)                           | `logWebhookEvent`, `markWebhookEventProcessed`, CAS `WebhookClaim` fencing (`claimedAt`), and `TERMINAL_ERROR_PREFIXES` (`gave up:`, `permanent:`).                                                                                                                                                                                                                                              |
| [`schemas/webhooks/razorpay.ts`](../../../../../schemas/webhooks/razorpay.ts)                     | `razorpayNotesSchema` (PHP `[]` array normalization), payment/order/refund/dispute/payout/fund-account-validation Zod schemas, and `razorpayWebhookEnvelopeSchema`.                                                                                                                                                                                                                              |

---

## 1. Verified Official Razorpay Webhook Delivery Rules

1. **5-Second Timeout**:
   - Razorpay requires a `2XX` response within **5 seconds** (`https://razorpay.com/docs/webhooks/best-practices/`). Any non-2xx status or response exceeding 5 seconds is treated as a delivery failure.
   - `route.ts` verifies the signature and persists the idempotency row synchronously via `logWebhookEvent`, then schedules `processRazorpayWebhookEvent` inside Next.js `after()` before returning `200 OK`.
2. **Exponential Backoff for 24 Hours & Auto-Disable**:
   - Failed deliveries retry with exponential backoff across a **24-hour** window from event creation.
   - If every attempt across 24 hours fails, **Razorpay disables the webhook endpoint automatically** and emails the configured Alert Email Address.
3. **No Self-Serve Dashboard Replay (Support Ticket Only, ≤ 15 Days)**:
   - Missed deliveries cannot be replayed from the Razorpay Dashboard UI; recovery requires a Razorpay Technical Support ticket (only for enabled endpoints and events ≤ 15 days old).
   - Scheduled reconcilers (`reconcile-payment-status`, `reconcile-pending-refunds`, `reconcile-disputes`, `reconcile-payout-status`) poll Razorpay REST APIs directly as an independent backstop.

---

## 2. Signature Verification, Secret Rotation & RazorpayX Scope (`signature.ts`)

Razorpay signs the **raw HTTP request body** using HMAC-SHA256 and transmits the 64-character lowercase hex digest in `x-razorpay-signature`.

```ts
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

1. **`RAZORPAY_WEBHOOK_SECRET` (`role: "current"`)**: Tried first for all inbound events.
2. **`RAZORPAY_WEBHOOK_SECRET_PREVIOUS` (`role: "previous"`)**: Tried second during secret rotation. Razorpay continues signing in-flight retries generated before a Dashboard secret change with the previous secret; matching `"previous"` emits a `WARN` `SystemEvent` so operators can retire the grace secret once traffic drains.
3. **`RAZORPAYX_WEBHOOK_SECRET` (RazorpayX Banking & Validation Fallback)**: Tried **only** when `isPayoutEventName(body)` returns `true` (`event.startsWith("payout.") || event.startsWith("fund_account.")`). Non-RazorpayX events (`payment.captured`, `refund.processed`, etc.) are strictly rejected under `RAZORPAYX_WEBHOOK_SECRET` so the payout webhook key can never be abused to forge customer payment confirmations.

---

## 3. `eventId`: `${eventType}:${entityId}:${x-razorpay-event-id | sha256(rawBody).slice(0, 16)}`

`route.ts` keys dedupe on Razorpay's own event id when the `x-razorpay-event-id` header is present and well formed (`/^[A-Za-z0-9_-]{1,64}$/`), and on a 16-character SHA-256 digest of the raw body otherwise. Razorpay keeps the same event id across its retries and dashboard replays, which is exactly the boundary dedupe needs, and two distinct upstream updates on one entity (a `payout.updated` with a later `utr`, a dispute phase change) arrive as two events with two ids.

The event type and entity id always come from the signed body, so a forged header can only re-key the same verified event. The trade-off is known and accepted: the header is not covered by `x-razorpay-signature`, so a party holding a captured `(body, signature)` pair could replay it under new header values. Every handler is idempotent (ledger keys, CAS status guards), so such a replay re-runs no money movement; it only adds a `WebhookEvent` row.

- **Most-specific entity probing**: refund events ship `contains: ["refund", "payment"]` and dispute events ship `contains: ["payment", "dispute"]`, so `refund`, `dispute`, `payout` and `fund_account.validation` are probed before `payment`.

---

## 4. Schema Normalization & Multi-Attempt Checkout Semantics

### `razorpayNotesSchema` (PHP `notes: []` Serialization Quirk)

Razorpay's backend serializes empty associative arrays in PHP as JSON `[]` (`"notes": []`) instead of `{}` whenever an order, payment, refund, or payout is created without custom notes, and may echo numeric or boolean values unquoted. `razorpayNotesSchema` (`z.unknown().transform(...)`) normalizes `[]`, `null`, `undefined`, and primitive map values into a uniform `Record<string, string>` across all webhook entity schemas so empty notes never trigger Zod schema failures.

### `payment.failed` Multi-Attempt Modal Semantics (`handlePaymentFailure`)

Inside Razorpay Checkout, a single `order_id` (`Payment.paymentIntent`) spans multiple payment attempts while the checkout modal stays open:

1. **In-Transaction `SUCCEEDED` Guard**: Inside its transaction under `PG_POOL_MAX=1`, `handlePaymentFailure` checks `payment.paymentStatus === "SUCCEEDED"` and exits immediately if the order is already `SUCCEEDED` (protecting against late-arriving `payment.failed` webhooks from an earlier failed card/UPI attempt after a retry on the same order already succeeded).
2. **Active Hold Preservation (`expiresAt > now()`)**: While the appointment or checkout hold has not yet expired (`expiresAt > now()`), an intermediate `payment.failed` attempt **preserves** the slot hold, keeps customer-facing `Payment.description` untouched, and **never restores applied wallet or referral credits** on that `order_id`:
   - Destroying the hold mid-modal caused attempt #2's `payment.captured` to land on a released slot and trigger an unintended auto-refund.
   - Restoring applied wallet/referral credits on attempt #1 while `order_id` remained payable allowed a malicious buyer to spend the restored wallet balance on a second booking and still complete attempt #2 on the original order.
   - Only when the hold has already expired (`expiresAt <= now()`) or cleanup reaps the expired checkout are applied wallet/referral credits reversed.

---

## 5. Durability: `PG_POOL_MAX=1`, `after()` Freeze Recovery & CAS Fencing

Because serverless containers run under `PG_POOL_MAX=1` and Netlify may freeze execution immediately after `POST /api/webhooks/razorpay` flushes `200 OK` (leaving `WebhookEvent` rows in `processed = false, error = null`), durability relies on three invariants:

1. **CAS Claim Fencing (`WebhookClaim` on `claimedAt`)**: `logWebhookEvent` and `reclaimStaleProcessingWebhookEvent` stamp `claimedAt` atomically via conditional `updateMany`, and `markWebhookEventProcessed` fences completion writes on `where: { eventId, claimedAt: claim.claimedAt }`. A slow or unfreezing worker whose lease (>5 minutes) was superseded cannot overwrite the newer worker's terminal state.
2. **Per-Event Timeout in `sweep-stuck-webhook-events`**: The stuck-event sweeper (`scripts/cleanup/sweep-stuck-webhook-events.ts`, invoked via `/api/cleanup/sweep-stuck-webhook-events`) wraps each re-driven webhook in a bounded per-event timeout so a single hung downstream call never exhausts the sweep window or starves `PG_POOL_MAX=1`.
3. **`DeferSignal` vs. `TERMINAL_ERROR_PREFIXES`**: Out-of-order events (`DeferSignal`) increment `deferCount` and leave `processed = false, error = null` for clean re-drive (alerting Sentry when `deferCount >= 5` or age `> 1h`, and capping at `gave up:` after 168h), whereas Zod schema mismatches stamp `permanent:` and never churn.

---

## Deprecated & Superseded Approaches

- **Keying Deduplication on the Body Hash Alone**: Superseded by preferring `x-razorpay-event-id`, which Razorpay holds stable across retries and dashboard replays; the body hash remains the fallback when the header is absent.
- **Keying Deduplication on `${eventType}:${entityId}` Without Body Hash**: Superseded because repeat state transitions on one entity (`payout.updated` UTR assignment after status details update, multi-stage `payment.dispute.action_required`) share `(eventType, entityId)` and were falsely discarded as duplicates.
- **Restricting `RAZORPAYX_WEBHOOK_SECRET` Fallback to `payout.*` Only**: Superseded by `isPayoutEventName` accepting both `payout.*` and `fund_account.*` so `fund_account.validation.{completed,failed}` RPD webhooks verify cleanly under the RazorpayX secret.
- **Immediate Slot Cancellation & Wallet Credit Restoration on Every `payment.failed`**: Superseded by active hold preservation (`expiresAt > now()`) because Razorpay reuses one `order_id` across multiple in-modal payment attempts.
