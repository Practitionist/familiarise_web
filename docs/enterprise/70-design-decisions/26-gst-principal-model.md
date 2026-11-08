---
title: GST — the platform bills as principal supplier
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-11-09
---

# ADR 26 — GST: the platform bills as principal supplier

## Context

Checkout has always charged 18% GST on the full discounted booking price (`lib/payments/pricing/derive-checkout-amount.ts` → `lib/payments/tax/tax-engine.ts`), and the booking journal credits `GST_PAYABLE` for that amount (`lib/payments/payouts/earnings-service.ts`). That is the behaviour of a supplier of record: the platform sells the consultation to the buyer and remits output tax on the whole consideration. Income tax was wired the other way round: the platform withholds Section 194-O as an e-commerce operator paying an e-commerce participant (`lib/compliance/tds-194o.ts`, `lib/compliance/tds.ts`), which is the behaviour of a facilitator.

The 2026-09-03 financial audit assumed the facilitator reading for GST as well and filed GST-TCS Section 52 collection (#1360) and GSTR builders (#1361) as launch blockers. The two readings cannot both drive the code: a facilitator charges GST only on its commission and collects 0.5% TCS on registered suppliers' sales; a principal charges GST on the whole price, issues the tax invoice to the buyer, and collects no TCS because it is the supplier. Consulting is not a Section 9(5) notified service, so neither reading is forced by statute; it is a business-model choice with a chartered accountant's sign-off.

## Decision

The platform bills as **principal supplier for GST**. Concretely:

1. Once the platform is GST-registered, GST is 18% on the full discounted price, booked to `GST_PAYABLE` at settlement. While `PLATFORM_GSTIN` is unset the platform is unregistered under the CGST s.22 threshold and charges no GST at all; [GST registration and the tax regime](../../finance/60-tax/05-gst-registration-and-tax-regime.md) covers both regimes and the `Payment.gstRegime` stamp.
2. The platform issues a numbered **B2C tax invoice** for every consumer supply made while registered and a **credit note** for every refund (`ConsumerInvoice`, `ConsumerCreditNote`, platform-wide gapless series under CGST Rule 46 and Rule 53, minted by `mintConsumerInvoice` in `lib/payments/billing/consumer-invoice.ts`), alongside the org invoices for sponsored supplies. A payment stamped `UNREGISTERED` gets a receipt and never a retroactive tax invoice.
3. Place of supply for a consumer is the declared or remembered billing state, which a domestic buyer-paid checkout must now supply (question 4 below); for an older payment with no address on record, it defaults to the **supplier's state under Section 12(2)(b)** of the IGST Act, which makes the supply intra-state (CGST + SGST). This is the opposite of the B2B derivation's IGST fallback, which stays as an audit signal for org invoices.
4. GST-TCS under Section 52 **does not apply** on this model and is not collected. The dormant TCS schema and GSTR-8 draft builder were deleted on 2026-10-04; if the CA overturns this decision, TCS is rebuilt at the then-current rate.
5. The platform's own outward-supply return is produced as a period **register export** (all tax invoices and credit notes, with place of supply and tax heads) that the CA files GSTR-1 and GSTR-3B from. No in-app GSTR JSON builders.
6. Income tax is unchanged: 194-O at 0.1% with the three-limb ₹5 lakh exemption, withheld on both the consultant and the host-org payout rails and reported on Form 140 (formerly 26Q) with Section 393 payment codes.

## Alternatives considered

The facilitator model — GST only on the platform's commission, 0.5% Section 52 TCS collected on registered consultants' sales, and monthly GSTR-8 filing — was rejected because it does not match the code that already exists: checkout has always charged 18% GST on the full discounted price and the booking journal has always credited `GST_PAYABLE` for that full amount, which is principal-supplier behaviour, not facilitator behaviour. Adopting the facilitator reading now would mean re-deriving every historical GST figure, wiring the dormant TCS schema, and building GSTR-8 tooling that the platform does not currently need — a pricing, invoice and ledger re-architecture rather than a continuation of the current design. It remains the fallback if the CA rejects the principal-supplier pairing (see Consequences below).

## Consequences

Every consumer payment made while registered leaves a statutory document trail the buyer can download (`ConsumerInvoice`, `ConsumerCreditNote`), which closes the "incomplete information" gap in the money journey. The register export (`jobs/compliance/gst-outward-register-export.ts`) gives the CA one file per month instead of a database query.

The principal model also makes the platform's GST turnover the full value of every sale, so the ₹20 lakh registration threshold is reached on gross sales, not on the platform fee. If the CA rejects the principal model, registration becomes compulsory from the first rupee and the unregistered regime does not apply. Consultants who hold a GSTIN invoice the platform, not the buyer; that is a contractual and onboarding matter, not a code path, and belongs in the consultant terms.

The pairing of principal-for-GST with operator-for-income-tax is defensible but unusual, and it is the first question on the CA list below. If the CA rejects it, the facilitator model is a pricing, invoice and ledger re-architecture (GST only on the platform fee, TCS on registered consultants, GSTR-8 monthly) and would be a new ADR.

## Questions for the chartered accountant

1. Does the principal-for-GST plus 194-O-operator pairing hold for a consultation marketplace where the platform sets the commission but the consultant sets the price and delivers the service?
2. Referral credits are platform-funded and are applied **after** tax at checkout (price → discount code → tax → credits), so a buyer using a ₹500 credit pays GST on the pre-credit base. Is a platform-funded credit a discount recorded on the invoice under Section 15(3)(a), which would reduce the taxable value, or third-party consideration, which would not? The code path is `deriveCheckoutAmount`; nothing changes until this is answered.
3. SAC classification: the platform defaults to 999293 (commercial training and coaching). For advisory consultations 998311 or 998399 may be the correct code; rates are unaffected, input-tax-credit trails are not.
4. **Resolved.** Is the Section 12(2)(b) supplier-state default acceptable for consumers who decline to declare a state, or must the checkout collect a state before payment? CBIC Circular 242/36/2024-GST (31 Dec 2024) and the CGST Rule 46(f) proviso require the recipient's state on every invoice for a service supplied online, whatever its value, so checkout now requires the buyer's state; the default remains only for older payments with none on record.
5. Confirm that Section 52 TCS registration is not required while the platform is the supplier of record.

The full 14-question research memo, with code status, is [docs/finance/60-tax/03-tds-rules-and-returns.md](../../finance/60-tax/03-tds-rules-and-returns.md).

## Related

- ADR 21 (single writer for payment confirmation) — the invoice is minted inside the same pipeline, never by a second writer.
- ADR 08 (gapless invoice counters) — the platform series reuses the same atomic counter shape.
- docs/finance/60-tax/02-gst-invoices-and-credit-notes.md, docs/finance/60-tax/05-gst-registration-and-tax-regime.md, docs/compliance/00-overview.md (RBI payment-aggregator posture).
- docs/decisions/2026-11-09-tax-compliance-and-pricing-levers.md (the registration regime and the profitability floor).
- #1360 (relabelled CA-gated), #1361 (re-scoped to the register export), #1365, #1370.

## Deprecated & Superseded Approaches

- **"The consumer invoice models do not exist yet."** This ADR first described `ConsumerInvoice` and `ConsumerCreditNote` as in-flight design intent. They have shipped, together with the healer and the monthly register export.
- **18% on every order regardless of registration.** Checkout charged GST before the platform held a GSTIN. GST is now charged only in the registered regime.
