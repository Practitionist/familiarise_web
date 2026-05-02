# 05 — Refund & chargeback tax adjustments

> **Status:** 🔴 critical gap on both rails. Refund cascade exists (`lib/payments/operations/refund.ts`) but emits **no tax adjustments** — every refund silently corrupts the next 26Q / GSTR-8 filing period.
> **Audience:** payment / refund / dispute code; finance ops.
> **Last reviewed:** 2026-05-02
> **Linked issues:** [#738 Items A, B, H](https://github.com/Practitionist/familiarise_web/issues/738) (this is the largest gap added in #738).

## What it is

When a payment is refunded (or a chargeback is lost), the **money already moved** through several statutory hooks:

| Hook | What was deposited | Adjustment required |
|---|---|---|
| **Income-tax TDS (Sec 194O / 195)** | Already deposited to govt by 7th of following month | Reverse-credit in **next** 26Q / 27Q quarterly return as a negative adjustment line. Cross-FY adjustments require an income-tax refund claim by the consultant — NOT something we can self-adjust. |
| **GST output liability** (the GST charged on the original invoice) | Already discharged in GSTR-3B for the month of supply | Issue a **GST credit note** under CGST Sec 34, link to original invoice, and net it off in the next month's GSTR-1 / 3B. |
| **GST TCS (Sec 52)** — B2C only | Already collected from consultant + deposited via GSTR-8 | Reduce the next-month GSTR-8 by the refunded TCS, OR file a GSTR-8 amendment if the supply month already passed. |
| **Consultant earnings ledger** | Already credited to consultant's earnings | Reverse via the existing PaymentLeg negative-leg cascade. ✅ already works. |
| **Org earnings ledger** (B2B) | Already credited to org's earnings + accrued in the next invoice | Reverse via existing cascade. ✅ already works. |
| **Org payout / consultant payout** (already disbursed) | Money is gone | **Clawback** flow needed — see #715/#716 epics. |

The **first three rows** are entirely unimplemented. Without them, every refund causes the next quarterly TDS return + the next monthly GSTR-8 to be **wrong by the refunded amount**, which is a Sec 234E / Sec 122 penalty risk.

## When it applies

### B2B (org-sponsored)

- Refund of an org-sponsored booking → reduce the org's invoice (or issue a credit note if invoice already issued).
- TDS reversal: applies if the refund causes the consultant's per-FY total to drop back below the threshold. Edge case but real.
- GST credit note: applies if the org invoice was already issued. Issued to the org under their GSTIN.
- GST TCS: N/A for B2B (no TCS collected on org leg).

### B2C (consumer marketplace)

- Refund of a consumer payment → reduce consultant earnings + reverse the negative `PaymentLeg`. Already works.
- TDS reversal: same logic as B2B; affects per-FY consultant aggregate.
- GST credit note: applies if the consumer invoice was already issued. Issued to the consumer (or the consultant supplier per Sec 34, depending on who's the deemed supplier — for facilitator marketplace like ours, the consultant issues, but the platform generates on their behalf).
- GST TCS: applies if the consultant is GST-registered. Reduce next month's GSTR-8 batch.

### Chargeback (lost dispute)

- Same cascade as refund, but triggered by the gateway, not by us. Razorpay/Stripe debits us; consumer never went through our refund flow.
- Currently `app/api/webhooks/utils.ts:955–1104` (dispute auto-hold) holds consultant earnings but does NOT emit any tax adjustment.

### Partial refund

- Proportional. 50% refund → 50% of original TDS / TCS / GST adjusted, not full reversal. Multi-leg refunds (B2B WALLET + LICENSE + INVOICE_ACCRUAL combinations) compound this.

## Current code

| File | What it does | State |
|---|---|---|
| `lib/payments/operations/refund.ts:336–388` | Refund cascade — negative `PaymentLeg`, wallet credit, ConsultantEarnings refundedShareAmount update | ✅ ledger-side OK |
| Refund tax-adjustment hook | **Missing** | 🔴 |
| `CreditNote` model | **Missing** | 🔴 |
| GST output reversal in GSTR-1/3B | **Missing** | 🔴 |
| 26Q / 27Q negative-adjustment line | **Missing** | 🔴 |
| Monthly GSTR-8 amendment for TCS reversal | **Missing** (Sec 52 itself missing — see [doc 02](./02-gst-overview.md)) | 🔴 |
| `app/api/webhooks/utils.ts:955–1104` | Dispute auto-hold of consultant earnings | ✅ holds money correctly |
| Chargeback tax-adjustment trigger on dispute LOST | **Missing** | 🔴 |

## Gap

| Gap | Severity |
|---|---|
| Refund emits no GST credit note (CGST Sec 34) | 🔴 |
| Refund emits no TDS adjustment record for next quarterly return | 🔴 |
| Refund emits no TCS adjustment for next GSTR-8 (depends on doc 02 first) | 🔴 |
| Chargeback (dispute LOST) emits no tax adjustments at all | 🔴 |
| No proportional logic for partial refunds | 🟡 |
| Cross-FY refunds (refund this April for an invoice from March) — TDS adjustment isn't possible same-system; needs consultant refund-claim flow | 🟡 |

## Required

### A. CreditNote model

```prisma
model CreditNote {
  id                  String          @id @default(cuid())
  creditNoteNumber    String          @unique  // sequential, separate from invoice numbering
  invoiceId           String
  invoice             Invoice         @relation(fields: [invoiceId], references: [id])
  amountPaise         Int             // signed positive
  cgstPaise           Int
  sgstPaise           Int
  igstPaise           Int
  reason              String          // refund / cancellation / discount
  refundId            String?         @unique
  refund              Refund?         @relation(fields: [refundId], references: [id])
  issuedAt            DateTime        @default(now())
  reportedInGstr1     Boolean         @default(false)
  reportedInGstr1At   DateTime?

  @@index([invoiceId])
  @@index([reportedInGstr1])
}
```

Same shape but linked to `OrganizationInvoice` for the B2B side (reuse via polymorphic FK or two parallel relations).

### B. Refund cascade additions

Inside the existing Prisma transaction in `refund.ts`:

```typescript
// 1. existing — negative PaymentLeg, wallet credit, ConsultantEarnings reversal
// 2. NEW — emit credit note if original invoice already issued
if (originalInvoice && originalInvoice.status === "ISSUED" || "PAID") {
  await tx.creditNote.create({
    data: {
      creditNoteNumber: await nextCreditNoteNumber(tx),
      invoiceId: originalInvoice.id,
      amountPaise: refund.amountPaise,
      cgstPaise: proportional(originalInvoice.cgstPaise, refundFraction),
      sgstPaise: proportional(originalInvoice.sgstPaise, refundFraction),
      igstPaise: proportional(originalInvoice.igstPaise, refundFraction),
      refundId: refund.id,
      reason: refund.reason,
    },
  });
}

// 3. NEW — TDS adjustment record
if (originalTdsRecord) {
  await tx.tdsAdjustment.create({
    data: {
      originalTdsRecordId: originalTdsRecord.id,
      refundId: refund.id,
      adjustmentPaise: -proportional(originalTdsRecord.tdsDeducted, refundFraction),
      financialYear: getIndianFinancialYear(refund.createdAt),
      quarter: getIndianFYQuarter(refund.createdAt),
      reportedInForm26Q: false,
    },
  });
}

// 4. NEW — TCS adjustment (B2C only, when consultant is GST-registered)
if (consultant.gstin && originalPayment.gstTcsCollectedPaise > 0) {
  await tx.gstTcsAdjustment.create({
    data: {
      originalPaymentId: originalPayment.id,
      refundId: refund.id,
      adjustmentPaise: -proportional(originalPayment.gstTcsCollectedPaise, refundFraction),
      monthYear: monthYearOf(refund.createdAt),
      reportedInGstr8: false,
    },
  });
}
```

### C. Chargeback hook

In `app/api/webhooks/utils.ts:handleDisputeLost` (or equivalent), after the existing earnings hold/release logic:

```typescript
// Treat lost chargeback as an involuntary 100% refund for tax purposes.
await applyTaxAdjustments({
  tx,
  refundLikeEvent: { kind: "CHARGEBACK_LOST", paymentId, fraction: 1.0 },
});
```

### D. Quarterly / monthly aggregation pickup

- The cron in [doc 04](./04-tds-quarterly-filings.md) (FVU generator) needs to include `TdsAdjustment` rows where `reportedInForm26Q = false` as **negative lines** in the next return.
- The cron in [doc 02](./02-gst-overview.md) (GSTR-8 batcher) needs to include `GstTcsAdjustment` rows as **negative lines** in the next GSTR-8.
- The GSTR-1 export (not yet built) needs to read `CreditNote WHERE reportedInGstr1 = false` and include them in the credit-notes section.

### E. Cross-FY edge case

When the refund happens in a different FY than the original payment, **we cannot adjust the previous FY's 26Q/27Q** — that return is closed. Instead:

1. Surface this in admin dashboard as "Cross-FY refund — consultant refund-claim required".
2. Generate a Form 16A correction for the consultant showing that ₹X TDS was deposited but the underlying income was reversed; consultant claims a refund from IT dept directly.
3. Skip the 26Q adjustment record (don't pollute the current FY's return with a previous FY's reversal).

## Acceptance

- A 100% refund of an invoiced consumer payment emits: negative PaymentLeg + CreditNote + TdsAdjustment + GstTcsAdjustment (if applicable), all in one Prisma transaction.
- A 50% refund emits all of the above with proportional amounts.
- A lost chargeback emits the same cascade as a 100% refund.
- The next quarterly 26Q FVU includes negative-line entries for all unreported TdsAdjustments.
- The next monthly GSTR-8 includes negative-line entries for all unreported GstTcsAdjustments.
- The next GSTR-1 (when implemented) includes the CreditNote rows.
- Cross-FY refund flags admin dashboard, doesn't pollute current-FY return.

## Don't build

| Don't build | Reason |
|---|---|
| Auto-issue a 16A correction certificate to the consultant cross-FY | The consultant must self-claim from IT dept; we just stop double-deposit. |
| Reverse a fully-deposited TDS via TRACES API | Not technically possible in same-cycle; same-FY adjustments are quarterly-return-only. |

## References

- [CGST Sec 34 — credit and debit notes](https://www.cbic.gov.in/htdocs-cbec/gst/cgst-act-2017-amend-finance-act-2024.pdf)
- [Sec 52 GSTR-8 amendments (TaxGuru)](https://taxguru.in/goods-and-service-tax/gstr-8-amendment-rules.html)
- [TDS adjustment vs refund-claim guidance (CBDT)](https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1)
- See also: [04](./04-tds-quarterly-filings.md), [02](./02-gst-overview.md), [#715](https://github.com/Practitionist/familiarise_web/issues/715) (clawback for already-disbursed payouts), [#716](https://github.com/Practitionist/familiarise_web/issues/716) (refund unification epic).
