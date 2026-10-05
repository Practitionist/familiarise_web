# GST Invoicing & Tax Compliance (Why We Don't Use Razorpay's `/v1/invoices` API)

Official citations:
- [Razorpay Invoices API Overview](https://razorpay.com/docs/api/payments/invoices/)
- [Create an Invoice (`POST /v1/invoices`)](https://razorpay.com/docs/api/payments/invoices/create-with-details/)
- [Create an Item (`POST /v1/items`)](https://razorpay.com/docs/api/payments/invoices/create-item/)

## Where It Lives in This Repo

| File | Responsibility |
|---|---|
| [`lib/payments/tax/tax-engine.ts`](../../../../../lib/payments/tax/tax-engine.ts) | `determineTax` — computes additive 18% GST (`CGST 9% + SGST 9%` for intra-state Maharashtra `27`, `IGST 18%` for inter-state, `0%` for LUT export with `export_lut`). |
| [`lib/payments/payouts/constants.ts`](../../../../../lib/payments/payouts/constants.ts) | `TAX_CONSTANTS` (`GST_RATE: 18`, `SAC_CODE: "999293"`, `HSN_CODES`). |
| [`lib/payments/billing/consumer-invoice.ts`](../../../../../lib/payments/billing/consumer-invoice.ts) | Mints B2C GST tax invoices (`Invoice`) and consumer credit notes (`mintConsumerCreditNote`). |
| [`lib/payments/billing/invoice-numbering.ts`](../../../../../lib/payments/billing/invoice-numbering.ts) & [`credit-note-numbering.ts`](../../../../../lib/payments/billing/credit-note-numbering.ts) | Gap-free, Indian-FY-scoped (`FAM/26-27/000001`), ≤16-char Rule 46 CGST compliant serial numbers via `FiscalCounter`. |
| [`lib/compliance/gst-credit-note-cutoff.ts`](../../../../../lib/compliance/gst-credit-note-cutoff.ts) | Section 34(2) CGST Act credit-note cutoff guard (November 30 following the end of the financial year in which the supply was made). |

---

## 1. Verified Fact: Razorpay's `/v1/invoices` API Cannot Create GST Invoices

From [Official Razorpay Invoices API Docs](https://razorpay.com/docs/api/payments/invoices/create-with-details/):

> **"You can only create non-GST Invoices via APIs."**
> **"You cannot create GST compliant invoices using APIs. This means you cannot add the following to the invoice when creating an invoice via APIs:**
> - **tax rate**
> - **cess**
> - **HSN code**
> - **SAC code"**

### Why Workarounds Fail Rule 46 of the CGST Rules, 2017
- Calling `razorpay.invoices.create()` or `POST /v1/items` via API sets `"hsn_code": null`, `"sac_code": null`, `"tax_rate": null`, and `"tax_amount": 0` in the response (those fields are only populated when items/invoices are created manually in the Razorpay Dashboard UI).
- **Never** add `"CGST @ 9%"` and `"SGST @ 9%"` as separate line items on a Razorpay Invoice: line items represent taxable supplies, not tax components, and the resulting document lacks mandatory Rule 46 fields (supplier & recipient GSTINs, Place of Supply state code, SAC code per item, taxable value vs tax breakdown, and reverse-charge declaration).

---

## 2. How Familiarise Generates GST-Compliant Tax Invoices

We use Razorpay **strictly as the payment rail (`POST /v1/orders`)** and generate our own Rule 46 CGST-compliant tax invoices and Section 34 credit notes in Postgres + PDF (`lib/payments/billing/` & `lib/pdf/`).

### Additive 18% GST Calculation (`lib/payments/tax/tax-engine.ts`)

All plan prices in this repo are **base (tax-exclusive) amounts in integer paise**. GST is added on top at checkout:

| Buyer Location / Context | Tax Mode | Breakdown | Total Charged |
|---|---|---|---|
| **Intra-state** (`buyerState === supplierState`, e.g., `"27"` Maharashtra) | `CGST_SGST` | `9% CGST` (`900` bps) + `9% SGST` (`900` bps) | `basePaise + cgstPaise + sgstPaise` (`118%` of base) |
| **Inter-state** (Indian buyer outside supplier state, or state unknown) | `IGST` | `18% IGST` (`1800` bps) | `basePaise + igstPaise` (`118%` of base) |
| **International Export under LUT** (`buyerCountry !== "IN"` with valid LUT) | `EXPORT_LUT` | `0%` zero-rated export under Bond/LUT (Section 16 IGST Act) | `basePaise` (`100%` of base) |

> **Never back-calculate GST from gross using `amount / 1.18`** — always read the authoritative `Payment.originalAmount` (base paise) and `Payment.taxAmount` (tax paise) stored at checkout time, or use `determineTax()` in `lib/payments/tax/tax-engine.ts`.

---

## 3. SAC Codes Used (`lib/payments/payouts/constants.ts`)

```ts
export const TAX_CONSTANTS = {
  GST_RATE: 18,
  SAC_CODE: "999293", // commercial training and coaching services (platform default)
  HSN_CODES: {
    CONSULTING: "999293",
    EDUCATION: "999294",
    TRAINING: "999295",
  },
} as const;
```

---

## 4. Refunds, Chargebacks & GST Credit Notes (`CreditNote`)

When a captured payment is refunded (`applyRefundCascade` in [`lib/payments/operations/refund.ts`](../../../../../lib/payments/operations/refund.ts)):
1. Checks `isPastGstCreditNoteCutoff(invoiceIssuedAt)` (November 30 following the end of the financial year in which the original invoice was issued, per Section 34(2) of the CGST Act).
2. **Before cutoff**: Mints a sequential `CreditNote` (`CN/26-27/...`) referencing the original `Invoice` / `OrganizationInvoice` and reverses the proportional `GST_PAYABLE` ledger entry.
3. **After cutoff**: Still refunds the full customer amount, but does **not** reverse `GST_PAYABLE` (the platform absorbs the unrecoverable tax component).
