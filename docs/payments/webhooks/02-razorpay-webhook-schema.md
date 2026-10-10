# Razorpay & RazorpayX Webhook Schema & Invariant Reference

> **Canonical Implementation:** [`schemas/webhooks/razorpay.ts`](../../../schemas/webhooks/razorpay.ts), [`app/api/webhooks/razorpay/signature.ts`](../../../app/api/webhooks/razorpay/signature.ts), [`app/api/webhooks/razorpay/route.ts`](../../../app/api/webhooks/razorpay/route.ts), and [`app/api/webhooks/razorpay-dispatch.ts`](../../../app/api/webhooks/razorpay-dispatch.ts).  
> **Organization Ledger & Settlement Details:** See [`docs/enterprise/10-money-and-ledger/12-payment-webhooks.md`](../../enterprise/10-money-and-ledger/12-payment-webhooks.md).

---

## 1. Signature Scope, Secret Resolution & Tamper-Proof `eventId`

### Multi-Secret HMAC Verification (`signature.ts`)

1. `RAZORPAY_WEBHOOK_SECRET` (`role: "current"`): Primary HMAC-SHA256 secret checked against the raw UTF-8 HTTP body (`x-razorpay-signature`, 64-char hex digest via `crypto.timingSafeEqual`).
2. `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` (`role: "previous"`): Checked during Dashboard secret rotation so in-flight retries signed prior to cutover succeed cleanly while logging a `WEBHOOK` `WARN` `SystemEvent`.
3. `RAZORPAYX_WEBHOOK_SECRET` (RazorpayX Banking Fallback): Consulted **only** when `isPayoutEventName(rawBody)` returns `true` (`event.startsWith("payout.") || event.startsWith("fund_account.")`). Customer payment, order, refund, and dispute events can never authenticate against `RAZORPAYX_WEBHOOK_SECRET`.

### Tamper-Proof `eventId` Derivation (`route.ts`)

Razorpay's `x-razorpay-signature` covers **only** the HTTP body bytes; HTTP headers (`x-razorpay-event-id`) are completely unsigned. Conversely, `${eventType}:${entityId}` without a body digest drops legitimate repeat updates on the same entity (such as sequential `payout.updated` webhooks when `status_details` changes followed later by bank `utr` assignment on the same `pout_...`, or multi-stage `payment.dispute.action_required` / `payment.dispute.under_review` transitions across `chargeback` and `pre_arbitration` on the same `disp_...`).

Therefore, every Razorpay webhook synthesizes a tamper-proof composite key strictly from signature-authenticated bytes:

```typescript
const bodyDigest = crypto
  .createHash("sha256")
  .update(body)
  .digest("hex")
  .slice(0, 16);

const entityId =
  event.payload?.refund?.entity?.id ||
  event.payload?.dispute?.entity?.id ||
  event.payload?.payout?.entity?.id ||
  event.payload?.["fund_account.validation"]?.entity?.id ||
  event.payload?.payment?.entity?.id ||
  event.payload?.order?.entity?.id ||
  event.account_id ||
  `body_${bodyDigest}`;

const eventId = `${eventType}:${entityId}:${bodyDigest}`;
```

---

## 2. Official Wire Quirks & Zod Normalization (`schemas/webhooks/razorpay.ts`)

### 1. PHP Empty Array `notes: []` Serialization Quirk (`razorpayNotesSchema`)

When an order, payment, refund, or payout is created without metadata notes, Razorpay's PHP serializer emits `"notes": []` (empty JSON array) instead of `{}` and may echo unquoted numbers or booleans. `razorpayNotesSchema` normalizes `[]`, `null`, `undefined`, and primitive values into a strict `Record<string, string>`:

```typescript
export const razorpayNotesSchema = z
  .union([
    z.record(z.union([z.string(), z.number(), z.boolean()]).transform(String)),
    z.array(z.unknown()).transform((): Record<string, string> => ({})),
  ])
  .nullish()
  .transform((notes): Record<string, string> => notes ?? {});
```

### 2. Multi-Attempt Checkout Modal Semantics on `payment.failed`

Inside Razorpay Checkout, all payment attempts within one checkout session share a single `order_id` (`Payment.paymentIntent`):

- **Pre-Transaction `SUCCEEDED` Fast-Path**: `handlePaymentFailure` checks `Payment.paymentStatus` before opening a database transaction under `PG_POOL_MAX=1`; if a subsequent retry on the same `order_id` already settled `SUCCEEDED`, late-arriving `payment.failed` webhooks from an earlier attempt return immediately as a no-op.
- **Active Hold Preservation (`expiresAt > now()`)**: While the booking hold has not expired (`expiresAt > now()`), `payment.failed` preserves the active slot reservation and **never restores applied wallet or referral credits** (preventing both mid-checkout slot cancellation and wallet double-spend exploits while the buyer retries inside the modal).

### 3. `refund.entity.speed_requested` vs `speed_processed` & In-Place Placeholder Adoption

- `speed_requested` is `"normal" | "optimum"` (never `"instant"`); `speed_processed` is `"normal" | "instant"`.
- In `handleRefundCreated`, incoming `refund.created` / `refund.processed` webhooks inspect `refund.entity.notes?.reservationId` inside a Serializable transaction to **adopt existing `pending_<uuid>` reservation rows in place** (`refundId = rfnd_...`) instead of creating duplicate `Refund` rows when the webhook outraces Phase 3 of the outbound HTTP call.

### 4. Dispute Lifecycle & Multi-Dispute Earnings Guard

- All 6 dispute events (`created`, `under_review`, `action_required`, `won`, `lost`, `closed`) are routed cleanly, and out-of-order deliveries (`payment.dispute.created` arriving before `payment.captured`, or `payment.dispute.*` updates arriving before `payment.dispute.created`) return `DeferSignal` for automatic re-drive by `sweep-stuck-webhook-events`.
- `respond_by` and `created_at` are Unix epoch **seconds** (multiply by `1000` for JS `Date`). No `comments` field exists on Razorpay Dispute entities (`reason_code`, `reason_description`, and `evidence.summary` carry dispute text).
- `payment.dispute.action_required` (including `pre_arbitration` escalations) legally transitions `UNDER_REVIEW -> NEEDS_RESPONSE` and refreshes `dueBy`.
- Winning or closing one dispute releases `HELD` earnings **only** when `tx.dispute.count({ where: { paymentId, id: { not: dispute.id }, status: { notIn: ["WON", "LOST", "CHARGE_REFUNDED", "CLOSED", "WARNING_CLOSED"] } } }) === 0`.

### 5. RazorpayX `payout.*` & `fund_account.validation.*` Entities

- `payout.initiated` marks transition into `processing` (`payout.processing` does not exist), while non-terminal events (`payout.queued`, `payout.pending`, `payout.initiated`) preserve `PayoutStatus.PROCESSING` on submitted consultant payouts.
- `failure_reason` is deprecated and often `null`; always read `failure_reason ?? status_details?.description ?? status_details?.reason`.
- Terminal `COMPLETED` transitions exclude terminal statuses via CAS `WHERE` so delayed `payout.processed` / `payout.updated` events never resurrect reversed payouts, while raising `PAYOUT_COMPLETED_AFTER_LOCAL_FAILED` error alerts if RazorpayX disburses a payout previously marked `FAILED`.
- `markConsultantPayoutReversed` and `markOrgPayoutReversed` handle both `COMPLETED -> REVERSED` (inverse ledger journal + reopening `PAID -> READY` earnings + TDS reversal) and pre-settlement `PENDING`/`PROCESSING`(/`APPROVED`) -> `REVERSED` (detaching `BATCHED -> READY` earnings with no inverse journal) inside **one atomic Prisma transaction (`tx`)**.
- `fundAccountValidationEntitySchema` normalizes `null` values on `fund_account`, `results`, `validation_results`, and `status_details` to `undefined`. `handleFundAccountValidationWebhook` requires **both** `status === "completed"` and `summary.accountStatus === "valid"` (`account_status === "active"`), verifying `PayoutAccount` / `OrganizationPayoutAccount` strictly by `fund_account.id` and falling back to `{ id: referenceId, status: "PENDING_VERIFICATION" }` -> `"FAILED_VERIFICATION"` when `fund_account` is `null` on failed validations.

---

## 3. Complete Validated Event Catalog (25 Events)

```typescript
export const RazorpayEventTypeSchema = z.enum([
  // Payment & Order Events
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "order.paid",

  // Refund Events
  "refund.created",
  "refund.processed",
  "refund.failed",
  "refund.speed_changed",

  // Dispute Events (All 6 Official Events)
  "payment.dispute.created",
  "payment.dispute.under_review",
  "payment.dispute.action_required",
  "payment.dispute.won",
  "payment.dispute.lost",
  "payment.dispute.closed",

  // Settlement Events
  "settlement.processed",
  "settlement.failed",

  // RazorpayX Payout Events (All 9 Official Events)
  "payout.initiated",
  "payout.updated",
  "payout.processed",
  "payout.reversed",
  "payout.failed",
  "payout.rejected",
  "payout.queued",
  "payout.pending",
  "payout.cancelled",

  // RazorpayX Fund Account Validation (Penny Drop & UPI RPD) Events
  "fund_account.validation.completed",
  "fund_account.validation.failed",
]);
```

---

## Deprecated & Superseded Approaches

- **Strict `z.record(z.string())` on `notes`**: Superseded by `razorpayNotesSchema` because Razorpay serializes empty notes in PHP as JSON `[]`, which previously threw Zod schema errors on clean payments, refunds, and payouts.
- **Dispute Entity Schema Assuming a `comments` Field or Blocking `UNDER_REVIEW -> NEEDS_RESPONSE`**: Superseded by `reason_description` / `evidence.summary` extraction and legal `UNDER_REVIEW -> NEEDS_RESPONSE` transitions for `action_required` / `pre_arbitration` phases.
- **Dropping `fund_account.validation.*` and `payout.cancelled` / `payout.updated` Webhooks**: Superseded by full `RAZORPAYX_WEBHOOK_SECRET` verification via `isPayoutEventName` and atomic single-transaction payout & RPD settlement handlers.
