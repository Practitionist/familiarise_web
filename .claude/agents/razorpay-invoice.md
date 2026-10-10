---
name: razorpay-invoice
description: Works on this repo's in-house GST invoice and credit note pipeline (lib/payments/billing/, lib/compliance/gst.ts, SAC 999293, CGST/SGST vs IGST place-of-supply split). Use when modifying invoice generation, GST compliance, or credit notes for Razorpay payments/refunds/disputes.
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: yellow
---

## Before you start

**Read these first under `.claude/skills/finance/`:**

1. `references/razorpay/references/gst-invoicing.md` — how GST invoicing works in this repo and why Razorpay's `/v1/invoices` API is NOT used.
2. `references/razorpay/references/this-repo.md` — file map and Prisma models (`ConsumerInvoice`, `ConsumerCreditNote`, `OrganizationInvoice`, `CreditNote`).
3. `references/compliance.md` and `references/doctrine.md` — principal-supplier GST model, SAC `999293`, consumer document numbering, CGST s.34(2) credit-note window, Income-tax Act 2025 s.393 e-commerce operator TDS continuity, IST period boundaries, and GSTIN-first supplier state.

**CRITICAL — Do NOT call `razorpay.invoices.create()` for GST invoices and do NOT scaffold `lib/billing/gst.ts` or Drizzle `gst_invoices` tables.**
Per official Razorpay documentation (`https://razorpay.com/docs/api/payments/invoices/`), Razorpay's `/v1/invoices` REST API **only creates non-GST invoices** (HSN/SAC codes and CGST/SGST/IGST tax rates cannot be passed via API). Adding `"CGST @ 9%"` as a plain line item on a Razorpay API invoice does not produce a legally compliant tax invoice.

This repo already implements a complete, GST-compliant invoicing and credit-note engine in-house. Always extend the existing modules.

---

## Where GST Invoicing Lives in This Repo

| Area                                          | File(s)                                                                                                                                | Key Details                                                                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GST Calculation & Place of Supply**         | `lib/compliance/gst.ts`                                                                                                                | Computes 18% GST (`CGST 9% + SGST 9%` for intra-state when customer state matches supplier state; `IGST 18%` for inter-state). Uses integer `BigInt` paise math.                                                                                                       |
| **SAC & Tax Constants**                       | `lib/payments/payouts/constants.ts`                                                                                                    | `TAX_CONSTANTS.SAC_CODE` = `"999293"` (management/consulting services; `999294` education, `999295` training). Never hardcode IT SaaS SAC codes (`998314`/`998315`).                                                                                                   |
| **Invoice Generation & Sequential Numbering** | `lib/payments/billing/consumer-invoice.ts`, `lib/payments/billing/invoice-numbering.ts`                                                | Generates sequential GST-compliant `ConsumerInvoice` and `OrganizationInvoice` records (`INV-FY2627-...` / `CINV-FY2627-...`) after payment capture (`handlePaymentSuccess` / `handleOrgPaymentSuccess`).                                                              |
| **Credit Notes & Outward Register Export**    | `lib/payments/operations/refund.ts`, `lib/payments/billing/credit-note-numbering.ts`, `jobs/compliance/gst-outward-register-export.ts` | Issues sequential `ConsumerCreditNote` / `CreditNote` records (`CN-FY2627-...`) reversing proportional base + CGST/SGST or IGST within the CGST Act s.34(2) Nov 30 cutoff (commercial-only credit notes when past window) and exports GSTR-1 Table 7A/7B/9B CSV lines. |
| **Prisma Models**                             | `prisma/schema.prisma`                                                                                                                 | `ConsumerInvoice`, `ConsumerCreditNote`, `OrganizationInvoice`, `CreditNote` (all amounts in `BigInt` paise).                                                                                                                                                          |

---

## Non-Negotiable Compliance Rules

1. **Principal-Supplier Model**: The platform bills the end consumer 18% GST on the full price as principal supplier and issues its own tax invoice (`ConsumerInvoice` / `OrganizationInvoice`) and credit note (`ConsumerCreditNote` / `CreditNote`). Section 52 GST TCS does not apply under the principal-supplier model; e-commerce operator payouts withhold statutory 0.1% / 5% non-PAN TDS under Income-tax Act 1961 s.194-O / Income-tax Act 2025 s.393.
2. **Place-of-Supply Split (`CGST + SGST` vs `IGST`)**:
   - Intra-state (`customerStateCode === supplierStateCode`): `CGST 9%` + `SGST 9%` (`igstAmount = null` or `0n` per model convention).
   - Inter-state (`customerStateCode !== supplierStateCode`): `IGST 18%` (`cgstAmount = null`, `sgstAmount = null`).
   - Supplier state is derived **GSTIN-first** (first 2 digits of the platform's GSTIN), falling back to configured state code.
3. **Integer Paise Arithmetic**:
   - Never use floating-point rupee values for stored tax fields.
   - Ensure `baseAmount + cgstAmount + sgstAmount === totalAmount` (intra-state) or `baseAmount + igstAmount === totalAmount` (inter-state) with zero rounding drift.
4. **SAC Code**:
   - Always import `TAX_CONSTANTS.SAC_CODE` (`"999293"`) from `lib/payments/payouts/constants.ts`.
5. **Idempotency & Non-Blocking Webhook Execution**:
   - Invoice creation is idempotent per `paymentId` / `orderId`.
   - When triggered from a webhook or confirmation pipeline, follow the repo's transaction and `after()` rules in `.claude/skills/finance/references/doctrine.md` (never hold a DB transaction open across external I/O or PDF rendering).
