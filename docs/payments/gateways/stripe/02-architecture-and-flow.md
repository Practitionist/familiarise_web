# Stripe Payment Architecture

> How payments flow through the system using Stripe Checkout Sessions for international customers.

**Last Updated**: 2026-02-14

---

## Overview

Stripe handles all payment collection from international consultees. Payments are always in USD and use **Stripe Checkout Sessions** — a hosted checkout page where customers are redirected to complete payment on Stripe's servers.

> **Note**: The system uses Stripe Checkout Sessions (hosted redirect), not PaymentIntents with Stripe Elements (embedded card form).

---

## Payment Flow

### High-Level Flow

```
Consultee clicks "Book"
        |
        v
Server creates Stripe Checkout Session
(30-minute expiry)
        |
        v
Consultee redirected to checkout.stripe.com
        |
        v
Consultee completes payment on Stripe's hosted page
(card, Apple Pay, Google Pay, etc.)
        |
        v
Stripe processes payment
        |
        v
Webhook: payment_intent.succeeded
        |
        v
Server updates payment, creates earnings, sends notifications
        |
        v
Consultee redirected back to success/failure page
```

### Step-by-Step

```
+-------------+          +-------------+          +-------------+
|  Consultee  |          | Familiarise |          |   Stripe    |
|  (Browser)  |          |   Server    |          |   Servers   |
+------+------+          +------+------+          +------+------+
       |                        |                        |
       |  1. Click "Book"       |                        |
       |----------------------->|                        |
       |                        |                        |
       |                        |  2. Create Checkout    |
       |                        |     Session            |
       |                        |----------------------->|
       |                        |                        |
       |                        |  3. Return session URL |
       |                        |<-----------------------|
       |                        |                        |
       |  4. Redirect to        |                        |
       |     checkout.stripe.com|                        |
       |----------------------------------------------->|
       |                        |                        |
       |                        |                        |  5. Customer
       |                        |                        |     enters card
       |                        |                        |     3DS if needed
       |                        |                        |
       |                        |  6. Webhook:           |
       |                        |     payment_intent     |
       |                        |     .succeeded         |
       |                        |<-----------------------|
       |                        |                        |
       |                        |  7. Update payment     |
       |                        |  8. Create earnings    |
       |                        |  9. Send notifications |
       |                        |                        |
       |  10. Redirect back     |                        |
       |      to success page   |                        |
       |<-----------------------------------------------|
```

### Session Details

- **Expiry**: 30 minutes from creation
- **Success URL**: `/checkout/checkout-success?session_id={CHECKOUT_SESSION_ID}`
- **Cancel URL**: `/checkout/checkout-failure`
- **Payment methods**: Cards only (configured via `payment_method_types: ["card"]`)

---

## Revenue Split

Familiarise uses a **flat 20% platform fee** for all consultants. There are no tiered commission rates.

### Breakdown (on $100 payment)

```
Customer Pays:                     $ 100.00
                                   ========

Gateway Fee:
  Stripe charges: 2.9% + $0.30
  2.9% of $100 = $2.90
  Plus fixed fee = $0.30
  Total gateway fee: $3.20 (3.2%)
                                   ------
Net Amount to Platform:            $ 96.80

Platform Commission (20% of net):  $ 19.36
Consultant Earnings (80% of net):  $ 77.44
```

| Party       | Amount      | Percentage    |
| ----------- | ----------- | ------------- |
| Stripe      | $3.20       | 3.2% of total |
| Familiarise | $19.36      | 20% of net    |
| Consultant  | $77.44      | 80% of net    |
| **Total**   | **$100.00** | **100%**      |

### Gateway Fees by Region

| Customer Region | Stripe Fee      |
| --------------- | --------------- |
| US              | 2.9% + $0.30    |
| Europe (SEPA)   | 1.4% + EUR 0.25 |
| UK              | 1.4% + GBP 0.20 |
| International   | 3.9% + $0.30    |

We use 3.2% as the average for calculations.

**Source**: `lib/payments/payouts/constants.ts` and `lib/payments/payouts/earnings-service.ts`

---

## Multi-Currency

```
Customer in USA pays: $100 USD
        |
        v
Platform receives: $100 USD (minus Stripe fees)
        |
        v
Calculate consultant share: $77.44 USD
        |
        v
Transfer to Connected Account
Stripe converts to consultant's bank currency if needed
        |
        v
Consultant in UK receives: ~62 GBP
(Stripe handles conversion, ~2% FX fee built into rate)
```

All payments on Familiarise are accepted in **USD**. Currency conversion to the consultant's bank currency is handled automatically by Stripe at the transfer/payout stage.

---

## Webhook Events

### Events Handled

| Event                           | When It Fires                       | What We Do                                                      |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `payment_intent.succeeded`      | Payment captured                    | Update payment to SUCCEEDED, create earnings, send confirmation |
| `payment_intent.payment_failed` | Payment declined/errored            | Update payment to FAILED, send failure notification             |
| `charge.refunded`               | Refund completed                    | Create/update refund record, mark earnings as REFUNDED          |
| `charge.dispute.created`        | Customer opened chargeback          | Create dispute record, notify admin via Novu                    |
| `charge.dispute.updated`        | Dispute evidence submitted/reviewed | Update dispute status                                           |
| `charge.dispute.closed`         | Dispute resolved                    | Update dispute to WON/LOST/CHARGE_REFUNDED                      |

### Stripe Connect Events (Payouts)

| Event               | When It Fires                    | What We Do                              |
| ------------------- | -------------------------------- | --------------------------------------- |
| `payout.created`    | Payout initiated                 | Log payout creation                     |
| `payout.paid`       | Funds deposited to bank          | Mark payout COMPLETED, earnings as PAID |
| `payout.failed`     | Payout failed                    | Mark payout FAILED, restore balance     |
| `payout.canceled`   | Payout cancelled                 | Mark payout CANCELLED                   |
| `account.updated`   | Connected account status changed | Update consultant's account status      |
| `transfer.created`  | Transfer initiated               | Log transfer creation                   |
| `transfer.reversed` | Transfer clawed back             | Handle transfer reversal                |

**Source**: `app/api/webhooks/stripe/route.ts`

---

## Dispute Handling

Unlike Razorpay, Stripe provides **full API access** for dispute management:

- **Get dispute details**: Retrieve dispute status, evidence requirements, due date
- **Submit evidence**: Programmatically submit evidence (customer info, cancellation policy, communications, etc.)
- **List disputes**: Admin dashboard lists all disputes with pagination

Evidence fields supported: customer name, email, purchase IP, cancellation policy, duplicate charge info, product description, receipts, customer communications.

**Source**: `lib/payments/core/stripe.ts` (dispute operations section)

---

## Error Handling

| Error                       | Description                          |
| --------------------------- | ------------------------------------ |
| `card_declined`             | Customer's card was declined         |
| `insufficient_funds`        | Card doesn't have enough balance     |
| `expired_card`              | Customer needs to update card        |
| `processing_error`          | Transient error, retry the payment   |
| `incorrect_cvc`             | Wrong CVC entered                    |
| `authentication_required`   | Customer needs to complete 3D Secure |
| `StripeAuthenticationError` | Invalid API key                      |
| `StripeRateLimitError`      | Too many requests                    |

**Source**: `lib/payments/core/stripe.ts` (error handling section)

---

## Related Documents

- [Gateway Overview](../README.md) — Comparison and selection logic
- [01-setup.md](./01-setup.md) — Setup and configuration
- [03-payout-flow.md](./03-payout-flow.md) — Stripe Connect payout system
- [Status Enums Reference](../../03-status-enums-reference.md) — PaymentStatus, RefundStatus, DisputeStatus
