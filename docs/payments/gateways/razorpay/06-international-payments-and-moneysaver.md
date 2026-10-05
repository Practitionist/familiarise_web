# Razorpay International Payments, Apple Pay, PayPal & MoneySaver Export Account

> **Last Updated**: 2026-10-05
> **Official Citations**:
> - [Razorpay International Payments Overview](https://razorpay.com/docs/payments/international-payments/)
> - [Accept Apple Pay on Standard Checkout](https://razorpay.com/docs/payments/payment-methods/apple-pay/)
> - [Accept PayPal Payments on Razorpay](https://razorpay.com/docs/payments/payment-methods/paypal/)
> - [MoneySaver Export Account (International Bank Transfers)](https://razorpay.com/docs/payments/international-payments/bank-transfers/)
> - [Automated FIRS / e-FIRA Process](https://razorpay.com/docs/payments/international-payments/firs-automated-process/)

---

## 1. Overview & RBI PA-CB License Status

On **December 2, 2025**, Razorpay received its final **Payment Aggregator – Cross Border (PA-CB)** authorization from the Reserve Bank of India (RBI), alongside its PA-Online and PA-Physical licenses.

For Familiarise (an Indian entity exporting 1:1 consultations, classes, webinars, and mentorship packages), this enables compliant cross-border collection in **160+ currencies** with automatic conversion to **INR** and automated **Foreign Inward Remittance Statement (FIRS / e-FIRA)** generation:

- **Maximum Per-Transaction Cap (RBI PA-CB Rule)**: **₹25,00,000** (~**\$30,000 USD**) per unit of service or invoice.
- **Settlement Currency**: Always **INR** into Familiarise's Indian current account (`assertInrSettlement` in `lib/payments/core/razorpay.ts`).
- **Consultant Disbursement**: Once settled in INR, Indian consultants are paid through the exact same **RazorpayX Payouts** pipeline (`lib/payments/payouts/payout-service.ts`) with Section 194-O TDS withholding.

---

## 2. Four International Payment Rails on Razorpay

Enabling all four methods in the Razorpay Dashboard lifts international checkout conversion from **~65%–75%** (raw cross-border card entry) to **85%+** by giving US/EU/UK buyers one-tap wallet and local bank rails:

| Payment Rail | Target Buyers | Pricing | Settlement Cycle | How It Works |
|---|---|---|---|---|
| **1. International Cards** (Visa, Mastercard, Amex, Diners) | Global B2C buyers in **160+ currencies** | **3.0% + 18% GST** (~3.54%–4.3% effective with network FX spread) | **T+7 working days** | Standard Checkout modal (`checkout.js`). Uses 3DS2 Risk-Based Authentication. |
| **2. Apple Pay** | iOS / Safari buyers in **70+ countries** (US, UK, EU, UAE, SG, AU, CA) | **0% extra fee** on top of base international card rate | **T+7 working days** | Uses biometric FaceID/TouchID network tokens (cryptograms), bypassing manual 3DS OTP challenges and recovering ~15%–20% of US issuer declines. |
| **3. PayPal on Razorpay Checkout** | US / EU / Global buyers who prefer buyer-protection wallets | PayPal merchant fee (~4.4% + fixed fee + FX) | **T+1 / T+2 to PayPal** | Links your PayPal Business account under **Dashboard → Account & Settings → Payment Methods → International Payments → PayPal**; renders directly inside Razorpay Standard Checkout. |
| **4. MoneySaver Export Account (IBT)** | High-ticket mentorship packages (\$500+) & B2B Organization Invoices | **1.0% platform fee + 18% GST** with **0% FX markup** (mid-market live Reuters rate) | **T+1 working day** after funds hit virtual account | Opens dedicated virtual **USD (ACH / Fedwire)**, **EUR (SEPA)**, and **GBP (Faster Payments)** receiving accounts via Razorpay's global banking partners. |

---

## 3. Enabling Apple Pay, PayPal & International Cards (Dashboard Checklist)

1. **Import Export Code (IEC)**: Obtain a lifetime IEC from the DGFT portal (`https://www.dgft.gov.in`, ₹500 government fee, issued in 1–2 days).
2. **Enable International Cards**:
   - Navigate to **Razorpay Dashboard → Account & Settings → Payment Methods → International Payments**.
   - Submit business model details, website URL (must show live pricing, Terms & Conditions, Privacy Policy, and Refund/Cancellation Policy), and IEC/GST LUT details.
3. **Enable Apple Pay**:
   - Under **Payment Methods → International Cards → Apple Pay**, click **Request Activation**.
   - Host Razorpay's Apple Pay domain-association verification file at `/.well-known/apple-developer-merchantid-domain-association` if using a custom domain frame, or rely on Razorpay Standard Checkout's hosted sheet.
4. **Enable PayPal**:
   - Under **Payment Methods → International Payments → PayPal**, click **Link Account** and complete the PayPal Business OAuth onboarding.
5. **Configure RBI Purpose Code for Automated FIRS / e-FIRA**:
   - Navigate to **Account & Settings → International Payment Codes**.
   - Select the applicable RBI Purpose Code for Familiarise's services export:
     - **`P1006`** — Business and management consultancy and public relations services
     - **`P0802`** — Software / IT consultancy and implementation services
     - **`P1107`** — Educational, training, and coaching services
   - Once set, Razorpay automatically generates a downloadable **FIRS (Foreign Inward Remittance Statement)** per settlement batch under **Dashboard → Settlements → FIRS**, satisfying IGST Act Section 2(6) + Section 16 (`EXPORT_LUT`) proof of export in convertible foreign exchange.

---

## 4. How This Maps to Familiarise's Codebase

| Concern | Current Implementation | Future Multi-Currency Enhancement |
|---|---|---|
| **Order Creation (`lib/payments/core/razorpay.ts`)** | `createRazorpayOrder` creates orders in integer `INR` paise (`assertInrSettlement`). International cards are converted by the buyer's card network or Razorpay DCC at checkout and settled in INR. | When display/presentment currency (`USD`/`EUR`/`GBP`) is enabled on `POST /v1/orders`, store both `presentmentCurrency` / `presentmentAmount` and the authoritative `INR` settlement amount (`Payment.amount` in paise) so the single-writer ledger remains strictly INR-denominated. |
| **Tax Determination (`lib/payments/tax/tax-engine.ts`)** | `determineTax({ baseAmountPaise, buyerCountry })` charges **0% GST (`EXPORT-ZERO`)** when `buyerCountry !== "IN"` and `hasValidPlatformLut()` is `true` (failing closed to **18% IGST** if no valid FY LUT is configured). | Attach FIRS settlement reference and billing address country to the `Invoice` export audit trail (`lib/payments/billing/consumer-invoice.ts`). |
| **Webhooks (`app/api/webhooks/razorpay/route.ts`)** | `payment.captured` carries `"international": true` on `payload.payment.entity` for cross-border cards/Apple Pay/PayPal. | Persist `payload.payment.entity.international` on payment metadata to tag export transactions for GSTR-1 Table 6A (`EXPWP` / `EXPWOP`) reporting. |
| **Refunds (`lib/payments/operations/refund.ts`)** | `postRefund` sends `POST /v1/payments/:id/refund` with `X-Refund-Idempotency`. | Note: International card refunds take **5–10 working days**, and any FX rate movement between capture and refund is borne by the buyer's card issuer (or platform if settled in foreign currency). Razorpay's original 3% PG fee is not refunded. |

---

## 5. Related Documents

- [Payment Gateways Overview](../README.md)
- [2026 Payment Gateway Evaluation](../gateway-evaluation-2026.md)
- [01-setup.md](./01-setup.md)
- [02-architecture-and-flow.md](./02-architecture-and-flow.md)
- [05-go-live-checklist.md](./05-go-live-checklist.md)
