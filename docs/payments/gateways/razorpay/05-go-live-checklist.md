# Razorpay & RazorpayX Go-Live Checklist & Live-Key Verification Matrix

> What must be true in the Razorpay / RazorpayX dashboards, production environment variables, and live PostgreSQL database before accepting real money or disbursing real payouts — plus the complete **Test Key (`rzp_test_*`) vs Live Key (`rzp_live_*`) Verification Matrix** so zero paise is ever lost in flight or over/under-settled.

**Last Updated**: 2026-10-11 · **Tracking Issues**: #1377, #2088

---

## How to read this page

Accepting money (**Razorpay Payments**, gated by `RAZORPAY_KEY_ID` / `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION`) and disbursing money (**RazorpayX Payouts**, gated by `ENABLE_LIVE_PAYOUTS` — see [docs/enterprise/50-operations/05-live-payout-go-live-runbook.md](../../../enterprise/50-operations/05-live-payout-go-live-runbook.md)) can cut over independently or together, **provided the pre-cutover database purge of Test-Mode gateway IDs in [Section 8](#8-complete-test-key-vs-live-key-verification-matrix--blind-spots) is executed before flipping either product to live keys**.

Several items below live in the Razorpay / RazorpayX dashboards rather than in code (auto-capture window, settlement cycle, uncaptured-payment expiry, webhook alert inbox, and separate live webhook secrets). Record dashboard screenshots or signed delivery logs against the cutover issue before opening traffic.

---

## 1. Account activation

- [ ] **Razorpay Payments KYC approved** and dashboard badge shows **Activated** (1–3 business days; any KYC query resets SLA).
- [ ] **Settlement bank account** is the platform's current account and the beneficiary name matches the registered entity exactly.
- [ ] **Platform GSTIN** is recorded on Razorpay so monthly merchant fee invoices carry B2B input tax credit (separate from consumer/org tax invoices minted in-house — see [../../06-b2c-tax-invoice.md](../../06-b2c-tax-invoice.md)).
- [ ] **International / PA-CB acceptance** (if accepting foreign cards): domestic activation + Video KYC completed first; verify `₹25,00,000` per-invoice PA-CB ceiling and automated FIRS / e-FIRA issuance.
- [ ] **RazorpayX Business Banking current/escrow account** activated and funded before turning on `ENABLE_LIVE_PAYOUTS=true`.

---

## 2. Keys, secrets, and the test-key boot guard

- [ ] `RAZORPAY_KEY_ID` and `RAZORPAY_SECRET` hold the **live** key pair (`rzp_live_*`).
- [ ] `NEXT_PUBLIC_RAZORPAY_KEY_ID` holds the identical `rzp_live_*` key ID. Never prefix any secret with `NEXT_PUBLIC_`.
- [ ] `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION` is **deleted** from production env vars so [`lib/payments/core/razorpay.ts`](../../../../lib/payments/core/razorpay.ts) fails fast at boot if a test key ever re-enters production.
- [ ] If enabling live payouts (`ENABLE_LIVE_PAYOUTS=true`), `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`, and `RAZORPAYX_ACCOUNT_NUMBER` hold **live** RazorpayX credentials.

---

## 3. Dual-product webhooks & zero-downtime secret rotation

- [ ] **Razorpay Payments Live Webhook** points to `https://<production-host>/api/webhooks/razorpay` (HTTPS port 443) signed with live `RAZORPAY_WEBHOOK_SECRET`:
  - Subscribed events: `payment.authorized`, `payment.captured`, `order.paid`, `payment.failed`, `refund.created`, `refund.processed`, `refund.failed`, `refund.speed_changed`, and all `payment.dispute.*` events.
- [ ] **RazorpayX Live Webhook** points to the same `https://<production-host>/api/webhooks/razorpay` endpoint signed with live `RAZORPAYX_WEBHOOK_SECRET`:
  - Subscribed events: `payout.initiated`, `payout.queued`, `payout.pending`, `payout.processing`, `payout.processed`, `payout.updated`, `payout.failed`, `payout.reversed`, `payout.rejected`, `payout.cancelled`, `fund_account.validation.completed`, and `fund_account.validation.failed`.
- [ ] **Monitored Alert Email** set on both dashboards: Razorpay retries non-2xx responses with exponential backoff for **24 hours** and then **permanently disables** the webhook endpoint without self-serve replay.
- [ ] **Zero-downtime secret rotation**:
  - Payment webhook rotation uses `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` ([`resolveRazorpayPaymentSecrets`](../../../../app/api/webhooks/razorpay/signature.ts)).
  - RazorpayX webhook rotation uses `RAZORPAYX_WEBHOOK_SECRET_PREVIOUS` ([`resolveRazorpayXSecrets`](../../../../app/api/webhooks/razorpay/signature.ts)), strictly isolated to `payout.*` and `fund_account.*` events so a RazorpayX secret can never forge `payment.captured`.

---

## 4. Capture, order metadata, and in-flight safety guards

- [ ] **Automatic capture enabled** in Razorpay Dashboard (`Settings -> Payments -> Payment Capture`). Every order minted by [`createRazorpayOrder`](../../../../lib/payments/core/razorpay.ts) explicitly sets `payment: { capture: "automatic", capture_options: { automatic_expiry_period, manual_expiry_period, refund_speed: "normal" } }` bounded to `[12, 7200]` minutes.
- [ ] **Order metadata & stale customer self-healing verified**:
  - [`sanitizeRazorpayNotes`](../../../../lib/payments/core/razorpay.ts) caps every `orders.create` payload to `<= 15` keys and `<= 256` characters per value so long user booking notes can never trigger `400 BAD_REQUEST_ERROR`.
  - [`createRazorpayOrder`](../../../../lib/payments/core/razorpay.ts) automatically clears stale `users.razorpayCustomerId` (`cust_*` minted in Test Mode) and retries order creation seamlessly if `orders.create` rejects a cross-mode `customer_id`.
- [ ] **Out-of-order webhook deferral active**: `refund.*`, `payment.dispute.created`, `refund.speed_changed`, and contended RPD webhooks emit `DeferSignal` (`processed=false, error=null`) whenever the parent `Payment` is still `PENDING` or locked so `sweep-stuck-webhook-events` replays them after capture settles.

---

## 5. Complete Test Key vs Live Key Verification Matrix & Blind Spots

Switching from `rzp_test_*` to `rzp_live_*` does **far more** than charge real cards — Razorpay's Test Sandbox mocks entire banking subsystems that behave fundamentally differently against real NPCI, partner-bank IMPS/NEFT/RTGS switches, acquiring banks, and government tax portals:

| #      | Financial Rail / Invariant                                          | What Test Key (`rzp_test_*`) Simulates                                                                            | What **ONLY Live Key (`rzp_live_*`)** Unlocks & Tests                                                                                                                                                                                                   | Code Guard & Live Verification Requirement                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | **Cross-Environment Gateway IDs (`cust_*`, `cont_*`, `fa_*`)**      | Accepts `cust_Test*`, `cont_Test*`, `fa_Test*` created in sandbox.                                                | **Hard-rejects every Test-Mode ID with `400 BAD_REQUEST_ERROR: The id provided does not exist`**. Live DB had `46` `PayoutAccount` rows + `1` `OrganizationPayoutAccount` row holding Test IDs.                                                         | Run pre-cutover SQL reset below before enabling live mode; [`createRazorpayOrder`](../../../../lib/payments/core/razorpay.ts) self-heals stale `users.razorpayCustomerId`.                                                       |
| **2**  | **UPI Collect / Intent Latency & Late Capture Race**                | Instant synchronous success/failure click inside modal.                                                           | Real PSP app handoffs (GPay/PhonePe/Paytm), user closing browser mid-collect while bank settles 2–10 mins later, midnight NPCI cutoffs, and `automatic_expiry_period` auto-refunds.                                                                     | [`route.ts`](../../../../app/api/webhooks/razorpay/route.ts) + `reconcile-payment-status` + `48h` org top-up grace ([`cleanup-abandoned-org-top-ups.ts`](../../../../scripts/cleanup/cleanup-abandoned-org-top-ups.ts)).         |
| **3**  | **Settlements (`T+2` / `T+7`) & Real MDR + 18% GST Fee Deductions** | ₹0 bank movement; no real MDR/GST deduction or bank statement UTR.                                                | Real `T+2` domestic (`T+7` international) bank settlements deducting actual Razorpay fee + 18% GST on fees and generating real bank NEFT/RTGS settlement UTRs.                                                                                          | Reconcile first live settlement batch against bank statement via [`reconcile-ledgers.ts`](../../../../scripts/reconcile/reconcile-ledgers.ts).                                                                                   |
| **4**  | **Reverse Penny Drop (`upi_intent`) & Fuzzy Bank Holder Names**     | Mock holder `"Gaurav Kumar"` / `"100"` score; cannot test real mobile UPI Intent QR/deep-link bank holder lookup. | Real NPCI/bank holder strings with initials/titles (`"MR K G"` vs `"Kaustav G"`), string `"00"`–`"100"` `name_match_score` payloads, IFSC extraction, and real ₹1 auto-refund.                                                                          | Coerced numeric/string `name_match_score` in [`schemas/webhooks/razorpay.ts`](../../../../schemas/webhooks/razorpay.ts) & [`reverse-penny-drop.ts`](../../../../lib/payments/payouts/reverse-penny-drop.ts).                     |
| **5**  | **RazorpayX Payout Rails, Limits & Post-Ack Bank Reversals**        | Virtual balance; instant `processed` state; never hits partner-bank queues or beneficiary bank rejections.        | Real current/escrow balance checks (`queue_if_low_balance`), `UPI <= ₹1L` / `IMPS <= ₹5L` / `RTGS >= ₹2L` mode selection, strict `30`-char `[A-Za-z0-9 ]` bank narration, **and `processed -> reversed` when beneficiary bank rejects after IMPS ack**. | Enforced in [`razorpay-payouts.ts`](../../../../lib/payments/payouts/razorpay-payouts.ts) & [`org-payout-service.ts`](../../../../lib/payments/payouts/org-payout-service.ts); verify `payout.reversed` restores ledger balance. |
| **6**  | **Unlinked Stale `PROCESSING` Payout Redrive (>7d TTL)**            | Simulated responses never drop mid-flight after partner-bank submission.                                          | If HTTP response times out after RazorpayX accepted payout, `X-Payout-Idempotency` expires after **7 days** — blind retry double-pays real INR!                                                                                                         | [`redriveSingleOrgPayoutRow`](../../../../lib/payments/payouts/org-payout-service.ts) calls [`findRazorpayPayoutByReference`](../../../../lib/payments/payouts/payout-gateway-lookup.ts) before ever re-submitting.              |
| **7**  | **Refund Speed Downgrades & Issuer Bank Rejections**                | Instant `processed` refund on every call.                                                                         | Acquiring bank downgrading `optimum -> normal` (`refund.speed_changed`, 5–7 business days), closed/frozen account `refund.failed`, and multi-leg paise conservation.                                                                                    | [`refund.ts`](../../../../lib/payments/operations/refund.ts) + `DeferSignal` on missing/pending parent rows.                                                                                                                     |
| **8**  | **Card & UPI Chargebacks (`payment.dispute.*`, `deduct_at_onset`)** | Only synthetic dashboard mock payload.                                                                            | Real Visa/Mastercard/RuPay & NPCI UPI dispute codes (`U01`–`U99`), immediate `deduct_at_onset: true` settlement hold, and evidence upload validation.                                                                                                   | [`handleDisputeCreated`](../../../../app/api/webhooks/utils.ts) + `PENDING` capture deferral.                                                                                                                                    |
| **9**  | **International Cards & RBI PA-CB (`₹25L` Cap & FIRS/e-FIRA)**      | Domestic sandbox mock only.                                                                                       | Real foreign-issued 3DS2 friction, Amex/Diners routing, FX conversion spread, `₹25,00,000` RBI PA-CB invoice cap, and automated FIRS / e-FIRA download.                                                                                                 | [`assertInrSettlement`](../../../../lib/payments/validation/currency-guards.ts) + export LUT invoicing.                                                                                                                          |
| **10** | **CGST Rule 46(b) / Rule 53 IRP E-Invoicing (`<= 16` Chars)**       | Mock/skipped IRP in dev/test.                                                                                     | Live GSTN IRP hard-rejects any invoice or credit note number `> 16` chars or containing characters outside `[A-Za-z0-9/-]`.                                                                                                                             | Enforced at generation time by [`fitPrefixToRule46`](../../../../lib/payments/billing/invoice-numbering.ts) + live DB check (`rule46_breach_count = 0`).                                                                         |

---

## 6. Pre-Cutover SQL Purge & Live Penny-Test Protocol

### Step 6.1 — Clear Test-Mode Razorpay / RazorpayX Entity Pointers Before Flipping Live Keys

Run this transaction once during the cutover maintenance window **before** enabling live traffic so zero test `cust_*` / `cont_*` / `fa_*` pointers remain active in production:

```sql
BEGIN;

UPDATE users
SET "razorpayCustomerId" = NULL
WHERE "razorpayCustomerId" IS NOT NULL;

UPDATE "PayoutAccount"
SET "razorpayContactId" = NULL,
    "razorpayFundAccId" = NULL,
    "isVerified" = false
WHERE "razorpayContactId" IS NOT NULL
   OR "razorpayFundAccId" IS NOT NULL;

UPDATE "OrganizationPayoutAccount"
SET "razorpayContactId" = NULL,
    "razorpayFundAccountId" = NULL,
    "isVerified" = false
WHERE "razorpayContactId" IS NOT NULL
   OR "razorpayFundAccountId" IS NOT NULL;

COMMIT;
```

### Step 6.2 — Mandatory Live Penny-Test Verification Sequence (`₹1.00` = `100` Paise Net Cost)

Execute and record each live check on the tracking GitHub issue before opening user signups:

- [ ] **Live Smoke 1 — ₹1.00 B2C Standard Checkout (`order_*` -> `pay_*`)**: Complete a real ₹1 UPI payment -> verify `Payment.paymentStatus = SUCCEEDED`, `Appointment` confirmed, consumer tax invoice <= 16 chars minted, and `SELECT COALESCE(SUM(debit) - SUM(credit), 0) FROM "LedgerEntry"` equals `0`.
- [ ] **Live Smoke 2 — ₹1.00 Full Refund (`rfnd_*`)**: Trigger full cancellation/refund on Smoke 1 -> verify `Refund.status = SUCCEEDED` via live `refund.processed` webhook, `ConsumerCreditNote` <= 16 chars minted, and ledger imbalance remains `0`.
- [ ] **Live Smoke 3 — ₹1.00 Reverse Penny Drop (`upi_intent`)**: Onboard a real UPI payout account via mobile UPI Intent -> verify `fund_account.validation.completed` webhook verifies live HMAC under `RAZORPAYX_WEBHOOK_SECRET`, parses numeric `name_match_score`, marks `PayoutAccount.isVerified = true`, and refunds ₹1 automatically.
- [ ] **Live Smoke 4 — ₹1.00 Live Consultant Payout (`pout_*`)**: With `ENABLE_LIVE_PAYOUTS=true`, disburse ₹1.00 IMPS/UPI payout -> verify live `payout.processed` webhook records non-null bank `gatewayUtr` and leaves net ledger imbalance at `0`.

---

## Deprecated & Superseded Approaches

- **Deprecated top-level `payment_capture: 1` order parameter**: Older Razorpay examples passed top-level `payment_capture: 1` on `orders.create`. Superseded by nested `payment: { capture: "automatic", capture_options: { automatic_expiry_period, manual_expiry_period, refund_speed: "normal" } }` ([`holdCaptureSettings`](../../../../lib/payments/core/razorpay.ts)).
- **Superseded single-secret `RAZORPAYX_WEBHOOK_SECRET` string check without rotation grace**: Previously only payment webhooks supported `_PREVIOUS` secret rotation and unsanitized order notes (>256 chars) reached `orders.create`. Superseded by [`resolveRazorpayXSecrets`](../../../../app/api/webhooks/razorpay/signature.ts) (`RAZORPAYX_WEBHOOK_SECRET_PREVIOUS`) and [`sanitizeRazorpayNotes`](../../../../lib/payments/core/razorpay.ts).
