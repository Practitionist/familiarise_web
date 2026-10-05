---
name: tazapay-global-payouts
description: Designs, implements, or audits Tazapay v3 global checkout (80+ local payment rails in 173+ countries) and Tazapay Multi-Currency Treasury (USD/EUR/GBP) for paying foreign non-Indian consultants in 70+ countries without double-FX conversion or Indian Section 393 / Forms 145 & 146 (pre-cutover Section 195 / Forms 15CA/15CB) wire friction.
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: purple
---

## Before you start

**Read these first:**
1. `.claude/skills/finance/references/gateways/tazapay.md` — Tazapay v3 API (`POST /v3/checkout`, `POST /v3/beneficiary`, `POST /v3/payout` with `purpose: "PYR003"`), multi-currency USD/EUR/GBP balance architecture, and webhook mapping.
2. `docs/payments/gateways/tazapay/README.md` — end-to-end architecture for global pay-ins and foreign consultant payouts.
3. `.claude/skills/finance/references/doctrine.md` and `.claude/skills/finance/references/compliance.md` — money truth invariants, INR ledger rules, and Income-tax Act, 2025 Section 393 (`§393(1) Table Sl.8(v)` vs `§393(2) Table Sl.17` & Forms 145/146; pre-cutover Section 194-O vs Section 195 & Forms 15CA/15CB) boundaries.

---

## Architectural Guardrails for Tazapay in This Repo

1. **Why Tazapay Is Used for Foreign (Non-Indian) Consultants**:
   - RazorpayX and Cashfree Payouts can only disburse `INR` to Indian domestic bank accounts (`IFSC`) or `UPI` VPAs.
   - Remitting funds from an Indian current account to a foreign non-resident consultant on or after April 1, 2026 requires **Income-tax Act, 2025 Section 393 (`§393(2) Table Sl.17`, code `1057`) TDS adjudication + DTAA TRC/Form 10F + Form 145** (plus Chartered Accountant **Form 146** when filing under **Form 145 Part C** for taxable remittances above `₹5,00,000` in a FY; or **Section 195 + Form 15CA** and Part C **Form 15CB** for pre-cutover transactions) per wire, plus double FX loss (`USD -> INR -> USD`).
   - With Tazapay, foreign buyer payments settle into Familiarise's **Tazapay Multi-Currency Treasury (`USD` / `EUR` / `GBP`)**:
     - The foreign consultant's `80%` share is paid out directly from the matching foreign currency balance (`holding_currency === currency`, `purpose: "PYR003"`) via local rails (**US ACH**, **EU SEPA**, **UK Faster Payments**, **Canada EFT**, **Australia BSB**, **Singapore FAST**).
     - Only Familiarise's net `20%` platform fee is repatriated to India in `INR` with an automated 1-day **`e-FIRA`**.
2. **Preserve the Domestic INR Non-Resident Guard**:
   - Never remove the non-resident throw in `lib/payments/payouts/payout-service.ts` (`processSinglePayout`) for domestic `RAZORPAY` or `CASHFREE` INR payouts!
   - Non-resident payouts may proceed **only** when `payoutAccount.gateway === "TAZAPAY"` (funded by the Tazapay foreign-currency balance) or when full Section 393 + Form 145 (and Form 146 where required under Part C > `₹5,00,000`; pre-cutover Section 195 + Form 15CA and Part C Form 15CB) artifacts are verified.
3. **Monetary Units & Ledger Accounting**:
   - Tazapay v3 API uses **integer minor units (`cents` / `paise`)**, matching Prisma `BigInt`.
   - Maintain strict currency separation so `USD` cents and `INR` paise are never summed together in `LedgerEntry` queries without explicit FX conversion to our canonical INR functional currency.
4. **Webhook Security & Single-Writer Pipeline**:
   - Verify `x-tazapay-signature` over the raw request body with length-guarded `crypto.timingSafeEqual`.
   - Deduplicate via `WebhookEvent` and route `checkout.paid` / `payment_attempt.succeeded` through `handlePaymentSuccess` inside a single `Serializable` `$transaction`.
