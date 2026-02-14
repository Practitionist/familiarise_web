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

## Revenue Split

Familiarise uses a **flat 20% platform fee** for all consultants. There are no tiered commission rates.

### Breakdown (on Rs. 1,000 payment)

```
Customer Pays:                     Rs. 1,000.00
                                   ============

Gateway Fee:
  Razorpay charges: 2% + 18% GST on fee
  2% of 1000 = Rs. 20
  18% GST on Rs. 20 = Rs. 3.60
  Total gateway fee: Rs. 23.60 (~2.36%)

  Simplified to ~3% for calculations:  Rs. 30
                                       ------
Net Amount to Platform:                Rs. 970

Platform Commission (20% of net):      Rs. 194
Consultant Earnings (80% of net):      Rs. 776
```

| Party | Amount | Percentage |
|-------|--------|------------|
| Razorpay | Rs. 30 | ~3% of total |
| Familiarise | Rs. 194 | 20% of net |
| Consultant | Rs. 776 | 80% of net |
| **Total** | **Rs. 1,000** | **100%** |

**Source**: `lib/payments/payouts/constants.ts` and `lib/payments/payouts/earnings-service.ts`

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

### Events Handled

| Event | When It Fires | What We Do |
|-------|--------------|------------|
| `payment.captured` | Payment successfully captured | Update payment to SUCCEEDED, create earnings record, send confirmation |
| `order.paid` | Order fully paid | Same as payment.captured (alternative trigger) |
| `payment.failed` | Payment declined/errored | Update payment to FAILED, send failure notification |
| `refund.created` | Refund initiated | Create refund record with PENDING status |
| `refund.processed` | Refund completed | Update refund to SUCCEEDED, mark earnings as REFUNDED |
| `refund.failed` | Refund processing failed | Update refund to FAILED |
| `payment.dispute.created` | Customer raised chargeback | Create dispute record, notify admin via Novu |
| `payment.dispute.won` | Merchant won the dispute | Update dispute status to WON |
| `payment.dispute.lost` | Customer won the dispute | Update dispute status to LOST |
| `payment.dispute.closed` | Dispute resolved | Update dispute status |

### RazorpayX Payout Events (separate product)

| Event | When It Fires | What We Do |
|-------|--------------|------------|
| `payout.processed` | Payout completed | Update payout to COMPLETED, mark earnings as PAID |
| `payout.reversed` | Bank returned funds | Update payout to FAILED, restore available balance |
| `payout.rejected` | Payout rejected | Update payout to FAILED |
| `payout.queued` | Payout queued (low balance) | Update payout status |
| `payout.pending` | Payout pending processing | Update payout status |
| `payout.cancelled` | Payout cancelled | Update payout to CANCELLED |

**Source**: `app/api/webhooks/razorpay/route.ts`

---

## Currency

All Razorpay payments are in **INR**. The checkout logic forces `currency: "INR"` when Razorpay is selected as the gateway.

All amounts are stored and transmitted in **paise** (smallest unit). Rs. 1,000 = 100,000 paise.

---

## Dispute Handling

Razorpay does **not** provide a direct API for managing disputes. Disputes are:

- **Created** via webhook events only
- **Managed** through the Razorpay dashboard
- **Evidence submission** is done manually in the dashboard (no API)

This differs from Stripe, which provides full dispute management APIs.

---

## Error Handling

| Error | Description |
|-------|-------------|
| `BAD_REQUEST_ERROR` | Invalid request parameters or authentication failure |
| `GATEWAY_ERROR` | Payment gateway temporarily unavailable |
| `PAYMENT_FAILED` | Customer's payment method declined |
| `SIGNATURE_MISMATCH` | Webhook secret mismatch |

**Source**: `lib/payments/core/razorpay.ts` (error handling section)

---

## Related Documents

- [Gateway Overview](../README.md) — Comparison and selection logic
- [01-setup.md](./01-setup.md) — Setup and configuration
- [03-payout-flow.md](./03-payout-flow.md) — Consultant payouts via RazorpayX
- [Status Enums Reference](../../03-status-enums-reference.md) — PaymentStatus, RefundStatus, DisputeStatus
