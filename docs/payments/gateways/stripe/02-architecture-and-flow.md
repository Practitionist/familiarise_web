# Stripe Payment Architecture

## Overview

This document explains how payments flow through our system using Stripe for international customers. If you're new to the team, read this to understand how international payments work.

### Quick Summary

```
Customer (USA) pays $100
        |
        v
    [ STRIPE ] --- takes $2.90 (2.9% + $0.30)
        |
        v
   [ PLATFORM ] --- $97.10 received
        |
        +---> Platform keeps $19.42 (20% commission)
        |
        +---> Consultant gets $77.68 (80%)
              (Paid in their local currency!)
```

---

## The Big Picture

### Who's Involved?

```
+------------------+     +------------------+     +------------------+
|    CUSTOMER      |     |   FAMILIARISE    |     |   CONSULTANT     |
|    (USA)         |     |    (Platform)    |     |    (UK)          |
+------------------+     +------------------+     +------------------+
        |                        |                        |
        | Books consultation     |                        |
        | Pays $100 USD          |                        |
        +----------------------->|                        |
                                 |                        |
                                 | Converts to GBP        |
                                 | Sends 62 GBP           |
                                 +----------------------->|
                                 |                        |
                                 |              Money in UK bank!
```

### Stripe vs Razorpay: Key Differences

```
+---------------------+------------------+------------------+
| Feature             | Razorpay         | Stripe           |
+---------------------+------------------+------------------+
| Best for            | India            | International    |
| Currency            | INR only         | 135+ currencies  |
| Account Type        | Linked Account   | Connected Account|
| KYC Handled By      | Us + Razorpay    | Stripe entirely  |
| Onboarding          | We collect data  | Stripe hosted    |
| Settlement          | T+2 days         | 2-7 business days|
| Gateway Fee         | 2% + GST         | 2.9% + $0.30     |
+---------------------+------------------+------------------+
```

---

## Payment Flow - Step by Step

### Step 1: Customer Initiates Payment

```
+-------------+                      +-------------+
|  Customer   |                      | Familiarise |
|  (Browser)  |                      |   Server    |
+------+------+                      +------+------+
       |                                    |
       |  1. Click "Book Consultation"      |
       |----------------------------------->|
       |                                    |
       |  2. Server creates PaymentIntent   |
       |                                    |
       |  3. Return clientSecret            |
       |<-----------------------------------|
       |                                    |
```

### Step 2: Customer Pays via Stripe Elements

```
+-------------+                      +-------------+
|  Customer   |                      |   Stripe    |
|  (Browser)  |                      |   Servers   |
+------+------+                      +------+------+
       |                                    |
       |  1. Stripe Elements form loaded    |
       |                                    |
       |  2. Customer enters card details   |
       |     (Card data never hits our      |
       |      server - PCI compliance!)     |
       |                                    |
       |  3. Confirm PaymentIntent          |
       |----------------------------------->|
       |                                    |
       |  4. 3D Secure if required          |
       |<---------------------------------->|
       |                                    |
       |  5. Payment confirmed              |
       |<-----------------------------------|
       |                                    |
```

### Step 3: Webhook Notification

```
+-------------+          +-------------+
|   Stripe    |          | Familiarise |
|   Server    |          |   Server    |
+------+------+          +------+------+
       |                        |
       |  POST /webhooks/stripe |
       |  Event: payment_intent.succeeded
       |----------------------->|
       |                        |
       |                        |  1. Verify signature
       |                        |  2. Find appointment
       |                        |  3. Update payment status
       |                        |  4. Create earnings record
       |                        |  5. Send confirmation
       |                        |
       |  HTTP 200 OK           |
       |<-----------------------|
```

---

## Revenue Split Breakdown

### The Math (On $100 Payment)

```
+------------------------------------------------------------------+
|                    PAYMENT BREAKDOWN                              |
+------------------------------------------------------------------+
|                                                                   |
|  Customer Pays:                    $ 100.00                       |
|                                    =========                      |
|                                                                   |
|  STEP 1: Gateway Fee                                              |
|  +-- Stripe charges: 2.9% + $0.30                                 |
|  +-- 2.9% of $100 = $2.90                                         |
|  +-- Plus fixed fee = $0.30                                       |
|  +-- Total gateway fee: $3.20 (3.2%)                              |
|                                                                   |
|  Net Amount to Platform: $96.80                                   |
|                                                                   |
|  STEP 2: Platform Commission (varies by tier)                     |
|  +-- Standard: 20% of $96.80 = $19.36                             |
|  +-- Premium: 18% of $96.80 = $17.42                              |
|  +-- Luxury: 15% of $96.80 = $14.52                               |
|                                                                   |
|  STEP 3: Consultant Earnings (Standard tier)                      |
|  +-- 80% of $96.80 = $77.44                                       |
|                                                                   |
+------------------------------------------------------------------+

Summary Table (Standard 20% tier):
+------------------+----------+--------------+
| Party            | Amount   | Percentage   |
+------------------+----------+--------------+
| Stripe           | $3.20    | 3.2% of total|
| Familiarise      | $19.36   | 20% of net   |
| Consultant       | $77.44   | 80% of net   |
+------------------+----------+--------------+
| Total            | $100.00  | 100%         |
+------------------+----------+--------------+
```

### Multi-Currency Example

```
Scenario: US customer books UK consultant

Customer pays: $100 USD
              |
              v
Stripe converts to platform currency
              |
              v
We calculate commission in USD
              |
              v
Consultant receives: ~62 GBP
(Stripe handles the conversion automatically)

The consultant always gets paid in THEIR currency.
The customer always pays in THEIR currency.
Stripe handles all conversions.
```

---

## PaymentIntent States

### State Machine

```
                    +-------------------+
                    | requires_payment  |  Created, waiting for card
                    | _method           |
                    +--------+----------+
                             |
                             | Customer provides card
                             v
                    +-------------------+
                    | requires          |  Card entered, awaiting confirm
                    | _confirmation     |
                    +--------+----------+
                             |
           +-----------------+----------------+
           |                                  |
           | Confirm succeeds                 | 3DS required
           v                                  v
    +------------+                   +-------------------+
    | processing |                   | requires_action   |
    +-----+------+                   +--------+----------+
          |                                   |
          |                                   | 3DS completed
          |                                   v
          +<----------------------------------+
          |
          | Payment successful
          v
    +------------+
    | succeeded  |  Money captured!
    +------------+

    OR if failed:

    +------------+
    | canceled   |  Payment canceled
    +------------+
```

### State Descriptions

```
+-------------------------+----------------------------------------------+
| State                   | Description                                  |
+-------------------------+----------------------------------------------+
| requires_payment_method | PaymentIntent created, no card yet           |
| requires_confirmation   | Card entered, waiting for confirmation       |
| requires_action         | 3D Secure authentication needed              |
| processing              | Payment being processed                      |
| succeeded               | Payment successful, funds captured           |
| canceled                | Payment was canceled                         |
+-------------------------+----------------------------------------------+
```

---

## Webhook Events

### Key Events We Handle

```
+-----------------------------+------------------------------------------+
| Event                       | When It Fires                            |
+-----------------------------+------------------------------------------+
| payment_intent.succeeded    | Payment captured successfully            |
| payment_intent.payment_failed| Payment failed                          |
| charge.refunded             | Refund completed                         |
| charge.dispute.created      | Customer opened dispute/chargeback       |
+-----------------------------+------------------------------------------+
```

### Webhook Payload Example

```json
{
  "id": "evt_xxxxxxxxxxxxx",
  "type": "payment_intent.succeeded",
  "data": {
    "object": {
      "id": "pi_xxxxxxxxxxxxx",
      "amount": 10000,
      "currency": "usd",
      "status": "succeeded",
      "metadata": {
        "appointmentId": "appt_xxxxx"
      },
      "charges": {
        "data": [{
          "id": "ch_xxxxxxxxxxxxx",
          "amount": 10000,
          "balance_transaction": "txn_xxxxxxxxxxxxx"
        }]
      }
    }
  }
}
```

### What We Do On Each Event

```
payment_intent.succeeded:
+-- Verify webhook signature
+-- Extract appointmentId from metadata
+-- Update payment status to CAPTURED
+-- Calculate fees and earnings
+-- Create ConsultantEarnings record
+-- Send confirmation email

payment_intent.payment_failed:
+-- Update payment status to FAILED
+-- Log failure reason
+-- Send failure notification
+-- Allow customer to retry

charge.refunded:
+-- Update payment status
+-- Update earnings to REFUNDED
+-- Notify both parties

charge.dispute.created:
+-- Mark earnings as DISPUTED
+-- Alert admin team
+-- Gather evidence for response
```

---

## Code Flow

### 1. Create PaymentIntent (Backend)

```typescript
// app/api/payments/create-stripe-intent/route.ts

import stripe from "@/lib/payments/core/stripe";

export async function POST(req: Request) {
  const { appointmentId, amount, currency } = await req.json();

  // Convert to smallest unit (cents)
  const amountInCents = Math.round(amount * 100);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountInCents,
    currency: currency.toLowerCase(),
    metadata: {
      appointmentId,
      platform: "familiarise",
    },
    automatic_payment_methods: {
      enabled: true,
    },
  });

  // Save to database
  await prisma.payment.create({
    data: {
      appointmentId,
      amount: amountInCents,
      currency: currency.toUpperCase(),
      gateway: "STRIPE",
      gatewayPaymentIntentId: paymentIntent.id,
      status: "PENDING",
    },
  });

  return Response.json({
    clientSecret: paymentIntent.client_secret,
  });
}
```

### 2. Customer Checkout (Frontend)

```tsx
// components/checkout/StripeCheckout.tsx

import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { stripePromise } from "@/lib/stripe-client";

function CheckoutForm({ clientSecret }: { clientSecret: string }) {
  const stripe = useStripe();
  const elements = useElements();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) return;

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/booking/success`,
      },
      redirect: "if_required",
    });

    if (error) {
      // Handle error
      console.error(error.message);
    } else if (paymentIntent?.status === "succeeded") {
      // Payment successful
      // Webhook will handle the rest
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      <button type="submit" disabled={!stripe}>
        Pay Now
      </button>
    </form>
  );
}

export default function StripeCheckout({ clientSecret }: { clientSecret: string }) {
  return (
    <Elements stripe={stripePromise} options={{ clientSecret }}>
      <CheckoutForm clientSecret={clientSecret} />
    </Elements>
  );
}
```

### 3. Handle Webhook (Backend)

```typescript
// app/api/webhooks/stripe/route.ts

import { headers } from "next/headers";
import stripe from "@/lib/payments/core/stripe";

export async function POST(req: Request) {
  const body = await req.text();
  const signature = headers().get("stripe-signature")!;

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  switch (event.type) {
    case "payment_intent.succeeded":
      await handlePaymentSuccess(event.data.object);
      break;

    case "payment_intent.payment_failed":
      await handlePaymentFailed(event.data.object);
      break;

    case "charge.refunded":
      await handleRefund(event.data.object);
      break;
  }

  return Response.json({ received: true });
}

async function handlePaymentSuccess(paymentIntent: any) {
  const appointmentId = paymentIntent.metadata.appointmentId;

  // Get fee details from balance transaction
  const charge = paymentIntent.charges.data[0];
  const balanceTx = await stripe.balanceTransactions.retrieve(
    charge.balance_transaction
  );

  const grossAmount = paymentIntent.amount;
  const gatewayFee = balanceTx.fee;
  const netAmount = balanceTx.net;
  const platformFee = Math.round(netAmount * 0.20);
  const consultantEarnings = netAmount - platformFee;

  await prisma.$transaction([
    prisma.payment.update({
      where: { gatewayPaymentIntentId: paymentIntent.id },
      data: { status: "CAPTURED" },
    }),
    prisma.consultantEarnings.create({
      data: {
        consultantProfileId: appointment.consultantProfileId,
        paymentId: payment.id,
        grossAmount,
        gatewayFee,
        platformFee,
        netAmount: consultantEarnings,
        currency: paymentIntent.currency.toUpperCase(),
        status: "PENDING",
        holdUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    }),
  ]);
}
```

---

## Multi-Currency Support

### How Currency Works

```
+----------------------------------------------------------------------+
|                    STRIPE MULTI-CURRENCY                             |
+----------------------------------------------------------------------+
|                                                                       |
|  Customer Location: USA                                               |
|  Customer pays in: USD ($100)                                         |
|                                                                       |
|  Platform Location: India                                             |
|  Platform receives: USD (or configured settlement currency)           |
|                                                                       |
|  Consultant Location: UK                                              |
|  Consultant paid in: GBP (~62 GBP)                                   |
|                                                                       |
|  Stripe handles ALL conversions automatically!                        |
|                                                                       |
+----------------------------------------------------------------------+

Flow:
$100 USD --> Stripe --> Familiarise account --> Transfer --> UK bank (GBP)
                          (in USD)                           (converted)
```

### Supported Currencies

```
Major currencies we support:
+------+-------------------+
| Code | Currency          |
+------+-------------------+
| USD  | US Dollar         |
| EUR  | Euro              |
| GBP  | British Pound     |
| CAD  | Canadian Dollar   |
| AUD  | Australian Dollar |
| JPY  | Japanese Yen      |
| SGD  | Singapore Dollar  |
| AED  | UAE Dirham        |
+------+-------------------+

Full list: 135+ currencies
```

---

## Pricing by Region

### Gateway Fees Vary by Location

```
+------------------+------------------+
| Customer Region  | Stripe Fee       |
+------------------+------------------+
| US               | 2.9% + $0.30     |
| Europe (SEPA)    | 1.4% + EUR 0.25  |
| UK               | 1.4% + GBP 0.20  |
| International    | 3.9% + $0.30     |
+------------------+------------------+

We use 3.2% average for calculations.
```

---

## Error Handling

### Common Errors

```
+--------------------------------+------------------------------------------+
| Error                          | What To Do                               |
+--------------------------------+------------------------------------------+
| card_declined                  | Ask customer to try different card       |
| insufficient_funds             | Card doesn't have enough balance         |
| expired_card                   | Ask customer to update card              |
| processing_error               | Retry the payment                        |
| incorrect_cvc                  | Customer entered wrong CVC               |
| authentication_required        | Customer needs to complete 3DS           |
+--------------------------------+------------------------------------------+
```

### Stripe-Specific Errors

```typescript
try {
  const paymentIntent = await stripe.paymentIntents.create({...});
} catch (error) {
  if (error instanceof Stripe.errors.StripeCardError) {
    // Card was declined
    console.log(error.decline_code);
  } else if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    // Invalid parameters
  } else if (error instanceof Stripe.errors.StripeAPIError) {
    // Stripe API issue - retry
  }
}
```

---

## Testing Checklist

```
[ ] PaymentIntent creation works
[ ] Stripe Elements loads correctly
[ ] Test card payment succeeds
[ ] 3D Secure flow works
[ ] Failed payment handled correctly
[ ] Webhook received and verified
[ ] Earnings record created
[ ] Refund flow works
[ ] Multi-currency works
[ ] Error messages displayed properly
```

---

## Related Documents

- [01-setup.md](./01-setup.md) - Initial Stripe setup
- [03-payout-flow.md](./03-payout-flow.md) - Consultant payouts via Connect
- [Stripe API Docs](https://stripe.com/docs/api)
- [Stripe Connect Docs](https://stripe.com/docs/connect)
