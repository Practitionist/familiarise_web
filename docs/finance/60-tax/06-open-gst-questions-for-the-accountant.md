---
title: Open GST questions for the accountant
type: explanation
audience: engineers changing credit notes, referral credits or organisation overage, and finance staff
status: live
last-reviewed: 2026-11-18
---

# Open GST questions for the accountant

Two questions about GST are open with the chartered accountant (CA). This page states them in neutral terms, says what the code does today so that nobody has to rediscover it, and says plainly that the code does not change until the CA has answered. It takes no position on either question. The full brief, with the worked examples and the sources, is kept in Notion under Familiarise / Tax & CA Working Notes / Tax, Legal & Regulatory Register; this repository holds only the mechanism. The wider list of questions for the CA, such as whether the principal-supplier model holds, is in [the GST principal-supplier decision](../../enterprise/70-design-decisions/26-gst-principal-model.md).

Both questions arise only once the platform is registered for GST. While `PLATFORM_GSTIN` is unset the platform charges no GST, issues no tax invoice and no credit note, and refuses the organisation-funded rails ([GST registration and the tax regime](05-gst-registration-and-tax-regime.md)). Referral credits are not part of that switch: while `PLATFORM_GSTIN` is unset, `deriveCheckoutAmount` still applies a learner's eligible credits to paid orders and `reverseCreditsForPayment` still restores them after a refund. Only the GST and the tax documents described below stay inactive until registration.

## TP-1: referral credits on the invoice and on a refund

**The question.** A learner can pay part of an order with referral credits that the platform funds. Does that credit count as part of the value on which GST is charged, or is it a discount that the invoice should record? The answer decides what the invoice shows and what a credit note must cover when the order is refunded.

**What the code does today.**

- `deriveCheckoutAmount` (`lib/payments/pricing/derive-checkout-amount.ts`) applies credits after GST, against the tax-inclusive total.
- `mintConsumerInvoice` (`lib/payments/billing/consumer-invoice.ts`) bills the cash paid plus the credits applied. In the example in [the money system explainer](../../start-here/02-money-system-hld.md), the invoice total is ₹2,124 and the card payment is ₹2,007.55.
- `applyRefundCascade` (`lib/payments/operations/refund.ts`) asks `mintConsumerCreditNote` for a note sized on the cash refunded, and `deriveConsumerCreditNoteAmounts` spreads it over the invoice's total.
- `reverseCreditsForPayment` (`lib/referrals/service.ts`) restores the credits after a refund and issues no tax document. A partial refund restores the same share of the credits as of the cash, and a credit that has lapsed is restored only when the expert or the platform caused the refund, so a buyer's own cancellation leaves it spent.
- The one path that sizes a credit note on the credits is the booking paid entirely with credits: `reverseFreeCreditSettlement` in `lib/payments/operations/booking-refund.ts`.
- The registration turnover alarm in `lib/compliance/gst-turnover.ts` adds credits still spent to the cash charged.

The credit-note cap is enforced by `mintConsumerCreditNote`, which sums earlier notes under a row lock on the invoice; the other rules above are the behaviour of the named functions. [GST invoices and credit notes](02-gst-invoices-and-credit-notes.md) describes the documents.

## TP-2: GST when a member pays the over-cap part of a sponsored session

**The question.** When an organisation's programme is set so that the member pays what lies beyond the programme's cap (`CHARGE_MEMBER`), one session has two payers. Who is the recipient of the over-cap part, and how is the GST on that part divided between the organisation's invoice and the member's document?

**What the code does today.**

- `carveParentBaseForMemberOverage` (`lib/payments/billing/overage-settlement.ts`) takes the over-cap base off the parent booking's `INVOICE_ACCRUAL` leg and its `Payment.amount`. It leaves the booking's recorded `taxAmount` whole.
- `accruedTaxPaise` (`lib/payments/billing/invoice-rollup.ts`) keeps the booking's whole tax on the organisation's rollup line, because the carve lowers the accrual leg in place rather than adding a reversal leg. Only a refund's reversal legs scale that tax down, in proportion to the net accrual over the gross.
- The member's side payment carries GST on the surcharge only (`surchargeTaxPaise` in `lib/payments/billing/overage.ts`), and its own consumer invoice is minted from the member's payment by `handleOverageMemberSuccess`.
- The numbers for a worked overage are in [worked examples](../50-b2b/05-worked-examples.md), "Example 2: Wipro's learner goes past the cap", and the rules are in [rate cards and overage](../50-b2b/03-rate-cards-and-overage.md).

## What happens next

No code changes for TP-1 or TP-2 until the CA answers. When an answer arrives, the owner records it as a decision, and the code, these pages and the finance skill change in the same pull request. Until then, do not "fix" the behaviour above on the strength of a reading of the statute: each point listed here is an open question, and either answer would change a different part of the code.

## Where in code

- `lib/payments/billing/consumer-invoice.ts`: `mintConsumerInvoice`, `mintConsumerCreditNote`, `deriveConsumerCreditNoteAmounts`.
- `lib/payments/operations/refund.ts`: `applyRefundCascade`. `lib/payments/operations/booking-refund.ts`: `reverseFreeCreditSettlement`.
- `lib/referrals/service.ts`: `reverseCreditsForPayment`.
- `lib/payments/billing/overage-settlement.ts`, `invoice-rollup.ts` and `overage.ts`.

## Related

- [GST invoices and credit notes](02-gst-invoices-and-credit-notes.md)
- [GST registration and the tax regime](05-gst-registration-and-tax-regime.md)
- [Rate cards and overage](../50-b2b/03-rate-cards-and-overage.md)
- [The tax and pricing decision record](../../decisions/2026-11-09-tax-compliance-and-pricing-levers.md), item 13 on the CA pack

## Deprecated & Superseded Approaches

- **Holding the CA questions only inside ADR 26.** The principal-supplier decision lists its own questions for the CA. TP-1 and TP-2 are narrower, were found later in the code, and have their own brief; the ADR's second question is the same subject as TP-1.
