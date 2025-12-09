# Razorpay Setup Guide

## Overview

This guide covers setting up Razorpay for payment processing on Familiarise. Razorpay is our primary payment gateway for Indian customers.

### What is Razorpay?

Razorpay is India's leading payment gateway that supports:
- Credit/Debit Cards (Visa, Mastercard, RuPay)
- UPI (Google Pay, PhonePe, Paytm)
- Net Banking (100+ banks)
- Wallets (PayZapp, Mobikwik, etc.)
- EMI options

### Why Razorpay for Familiarise?

```
+------------------+----------------------------------------+
| Feature          | Why It Matters                         |
+------------------+----------------------------------------+
| Route            | Automated payouts to consultants       |
| UPI Support      | 60%+ of Indian payments are UPI        |
| Low Fees         | 2% + GST (competitive rates)           |
| Quick Settlement | T+2 days (funds in bank)               |
| Indian Focus     | Best support for INR transactions      |
+------------------+----------------------------------------+
```

---

## Prerequisites

Before setting up Razorpay, ensure you have:

| Requirement | Details |
|-------------|---------|
| Business Registration | Sole proprietorship, Partnership, Pvt Ltd, or LLP |
| PAN Card | Business PAN or Individual PAN |
| GST Registration | Optional but recommended (for input tax credit) |
| Bank Account | Current account in business name |
| Website/App | Live URL for verification |
| Email/Phone | For account verification |

---

## Account Setup Steps

### Step 1: Create Razorpay Account

```
1. Go to https://dashboard.razorpay.com/signup
2. Enter business email
3. Create password
4. Verify email
```

### Step 2: Complete Business Verification

```
Dashboard -> Settings -> Business Settings

Provide:
+-- Business Details
|   +-- Business type (Pvt Ltd, Sole Prop, etc.)
|   +-- Business name
|   +-- Business PAN
|   +-- GSTIN (if registered)
|
+-- Bank Details
|   +-- Account number
|   +-- IFSC code
|   +-- Account holder name
|
+-- Address Proof
|   +-- Registered address
|   +-- Supporting document
|
+-- Identity Proof
    +-- Authorized signatory details
    +-- Aadhaar/Passport
```

### Step 3: Enable Route Feature

Route is required for consultant payouts. Request activation:

```
Dashboard -> Route -> Request Access

Requirements for Route:
- Verified Razorpay account
- Minimum 3 months account age (or business documents)
- Clear use case explanation
```

### Step 4: Generate API Keys

```
Dashboard -> Settings -> API Keys -> Generate Key

You will receive:
+-- Key ID: rzp_test_xxxxxxxxxxxxx (starts with rzp_test_ or rzp_live_)
+-- Key Secret: xxxxxxxxxxxxxxxxx (shown only once - SAVE IT!)
```

---

## Environment Variables

Add these to your `.env` file:

```env
# Razorpay Configuration
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx

# Optional: Separate webhook secret for Route/Payout events
RAZORPAY_ROUTE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
```

### Test vs Live Keys

```
+------------------+----------------------------------+
| Environment      | Key Format                       |
+------------------+----------------------------------+
| Test Mode        | rzp_test_xxxxxxxxxxxxx           |
| Live Mode        | rzp_live_xxxxxxxxxxxxx           |
+------------------+----------------------------------+

IMPORTANT: Never commit live keys to git!
Use environment variables or secrets manager.
```

---

## Dashboard Configuration

### Webhook Setup

```
Dashboard -> Settings -> Webhooks -> Add New Webhook

URL: https://yoursite.com/api/webhooks/razorpay

Select Events:
+-- Payment Events
|   +-- payment.authorized
|   +-- payment.captured
|   +-- payment.failed
|
+-- Refund Events
|   +-- refund.created
|   +-- refund.processed
|
+-- Route Events (for payouts)
    +-- transfer.processed
    +-- transfer.settled
    +-- transfer.failed
```

### Webhook Secret

After creating webhook, copy the secret:

```
Webhook Secret: whsec_xxxxxxxxxxxxx

This is used to verify webhook signatures.
Store in RAZORPAY_WEBHOOK_SECRET env variable.
```

### Test Mode vs Live Mode

```
Dashboard -> Toggle in top-right corner

Test Mode:
+-- Uses test API keys
+-- No real money moved
+-- Use test card numbers
+-- Webhooks still fire (to test endpoints)

Live Mode:
+-- Uses live API keys
+-- Real transactions
+-- Real money movement
+-- Complete verification required
```

---

## SDK Installation

### Install Razorpay Package

```bash
npm install razorpay
```

### Initialize Client

```typescript
// lib/payments/core/razorpay.ts

import Razorpay from "razorpay";

// Initialize Razorpay client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export default razorpay;
```

### Create Order Example

```typescript
// Create an order before checkout
async function createOrder(amount: number) {
  const order = await razorpay.orders.create({
    amount: amount * 100, // Razorpay expects paise (100 paise = 1 INR)
    currency: "INR",
    receipt: `order_${Date.now()}`,
    notes: {
      description: "Consultation booking",
    },
  });

  return order;
}
```

### Webhook Verification

```typescript
// lib/payments/webhooks/verify.ts

import crypto from "crypto";

export function verifyRazorpayWebhook(
  body: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

---

## Testing

### Test Card Numbers

```
+------------------------+------------------+-------------+
| Card Type              | Number           | CVV/Expiry  |
+------------------------+------------------+-------------+
| Mastercard (Success)   | 5267 3181 8797 5449 | Any CVV, Future date |
| Visa (Success)         | 4111 1111 1111 1111 | Any CVV, Future date |
| RuPay (Success)        | 6076 6506 0000 0083 | Any CVV, Future date |
| Card (Failure)         | 4000 0000 0000 0002 | Any CVV, Future date |
+------------------------+------------------+-------------+

Note: Any future expiry date and any 3-digit CVV works in test mode.
```

### Test UPI IDs

```
+------------------------+------------------+
| Scenario               | UPI ID           |
+------------------------+------------------+
| Success                | success@razorpay |
| Failure                | failure@razorpay |
+------------------------+------------------+
```

### Test Net Banking

```
In test mode, any bank selection will show a simulation page
where you can choose success or failure.
```

### Testing Webhooks Locally

Use ngrok or similar to expose local server:

```bash
# Install ngrok
npm install -g ngrok

# Expose local server
ngrok http 3000

# Use the ngrok URL for webhook endpoint
# https://xxxx-xx-xx-xx.ngrok.io/api/webhooks/razorpay
```

### Test Transfer (Route)

```typescript
// In test mode, transfers work the same as live
// but no real money moves

const transfer = await razorpay.transfers.create({
  account: "acc_xxxxx", // Linked account ID
  amount: 10000, // 100 INR in paise
  currency: "INR",
});
```

---

## Common Issues & Troubleshooting

### Issue: "Invalid API Key"

```
Cause: Wrong key or environment mismatch
Fix:
1. Check if using test key with test mode
2. Check if key is copied correctly (no spaces)
3. Verify key hasn't been regenerated
```

### Issue: "Webhook signature verification failed"

```
Cause: Wrong webhook secret or body modification
Fix:
1. Use raw request body (not parsed JSON)
2. Verify webhook secret matches dashboard
3. Check for proxy/middleware modifying body
```

### Issue: "Route not enabled"

```
Cause: Route feature not activated on account
Fix:
1. Apply for Route in dashboard
2. Wait for Razorpay approval (1-3 days)
3. Complete any additional verification
```

### Issue: "Insufficient balance for transfer"

```
Cause: Trying to transfer more than available
Fix:
1. Check settlement status of payments
2. Wait for T+2 settlement
3. Use "on_hold" parameter for delayed transfers
```

---

## Security Best Practices

```
DO:
+-- Store API keys in environment variables
+-- Verify webhook signatures
+-- Use HTTPS for all endpoints
+-- Log payment events for audit
+-- Implement idempotency keys

DON'T:
+-- Commit API keys to git
+-- Log full card numbers
+-- Trust client-side payment data
+-- Skip webhook verification
+-- Store CVV or full card details
```

---

## Related Documents

- [02-architecture-and-flow.md](./02-architecture-and-flow.md) - Payment flow details
- [03-payout-flow.md](./03-payout-flow.md) - Consultant payout system
- [Razorpay Official Docs](https://razorpay.com/docs/) - API reference
