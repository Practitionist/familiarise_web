# Razorpay & RazorpayX Go-Live Playbook, Portable Cutover Checklist & 12-Rail Live Verification Matrix

> **Portable Engineering Playbook (Company-Agnostic + Repo Bindings)**: Use this playbook when taking **any** Razorpay + RazorpayX codebase from Test Sandbox (`rzp_test_*`) to Live Production (`rzp_live_*`) without losing money in flight, double-paying vendors, breaking returning users, or tripping government tax/banking rejections.

---

## Part 1 — Portable Cross-Company Cutover Checklist (14 Hidden Production Traps)

Copy and verify these **14 universal invariants** in **any** company or codebase integrating Razorpay Payments + RazorpayX:

### A. Orders, Checkout & Cross-Environment Entity Isolation

1. **Purge All Sandbox Gateway IDs Before Flipping Live Keys (`cust_*`, `cont_*`, `fa_*`)**:
   - Every Razorpay Customer (`cust_*`), RazorpayX Contact (`cont_*`), and Fund Account (`fa_*`) ID is strictly scoped to **either** Test Mode **or** Live Mode. Passing a sandbox `cust_*`/`cont_*`/`fa_*` under `rzp_live_*` fails with `400 BAD_REQUEST_ERROR: The id provided does not exist`.
   - **Portable SQL Pre-Cutover Reset Template**:
     ```sql
     BEGIN;
     UPDATE users SET "razorpayCustomerId" = NULL WHERE "razorpayCustomerId" IS NOT NULL;
     UPDATE "PayoutAccount"
       SET "razorpayContactId" = NULL, "razorpayFundAccId" = NULL, "isVerified" = false
       WHERE "razorpayContactId" IS NOT NULL OR "razorpayFundAccId" IS NOT NULL;
     UPDATE "OrganizationPayoutAccount"
       SET "razorpayContactId" = NULL, "razorpayFundAccountId" = NULL, "isVerified" = false
       WHERE "razorpayContactId" IS NOT NULL OR "razorpayFundAccountId" IS NOT NULL;
     COMMIT;
     ```
2. **Self-Heal Stale `customer_id` at Order Creation**:
   - Even with a pre-cutover SQL purge, if `orders.create({ customer_id })` returns `400`/`404` ("does not exist"), clear the stale customer pointer in DB and retry `orders.create` without `customer_id` so returning users are never blocked from paying.
3. **Cap Order `notes` at the Gateway Boundary (`<= 15` Keys, `<= 256` Chars/Value)**:
   - Razorpay rejects the entire `POST /v1/orders` call with `400 BAD_REQUEST_ERROR` if `notes` exceeds 15 keys or any value exceeds 256 characters. Always truncate keys/values at the SDK wrapper boundary (`sanitizeRazorpayNotes`).
4. **Enforce Minimum Order Floor (`>= 100` Paise = ₹1.00) & Explicit Capture Expiry (`[12, 7200]` Mins)**:
   - Never pass sub-₹1 amounts (`< 100` paise) or floats to Razorpay. Explicitly set `payment: { capture: "automatic", capture_options: { automatic_expiry_period, manual_expiry_period, refund_speed: "normal" } }` clamped to `[12, 7200]` minutes.

### B. Webhooks, Secret Rotation & Out-of-Order Race Safety

5. **Enforce Body-Size Cap Before HMAC Verification & Lazy Fallback Secret Resolution**:
   - Reject oversized requests (`Content-Length > 256 KB` / streaming cap -> `HTTP 413`) before allocating buffers or resolving fallback secrets.
6. **Separate Payment vs RazorpayX Webhook Secrets + Zero-Downtime `_PREVIOUS` Rotation**:
   - Verify primary payment secrets (`RAZORPAY_WEBHOOK_SECRET`, fallback `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`) first.
   - Consult RazorpayX secrets (`RAZORPAYX_WEBHOOK_SECRET`, fallback `RAZORPAYX_WEBHOOK_SECRET_PREVIOUS`) **only** when payment secrets fail **and** `event` starts with `payout.` or `fund_account.` so a compromised/separate RazorpayX secret can never forge `payment.captured`.
7. **Protect Against Razorpay's 24-Hour Non-2xx Webhook Auto-Disable Cliff**:
   - Razorpay retries non-2xx deliveries with exponential backoff for **24 hours** and then **permanently disables** the webhook endpoint without self-serve replay. Always acknowledge valid deliveries within 5 seconds (`200 OK` + async processing via `after()`/queue) and set a monitored alert email on both dashboards.
8. **Defer Out-of-Order Child Webhooks When Parent `Payment` Is Still `PENDING`**:
   - Webhook delivery order is never guaranteed (`refund.created`, `refund.speed_changed`, or `payment.dispute.created` can arrive before delayed `payment.captured`). Never discard or mis-journal early child events — defer them cleanly (`DeferSignal` / retry queue) until parent capture commits.

### C. RazorpayX Payouts, Penny Drop & Reverse Penny Drop (`upi_intent`)

9. **Sanitize Bank Statement Narration (`<= 30` Chars, `[A-Za-z0-9 ]` Only)**:
   - Partner banks reject any `POST /v1/payouts` payload whose `narration` exceeds 30 characters or contains hyphens/punctuation (`400 BAD_REQUEST_ERROR`). Never append raw UUIDs with hyphens into `narration`.
10. **Enforce NPCI / RBI Payout Mode Ceilings & Floors**:
    - `UPI` (`vpa`): **hard maximum ₹1,00,000** (`10_000_000` paise) per payout; VPA validations must **omit** `amount` and `currency`.
    - `IMPS`: **maximum ₹5,00,000** (`50_000_000` paise), 24x7 instant.
    - `RTGS`: **minimum ₹2,00,000** (`20_000_000` paise).
    - `NEFT`: no amount cap; use for `> ₹5L` bank transfers or fallback.
11. **Lookup Gateway Payouts by `reference_id` Before Redriving Stale `PROCESSING` Rows (>7d TTL)**:
    - RazorpayX `X-Payout-Idempotency` expires after **7 days**. If an outbound payout HTTP call timed out after RazorpayX accepted it (`gatewayPayoutId = NULL`), always query `GET /v1/payouts?reference_id=<id>` before re-submitting so a stale sweeper never double-pays real money.
12. **Coerce String `"00"`–`"100"` `name_match_score` & Handle Server-Side RPD Settlement**:
    - RazorpayX frequently serializes `name_match_score` as a string (`"00"` is truthy in JS!). Coerce to finite `number | null`, read `results ?? validation_results`, accept `ifsc ?? bank_routing_code`, and defer under Redis lock contention so mobile UPI app-switch tab closures never lose verification state.

### D. Reconcilers, Refunds, GST E-Invoicing & Income-Tax Act 2025

13. **Set Abandoned Pending Cleanup Grace `> 24 Hours` (`48h` Standard)**:
    - Never delete or expire pending bank/wallet top-up rows before **48 hours** — Razorpay retries delayed `payment.captured` webhooks for up to **24 hours**, so a short cleanup window orphans real settled customer money.
14. **Enforce Indian Statutory Limits in Code**:
    - **CGST Rule 46(b) & Rule 53**: Every tax invoice and credit note number must match `^[A-Za-z0-9/-]{1,16}$` (**strict 16-character ceiling** enforced by GSTN GSTR-1 & IRP).
    - **Income-tax Act 2025 (`IT2025`, effective 1 Apr 2026)**: Section `393(1)` Table Sl. `8(v)` e-commerce TDS (`0.1%` = `10 bps`; no-PAN `5%` = `500 bps` under `s.397(2)(b)(i)`), Section `194J` (`s.393(1)` Sl. `6(iii)`) ₹50,000 threshold (`5_000_000` paise), Section `195` (`20%` = `2000 bps` non-resident), and CBDT payment codes (`1035`, `1027`, `1017`, `1057`).
    - **RBI PA-CB Cross-Border Exports**: Enforce `₹25,00,000` per-invoice cap, INR settlement currency guard, and automated FIRS / e-FIRA retention.

---

## Part 2 — Complete 12-Rail Test Key (`rzp_test_*`) vs Live Key (`rzp_live_*`) Matrix

| #      | Financial Rail                                                        | What Test Key (`rzp_test_*`) Simulates                                                         | What **ONLY Live Key (`rzp_live_*`)** Unlocks & Verifies                                                                                                                                                  |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | **Cross-Mode Entity IDs (`cust_*`, `cont_*`, `fa_*`)**                | Accepts sandbox entity IDs without error.                                                      | **Rejects all Test-Mode IDs with `400 BAD_REQUEST_ERROR`**. Tests stale `customer_id` self-healing & SQL reset.                                                                                           |
| **2**  | **UPI Collect / Intent Latency & Late Captures**                      | Instant modal click (`Success` / `Failure`).                                                   | Real PSP app handoffs (GPay / PhonePe / Paytm), user closing tab while bank captures minutes later, and midnight NPCI cutoffs.                                                                            |
| **3**  | **Settlements (`T+2` / `T+7`) & Real MDR + 18% GST Fees**             | ₹0 bank movement; zero real fee/tax deduction; no bank NEFT/RTGS UTR.                          | Real bank deposits (`T+2` domestic, `T+7` international), exact MDR + 18% GST deductions, and real settlement UTRs.                                                                                       |
| **4**  | **Reverse Penny Drop (`upi_intent`) & Bank Holder Names**             | Mock holder `"Gaurav Kumar"` / `"100"` score; QR/deep link cannot hit real NPCI bank registry. | Real Indian bank account holder formatting (`"MR K G"`, initials, prefixes), string `"00"`–`"100"` score coercion, IFSC extraction, and real ₹1 auto-refund.                                              |
| **5**  | **RazorpayX Payout Rails & Post-Ack Bank Reversals**                  | Virtual balance; instant `processed` transition; never hits partner-bank queues.               | Real balance locks (`queue_if_low_balance`), `UPI <= ₹1L` / `IMPS <= ₹5L` / `RTGS >= ₹2L` routing, 30-char narration rules, **and `processed -> reversed` when beneficiary bank rejects after IMPS ack**. |
| **6**  | **Unlinked Stale `PROCESSING` Payout Redrive (>7d TTL)**              | Simulated HTTP responses never drop after partner-bank dispatch.                               | Proves `GET /v1/payouts?reference_id=<id>` prevents duplicate real-INR payouts when `X-Payout-Idempotency` expires after 7 days.                                                                          |
| **7**  | **Refund Speed Downgrades & Issuer Bank Rejections**                  | Refunds complete instantaneously in sandbox.                                                   | Acquiring bank downgrading `optimum -> normal` (`refund.speed_changed`, 5–7 business days), closed-account `refund.failed`, and multi-leg paise conservation.                                             |
| **8**  | **Card & UPI Chargebacks (`payment.dispute.*`, `deduct_at_onset`)**   | Static mock webhook JSON only.                                                                 | Real Visa/Mastercard/RuPay & NPCI UPI dispute codes (`U01`–`U99`), immediate `deduct_at_onset: true` balance debit, and evidence file upload limits.                                                      |
| **9**  | **Webhook Secret Isolation & Zero-Downtime Rotation**                 | Single test webhook secret.                                                                    | Live dual-secret isolation (`RAZORPAY_WEBHOOK_SECRET` vs `RAZORPAYX_WEBHOOK_SECRET`) + `_PREVIOUS` rotation grace across deployments.                                                                     |
| **10** | **International Cards & RBI PA-CB (`₹25L` Cap & FIRS/e-FIRA)**        | Domestic INR test cards only.                                                                  | Live foreign 3DS2 friction, Amex/Diners acceptance, FX spread, `₹25,00,000` cap, and automated FIRS / e-FIRA download.                                                                                    |
| **11** | **CGST Rule 46(b) / Rule 53 IRP E-Invoicing (`<= 16` Chars)**         | Mock/skipped IRP in dev/test.                                                                  | Live ClearTax / GSTN IRP IRN generation enforcing strict `^[A-Za-z0-9/-]{1,16}$`.                                                                                                                         |
| **12** | **Income-Tax Act 2025 (`IT2025`) Section `393` / `194J` / `195` TDS** | Static DB table seed rows.                                                                     | Live PAN status validation (`5%` no-PAN `s.397(2)(b)(i)`), `₹50K` 194J threshold, `20%` Section 195 non-resident withholding, and quarterly challans.                                                     |

---

## Part 3 — Mandatory ₹1.00 Live Penny-Test Verification Suite

Before opening live customer traffic, execute all 4 penny tests using real UPI/bank accounts (`₹1.00` = `100` paise net cost):

1. **Live Smoke 1 — ₹1.00 Standard Checkout (`order_*` -> `pay_*`)**: Pay real ₹1 via UPI -> confirm `Payment.paymentStatus = SUCCEEDED`, `Appointment` confirmed, invoice number `<= 16` chars, and `SUM(debit) - SUM(credit) = 0` in `LedgerEntry`.
2. **Live Smoke 2 — ₹1.00 Full Refund (`rfnd_*`)**: Refund Smoke 1 -> confirm `Refund.status = SUCCEEDED` via live `refund.processed` webhook, credit note `<= 16` chars minted, ₹1 credited to bank, and ledger net imbalance `= 0`.
3. **Live Smoke 3 — ₹1.00 Reverse Penny Drop (`upi_intent`)**: Complete mobile UPI Intent RPD -> confirm `fund_account.validation.completed` verifies under `RAZORPAYX_WEBHOOK_SECRET`, parses `name_match_score`, sets `isVerified = true`, and refunds ₹1.
4. **Live Smoke 4 — ₹1.00 Live Consultant Payout (`pout_*`)**: Disburse ₹1 payout with `ENABLE_LIVE_PAYOUTS=true` -> confirm live `payout.processed` webhook records real bank `gatewayUtr`, bank statement shows sanitized narration, and ledger net imbalance `= 0`.

---

## Part 4 — Repository File Map (`Practitionist/familiarise_web`)

- **Core Gateway & Stale Customer Self-Healing**: [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts) (`sanitizeRazorpayNotes`, `createRazorpayOrder`, boot test-key guard)
- **Webhook Signature Isolation & Rotation**: [`app/api/webhooks/razorpay/signature.ts`](../../../../../app/api/webhooks/razorpay/signature.ts) (`resolveRazorpayPaymentSecrets`, `resolveRazorpayXSecrets`, `isPayoutEventName`) & [`route.ts`](../../../../../app/api/webhooks/razorpay/route.ts)
- **Webhook Dispatch & Out-of-Order Deferral**: [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts) & [`app/api/webhooks/utils.ts`](../../../../../app/api/webhooks/utils.ts)
- **RazorpayX Payouts & Redrive Safety**: [`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts) & [`lib/payments/payouts/org-payout-service.ts`](../../../../../lib/payments/payouts/org-payout-service.ts)
- **Reverse Penny Drop (`upi_intent`)**: [`lib/payments/payouts/reverse-penny-drop.ts`](../../../../../lib/payments/payouts/reverse-penny-drop.ts)
- **Canonical Production Checklist**: [`docs/finance/70-operations/07-go-live-checklist.md`](../../../../../../docs/finance/70-operations/07-go-live-checklist.md)
