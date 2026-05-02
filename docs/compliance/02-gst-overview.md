# 02 — GST overview (TCS Sec 52, invoicing, place of supply, HSN, IRN, LUT)

> **Status:** core derivation real (`deriveGstBreakdown` does CGST/SGST/IGST split + zero-rated export); TCS Sec 52 + GSTR-8 missing entirely; place-of-supply state capture missing on B2C side; e-invoicing / IRN connector live (env-gated) + cron wired (Round 2, 2026-05-02).
> **Audience:** payments + invoice + finance code.
> **Last reviewed:** 2026-05-02
> **Linked issues:** [#737 §2,§5,§11](https://github.com/Practitionist/familiarise_web/issues/737), [#738 §A,§F](https://github.com/Practitionist/familiarise_web/issues/738).

## What it is

GST has four interlocking obligations for an e-commerce operator (us):

1. **GST registration (Sec 24(x))** — mandatory for the platform regardless of turnover.
2. **Tax invoice (Rule 46)** — must be issued for every taxable supply; specific format + HSN/SAC + place-of-supply rules.
3. **TCS Section 52** — the platform must collect 1% (0.5% CGST + 0.5% SGST or 1% IGST) on the **net taxable value** of supplies of registered consultants and file **GSTR-8** monthly.
4. **E-invoicing (Notif 10/2023)** — mandatory for any registered person with aggregate annual turnover (AATO) ≥ ₹5 cr; voluntary B2C pilot launched Sep 2024.

Plus the orthogonal obligations:

- **Place of supply** (IGST Sec 12 / 13) — determines IGST vs CGST+SGST.
- **HSN/SAC codes** — mandatory on invoice; B2C reporting in GSTR-1 Table 12 is optional below ₹5 cr AATO.
- **LUT (Letter of Undertaking)** — for zero-rated exports without IGST payment.
- **Reverse charge (RCM)** — for imports of services and notified categories.
- **GST credit note (Sec 34)** — required on refund / cancellation / discount post-invoice. See [doc 05](./05-refund-and-chargeback-tax-adjustments.md).

## When it applies

### B2B (org-sponsored)

- Org-issued tax invoice → applies. `OrganizationInvoice` model is real.
- TCS Sec 52 → **N/A**. No ECO event in B2B; the org pays the platform on consolidated invoice; there's no "supply by registered person through ECO" in this leg.
- Place of supply uses **org's GST state** (`Organization.gstStateCode`).
- E-invoicing IRN → applies if AATO ≥ ₹5 cr (Familiarise's AATO determines this on a rolling-year basis). Connector + cron now live as of Round 2.
- LUT → applies for org invoices billed to non-resident parents (GCC / overseas HQ) with India delivery.
- Credit note on org refund → applies.

### B2C (consumer marketplace)

- Consumer tax invoice → applies. `Invoice` model is real; `ConsumerInvoiceDocument` PDF template exists at `lib/pdf/invoice-renderer.tsx`.
- TCS Sec 52 → **applies** when the consultant is GST-registered. **Does not apply** to unregistered consultants (their supply isn't taxable) but the platform still has Sec 24(x) registration obligations.
- Place of supply uses **consumer's state** (need to capture; see Gap below).
- E-invoicing IRN for B2C → currently a **voluntary pilot** (54th GST Council, Sep 2024). Don't enable on B2C until mandated.
- LUT → applies for non-resident consumer payments (zero-rated export under IGST Sec 16).
- Credit note on consumer refund → applies; currently missing.

## Current code

| File | What it does | State |
|---|---|---|
| `lib/compliance/gst.ts:68–128` | `deriveGstBreakdown` — zero-rated export, intra-state CGST 9%+SGST 9%, inter-state IGST 18%, HSN defaulting | ✅ live |
| `lib/compliance/irp.ts` | `generateIrn` — env-gated ClearTax connector | ✅ live |
| `jobs/compliance/irp-uploader.ts` | Daily cron — eligible invoices → `generateIrn` → persist IRN | ✅ wired (Round 2, daily 02:30 UTC) |
| `lib/pdf/invoice-renderer.tsx` | `ConsumerInvoiceDocument` + `OrganizationInvoiceDocument` PDF | ✅ live |
| `OrganizationInvoice` (schema) | igstPaise / cgstPaise / sgstPaise / placeOfSupply / lutNumber / irn / ackNumber / signedQrPayload / irpStatus / retry telemetry | ✅ schema-final |
| `Invoice` (schema, B2C) | Has HSN / GST split fields | ✅ schema-final |
| `Payment.consumerStateCode` | **Missing** | 🔴 |
| `Payment.gstTcsCollectedPaise` + `ConsultantEarnings.gstTcsAccruedPaise` | **Missing** | 🔴 |
| GSTR-8 monthly export | **Missing** | 🔴 |
| GSTIN registry verification (live API) | Format-only (`isValidGstin`) | 🔴 |
| Reverse charge routing | Schema field exists; no routing | 🔴 |
| LUT enforcement | Schema field exists; no enforcement | 🔴 |
| Credit note on refund | **Missing** entirely | 🔴 |
| HSN selection per appointment type | Static default 999293 / 999299 in PDF | 🟡 |

## Gap

1. **TCS Sec 52 entirely missing** — see `02-gst-tcs-section-52` walkthrough below.
2. **Place-of-supply state capture missing on B2C checkout** (CBIC Notification 02/2023-IT mandates it).
3. **GST credit notes on refunds missing** (handled in [doc 05](./05-refund-and-chargeback-tax-adjustments.md)).
4. **GSTIN live registry verification missing** — only format check today.
5. **HSN selection static** — should pick 999293 (consulting) for CONSULTATION; 999299 (education) for WEBINAR / CLASS / SUBSCRIPTION on educational content.
6. **LUT enforcement** — invoice generator doesn't gate on `lutNumber` for non-resident purchases.
7. **RCM routing** — schema field present; no logic.

## TCS Section 52 walkthrough

This is the largest discrete gap. What it requires:

| Item | Detail |
|---|---|
| **Rate** | 1% total — 0.5% CGST + 0.5% SGST (intra-state) **or** 1% IGST (inter-state) |
| **Base** | Net taxable value of supplies through ECO = gross supplies − returns/refunds (Sec 52(3) + Rule 67(1)) |
| **Frequency** | Monthly. **GSTR-8 due 10th of following month.** |
| **Liability** | Platform deposits to govt; consultant claims credit in GSTR-2B. |
| **Penalty** | Equal to TCS not collected (Sec 122(1)(viii)) + 18% p.a. interest (Sec 50(3)) |

Implementation:

```
Payment success
  ↓
Compute net taxable amount (gross − refunds)
  ↓
If consultant.gstin → write Payment.gstTcsCollectedPaise + ConsultantEarnings.gstTcsAccruedPaise
  ↓
Monthly aggregator → GstTcsBatch (one per month per consultant)
  ↓
GSTR-8 export (CSV in GSTN format) → file via portal or GSP partner (IRIS / ClearTax)
```

## Required

Phased — TCS first because it has a deadline (monthly):

1. **Schema**: add `Payment.consumerStateCode` (2-char), `Payment.gstTcsCollectedPaise` (Int), `ConsultantEarnings.gstTcsAccruedPaise` (Int), `GstTcsBatch` model (id, monthYear, consultantProfileId, totalSuppliesPaise, tcsCollectedPaise, gstr8Filed Boolean, filedAt). Migrate via Supabase MCP.
2. **`lib/payments/operations/checkout.ts`**: capture `consumerStateCode` from billing address; pass to `deriveGstBreakdown` for B2C path; emit `Payment.gstTcsCollectedPaise` when `consultant.gstin` is set.
3. **`lib/payments/operations/refund.ts`**: emit GST credit note (see [doc 05](./05-refund-and-chargeback-tax-adjustments.md)) and reduce TCS collected for the affected month's batch.
4. **Cron `jobs/gst/aggregate-tcs-batches.ts`**: run on 1st of each month for the prior month — group `Payment.gstTcsCollectedPaise` by consultant, write `GstTcsBatch` rows.
5. **GSTR-8 CSV export**: `app/api/admin/gst/gstr8/[monthYear]/route.ts` returning the filing-ready CSV.
6. **HSN selection logic**: read appointment type → pick 999293 vs 999299. Update `lib/pdf/invoice-renderer.tsx`.
7. **LUT enforcement**: in invoice generator, if `buyerCountry !== "IN"` and platform's LUT is on file, mark `lutNumber` on the invoice; otherwise charge IGST and let the consultant claim the export refund.
8. **GSTIN live verification**: integrate GSTN API (or GSP partner) at consultant onboarding.

## Acceptance

- A B2C purchase by a Karnataka consumer of a Karnataka-registered consultant: invoice shows CGST 9% + SGST 9%, place of supply = KA.
- Same purchase by a Tamil Nadu consumer: invoice shows IGST 18%, place of supply = TN.
- Same purchase by a US consumer: invoice shows zero GST, "Zero-rated export under IGST Sec 16", LUT number on the invoice.
- A purchase by any consumer of a GST-registered consultant emits `Payment.gstTcsCollectedPaise` = 1% of net.
- Monthly cron writes a `GstTcsBatch` per consultant; GSTR-8 export passes GSTN sandbox validation.
- A refund post-invoice issues a GST credit note (see doc 05).

## Don't build

| Don't build | Reason |
|---|---|
| Internal IRP integration | Use a licensed GSP connector (ClearTax / IRIS / Masters India). Already integrated. |
| B2C IRN today | Voluntary pilot only. Wait for mandatory rollout. |
| Self-managed GSTN portal session | GSP partners provide stable APIs; don't reverse the portal. |

## References

- [Rule 46 — Tax Invoice (CBIC)](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html)
- [GSTR-8 (ClearTax)](https://cleartax.in/s/gstr-8)
- [HSN/SAC requirement clarification (A2Z Taxcorp)](https://a2ztaxcorp.net/cbic-issued-clarification-on-gstns-tweet-hsn-code-requirement-in-gstr-1-mandatory-for-b2b-optional-for-b2c-below-%E2%82%B95-crore-turnover/)
- [Place of supply for online services (VJM Global)](https://www.vjmglobal.com/blog/clarification-on-place-supply-online-services-supplied-by-suppliers-services-to-unregistered-recipients)
- [GST Sec 9(5) — when ECO is deemed supplier (ClearTax)](https://cleartax.in/s/gst-on-notified-services-ecommerce-operators-95) — *not applicable to consulting/education; we're a facilitator, not deemed supplier*
- See also: [05](./05-refund-and-chargeback-tax-adjustments.md) (credit notes), [07](./07-cross-border-flows.md) (LUT, RCM, IGST Sec 16).
