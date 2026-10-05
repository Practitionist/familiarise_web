---
name: razorpay-setup
description: Configures or verifies Razorpay and RazorpayX environment variables, PM-10 live-key boot guards, and local/preview setup in this repo. Use when onboarding an environment, rotating secrets, or configuring Razorpay/RazorpayX credentials.
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: green
---

## Before you start

**Read these first under `.claude/skills/finance/references/razorpay/`:**
1. `references/this-repo.md` — the complete map of this repo's Razorpay and RazorpayX setup.
2. `references/go-live.md` — live-mode cutover, PM-10 boot guards, and zero-downtime secret rotation.
3. `references/local-testing.md` — local dev and Netlify deploy preview setup.

**CRITICAL — Do NOT scaffold `lib/razorpay.ts`, Drizzle schemas, or `/v1/plans` subscriptions.**
This repo's Razorpay (`lib/payments/core/razorpay.ts`) and RazorpayX (`lib/payments/payouts/razorpay-payouts.ts`) clients, Prisma schema (`prisma/schema.prisma`), and webhook handlers (`app/api/webhooks/razorpay/route.ts`) are already built. This agent configures and verifies environment variables, secret rotation, and boot guards for local, Netlify deploy preview, or production environments.

---

## Step 1: Verify or Configure Environment Variables

Check `.env.local` (for local development) and `.env.example` (template — never put real secrets in `.env.example`):

```bash
# 1. Razorpay Standard Gateway (Orders, Checkout, Refunds, Disputes, Customers)
RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXX
RAZORPAY_SECRET=your_razorpay_key_secret          # Named RAZORPAY_SECRET in this repo (NOT RAZORPAY_KEY_SECRET — drift-ok)
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXX # Must match RAZORPAY_KEY_ID

# 2. Razorpay Webhooks (Account & Settings -> Webhooks)
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret       # Distinct from RAZORPAY_SECRET!
# Optional: used only during zero-downtime webhook secret rotation
# RAZORPAY_WEBHOOK_SECRET_PREVIOUS=your_old_webhook_secret

# 3. RazorpayX Payouts & Fund Account Validation (Penny Drop / Reverse Penny Drop)
RAZORPAYX_KEY_ID=rzp_test_XXXXXXXXXXXXXX
RAZORPAYX_KEY_SECRET=your_razorpayx_key_secret
RAZORPAYX_ACCOUNT_NUMBER=23232300XXXXXXXX         # RazorpayX virtual/current account number (debited for payouts & penny drop)
ENABLE_LIVE_PAYOUTS=false                         # Set to "true" ONLY in live production

# Optional: Platform VPA for UPI Intent Reverse Penny Drop fallback
# RAZORPAY_RPD_VPA=familiarise@icici
```

### Rules for Credentials
1. **Default to Test Mode (`rzp_test_`)** for local development and Netlify deploy previews.
2. **PM-10 Production Boot Guards**:
   - `assertNoTestKeysInLiveProduction()` in `lib/payments/core/razorpay.ts` throws at boot if `RAZORPAY_KEY_ID` starts with `rzp_test_` when `NODE_ENV=production` on a live production deployment (unless `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION=true` is explicitly set for staging).
   - `assertNoTestKeysInLivePayouts()` in `lib/payments/payouts/razorpay-payouts.ts` blocks `rzp_test_` keys when `ENABLE_LIVE_PAYOUTS=true`.
3. **Never expose secrets to the browser**: Only `NEXT_PUBLIC_RAZORPAY_KEY_ID` is public.

---

## Step 2: Verify Client Singletons & Webhook Route

Confirm that the existing integration files are intact:
- `lib/payments/core/razorpay.ts` — exports `razorpayClient` (nullable when env vars are omitted in CI/tests), `verifyRazorpaySignature`, `verifyRazorpayWebhookSignature`, and `ensureRazorpayCustomer`.
- `lib/payments/payouts/razorpay-payouts.ts` — exports RazorpayX REST client helpers (`createRazorpayContact`, `createRazorpayFundAccount`, `createRazorpayPayout`, `fetchRazorpayPayout`).
- `app/api/webhooks/razorpay/route.ts` and `app/api/webhooks/razorpay-dispatch.ts` — single webhook ingress for both Razorpay Payments and RazorpayX events.

---

## Step 3: Connectivity & Drift Check

1. If `RAZORPAY_KEY_ID` and `RAZORPAY_SECRET` are set in `.env.local`, test connectivity against `GET https://api.razorpay.com/v1/orders?count=1`.
2. Run the documentation and contract drift check:
   ```bash
   bash .claude/skills/finance/references/razorpay/scripts/check-doc-drift.sh
   ```
3. Report the environment status and offer to run `razorpay-diagnostics` or `razorpay-test-webhook` if the user wants to test webhook delivery locally.
