# Razorpay International Payments, PA-CB & MoneySaver Export Account

**When to load**: Enabling or debugging international card acceptance, Apple Pay, PayPal via Razorpay, MoneySaver Export Virtual Accounts (`USD`/`EUR`/`GBP`), multi-currency `currency` orders, RBI PA-CB limits (`₹25,00,000`), purpose codes (`P1006` / `P0802`), or automated FIRS / e-FIRA generation.

See also: [`docs/payments/gateways/razorpay/06-international-payments-and-moneysaver.md`](../../../../../docs/payments/gateways/razorpay/06-international-payments-and-moneysaver.md).

---

## 1. RBI PA-CB Regulatory Framework

Razorpay holds final RBI authorization across **PA-O** (Online), **PA-P** (Physical), and **PA-CB** (Payment Aggregator – Cross Border, granted December 2025 under RBI Circular `CO.DPSS.POLC.No.S-786/02-14-008/2023-24`).

| Rule / Parameter | Verified Value | Impact on Familiarise |
| --- | --- | --- |
| **Max Per-Unit Transaction Cap** | **`₹25,00,000`** (~`$30,000 USD`) | Hard ceiling under RBI PA-CB regulations per unit of service sold |
| **Settlement Currency** | **`INR` only** | All foreign currency collections are converted into INR by Razorpay's AD-I partner banks before settlement to our Indian current account |
| **Settlement Schedule** | **T+7 working days** | Applies to both newly onboarded and mature Indian export merchants for international cards (`T+2` applies only to domestic INR transactions) |
| **Export Proof (`FIRS` / `e-FIRA`)** | **Automated (Free)** | Generated automatically per settled transaction in `Dashboard -> Settlements -> FIRS`; required for zero-rated GST export under LUT (IGST Act Section 16) |
| **Purpose Code** | **`P1006`** / **`P0802`** / **`P1107`** | `P1006` (Business & management consultancy and public relations), `P0802` (Software/IT consultancy), `P1107` (Educational/training services). Must match the IEC and GST LUT description |

---

## 2. The Four International Acceptance Channels on Razorpay

### Channel A: International Cards (130+ Currencies)
- **Networks**: Visa, Mastercard, American Express, Diners Club.
- **Pricing**: `~3.0%` (base international card fee) to `~4.3%` (when using Dynamic Currency Conversion / multi-currency display) + `18%` GST on the gateway fee.
- **Approval Rate Reality**: Cross-border card acquiring into India sees **~65%–75%** first-attempt authorization because US/UK/EU issuers often flag Indian MCCs (`8299` / `7392`) or fail 3DS1 challenges.
- **Mandatory Mitigations**:
  1. Ensure **EMV 3-D Secure 2.0 (3DS2)** is active on the Razorpay MID (`Account & Settings -> International Payments`).
  2. Pass `customer_id`, `prefill.name`, `prefill.email`, and `prefill.contact` (with country code, e.g., `+14155552671`) on `checkout.js` so 3DS2 frictionless risk scoring has maximum signal.

### Channel B: Apple Pay on Standard Checkout
- **Why enable**: Routes through biometric Face ID / Touch ID network cryptograms (`85%+` conversion for iOS/Safari buyers in US/UK/EU/UAE/SG).
- **Requirements**:
  1. International Card Acceptance active on MID.
  2. Host `/.well-known/apple-developer-merchantid-domain-association` on the production domain and verify in Razorpay Dashboard.
  3. Order `currency` must be an international currency (`USD`, `EUR`, `GBP`, `AUD`, `CAD`, `SGD`, `AED`) or international cards enabled.

### Channel C: PayPal Wallet Integration on Standard Checkout
- **Why enable**: Captures the 25%–35% of US/EU buyers whose bank declines a direct Indian card charge; buyers see the familiar PayPal login inside Razorpay's Standard Checkout modal.
- **Setup**: `Razorpay Dashboard -> Account & Settings -> Payment Methods -> International Payments -> PayPal -> Link Account` (requires an Indian PayPal Business Account with IEC + purpose code).
- **Note**: PayPal orders must be created in a PayPal-supported foreign currency (`USD`, `EUR`, `GBP`, `AUD`, `CAD`, `SGD`), not `INR`.

### Channel D: MoneySaver Export Account (International Bank Transfers / IBT)
- **How it works**: Razorpay provisions local virtual bank accounts in the US (**ACH / Fedwire**), Europe (**SEPA**), UK (**Faster Payments / BACS**), and global **SWIFT** via partner banks.
- **Pricing**: **`1%` + `18%` GST** (`1.18%` effective) with **0% FX markup** over the live interbank rate — saving ~2%–3% compared to international cards.
- **Order Creation (`POST /v1/orders`)**:
  ```json
  {
    "amount": 150000,
    "currency": "USD",
    "receipt": "rcpt_intl_ibt_001",
    "method": "bank_transfer",
    "notes": {
      "purpose_code": "P1006",
      "invoice_number": "FAM-EXP-2026-0042"
    }
  }
  ```
- **Settlement & Compliance**: Requires uploading the export invoice (`Invoice` / `OrganizationInvoice` PDF) when prompted or via API; settles in INR in 1–3 working days after funds hit the virtual account, with automated **e-FIRA** issued by Razorpay's partner AD bank.

---

## 3. Codebase Invariants & Multi-Currency Rules

1. **Current Codebase State (`lib/payments/index.ts`, `lib/payments/core/razorpay.ts`)**:
   - Currently, Familiarise creates Razorpay Orders in **`INR` paise** (`currency: "INR"`), and Razorpay's checkout handles issuer-side currency conversion for international cards.
   - `Payment.amount` in Prisma is stored in `BigInt` subunits (`paise` when `currency === "INR"`).
2. **If Enabling Native `USD` / `EUR` / `GBP` Order Display (Required for PayPal & Apple Pay)**:
   - Remember that our double-entry ledger (`LedgerEntry`, `LedgerTransaction`), `ConsultantEarnings`, and `OrganizationPayout` are **strictly INR-denominated (`paise`)** (see `.claude/skills/finance/references/doctrine.md` — *"INR-only settlement"*).
   - Never mix `USD` cents and `INR` paise in `LedgerEntry.amount` or `ConsultantEarnings`. Either:
     - Keep `Payment.amount` in `INR` paise and use display-only FX conversion before creating an `INR` order (works for Visa/Mastercard/Amex), OR
     - Store `displayCurrency` / `displayAmountSubunits` separately on `Payment` and record ledger entries strictly from the settled INR amount (`payload.payment.entity.base_amount` in INR paise on `payment.captured`).
3. **Zero-Rated GST Export Evidentiary Checklist (`lib/payments/tax/tax-engine.ts`)**:
   - Under Section 2(6) and Section 16 of the IGST Act, 0% GST export of services (`SAC 999293`) requires:
     1. Supplier in India (`Familiarise`),
     2. Recipient outside India (verified billing address + country != `IN`),
     3. Place of supply outside India,
     4. Payment received in convertible foreign exchange (or INR where permitted by RBI with FIRS/e-FIRA proof),
     5. Active **Letter of Undertaking (LUT)** Form `GST RFD-11` for the financial year, and
     6. Retaining the Razorpay **FIRS / e-FIRA** certificate mapped to `Invoice.invoiceNumber`.
