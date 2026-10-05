# Razorpay & RazorpayX Webhook Schema Reference

> **Canonical Source:** [`schemas/webhooks/razorpay.ts`](../../../schemas/webhooks/razorpay.ts) and [`app/api/webhooks/razorpay-dispatch.ts`](../../../app/api/webhooks/razorpay-dispatch.ts).  
> **Organization / B2B Details:** See [`docs/enterprise/10-money-and-ledger/12-payment-webhooks.md`](../../enterprise/10-money-and-ledger/12-payment-webhooks.md).

**Last Updated**: 2026-10-05

---

## Overview

All inbound webhooks from both **Razorpay Payments** (orders, payments, refunds, disputes, settlements) and **RazorpayX** (payouts, fund account validations) arrive at `POST /api/webhooks/razorpay` ([`app/api/webhooks/razorpay/route.ts`](../../../app/api/webhooks/razorpay/route.ts)) and are validated against [`schemas/webhooks/razorpay.ts`](../../../schemas/webhooks/razorpay.ts).

### Critical Official Razorpay Payload Nuances

1. **`refund.entity.speed_requested` vs `speed_processed`**:
   - `speed_requested` is `"normal" | "optimum"` (NEVER `"instant"` — Razorpay's Refunds API accepts `speed: "normal" | "optimum"`, and echoes that in `speed_requested`).
   - `speed_processed` is `"normal" | "instant"` (indicating whether Razorpay was actually able to execute an instant refund or fell back to normal speed).
2. **`order.paid` carries BOTH `order` and `payment` entities**:
   - In `order.paid` events, `contains` is `["payment", "order"]` and `payload` includes both `payload.order.entity` and `payload.payment.entity`.
3. **All 6 `payment.dispute.*` events**:
   - `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed`, `payment.dispute.under_review`, and `payment.dispute.action_required`.
   - `respond_by` and `created_at` are Unix epoch **seconds** (multiply by `1000` for JS `Date`).
   - Note: The official Razorpay Dispute webhook entity does **not** include a `comments` field (`reason_code`, `status`, `phase`, `amount_deducted`, and `respond_by` are the core fields).
4. **RazorpayX `payout.*` events & `status_details`**:
   - RazorpayX emits `payout.initiated` when a payout transitions into `processing` (not `payout.processed`, which fires on bank credit completion).
   - Top-level `failure_reason` is deprecated on modern RazorpayX payloads and frequently `null`; always fall back to `status_details.description ?? status_details.reason`.
5. **RazorpayX `fund_account.validation.*` (`fav_...`)**:
   - `status: "completed"` only means the validation check finished — you **must** inspect `results.account_status === "active"` (vs `"invalid"`) and `results.registered_name`.

---

## Validated Event Catalog (24 Events)

```typescript
export const RazorpayEventTypeSchema = z.enum([
  // Payment Events
  "payment.authorized",
  "payment.captured",
  "payment.failed",

  // Order Events
  "order.paid",

  // Refund Events
  "refund.created",
  "refund.processed",
  "refund.failed",
  "refund.speed_changed",

  // Dispute Events (All 6 Official Events)
  "payment.dispute.created",
  "payment.dispute.won",
  "payment.dispute.lost",
  "payment.dispute.closed",
  "payment.dispute.under_review",
  "payment.dispute.action_required",

  // Settlement Events
  "settlement.processed",
  "settlement.failed",

  // RazorpayX Payout Events
  "payout.initiated",
  "payout.updated",
  "payout.processed",
  "payout.reversed",
  "payout.failed",
  "payout.rejected",
  "payout.queued",
  "payout.pending",

  // RazorpayX Fund Account Validation (Penny Drop) Events
  "fund_account.validation.completed",
  "fund_account.validation.failed",
]);
```

> **Why `subscription.*` and `invoice.*` are not in this list**: Familiarise manages recurring billing in-house (`BillingSubscription` + per-cycle Razorpay Orders) and generates GST tax invoices in-house (`lib/invoices/`, `lib/compliance/gst.ts`). Any unrecognized webhook event type is safely logged and acknowledged with HTTP `200` (`status: "ignored"`) so Razorpay does not retry or auto-disable the webhook endpoint.

---

## Core Entity Schemas (`schemas/webhooks/razorpay.ts`)

### 1. Payment & Order Entities

```typescript
export const RazorpayPaymentEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("payment"),
  amount: z.number(), // in paise
  currency: z.string(),
  status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
  order_id: z.string().nullable(),
  invoice_id: z.string().nullable().optional(),
  international: z.boolean().optional(),
  method: z.string(), // card, netbanking, wallet, emi, upi, bank_transfer
  amount_refunded: z.number().optional(),
  refund_status: z.enum(["partial", "full"]).nullable().optional(),
  captured: z.boolean(),
  description: z.string().nullable().optional(),
  email: z.string().optional(),
  contact: z.string().optional(),
  notes: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
  fee: z.number().nullable().optional(),
  tax: z.number().nullable().optional(),
  error_code: z.string().nullable().optional(),
  error_description: z.string().nullable().optional(),
  error_source: z.string().nullable().optional(),
  error_step: z.string().nullable().optional(),
  error_reason: z.string().nullable().optional(),
  acquirer_data: z
    .object({
      rrn: z.string().nullable().optional(),
      upi_transaction_id: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
  upi: z
    .object({
      vpa: z.string().nullable().optional(),
      payer_account_type: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
  created_at: z.number(),
});

export const RazorpayOrderEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("order"),
  amount: z.number(),
  amount_paid: z.number(),
  amount_due: z.number(),
  currency: z.string(),
  receipt: z.string().nullable().optional(),
  status: z.enum(["created", "attempted", "paid"]),
  attempts: z.number(),
  notes: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
  created_at: z.number(),
});
```

### 2. Refund Entity

```typescript
export const RazorpayRefundEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("refund"),
  amount: z.number(), // in paise
  currency: z.string(),
  payment_id: z.string(),
  notes: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
  receipt: z.string().nullable().optional(),
  acquirer_data: z
    .object({
      arn: z.string().nullable().optional(),
      rrn: z.string().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  created_at: z.number(),
  batch_id: z.string().nullable().optional(),
  status: z.enum(["pending", "processed", "failed"]),
  // Official Razorpay values:
  // - speed_requested: "normal" | "optimum" (never "instant")
  // - speed_processed: "normal" | "instant"
  speed_processed: z.enum(["normal", "instant"]).nullable().optional(),
  speed_requested: z.enum(["normal", "optimum"]).nullable().optional(),
});
```

### 3. Dispute Entity

```typescript
export const RazorpayDisputeEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("dispute"),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string(),
  amount_deducted: z.number(),
  reason_code: z.string(),
  respond_by: z.number(), // Unix epoch seconds
  status: z.enum([
    "open",
    "under_review",
    "Action_Required",
    "action_required",
    "won",
    "lost",
    "closed",
  ]),
  phase: z.enum([
    "fraud",
    "chargeback",
    "pre_arbitration",
    "arbitration",
  ]),
  comments: z.string().nullable().optional(),
  created_at: z.number(),
});
```

### 4. RazorpayX Payout & Fund Account Validation Entities

```typescript
export const RazorpayPayoutEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("payout"),
  fund_account_id: z.string(),
  amount: z.number(), // in paise
  currency: z.string(),
  notes: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
  fees: z.number().optional(),
  tax: z.number().optional(),
  status: z.enum([
    "queued",
    "pending",
    "rejected",
    "processing",
    "processed",
    "cancelled",
    "reversed",
    "failed",
  ]),
  purpose: z.string(),
  utr: z.string().nullable(),
  mode: z.enum(["NEFT", "RTGS", "IMPS", "UPI", "card", "amazonpay"]),
  reference_id: z.string().nullable().optional(),
  narration: z.string().nullable().optional(),
  batch_id: z.string().nullable().optional(),
  failure_reason: z.string().nullable().optional(),
  status_details: z
    .object({
      reason: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  created_at: z.number(),
});

export const RazorpayFundAccountValidationEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("fund_account.validation"),
  fund_account: z.object({
    id: z.string(),
    entity: z.literal("fund_account"),
    contact_id: z.string().optional(),
    account_type: z.enum(["bank_account", "vpa"]),
    bank_account: z
      .object({
        name: z.string().optional(),
        bank_name: z.string().optional(),
        ifsc: z.string(),
        account_number: z.string(),
      })
      .optional(),
    vpa: z
      .object({
        username: z.string().optional(),
        handle: z.string().optional(),
        address: z.string(),
      })
      .optional(),
  }),
  status: z.enum(["created", "completed", "failed"]),
  amount: z.number().optional(),
  currency: z.string().optional(),
  results: z
    .object({
      account_status: z.string().nullable().optional(), // "active" | "invalid"
      registered_name: z.string().nullable().optional(),
    })
    .optional(),
  validation_results: z
    .object({
      account_status: z.string().nullable().optional(),
      registered_name: z.string().nullable().optional(),
    })
    .optional(),
  created_at: z.number(),
  utr: z.string().nullable().optional(),
});
```
