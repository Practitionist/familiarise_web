# Razorpay Setup Guide

> Setting up Razorpay for payment processing and RazorpayX for consultant payouts on Familiarise.

**Last Updated**: 2026-02-14

---

## Overview

Razorpay is our primary payment gateway for Indian customers, handling:

- Credit/Debit Cards (Visa, Mastercard, RuPay)
- UPI (Google Pay, PhonePe, Paytm)
- Net Banking (100+ banks)
- Wallets (PayZapp, Mobikwik, etc.)
- EMI options

Razorpay serves two distinct roles in our system:

| Product                 | Purpose                          |
| ----------------------- | -------------------------------- |
| **Razorpay** (Payments) | Accept payments from consultees  |
| **RazorpayX** (Payouts) | Disburse earnings to consultants |

---

## Prerequisites

| Requirement           | Details                                           |
| --------------------- | ------------------------------------------------- |
| Business Registration | Sole proprietorship, Partnership, Pvt Ltd, or LLP |
| PAN Card              | Business PAN or Individual PAN                    |
| GST Registration      | Optional but recommended (for input tax credit)   |
| Bank Account          | Current account in business name                  |
| Website/App           | Live URL for verification                         |
| Email/Phone           | For account verification                          |

---

## Account Setup

### Step 1: Create Razorpay Account

1. Sign up at `dashboard.razorpay.com/signup`
2. Enter business email and create password
3. Verify email

### Step 2: Complete Business Verification

Provide via Dashboard > Settings > Business Settings:

- Business type, name, PAN, GSTIN (if registered)
- Bank account number, IFSC code, account holder name
- Registered address and supporting document
- Authorized signatory identity proof (Aadhaar/Passport)

### Step 3: Enable RazorpayX

RazorpayX is required for consultant payouts:

1. Apply for RazorpayX via the Razorpay dashboard
2. Complete additional verification if required
3. Obtain a RazorpayX account number once approved

### Step 4: Generate API Keys

Dashboard > Settings > API Keys > Generate Key

- **Key ID**: starts with `rzp_test_` (test) or `rzp_live_` (live)
- **Key Secret**: shown only once — save immediately

---

## Environment Variables

### Payment & Webhook Keys

| Variable                                  | Description                                                             | Example                  |
| ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
| `RAZORPAY_KEY_ID`                         | Server-side API key ID                                                  | `rzp_test_xxxxxxxxxxxxx` |
| `RAZORPAY_SECRET`                         | Server-side API key secret (named `RAZORPAY_SECRET` in this repo)       | `xxxxxxxxxxxxxxxxx`      |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID`             | Client-side publishable key (must match `RAZORPAY_KEY_ID`)              | `rzp_test_xxxxxxxxxxxxx` |
| `RAZORPAY_WEBHOOK_SECRET`                 | Webhook HMAC-SHA256 verification secret (distinct from API secret)      | `xxxxxxxxxxxxxxxxx`      |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`        | Optional previous webhook secret during zero-downtime secret rotation   | `xxxxxxxxxxxxxxxxx`      |
| `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION`  | Pre-launch override only; **must be unset/deleted** in live production  | Unset in live prod       |

### RazorpayX Payout & Validation Keys

| Variable                   | Description                                            | Fallback                                     |
| -------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| `RAZORPAYX_KEY_ID`         | RazorpayX API key ID                                   | Falls back to `RAZORPAY_KEY_ID` in non-prod  |
| `RAZORPAYX_KEY_SECRET`     | RazorpayX API key secret                               | Falls back to `RAZORPAY_SECRET` in non-prod  |
| `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX current/virtual account number               | Required for payouts & Penny Drop            |
| `RAZORPAYX_WEBHOOK_SECRET` | Optional separate RazorpayX webhook secret             | Optional                                     |
| `ENABLE_LIVE_PAYOUTS`      | Enables live payouts (`"true"`); enforces PM-10 guard  | `"false"` in dev/staging                     |
| `RAZORPAY_RPD_VPA`         | Optional platform VPA for Reverse Penny Drop fallback  | Optional                                     |

### Test vs Live Keys

| Environment | Key Format               |
| ----------- | ------------------------ |
| Test Mode   | `rzp_test_xxxxxxxxxxxxx` |
| Live Mode   | `rzp_live_xxxxxxxxxxxxx` |

Never commit live keys to version control. In live production, PM-10 boot guards (`assertNoTestKeysInLiveProduction` in `lib/payments/core/razorpay.ts` and `assertNoTestKeysInLivePayouts` in `lib/payments/payouts/razorpay-payouts.ts`) refuse `rzp_test_` keys at startup.

---

## Dashboard Configuration

### Webhook Setup

Dashboard > Account & Settings > Webhooks > Add New Webhook (delivery logs live under Developers > Webhooks)

**URL**: `https://yoursite.com/api/webhooks/razorpay`

**Events to select**:

| Category                          | Events                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment & Order                   | `payment.authorized`, `payment.captured`, `order.paid`, `payment.failed`                                                                                              |
| Refund                            | `refund.created`, `refund.processed`, `refund.failed`, `refund.speed_changed`                                                                                         |
| Dispute                           | `payment.dispute.created`, `payment.dispute.under_review`, `payment.dispute.action_required`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed` |
| Payout (RazorpayX)                | `payout.initiated`, `payout.updated`, `payout.processed`, `payout.failed`, `payout.reversed`, `payout.rejected`, `payout.queued`, `payout.pending`, `payout.cancelled` |
| Fund Account Validation (FAV)     | `fund_account.validation.completed`, `fund_account.validation.failed`                                                                                                 |

This list matches the go-live checklist and the dispatcher in `app/api/webhooks/razorpay-dispatch.ts`. Omitting `payout.failed` or `payout.initiated` is a costly mistake: `payout.initiated` is the webhook RazorpayX fires when a payout enters `processing`, and `payout.failed` is the terminal event when a transfer fails at the bank.

Copy the webhook secret after creation and store it in `RAZORPAY_WEBHOOK_SECRET`. Each mode has its own webhook secret, so the value generated in test mode will reject every live delivery and vice versa. Rotating the secret later is a two-sided change and must follow the grace-window procedure (`RAZORPAY_WEBHOOK_SECRET_PREVIOUS`) in [05-go-live-checklist.md](./05-go-live-checklist.md), because a hard cutover loses events signed during the gap and Razorpay auto-disables any webhook endpoint that returns non-2xx for 24 hours.

### Test Mode vs Live Mode

Toggle via top-left/top-right mode selector of the Razorpay dashboard.

- **Test Mode**: Uses test API keys, no real money, webhooks still fire (note: RazorpayX `POST /v1/fund_accounts/validations` is not supported in test mode)
- **Live Mode**: Real transactions, requires complete KYC verification

---

## Testing

### Official Razorpay Test Card Numbers

> **Note**: Do **not** use Stripe test cards (`4111 1111 1111 1111` or `4000 0000 0000 0002`) with Razorpay. Use Razorpay's official test cards below ([official docs](https://razorpay.com/docs/payments/payments/test-card-details/)). On the simulated bank ACS page in test mode, you choose **Success** or **Failure** directly. <!-- drift-ok -->

| Card Network                | Number                | Notes                                                      |
| --------------------------- | --------------------- | ---------------------------------------------------------- |
| Visa (Domestic)             | `4100 2800 0000 1007` | Any 3-digit CVV, any future expiry, choose Success/Failure |
| Visa (International)        | `4012 8888 8888 1881` | Any 3-digit CVV, any future expiry, tests international FX |
| Mastercard (Domestic)       | `5500 6700 0000 1002` | Any 3-digit CVV, any future expiry, choose Success/Failure |
| RuPay (Domestic)            | `6069 8500 0000 1006` | Any 3-digit CVV, any future expiry, choose Success/Failure |
| American Express (Domestic) | `3782 8224 6310 005`  | Any 4-digit CVV, any future expiry                         |
| Diners Club                 | `3056 9309 0259 04`   | Any 3-digit CVV, any future expiry                         |

### Test UPI IDs

| Scenario | UPI ID             |
| -------- | ------------------ |
| Success  | `success@razorpay` |
| Failure  | `failure@razorpay` |

### Test Net Banking

In test mode, any bank selection shows a simulation page where you can choose success or failure.

### Local Webhook Testing

Use a Netlify deploy preview or ngrok to expose your local server, or replay signed payloads directly via `curl` (see `.claude/skills/finance/references/razorpay/references/local-testing.md`):

```
ngrok http 3000
```

Set the tunnel URL as your test-mode webhook endpoint in the Razorpay dashboard.

---

## Common Issues & Troubleshooting

### "Invalid API Key"

- Verify test/live key matches the dashboard mode
- Check key is copied correctly (no whitespace)
- Verify key hasn't been regenerated

### "Webhook signature verification failed"

- Use raw request body (`await req.text()`, not parsed JSON) for verification
- Verify `RAZORPAY_WEBHOOK_SECRET` matches the dashboard (and is not set to `RAZORPAY_SECRET`)
- During secret rotation, set `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` to the retiring secret

### "RazorpayX not configured"

- Ensure `RAZORPAYX_ACCOUNT_NUMBER` is set
- Verify RazorpayX is approved and active on your account
- Check that `RAZORPAYX_KEY_ID` and `RAZORPAYX_KEY_SECRET` are set

---

## Security Best Practices

- Store all API keys in environment variables, never in code
- Verify webhook signatures on every incoming webhook using length-guarded `crypto.timingSafeEqual`
- Use HTTPS for all endpoints (webhook responses must complete within 5 seconds)
- Pass `X-Payout-Idempotency` (4–36 chars, required since 15 March 2025) on payouts and `X-Refund-Idempotency` (`>= 10` chars) on refunds
- Never log full card numbers or sensitive payment data
- Never trust client-side payment data — always verify server-side

---

## Source Files

| File                                           | Purpose                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `lib/payments/core/razorpay.ts`                | Client initialization, signature verification, `ensureRazorpayCustomer()`, PM-10 live guards |
| `lib/payments/core/razorpay-disputes.ts`       | REST Disputes & Documents API (`getRazorpayDispute`, `uploadDisputeDocument`, `contestDispute`) |
| `lib/payments/payouts/razorpay-payouts.ts`     | RazorpayX Payouts service (Contacts, Fund Accounts, Payouts, `boundPayoutIdempotencyKey`)    |
| `lib/payments/payouts/reverse-penny-drop.ts`   | Bank & UPI verification via Penny Drop (`/v1/fund_accounts/validations`) & UPI Intent RPD    |
| `app/api/webhooks/razorpay/route.ts`           | Webhook ingress, signature verification, and `WebhookEvent` deduplication                    |
| `app/api/webhooks/razorpay-dispatch.ts`        | Webhook event dispatcher (payment, order, refund, dispute, payout, and FAV events)           |
| `schemas/webhooks/razorpay.ts`                 | Zod schemas for all 24 validated Razorpay and RazorpayX webhook event types                  |

---

## Related Documents

- [Gateway Overview](../README.md) — Comparison and selection logic
- [02-architecture-and-flow.md](./02-architecture-and-flow.md) — Payment flow and revenue split
- [03-payout-flow.md](./03-payout-flow.md) — RazorpayX payout system
- [04-kyc-and-onboarding.md](./04-kyc-and-onboarding.md) — KYC requirements
- [05-go-live-checklist.md](./05-go-live-checklist.md) — What must be true before the first live rupee
