---
title: Tax on the platform, in plain language
type: explanation
audience: founders, product and support staff, and engineers new to Indian tax on a marketplace
status: live
last-reviewed: 2026-11-09
---

# Tax on the platform, in plain language

Three different taxes touch a booking on Familiarise. They are charged on different money, at different moments, by different parts of the code. This page explains what each one is and what the platform does about it, without assuming any tax background. The pages that follow state the exact rules as the code implements them: [GST invoices and credit notes](02-gst-invoices-and-credit-notes.md), [TDS rules and returns](03-tds-rules-and-returns.md), [MSME, statutory exports and the calendar](04-msme-statutory-exports-and-calendar.md), and [GST registration and the tax regime](05-gst-registration-and-tax-regime.md).

## A booking, followed through

Priya books a one-hour consultation with Hannah, priced at ₹1,000, on Monday 2026-10-12 at 10:00 IST, after the platform has registered for GST.

1. **Priya pays ₹1,180.** That is the ₹1,000 price plus GST at 18 percent, ₹180 (118,000 paise in total). The ₹180 is not the platform's money. It is collected for the government. Before the platform registers, Priya pays ₹1,000 and no GST at all (see "Registered or not" below).
2. **The platform keeps a fee.** At a 20 percent marketplace fee, ₹200 of the ₹1,000 is the platform's revenue and ₹800 is Hannah's earning.
3. **A week later Hannah is paid.** Before sending her ₹800, the platform may withhold a small amount of income tax on her behalf and pay it to the government. For this session that amount is either nothing or ₹1, depending on how much Hannah has already earned this year.

The first of those is GST, the second is revenue, and the third is TDS.

## GST: tax on the sale

GST is a tax on the sale of a service. The buyer pays it, and the seller collects it and passes it to the government. On Familiarise the platform is treated as the seller of the session to the learner, the principal supplier, so the platform issues the invoice, charges the 18 percent and prepares the data for the returns that its accountant files. The expert is the platform's supplier for the underlying work. This is the platform's chosen model and is recorded in ADR 26 (`docs/enterprise/70-design-decisions/26-gst-principal-model.md`).

### Registered or not

The platform charges GST only once it is registered. Registration is compulsory once its turnover in a financial year passes ₹20 lakh (CGST section 22), and a business that is not registered may not collect any amount as tax (section 32). Because the platform is the principal supplier, that turnover is the full value of every sale, not only its fee. One setting decides the regime: while `PLATFORM_GSTIN` is unset the platform charges 0 percent, gives a receipt rather than a tax invoice, and refuses organisation-funded billing; once a valid GSTIN is set it charges 18 percent and issues tax invoices. Each payment remembers the regime it was sold under, so an order taken before registration never gets a tax invoice later. An alarm fires at ₹15 lakh of turnover so that registration, which takes about seven working days, is done before ₹20 lakh. [GST registration and the tax regime](05-gst-registration-and-tax-regime.md) has the details and the switch-over runbook.

What the code does about GST once registered:

- It charges 18 percent on the discounted price at checkout. The default SAC code is 999293 (commercial training and coaching), which every tax invoice carries; the checkout tax result names 999294 for webinars and classes, but that code is not written onto a document.
- It splits the tax into the right parts. If the buyer's state is the platform's own state, the 18 percent is two halves, 9 percent for the central government (CGST) and 9 percent for the state (SGST). If the buyer is in another state, it is 18 percent IGST. If the buyer's state is not known, a personal buyer is treated as in the platform's own state.
- It issues a numbered tax invoice for each personal payment, and a credit note when part or all of it is refunded. The invoice needs the platform's own GSTIN to be configured; without it no invoice is issued, and the booking is not affected.
- It produces one file per month of every invoice and credit note, which the accountant uses for the monthly GST return.

## TDS: tax withheld from the expert

TDS stands for tax deducted at source. It is income tax that a payer holds back from a payment and deposits with the government on the payee's behalf, so the payee does not have to pay it all at year end. A marketplace that collects money for sellers and then pays them is an e-commerce operator, and the law asks it to withhold 0.1 percent of the gross sale value when it pays a seller. This is section 194-O of the Income-tax Act 1961, called section 393(1) Table 8(v) in the Income-tax Act 2025 that applies from 1 April 2026.

Three details matter:

- The base is the gross sale value, the ₹1,000, not the ₹800 the expert receives and not the ₹1,180 the buyer paid.
- An individual with a verified PAN, the permanent account number, pays nothing until their sales in the financial year pass ₹5,00,000. After that the whole year's sales are taxed, so the payout that crosses the line carries a catch-up. A seller who is a company, a firm or an LLP is taxed from the first rupee.
- Without a verified PAN the rate is 5 percent, not 0.1 percent.

The platform computes this at the moment each payout is sent, records it when the bank confirms, and prepares a quarterly draft for the accountant to file. [TDS withholding](../40-payouts/06-tds-withholding.md) is the engineering detail.

## TCS: tax collected at source

TCS is the mirror image of TDS: tax collected from a buyer. A different TCS exists for GST (section 52 of the CGST Act), under which a marketplace that merely facilitates a sale collects a small percentage from the seller. Because the platform sells to the learner as the principal supplier, it does not collect that TCS, and no code or table for it exists. The older income-tax TCS on sale of goods (section 206C(1H)) was removed in April 2025 and never applied to services.

## Money that crosses the border

The platform settles only in rupees, to Indian bank accounts. A buyer abroad pays by international card in rupees. For GST, a sale to a buyer outside India is zero-rated (no GST) only when the platform holds a valid Letter of Undertaking (LUT) for the financial year. Without one the sale is taxed at 18 percent IGST, which is the safe default. On the payout side, an expert who is not an Indian resident cannot be paid at all, because the withholding rules for a non-resident (section 195) are not implemented.

## A deadline unrelated to tax rates: MSME

If the platform pays a micro or small enterprise late, the platform cannot deduct that payment as a business expense. Section 43B(h) therefore sets a 15-day deadline, or 45 days with a written agreement, for those payees. The platform stamps a deadline on each payout and emails finance when one is near.

## Where each piece lives

| Tax                    | What it is applied to         | When                                         | Code                                             |
| ---------------------- | ----------------------------- | -------------------------------------------- | ------------------------------------------------ |
| GST                    | The buyer's payment           | Checkout, then invoice                       | `lib/payments/tax/`, `lib/compliance/gst.ts`     |
| GST registration alarm | The financial year's sales    | Daily, in the ops digest, while unregistered | `lib/compliance/gst-turnover.ts`                 |
| TDS                    | The expert's or org's payout  | When the payout is sent                      | `lib/payments/payouts/consultant-tds.ts`         |
| MSME deadline          | The payout                    | When the payout is created                   | `lib/compliance/msme.ts`                         |
| Monthly GST register   | Every invoice and credit note | The 2nd of each month                        | `jobs/compliance/gst-outward-register-export.ts` |
| Quarterly TDS draft    | The quarter's TDS records     | The 5th after each quarter closes            | `jobs/compliance/tds-26q-draft-export.ts`        |

## Where in code

- `lib/compliance/` — the pure tax rules: GST split, LUT gate, 194-O base, MSME deadline, the return builders.
- `lib/payments/tax/` — the checkout tax engine and the TDS record writers.
- `lib/payments/billing/consumer-invoice.ts` — personal tax invoices and credit notes.

## Related

- [How payouts work](../40-payouts/01-how-payouts-work.md)
- [Money map](../00-overview/01-money-map.md)

## Deprecated & Superseded Approaches

- **The facilitator framing with GST TCS.** Older tax notes describe the platform as a facilitator that collects 0.5 percent TCS and files a monthly GSTR-8. The principal-supplier decision replaced that, and no TCS code exists. Do not build a GSTR-8 builder.
- **"Consultant TDS is 10 percent above ₹50,000."** That is section 194J and was how earlier documents described consultant tax. The platform withholds under 194-O.
- **"Every domestic order carries 18 percent GST."** Checkout used to charge 18 percent whether or not the platform was registered. It now charges GST only while `PLATFORM_GSTIN` holds a valid GSTIN.
