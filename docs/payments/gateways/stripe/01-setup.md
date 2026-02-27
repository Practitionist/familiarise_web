# Stripe Setup Guide

> Setting up Stripe for international payment processing and Stripe Connect for consultant payouts.

**Last Updated**: 2026-02-14

---

## Overview

Stripe is our payment gateway for international customers (outside India), handling:

- Credit/Debit Cards worldwide
- Apple Pay, Google Pay
- Bank debits (ACH, SEPA)
- Local payment methods (iDEAL, Bancontact, etc.)
- 135+ currencies

Stripe serves two roles in our system:

| Product             | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| **Stripe Payments** | Accept payments from international consultees  |
| **Stripe Connect**  | Disburse earnings to international consultants |

### When to Use Stripe vs Razorpay

| Customer From | Gateway  | Why                     |
| ------------- | -------- | ----------------------- |
| India         | Razorpay | UPI support, lower fees |
| USA           | Stripe   | ACH, US cards           |
| Europe        | Stripe   | SEPA, iDEAL             |
| UK            | Stripe   | GBP, UK cards           |
| Others        | Stripe   | Global support          |

---

## Prerequisites

| Requirement     | Details                                         |
| --------------- | ----------------------------------------------- |
| Business Entity | Registered business or individual               |
| Bank Account    | For receiving payouts from Stripe               |
| Website         | Live URL with clear product/service description |
| Email           | For account verification                        |
| Government ID   | For identity verification                       |

---

## Account Setup

### Step 1: Create Stripe Account

1. Sign up at `dashboard.stripe.com/register`
2. Enter email and create password
3. Verify email and select country

### Step 2: Complete Business Verification

Provide via Dashboard > Settings > Business settings:

- Business type, name, Tax ID (if applicable), website URL
- Personal details (legal name, DOB, address, phone)
- Bank account (account number, routing number)
- Identity verification (government ID upload)

### Step 3: Enable Stripe Connect

Connect is required for consultant payouts:

1. Dashboard > Connect > Get started
2. Accept Connect agreement
3. Configure branding (logo, colors)
4. Set connected account type to **Express**
5. Enable required capabilities: `card_payments`, `transfers`
6. Configure payout settings

### Step 4: Generate API Keys

Dashboard > Developers > API keys

- **Publishable key**: `pk_test_xxxxx` (safe for frontend)
- **Secret key**: `sk_test_xxxxx` (server-side only)
- **Webhook signing secret**: `whsec_xxxxx`

---

## Environment Variables

### Payment Keys

| Variable                 | Description                    | Example         |
| ------------------------ | ------------------------------ | --------------- |
| `STRIPE_SECRET_KEY`      | Server-side secret key         | `sk_test_xxxxx` |
| `STRIPE_WEBHOOK_SECRET`  | Webhook signature verification | `whsec_xxxxx`   |
| `NEXT_PUBLIC_STRIPE_KEY` | Client-side publishable key    | `pk_test_xxxxx` |

### Connect Keys (Payouts)

| Variable                        | Description                            |
| ------------------------------- | -------------------------------------- |
| `STRIPE_CONNECT_CLIENT_ID`      | OAuth client ID for Connect            |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Connect webhook signature verification |

### Test vs Live Keys

| Environment | Key Format                      |
| ----------- | ------------------------------- |
| Test Mode   | `sk_test_xxxx` / `pk_test_xxxx` |
| Live Mode   | `sk_live_xxxx` / `pk_live_xxxx` |

Never expose secret keys in client-side code.

### API Version

The system uses Stripe API version `2025-12-15.clover`.

---

## Dashboard Configuration

### Webhook Setup

Dashboard > Developers > Webhooks > Add endpoint

**URL**: `https://yoursite.com/api/webhooks/stripe`

**Events to select**:

| Category        | Events                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| Payment         | `payment_intent.succeeded`, `payment_intent.payment_failed`                 |
| Refund          | `charge.refunded`                                                           |
| Dispute         | `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed` |
| Connect Payout  | `payout.created`, `payout.paid`, `payout.failed`, `payout.canceled`         |
| Connect Account | `account.updated`                                                           |
| Transfer        | `transfer.created`, `transfer.reversed`                                     |

### Test Mode vs Live Mode

Toggle "Viewing test data" switch in the dashboard.

- **Test Mode**: Uses test API keys, no real money, test webhooks via CLI
- **Live Mode**: Real transactions, requires full verification

---

## Testing

### Test Card Numbers

| Scenario           | Card Number           | Notes                      |
| ------------------ | --------------------- | -------------------------- |
| Success            | `4242 4242 4242 4242` | Any CVC, any future expiry |
| Requires 3DS       | `4000 0027 6000 3184` | Triggers authentication    |
| Declined           | `4000 0000 0000 0002` | Always declined            |
| Insufficient Funds | `4000 0000 0000 9995` | Balance too low            |

### Testing with Stripe CLI

```
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login to Stripe
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# Trigger test events
stripe trigger payment_intent.succeeded
stripe trigger transfer.paid
```

### Test Connected Accounts

```
stripe accounts create --type express --country US --email test@example.com
```

---

## Currency Handling

Stripe uses smallest currency units (cents, pence, etc.):

| Currency | Unit             | $50 Amount |
| -------- | ---------------- | ---------- |
| USD      | cents            | 5000       |
| EUR      | cents            | 5000       |
| GBP      | pence            | 5000       |
| JPY      | yen (no decimal) | 5000       |

All Stripe payments on Familiarise are in **USD**. The checkout logic forces `currency: "USD"` when Stripe is selected.

---

## Common Issues & Troubleshooting

### "Invalid API Key"

- Verify test/live key matches the dashboard mode
- Check key hasn't been rolled/rotated
- Ensure no whitespace in environment variable

### "Webhook signature verification failed"

- Use raw request body (not parsed JSON) for verification
- Verify webhook secret matches the endpoint in Stripe dashboard
- Check for middleware modifying the request

### "Connected account onboarding incomplete"

- Check `account.details_submitted` status
- Send reminder to complete onboarding
- Generate a new onboarding link

### "Transfer failed - insufficient funds"

- Check platform Stripe balance
- Ensure payments have settled
- Wait for pending balance to become available

---

## Security Best Practices

- Use HTTPS everywhere
- Verify all webhook signatures
- Store only necessary data — use Stripe.js for card collection (PCI compliance)
- Implement idempotency keys for transfers
- Never trust client-side amounts — always verify server-side
- Never log sensitive payment data

---

## Source Files

| File                                         | Purpose                                                     |
| -------------------------------------------- | ----------------------------------------------------------- |
| `lib/payments/core/stripe.ts`                | Client initialization, Checkout Sessions, refunds, disputes |
| `lib/payments/payouts/stripe-connect.ts`     | StripeConnectService — accounts, transfers, payouts         |
| `app/api/webhooks/stripe/route.ts`           | Webhook handler (16 event types)                            |
| `app/checkout/components/StripeCheckout.tsx` | Client-side checkout component                              |

---

## Related Documents

- [Gateway Overview](../README.md) — Comparison and selection logic
- [02-architecture-and-flow.md](./02-architecture-and-flow.md) — Checkout Sessions flow and revenue split
- [03-payout-flow.md](./03-payout-flow.md) — Stripe Connect payout system
