---
name: razorpay-setup
description: Configures or verifies Razorpay and RazorpayX environment variables, PM-10 live-key boot guards, and local/preview setup in this repo. Use when onboarding an environment, rotating secrets, or configuring Razorpay/RazorpayX credentials.
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: sonnet
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
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret          # Distinct from RAZORPAY_SECRET!
# RAZORPAY_WEBHOOK_SECRET_PREVIOUS=old_payment_whsec  # Zero-downtime rotation grace window

# 3. RazorpayX Payouts & Fund Account Validation (Penny Drop / Reverse Penny Drop)
RAZORPAYX_KEY_ID=rzp_test_XXXXXXXXXXXXXX
RAZORPAYX_KEY_SECRET=your_razorpayx_key_secret
RAZORPAYX_ACCOUNT_NUMBER=23232300XXXXXXXX            # Live account_number differs from Test mode!
RAZORPAYX_WEBHOOK_SECRET=your_razorpayx_whsec        # Distinct secret for payout.* & fund_account.*
# RAZORPAYX_WEBHOOK_SECRET_PREVIOUS=old_rx_whsec     # Zero-downtime rotation grace window for RazorpayX
ENABLE_LIVE_PAYOUTS=false                            # Set to "true" ONLY after live preflight & SQL reset
```

### Rules for Credentials & Portable Cutover Hygiene (Any Company / Codebase)

1. **Default to Test Mode (`rzp_test_`)** for local development and deploy previews; **delete `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION`** when flipping live keys.
2. **Pre-Cutover SQL Purge of Sandbox Entity IDs (`cust_*`, `cont_*`, `fa_*`)**:
   - Every Razorpay `cust_*` / `cont_*` / `fa_*` ID is bound to Test **or** Live mode. Before enabling live keys on a shared DB, clear all test pointers (`UPDATE users SET "razorpayCustomerId" = NULL; UPDATE "PayoutAccount" SET "razorpayContactId" = NULL, "razorpayFundAccId" = NULL, "isVerified" = false; UPDATE "OrganizationPayoutAccount" SET "razorpayContactId" = NULL, "razorpayFundAccountId" = NULL, "isVerified" = false;`).
3. **Never expose secrets to the browser**: Only `NEXT_PUBLIC_RAZORPAY_KEY_ID` is public, and it must exactly match `RAZORPAY_KEY_ID`.

---

## Step 2: Verify Client Singletons, Safeguards & Webhook Route

Confirm that these portable safety invariants are intact:

- `lib/payments/core/razorpay.ts` — `sanitizeRazorpayNotes` caps `notes` to `<= 15` keys / `<= 256` chars; `createRazorpayOrder` self-heals stale cross-mode `customer_id` on `400`/`404` and bounds `capture_options` to `[12, 7200]` minutes.
- `lib/payments/payouts/razorpay-payouts.ts` — enforces `narration <= 30` chars `[A-Za-z0-9 ]`, `UPI <= ₹1L` (`10_000_000` paise), `IMPS <= ₹5L` (`50_000_000` paise), `RTGS >= ₹2L` (`20_000_000` paise), and `X-Payout-Idempotency` (`4–36` chars).
- `app/api/webhooks/razorpay/signature.ts` & `route.ts` — checks body cap (`<= 256 KB`) first, verifies `resolveRazorpayPaymentSecrets()` first, and lazily falls back to `resolveRazorpayXSecrets()` strictly for `payout.*` and `fund_account.*`.

---

## Step 3: Connectivity, Drift Check & Live ₹1 Penny-Test Protocol

1. If `RAZORPAY_KEY_ID` and `RAZORPAY_SECRET` are configured, verify connectivity via `GET https://api.razorpay.com/v1/orders?count=1`.
2. Run the documentation and contract drift check:
   ```bash
   bash .claude/skills/finance/references/razorpay/scripts/check-doc-drift.sh
   ```
3. When cutting over to Live Mode (`rzp_live_*`), guide the engineer through all **4 live ₹1.00 penny tests** in `.claude/skills/finance/references/razorpay/references/go-live.md` (Checkout -> Full Refund -> Reverse Penny Drop `upi_intent` -> Live Consultant Payout + UTR check).
