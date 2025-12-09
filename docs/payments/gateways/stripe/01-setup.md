# Stripe Setup Guide

## Overview

This guide covers setting up Stripe for payment processing on Familiarise. Stripe is our payment gateway for international customers (outside India).

### What is Stripe?

Stripe is a global payment platform that supports:

- Credit/Debit Cards worldwide
- Apple Pay, Google Pay
- Bank debits (ACH, SEPA)
- Local payment methods (iDEAL, Bancontact, etc.)
- 135+ currencies

### Why Stripe for International Payments?

```
+------------------+----------------------------------------+
| Feature          | Why It Matters                         |
+------------------+----------------------------------------+
| Connect          | Automated payouts to consultants       |
| Global Reach     | Accept payments from 195+ countries    |
| Multi-Currency   | Pay consultants in their local currency|
| Hosted KYC       | Stripe handles compliance per country  |
| Developer First  | Excellent API and documentation        |
+------------------+----------------------------------------+
```

### When to Use Stripe vs Razorpay

```
+------------------+------------------+------------------+
| Customer From    | Gateway          | Why              |
+------------------+------------------+------------------+
| India            | Razorpay         | UPI support,     |
|                  |                  | lower fees       |
+------------------+------------------+------------------+
| USA              | Stripe           | ACH, US cards    |
| Europe           | Stripe           | SEPA, iDEAL      |
| UK               | Stripe           | GBP, UK cards    |
| Others           | Stripe           | Global support   |
+------------------+------------------+------------------+
```

---

## Prerequisites

Before setting up Stripe, ensure you have:

| Requirement     | Details                                         |
| --------------- | ----------------------------------------------- |
| Business Entity | Registered business or individual               |
| Bank Account    | For receiving payouts from Stripe               |
| Website         | Live URL with clear product/service description |
| Email           | For account verification                        |
| Government ID   | For identity verification                       |

---

## Account Setup Steps

### Step 1: Create Stripe Account

```
1. Go to https://dashboard.stripe.com/register
2. Enter email and create password
3. Verify email
4. Select your country
```

### Step 2: Complete Business Verification

```
Dashboard -> Settings -> Business settings

Provide:
+-- Business Details
|   +-- Business type (Individual, Company, etc.)
|   +-- Business name
|   +-- Tax ID (if applicable)
|   +-- Website URL
|
+-- Personal Details (for verification)
|   +-- Full legal name
|   +-- Date of birth
|   +-- Address
|   +-- Phone number
|
+-- Bank Account
|   +-- Account number
|   +-- Routing number (or equivalent)
|
+-- Identity Verification
    +-- Upload government ID
    +-- May require additional documents
```

### Step 3: Enable Stripe Connect

Connect is required for consultant payouts:

```
Dashboard -> Connect -> Get started

Setup steps:
1. Accept Connect agreement
2. Configure branding (logo, colors)
3. Set up OAuth or onboarding flows
4. Configure payout settings
```

### Step 4: Generate API Keys

```
Dashboard -> Developers -> API keys

You will have:
+-- Publishable key: pk_test_xxxxx (safe for frontend)
+-- Secret key: sk_test_xxxxx (keep secret!)
+-- Webhook signing secret: whsec_xxxxx
```

---

## Environment Variables

Add these to your `.env` file:

```env
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional: Separate webhook for Connect events
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Test vs Live Keys

```
+------------------+----------------------------------+
| Environment      | Key Format                       |
+------------------+----------------------------------+
| Test Mode        | sk_test_xxxx / pk_test_xxxx      |
| Live Mode        | sk_live_xxxx / pk_live_xxxx      |
+------------------+----------------------------------+

IMPORTANT: Never expose secret keys!
Publishable keys are safe for client-side code.
```

---

## Dashboard Configuration

### Webhook Setup

```
Dashboard -> Developers -> Webhooks -> Add endpoint

URL: https://yoursite.com/api/webhooks/stripe

Select Events:
+-- Payment Events
|   +-- payment_intent.succeeded
|   +-- payment_intent.payment_failed
|   +-- charge.refunded
|
+-- Connect Events (for payouts)
|   +-- account.updated
|   +-- transfer.created
|   +-- transfer.paid
|   +-- transfer.failed
|
+-- Checkout Events (if using Checkout)
    +-- checkout.session.completed
```

### Configure Stripe Connect

```
Dashboard -> Connect -> Settings

Configure:
+-- Platform Profile
|   +-- Platform name: Familiarise
|   +-- Platform URL
|   +-- Support email
|
+-- Branding
|   +-- Logo
|   +-- Brand color
|   +-- Accent color
|
+-- Connected Account Settings
    +-- Account types: Express (recommended)
    +-- Countries: Enable all supported
    +-- Capabilities: card_payments, transfers
```

### Test Mode vs Live Mode

```
Dashboard -> Toggle "Viewing test data" switch

Test Mode:
+-- Uses test API keys
+-- No real money processed
+-- Use test card numbers
+-- Test webhooks with CLI

Live Mode:
+-- Uses live API keys
+-- Real transactions
+-- Requires full verification
```

---

## SDK Installation

### Install Stripe Package

```bash
npm install stripe @stripe/stripe-js @stripe/react-stripe-js
```

### Initialize Server-Side Client

```typescript
// lib/payments/core/stripe.ts

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2023-10-16", // Use latest stable version
  typescript: true,
});

export default stripe;
```

### Initialize Client-Side

```typescript
// lib/stripe-client.ts

import { loadStripe } from "@stripe/stripe-js";

export const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
);
```

### Create Payment Intent Example

```typescript
// app/api/payments/create-intent/route.ts

import stripe from "@/lib/payments/core/stripe";

export async function POST(req: Request) {
  const { amount, currency, appointmentId } = await req.json();

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amount, // Already in smallest unit (cents)
    currency: currency.toLowerCase(), // 'usd', 'eur', etc.
    metadata: {
      appointmentId,
    },
    automatic_payment_methods: {
      enabled: true,
    },
  });

  return Response.json({
    clientSecret: paymentIntent.client_secret,
  });
}
```

### Webhook Verification

```typescript
// lib/payments/webhooks/stripe-verify.ts

import Stripe from "stripe";

export function verifyStripeWebhook(
  body: string,
  signature: string,
  secret: string,
): Stripe.Event {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  return stripe.webhooks.constructEvent(body, signature, secret);
}
```

---

## Testing

### Test Card Numbers

```
+------------------------+------------------+------------------+
| Scenario               | Card Number      | CVC / Exp        |
+------------------------+------------------+------------------+
| Success                | 4242 4242 4242 4242 | Any 3 digits, Future |
| Requires Auth (3DS)    | 4000 0027 6000 3184 | Any 3 digits, Future |
| Declined               | 4000 0000 0000 0002 | Any 3 digits, Future |
| Insufficient Funds     | 4000 0000 0000 9995 | Any 3 digits, Future |
+------------------------+------------------+------------------+

For testing, use:
- Any future expiration date
- Any 3-digit CVC
- Any 5-digit ZIP code
```

### Testing with Stripe CLI

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe  # macOS
# Or download from https://stripe.com/docs/stripe-cli

# Login to Stripe
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# This gives you a webhook signing secret for testing:
# whsec_xxxxx

# In another terminal, trigger test events:
stripe trigger payment_intent.succeeded
stripe trigger transfer.paid
```

### Test Connected Accounts

```bash
# Create test connected account via CLI
stripe accounts create \
  --type express \
  --country US \
  --email test@example.com

# Or use the dashboard in test mode
```

### Test Transfers

```typescript
// Test transfer to connected account (test mode)
const transfer = await stripe.transfers.create({
  amount: 5000, // $50.00 in cents
  currency: "usd",
  destination: "acct_xxxxx", // Test connected account
});
```

---

## Common Issues & Troubleshooting

### Issue: "Invalid API Key"

```
Cause: Using wrong key or environment mismatch
Fix:
1. Verify you're using the correct test/live key
2. Check key hasn't been rolled/rotated
3. Ensure no whitespace in environment variable
```

### Issue: "Webhook signature verification failed"

```
Cause: Body modified before verification
Fix:
1. Use raw request body (not parsed JSON)
2. Verify webhook secret matches endpoint
3. Check for middleware modifying request
```

### Issue: "Connected account onboarding incomplete"

```
Cause: User didn't finish Stripe's onboarding
Fix:
1. Check account.details_submitted status
2. Send reminder to complete onboarding
3. Provide new onboarding link
```

### Issue: "Transfer failed - insufficient funds"

```
Cause: Platform balance doesn't cover transfer
Fix:
1. Check your Stripe balance
2. Ensure payments have settled
3. Wait for pending balance to become available
```

---

## Currency Handling

### Important: Stripe Uses Smallest Units

```
+----------+---------------+------------------+
| Currency | Unit          | $50 Amount       |
+----------+---------------+------------------+
| USD      | cents         | 5000             |
| EUR      | cents         | 5000             |
| GBP      | pence         | 5000             |
| JPY      | yen           | 5000 (no decimal)|
| INR      | paise         | 500000           |
+----------+---------------+------------------+

// Helper function
function toStripeAmount(amount: number, currency: string): number {
  const zeroDecimalCurrencies = ['JPY', 'KRW', 'VND'];
  if (zeroDecimalCurrencies.includes(currency.toUpperCase())) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}
```

---

## Security Best Practices

```
DO:
+-- Use HTTPS everywhere
+-- Verify all webhook signatures
+-- Store only necessary data
+-- Use Connect for marketplace payouts
+-- Implement idempotency keys
+-- Use Stripe.js for card collection (PCI compliance)

DON'T:
+-- Expose secret keys in client code
+-- Store raw card numbers
+-- Log sensitive payment data
+-- Skip webhook verification
+-- Trust client-side amounts (always verify server-side)
```

---

## Related Documents

- [02-architecture-and-flow.md](./02-architecture-and-flow.md) - Payment flow details
- [03-payout-flow.md](./03-payout-flow.md) - Consultant payout system
- [Stripe Official Docs](https://stripe.com/docs) - API reference
- [Stripe Connect Docs](https://stripe.com/docs/connect) - Marketplace guide
