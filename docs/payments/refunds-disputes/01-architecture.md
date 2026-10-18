# Refunds & Disputes Architecture

> **Moved (org/B2B side):** The organization-side documentation for this subsystem now lives in [`docs/enterprise/10-money-and-ledger/10-refunds.md`](../../enterprise/10-money-and-ledger/10-refunds.md), [`11-disputes.md`](../../enterprise/10-money-and-ledger/11-disputes.md), and [`12-payment-webhooks.md`](../../enterprise/10-money-and-ledger/12-payment-webhooks.md). This file keeps the consumer-marketplace (B2C) and gateway-generic details only.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Admin Dashboard                              │
│                    (Refund/Dispute Management)                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          API Layer                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │ /api/payments/  │  │ /api/payments/  │  │ /api/admin/     │     │
│  │ refunds         │  │ disputes        │  │ disputes        │     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘     │
└───────────┼────────────────────┼────────────────────┼───────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Payment Gateway Layer                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    lib/payments/index.ts                     │   │
│  │        createRefund() | listRefunds() | submitEvidence()     │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                             │                                        │
│  ┌──────────────────────────┴──────────────────────────┐           │
│  │                                                      │           │
│  ▼                                                      ▼           │
│  ┌─────────────────────┐              ┌─────────────────────┐      │
│  │ lib/payments/core/  │              │ lib/payments/core/  │      │
│  │ stripe.ts           │              │ razorpay.ts         │      │
│  │ - createStripeRefund│              │ - createRazorpay... │      │
│  │ - submitStripe...   │              │                     │      │
│  └─────────┬───────────┘              └─────────┬───────────┘      │
└────────────┼────────────────────────────────────┼───────────────────┘
             │                                    │
             ▼                                    ▼
┌─────────────────────┐              ┌─────────────────────┐
│    Stripe API       │              │   Razorpay API      │
│  - Refunds          │              │   - Refunds         │
│  - Disputes         │              │   - Disputes        │
└─────────────────────┘              └─────────────────────┘
```

---

## Component Details

### API Routes

| Route                      | File                                          | Description                        |
| -------------------------- | --------------------------------------------- | ---------------------------------- |
| `/api/payments/refunds`    | `app/api/payments/refunds/route.ts`           | Create and list refunds            |
| `/api/payments/disputes`   | `app/api/payments/disputes/route.ts`          | List disputes, submit evidence     |
| `/api/admin/disputes`      | `app/api/admin/disputes/route.ts`             | Admin disputes list with filtering |
| `/api/admin/disputes/[id]` | `app/api/admin/disputes/[disputeId]/route.ts` | Single dispute details             |

### Core Payment Libraries

| File                            | Functions                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `lib/payments/index.ts`         | Gateway abstraction: `createRefund()`, `listRefunds()`, `listDisputes()`, `submitDisputeEvidence()` |
| `lib/payments/core/razorpay.ts` | Razorpay implementation: `createRazorpayRefund()`, `listRazorpayRefunds()`                          |

---

## Database Schema

### Refund Model

```prisma
model Refund {
  id             String         @id @default(cuid())
  amount         Int            // Amount in smallest currency unit (cents/paise)
  currency       String         @default("USD")
  reason         String?        // Optional reason for refund
  status         String         // PENDING, SUCCEEDED, FAILED, CANCELLED
  refundId       String         @unique  // Gateway-assigned refund ID
  paymentGateway PaymentGateway
  metadata       Json?          // Additional gateway-specific data
  paymentId      String
  payment        Payment        @relation(fields: [paymentId], references: [id])
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt

  @@index([paymentId])
  @@index([status])
}
```

### Dispute Model

```prisma
model Dispute {
  id                 String         @id @default(cuid())
  disputeId          String         @unique  // Gateway dispute ID (dp_xxx for Stripe)
  amount             Int            // Disputed amount
  currency           String         @default("USD")
  reason             String?        // Dispute reason (fraudulent, product_not_received, etc.)
  status             DisputeStatus  // Current dispute status
  dueBy              DateTime?      // Evidence submission deadline
  isChargeRefundable Boolean        @default(false)
  evidence           Json?          // Submitted evidence
  paymentGateway     PaymentGateway
  paymentId          String
  payment            Payment        @relation(fields: [paymentId], references: [id])
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt

  @@index([paymentId])
  @@index([status])
}

enum DisputeStatus {
  WARNING_NEEDS_RESPONSE   // Early fraud warning
  WARNING_UNDER_REVIEW
  WARNING_CLOSED
  NEEDS_RESPONSE           // Formal dispute
  UNDER_REVIEW
  CHARGE_REFUNDED
  WON
  LOST
}
```

---

## Gateway Integration

### Stripe

**Refunds:**

- Full API support via `stripe.refunds.create()`
- Supports partial refunds
- Immediate status feedback

**Disputes:**

- Full API support via `stripe.disputes.update()`
- Evidence submission via API
- Webhook notifications for status changes

### Razorpay

**Refunds:**

- Full API support via `razorpay.payments.refund()`
- Supports partial refunds
- Status via webhooks

**Disputes:**

- NO API support for evidence submission
- Must handle via Razorpay Dashboard
- Webhook notifications only

---

## Data Flow

### Refund Creation

```
Admin Request
     │
     ▼
┌─────────────────┐
│ Validate Input  │
│ (Zod schema)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Phase 1: TX     │──── Creates PENDING refund record
│ Claim Amount    │     (prevents race conditions)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Phase 2: API    │──── Calls Stripe/Razorpay
│ Gateway Call    │     (outside transaction)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Phase 3: Update │──── Updates to SUCCEEDED/FAILED
│ Final Status    │
└────────┬────────┘
         │
         ▼
    API Response
```

### Dispute Evidence Submission

```
Admin Request
     │
     ▼
┌─────────────────┐
│ Validate Input  │
│ Check Status    │──── Reject if already resolved
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Gateway Call    │──── Submit to Stripe (outside TX)
│ (Stripe only)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Update Record   │──── Store evidence, update status
└────────┬────────┘
         │
         ▼
    API Response
```

---

## Security Considerations

1. **Authentication**: All endpoints require authenticated admin/staff session
2. **Authorization**: Role check (ADMIN or STAFF) before processing
3. **Input Validation**: Zod schemas validate all request data
4. **Gateway Secrets**: Stored in environment variables, never exposed
5. **Webhook Verification**: All webhook payloads verified with signatures

---

## Refund Front Doors and Durability

No code calls the gateway refund directly. Three front doors split the funding rails by payment-intent prefix (`org_*` reverses in-ledger, `free_*` restores credits, everything else is the two-phase gateway refund):

| Door                        | File                                        | Used for                                                                                      |
| :-------------------------- | :------------------------------------------ | :-------------------------------------------------------------------------------------------- |
| `refundBookingPayment`      | `lib/payments/operations/booking-refund.ts` | One booking: cancel, trial cancel, rejection, no-show, moderation, maintenance freeze, expiry |
| `refundWholeEventPayments`  | `lib/payments/operations/event-refunds.ts`  | Every seat of a cancelled webinar or class                                                    |
| `refundRemovedAttendeeSeat` | `lib/payments/operations/event-refunds.ts`  | One removed or departing seat                                                                 |

Each call may carry a `dedupeKey` (`Refund.dedupeKey` is unique), so a repeat returns the first refund. Existing keys include `consultant-no-show:<paymentId>`, `seat-leave:<participantId>`, `occ:<occurrence>:pay:<payment>` and `incident:<incident>:<occurrence>:<user>`.

**Platform-incident refunds (current).** When ops declare a platform incident, `refundIncidentSeat()` (`lib/payments/operations/incident-refunds.ts`) refunds a voided consultation, paid trial or webinar seat in full through `refundBookingPayment()`. It first looks for an existing refund under the key, then stamps the refund-owed marker with `stampRefundOwed()` in a transaction (a paid trial is cancelled in that same commit), and then drives the refund with `driveRefundOwed()`. The key is built by `incidentRefundKey()` in `lib/booking/incident-keys.ts`, so one seat gets one refund per session even when two declared windows overlap it. The marker is first-come: a payment that already owes a different key is never overwritten, and the remedy waits, then dead-letters for an operator after three counted attempts. A payment with an open dispute waits without counting an attempt. The amount is the payment's whole remaining balance, the platform bears the gateway fee, and `applyRefundCascade()` reverses the expert's earnings as for any refund. Because the key starts with `incident:`, the prefix scans that total what a payment has already got back (`occurrenceRefundsPaise()` in `lib/booking/class-series.ts` and `voidRefundExists()` in `lib/backoffice/session-outcomes.ts`) include these refunds, and a later day-14 sweep or seat exit is capped to the remaining balance. The runbook is in [the money console page](../backoffice/01-money-console.md#platform-incidents).

**Today** the cancel route computes the quote after the booking transaction commits and calls the door unkeyed, and a failed refund is written as a system error for ops. A process death between the commit and the refund leaves a cancelled booking with a captured payment and nothing re-driving it. The same gap exists in the trial cancel, rejection refund, moderation and maintenance-freeze doors, and in the whole-event refund, which is a sequential in-request loop.

**Landing in Wave 0 (W0-3):** the quote is computed inside the cancel transaction and checked against the amount the dialog displayed (409 `REFUND_QUOTE_CHANGED`). The same transaction stamps a per-payment refund-owed marker (`refundOwedPaise`, `refundOwedKey` unique, `refundOwedReason`, `refundOwedAt`), the door is called with `dedupeKey: "cancel:<appointmentId>"`, and `retry-auto-refunds` re-drives any marker with no refund under that key and clears it. The marker is separate from the existing `Auto-refund pending:` family, which means "the booking was never confirmed, refund the whole capture", and it is not a pre-created `Refund` row. Whole-event refunds become a bounded keyed sweep (`event-cancel:<eventId>:pay:<paymentId>`), and one alert per run reads the persisted owed amount. The policy decisions behind these changes are in [the money HLD](../../start-here/02-money-system-hld.md#11-refund-and-cancellation-policy-decisions).

## Related Files

```
app/api/payments/
├── refunds/
│   └── route.ts          # Refund API (POST, GET)
└── disputes/
    └── route.ts          # Disputes API (POST, GET)

app/api/admin/disputes/
├── route.ts              # Admin disputes list
└── [disputeId]/
    └── route.ts          # Single dispute details

lib/payments/
├── index.ts              # Gateway abstraction
└── core/
    ├── stripe.ts         # Stripe implementation
    └── razorpay.ts       # Razorpay implementation

prisma/
└── schema.prisma         # Refund, Dispute models
```

## Deprecated & Superseded Approaches

1. **Computing the cancel refund after the commit with no durable marker.** Replaced in Wave 0 by the in-transaction quote and the refund-owed marker.
2. **Calling `refundPayment` directly for org-funded bookings.** It died on `UNKNOWN_GATEWAY` and reversed nothing; the front doors now split the rails.
