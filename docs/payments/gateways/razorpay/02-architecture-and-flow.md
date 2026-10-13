# Razorpay Payment Architecture

> How payments flow through the system using Razorpay for Indian customers.

**Last Updated**: 2026-02-14

---

## Overview

Razorpay handles all payment collection from Indian consultees. Payments are always in INR and follow a Razorpay Order → Checkout Modal → Webhook confirmation flow.

---

## Payment Flow

### High-Level Flow

```
Consultee clicks "Book"
        |
        v
Server creates Razorpay Order
        |
        v
Client opens Razorpay Checkout modal
        |
        v
Consultee pays (card/UPI/net banking)
        |
        v
Razorpay processes payment
        |
        v
Webhook: payment.captured / order.paid
        |
        v
Server updates payment, creates earnings, sends notifications
```

### Step-by-Step

```
+-------------+                      +-------------+
|  Consultee  |                      | Familiarise |
|  Browser    |                      |   Server    |
+------+------+                      +------+------+
       |                                    |
       |  1. Click "Book Consultation"      |
       |----------------------------------->|
       |                                    |
       |  2. Server creates Razorpay Order  |
       |     (amount in paise, currency INR)|
       |                                    |
       |  3. Return order_id + amount       |
       |<-----------------------------------|
       |                                    |
       |  4. Open Razorpay Checkout modal   |
       |  5. Customer pays (card/UPI/etc.)  |
       |                                    |
       |  6. Payment captured by Razorpay   |
       |                                    |
       |  7. Razorpay sends webhook         |
       |                                    |
       |                              +-----+------+
       |                              |  Razorpay  |
       |                              |  Webhook   |
       |                              +-----+------+
       |                                    |
       |                                    |  8. POST /api/webhooks/razorpay
       |                                    |     Event: payment.captured
       |                                    |
       |                                    |  9. Verify signature
       |                                    | 10. Update payment status
       |                                    | 11. Create earnings record
       |                                    | 12. Send confirmation
       |                                    |
       |  13. Booking confirmed             |
       |<-----------------------------------|
```

---

## Saved Cards & Customer Tokenization

Before or during checkout, `ensureRazorpayCustomer()` in `lib/payments/core/razorpay.ts` lazily provisions a Razorpay Customer (`POST /v1/customers` with `fail_existing: 0`) and stores `User.razorpayCustomerId` (`cust_...`) using a race-safe `updateMany({ where: { id: userId, razorpayCustomerId: null } })`.

- Passing `customer_id` alongside `order_id` to Standard Checkout enables RBI-compliant **Card-on-File Tokenization (CoFT)** so returning consultees can pay with saved cards.
- If the Customers API call fails or times out, `ensureRazorpayCustomer()` returns `null` and checkout proceeds normally without saved cards.
- On GDPR/DPDP account erasure, `lib/Account-Deletion.ts` deletes all saved card tokens (`razorpay.customers.deleteToken(customerId, tokenId)`) and overwrites customer PII on Razorpay (`razorpay.customers.edit`).

---

## Revenue Split

For B2C bookings, the platform fee is calculated on `grossAmount` (`payment.originalAmount`, the pre-GST plan price) via `PlatformFeeSchedule` (`marketplaceBps` / `ownLinkBps`, defaulting to `PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE = 20%`, or `0%` when an active `ConsultantFeeWaiver` applies). For HOST/HYBRID organizations, the 3-way split (`platformBps + orgBps + consultantBps`) is governed by the active `RateCard`.

### Breakdown (on Rs. 1,000 base plan price, domestic B2C)

```
Base Plan Price (grossAmount):     Rs. 1,000.00
GST (18% principal supplier):      Rs.   180.00
Total Charged to Consultee:        Rs. 1,180.00
                                   ============

Platform Fee (20% of grossAmount): Rs.   200.00  (platform absorbs Razorpay PG fee out of this share)
Consultant Earnings (80% of base): Rs.   800.00  (subject to 0.1% Sec 194-O TDS at payout if > Rs. 5L/yr)
```

| Component                  | Amount (INR)  | Share of Base (`grossAmount`) | Notes                                                                                  |
| -------------------------- | ------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| **Base Plan Price**        | **Rs. 1,000** | **100%**                      | Stored in `Payment.originalAmount` (100,000 paise)                                     |
| **Platform Commission**    | **Rs. 200**   | **20%** (default marketplace) | Governed by `PlatformFeeSchedule` (`marketplaceBps` / `ownLinkBps`) or `0%` on waiver  |
| **Consultant Gross Share** | **Rs. 800**   | **80%**                       | Stored in `ConsultantEarnings`; Razorpay PG fee (~2.36% cards / 0% UPI) is NOT deducted from consultant |

**Sources**: `lib/payments/pricing/platform-fee.ts`, `lib/payments/payouts/earnings-service.ts`, and `lib/payments/payouts/constants.ts`

---

## Payment States

```
+----------+
| CREATED  |  Order created, waiting for payment
+----+-----+
     |
     | Customer initiates payment
     v
+----------+
|AUTHORIZED|  Payment authorized, funds reserved
+----+-----+
     |
     | Auto-capture
     v
+----------+
| CAPTURED |  Funds captured, payment complete
+----+-----+
     |
     | Refund requested
     v
+----------+
| REFUNDED |  Money returned to customer
+----------+

Failure path:
+----------+
|  FAILED  |  Payment declined, expired, or errored
+----------+
```

In our system, these map to `PaymentStatus`: `PENDING` (created/authorized), `SUCCEEDED` (captured), `FAILED`.

---

## Webhook Events

### Razorpay Payment, Refund & Dispute Events

| Event                             | When It Fires                                       | What We Do                                                                                      |
| --------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `payment.authorized`              | Payment authorized (prior to capture)               | Log and record payment authorization metadata                                                   |
| `payment.captured`                | Payment successfully captured                       | Single-writer confirmation: update `Payment` to `SUCCEEDED`, create earnings, issue GST invoice |
| `order.paid`                      | Order fully paid (carries both `order` & `payment`) | Confirm payment via single-writer pipeline if `payment.captured` has not already settled it     |
| `payment.failed`                  | Payment declined/errored                            | Update `Payment` to `FAILED` (if not already `SUCCEEDED`), notify consultee                     |
| `refund.created`                  | Refund initiated                                    | Ensure `Refund` record is tracked in `PENDING` status                                           |
| `refund.processed`                | Refund completed by bank/network                    | Update `Refund` to `SUCCEEDED`, record ARN (`acquirer_data.arn`), reverse earnings & issue GST Credit Note |
| `refund.failed`                   | Refund processing failed                            | Update `Refund` to `FAILED` and alert operations                                                |
| `refund.speed_changed`            | Instant (`optimum`) refund downgraded to `normal`   | Update refund metadata (`speed_processed`)                                                      |
| `payment.dispute.created`         | Customer raised chargeback/dispute                  | Upsert `Dispute` (`OPEN`), freeze linked earnings (`HELD`), notify admin                        |
| `payment.dispute.under_review`    | Evidence submitted; under bank review               | Update `Dispute` status to `UNDER_REVIEW`                                                       |
| `payment.dispute.action_required` | Additional evidence requested before `respond_by`   | Update `Dispute` status to `NEEDS_RESPONSE`, alert admin                                        |
| `payment.dispute.won`             | Merchant won the dispute                            | Update `Dispute` to `WON`, release held earnings back to normal schedule                        |
| `payment.dispute.lost`            | Customer won the dispute                            | Update `Dispute` to `LOST`, debit ledger/earnings, issue GST Credit Note                        |
| `payment.dispute.closed`          | Dispute closed (`status` indicates won/lost/closed) | Finalize `Dispute` and reconcile earnings                                                       |

### RazorpayX Payout & Validation Events

| Event                               | When It Fires                                   | What We Do                                                                                     |
| ----------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `payout.initiated`                  | Payout left queue and entered `processing`      | Update `Payout` status to `PROCESSING`                                                         |
| `payout.updated`                    | Payout metadata/UTR or status updated           | Sync `Payout` status and UTR                                                                   |
| `payout.processed`                  | Payout completed (`utr` assigned)               | Update `Payout` to `COMPLETED`, mark earnings `PAID`, post ledger settlement                   |
| `payout.failed`                     | Transfer failed at bank or gateway              | Update `Payout` to `FAILED` (reading `status_details`), restore earnings to `READY`            |
| `payout.reversed`                   | Bank returned funds after processing            | Update `Payout` to `FAILED`, reverse ledger/TDS and restore earnings to `READY`                |
| `payout.rejected`                   | Approval rejected in RazorpayX workflow         | Update `Payout` to `FAILED`, alert admin                                                       |
| `payout.queued`                     | Queued due to low balance (`queue_if_low_balance`)| Keep `Payout` in `PENDING`                                                                   |
| `payout.pending`                    | Awaiting approval workflow                      | Keep `Payout` in `PENDING`                                                                     |
| `payout.cancelled`                  | Queued payout cancelled                         | Update `Payout` to `CANCELLED`, restore earnings to `READY`                                    |
| `fund_account.validation.completed` | Penny Drop / FAV finished (`fav_...`)           | Check `results.account_status === "active"`; mark `PayoutAccount` verified or rejected         |
| `fund_account.validation.failed`    | Penny Drop / FAV request failed                 | Record validation failure on `PayoutAccount`                                                   |

**Sources**: `app/api/webhooks/razorpay/route.ts`, `app/api/webhooks/razorpay-dispatch.ts`, `schemas/webhooks/razorpay.ts`

### Webhook Idempotency

Inbound webhooks are deduplicated via the `WebhookEvent` table (`lib/webhooks/webhook-Deduplication.ts`):
- **Body-derived key (security invariant)**: `app/api/webhooks/razorpay/route.ts` deliberately **ignores** the unsigned `x-razorpay-event-id` HTTP header (which is not covered by `x-razorpay-signature` and could otherwise be spoofed to poison deduplication) and instead derives `eventId` deterministically from the HMAC-verified body (`${eventType}:${entityId}`, plus `:${bodyDigest}` on `payout.updated` so status and subsequent UTR updates do not collide, or `body_${bodyDigest}` when no entity ID is present).

---

## Currency

All Razorpay payments are in **INR**. The checkout logic forces `currency: "INR"` when Razorpay is selected as the gateway.

All amounts are stored as **`BigInt` paise** in Prisma and transmitted as integer paise to Razorpay (`Rs. 1,000 = 100,000 paise`; minimum Razorpay order amount is `100` paise = `₹1.00`).

---

## Dispute Handling (Webhooks + REST Disputes API)

Razorpay provides both **`payment.dispute.*` webhooks** and a **REST Disputes & Documents API**, both of which are integrated in this repo:

- **Webhook lifecycle (`lib/payments/webhooks/handlers.ts`)**: Handles all 6 `payment.dispute.*` events (`created`, `under_review`, `action_required`, `won`, `lost`, `closed`), freezing consultant earnings on creation, releasing them on win, or reversing earnings and issuing a GST Credit Note on loss.
- **REST Disputes & Evidence API (`lib/payments/core/razorpay-disputes.ts`)**:
  - `getRazorpayDispute(disputeId)` → `GET /v1/disputes/:id` (plus `isRazorpayUnknownDisputeIdError`)
  - `uploadDisputeDocument(file, mime, fileName)` → `POST /v1/documents` (`multipart/form-data` with `purpose: "dispute_evidence"`)
  - `contestDispute(disputeId, { action, amountPaise, summary, evidence })` → `PATCH /v1/disputes/:id/contest` (`action: "draft" | "submit"`)
  - Razorpay's API also supports accepting liability via `POST /v1/disputes/:id/accept`.

---

## Error Handling

| Error                | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `BAD_REQUEST_ERROR`  | Invalid request parameters or authentication failure |
| `GATEWAY_ERROR`      | Payment gateway temporarily unavailable              |
| `SERVER_ERROR`       | Internal error on Razorpay's servers                 |
| `PAYMENT_FAILED`     | Customer's payment method declined                   |
| `SIGNATURE_MISMATCH` | Checkout or webhook HMAC signature mismatch          |

**Source**: `lib/payments/core/razorpay.ts`

---

## Related Documents

- [Gateway Overview](../README.md) — Comparison and selection logic
- [01-setup.md](./01-setup.md) — Setup and configuration
- [03-payout-flow.md](./03-payout-flow.md) — Consultant payouts via RazorpayX
- [Status Enums Reference](../../03-status-enums-reference.md) — PaymentStatus, RefundStatus, DisputeStatus
