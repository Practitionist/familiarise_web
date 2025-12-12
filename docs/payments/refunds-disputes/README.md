# Refunds & Disputes System

Documentation for the Familiarise refund and dispute handling system.

**Last Updated**: 2025-12-11

---

## Overview

The refunds and disputes system handles:

- **Refunds**: Processing full or partial refunds for payments
- **Disputes**: Managing chargebacks and evidence submission

### Supported Payment Gateways

| Gateway  | Refunds          | Disputes                              |
| -------- | ---------------- | ------------------------------------- |
| Stripe   | Full API support | Full API support                      |
| Razorpay | Full API support | Webhook-only (dashboard for evidence) |

---

## Quick Links

| Document                                   | Description                                             |
| ------------------------------------------ | ------------------------------------------------------- |
| [Architecture](./01-architecture.md)       | System components, database models, gateway integration |
| [Refund Flow](./02-refund-flow.md)         | Two-phase refund pattern, race condition prevention     |
| [Dispute Flow](./03-dispute-flow.md)       | Dispute lifecycle, evidence submission                  |
| [API Reference](./04-api-reference.md)     | Endpoint specifications, request/response schemas       |
| [Troubleshooting](./05-troubleshooting.md) | Common issues and solutions                             |

---

## Key Concepts

### Two-Phase Refund Pattern

Refunds use a two-phase pattern to prevent race conditions while avoiding long-running database transactions:

```
Phase 1 (Transaction): Create PENDING refund → Claims the amount
Phase 2 (No TX):       Call payment gateway → Process refund
Phase 3 (No TX):       Update status → SUCCEEDED or FAILED
```

### Dispute Lifecycle

```
Early Warning:  WARNING_NEEDS_RESPONSE → WARNING_UNDER_REVIEW → WARNING_CLOSED
Formal Dispute: NEEDS_RESPONSE → UNDER_REVIEW → WON / LOST / CHARGE_REFUNDED
```

---

## Database Models

### Refund

```prisma
model Refund {
  id             String         @id @default(cuid())
  amount         Int
  currency       String
  reason         String?
  status         String         // PENDING, SUCCEEDED, FAILED, CANCELLED
  refundId       String         @unique  // Gateway refund ID
  paymentGateway PaymentGateway
  metadata       Json?
  paymentId      String
  payment        Payment        @relation(...)
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
}
```

### Dispute

```prisma
model Dispute {
  id                 String         @id @default(cuid())
  disputeId          String         @unique  // Gateway dispute ID
  amount             Int
  currency           String
  reason             String?
  status             DisputeStatus
  dueBy              DateTime?
  isChargeRefundable Boolean        @default(false)
  evidence           Json?
  paymentGateway     PaymentGateway
  paymentId          String
  payment            Payment        @relation(...)
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt
}
```

---

## API Endpoints

| Method | Endpoint                   | Description              |
| ------ | -------------------------- | ------------------------ |
| POST   | `/api/payments/refunds`    | Create a refund          |
| GET    | `/api/payments/refunds`    | List refunds             |
| GET    | `/api/payments/disputes`   | List disputes            |
| POST   | `/api/payments/disputes`   | Submit dispute evidence  |
| GET    | `/api/admin/disputes`      | Admin disputes dashboard |
| GET    | `/api/admin/disputes/[id]` | Get dispute details      |

---

## Related Documentation

- [Status Enums Reference](../../STATUS_ENUMS_REFERENCE.md) - RefundStatus, DisputeStatus
- [Payment System Overview](../../../app/checkout/payments.md) - Main payment documentation
- [Troubleshooting Guide](../pay-later/TROUBLESHOOTING.md) - General payment troubleshooting
