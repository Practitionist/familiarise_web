# Razorpay & RazorpayX Go-Live Checklist (Familiarise Platform)

Production cutover checklist for moving this repository from Razorpay Test Mode (`rzp_test_...`) to Live Mode (`rzp_live_...`).

---

## 1. Pre-Cutover Boot Guards in This Repo (`PM-10`)

This repository enforces two fail-fast runtime guards so a production deployment can never accidentally process live traffic against test keys:

1. **Core Gateway Guard ([`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts))**:
   - At module load, if `NODE_ENV === "production"` (outside `NEXT_PHASE === "phase-production-build"`) and `RAZORPAY_KEY_ID` starts with `rzp_test_`, the module throws `PaymentError("...", "RAZORPAY_TEST_KEY_IN_PRODUCTION")` unless `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION === "true"`.
   - **Go-Live Action**: Remove `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION` from Netlify/production environment variables when setting `rzp_live_...` keys.
2. **RazorpayX Payouts Guard ([`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts))**:
   - In `getRazorpayPayoutsService()`, if `ENABLE_LIVE_PAYOUTS === true` and the resolved RazorpayX key starts with `rzp_test_`, it throws `PaymentError("...", "RAZORPAYX_TEST_KEYS_IN_LIVE_MODE")`.
   - **Go-Live Action**: Set live `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`, and `RAZORPAYX_ACCOUNT_NUMBER` before flipping `ENABLE_LIVE_PAYOUTS=true`.

---

## 2. Credentials & Environment Variables (Netlify Production)

Generate Live keys in **Razorpay Dashboard** (switch top-bar toggle from **Test Mode** to **Live Mode** → **Account & Settings → API Keys**) and **RazorpayX Dashboard**:

| Variable | Live Value Requirements |
|---|---|
| `RAZORPAY_KEY_ID` | Must start with `rzp_live_` |
| `RAZORPAY_SECRET` | Live API Key Secret matching `RAZORPAY_KEY_ID` |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | **Must equal `RAZORPAY_KEY_ID`** (`rzp_live_...`) — baked into the client bundle at build time, so changing it requires a fresh Netlify build/deploy |
| `RAZORPAY_WEBHOOK_SECRET` | High-entropy secret (`openssl rand -hex 32`) configured on the Live Razorpay Dashboard webhook; **must be distinct** from `RAZORPAY_SECRET` |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` | Leave unset initially; populate with the retiring secret during any future webhook secret rotation (#1377) |
| `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION` | **Delete / unset** in production |
| `RAZORPAYX_KEY_ID` | Live RazorpayX Key ID (`rzp_live_...`) |
| `RAZORPAYX_KEY_SECRET` | Live RazorpayX Key Secret |
| `RAZORPAYX_ACCOUNT_NUMBER` | Live RazorpayX virtual/current account number (note: Live `account_number` is different from Test mode!) |
| `RAZORPAYX_WEBHOOK_SECRET` | High-entropy secret configured on the Live RazorpayX Dashboard webhook |
| `ENABLE_LIVE_PAYOUTS` | Set to `"true"` only after live RazorpayX keys, account number, and IP allowlist are verified |
| `ENABLE_SAVED_CARDS` | Set to `"true"` once Saved Cards / Flash Checkout tokenisation is active on the Live merchant account |

---

## 3. Live Webhook Configuration (Two Dashboards)

Test Mode and Live Mode webhooks are completely separate. Configure both in **Live Mode**:

### A. Razorpay Payments Dashboard (Developers → Webhooks → + Add New Webhook)
- **Webhook URL**: `https://<production-domain>/api/webhooks/razorpay`
- **Secret**: Value of `RAZORPAY_WEBHOOK_SECRET`
- **Alert Email**: Engineering/ops alert distribution address (Razorpay emails this address if the webhook fails for 24h and is auto-disabled)
- **Active Events to Subscribe (`14` events)**:
  - **Payments & Orders**: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`
  - **Refunds**: `refund.created`, `refund.processed`, `refund.failed`, `refund.speed_changed`
  - **Disputes**: `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed`, `payment.dispute.under_review`, `payment.dispute.action_required`

### B. RazorpayX Dashboard (Settings → Webhooks)
- **Webhook URL**: `https://<production-domain>/api/webhooks/razorpay`
- **Secret**: Value of `RAZORPAYX_WEBHOOK_SECRET`
- **Active Events to Subscribe (`11` events)**:
  - `payout.initiated` *(mandatory for `processing` transition)*
  - `payout.processed`
  - `payout.updated`
  - `payout.failed` *(mandatory per RazorpayX docs)*
  - `payout.reversed`
  - `payout.rejected`
  - `payout.queued`
  - `payout.pending`
  - `payout.cancelled`
  - `fund_account.validation.completed`
  - `fund_account.validation.failed`

---

## 4. Zero-Downtime Webhook Secret Rotation Procedure (`#1377`)

Because Razorpay continues signing in-flight retries with the secret that was active when the event originally fired, rotating `RAZORPAY_WEBHOOK_SECRET` without a grace window causes 400 rejections and risks 24h webhook auto-disable. Always rotate in 3 steps:

1. **Pre-stage**: Set `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` to the **current** secret value and `RAZORPAY_WEBHOOK_SECRET` to the **new** secret value in Netlify, then redeploy. (`app/api/webhooks/razorpay/signature.ts` now accepts both).
2. **Flip in Dashboard**: Update the webhook secret in the Razorpay Dashboard to the **new** value.
3. **Retire old secret**: Wait 24 hours (until no `WARN` `SystemEvent` logs for `"Razorpay webhook verified with RAZORPAY_WEBHOOK_SECRET_PREVIOUS"` appear), then unset `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`.

---

## 5. RazorpayX Production Prerequisites

1. **IP Allowlisting**: RazorpayX requires server outbound IPs to be allowlisted in the RazorpayX Dashboard before live `POST /v1/payouts` calls are permitted (`https://razorpay.com/docs/x/payouts/best-practices/`).
2. **Account Balance Preflight**: Verify `getAccountBalance()` in [`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts) against the live RazorpayX account before flipping `ENABLE_LIVE_PAYOUTS=true`.
3. **Reverse Penny Drop (`upi_intent`)**: Confirm Account Validation is enabled on the live RazorpayX account; if disabled, `startReversePennyDrop` gracefully returns `503 RPD_UNAVAILABLE` and falls back to manual bank account entry.

---

## 6. International Payments (PA-CB) & FIRS

If accepting international cards or bank transfers (`https://razorpay.com/docs/payments/international-payments/`):
1. **PA-CB Activation**: International card acceptance requires partner-bank approval under RBI's Payment Aggregator – Cross Border (PA-CB) framework (active website with pricing, Terms & Conditions, Privacy Policy, Refund & Cancellation Policy).
2. **RBI Purpose Code & FIRS**: Configure the applicable RBI Transaction Purpose Code under **Account & Settings → International Payment Codes** so Razorpay automatically generates **FIRS (Foreign Inward Remittance Statement)** certificates per settlement cycle (`https://razorpay.com/docs/payments/international-payments/firs-automated-process/`), required to substantiate zero-rated `EXPORT_LUT` supplies under GST.
3. **INR Settlement**: Razorpay settles international card payments in **INR** (T+7 working days default; T+2 working days for domestic payments).

---

## 7. Live Smoke Test Verification

1. **₹1 / Small Live Checkout**: Complete a real payment via UPI (`₹1` minimum on Razorpay Orders API).
2. **Verify Both Confirmation Doors**:
   - Check `SystemEvent` / logs for `/api/checkout/verify-signature` (`client-side payment confirmation`) and `WebhookEvent` for `payment.captured` (`processed = true`, `error = null`).
   - Confirm `Payment.paymentStatus = 'SUCCEEDED'`, `Payment.gatewayPaymentId = 'pay_...'`, `Appointment` confirmed, `ConsultantEarnings` created, and `LedgerTransaction` (`booking:<paymentId>`) balanced (`SUM(DEBIT) === SUM(CREDIT)`).
3. **Live Refund Smoke Test**: Issue a refund on the test booking, verify `X-Refund-Idempotency` succeeds (`Refund.refundId = 'rfnd_...'`), and confirm `refund.processed` runs `applyRefundCascade` and mints a `CreditNote`.
