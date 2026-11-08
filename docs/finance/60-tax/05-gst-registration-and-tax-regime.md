---
title: GST registration and the tax regime
type: explanation
audience: engineers changing checkout, tax or invoicing, and the owner preparing GST registration
status: live
last-reviewed: 2026-11-09
---

# GST registration and the tax regime

The platform can run in one of two GST regimes, and a single setting decides which: `PLATFORM_GSTIN`. While it is unset the platform is **unregistered**: it charges no GST, issues a receipt rather than a tax invoice, and refuses organisation-funded billing. Once a valid GSTIN is set the platform is **registered**: it charges 18 % GST as the principal supplier and issues tax invoices and credit notes. This page explains both regimes, how each order remembers which one it was sold under, the turnover alarm that says when registration is due, and the switch-over runbook. The owner decisions behind it are in [the tax and pricing levers decision record](../../decisions/2026-11-09-tax-compliance-and-pricing-levers.md).

## 1. Why there are two regimes

Under CGST s.22 a supplier of services must register for GST once its aggregate turnover in a financial year exceeds ₹20 lakh. Below that line registration is optional, and CGST s.32 forbids a person who is not registered from collecting any amount as tax. The platform sells every session to the learner as the principal supplier ([ADR 26](../../enterprise/70-design-decisions/26-gst-principal-model.md)), so it collects no s.52 TCS and s.24(x) does not force an earlier registration. It therefore launches unregistered, and it must stop charging GST until it registers.

The principal model is also what makes the threshold the platform's own: its turnover is the full value of every sale, not only its commission. If the chartered accountant were to reject the principal model, registration would be compulsory from the first rupee, and this page's unregistered regime would not apply.

## 2. How the regime is decided

`isPlatformGstRegistered()` (`lib/pdf/supplier.ts`) is true when `PLATFORM_GSTIN` is a well-formed GSTIN whose first two digits match the registered office's state in `lib/company.ts`; it reuses the validation `getPlatformSupplier()` applies to every statutory document. `currentGstRegime()` (`lib/payments/tax/gst-regime.ts`) turns that into the value every pricing path uses:

| `PLATFORM_GSTIN`                           | Regime         | What pricing does                                                     |
| ------------------------------------------ | -------------- | --------------------------------------------------------------------- |
| Unset or empty                             | `UNREGISTERED` | Charges 0 % GST and prices normally                                   |
| Valid, same state as the registered office | `REGISTERED`   | Charges 18 % GST (or zero-rates an export under a valid LUT)          |
| Set but malformed, or from another state   | none           | Refuses with `GST_CONFIG_INVALID` (503); never charges 0 % by mistake |

The regime is read from the environment on every pricing call, so a change takes effect on the next deploy that carries the new value.

## 3. What each regime does

| Area                            | Unregistered                                                                                                                                                                                          | Registered                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tax on an order                 | `determineTax` returns 0 with reason `UNREGISTERED_S22_THRESHOLD` (`lib/payments/tax/tax-engine.ts`)                                                                                                  | 18 % on the discounted base; an export is zero-rated only under a valid LUT                                             |
| Checkout preview                | `GET /api/checkout/context` sends `gstRegistered: false`; `calculatePricing` shows 0 % so the quoted total equals the charge                                                                          | `gstRegistered: true`; the preview adds 18 %                                                                            |
| Payment row                     | `Payment.gstRegime = UNREGISTERED`                                                                                                                                                                    | `Payment.gstRegime = REGISTERED`                                                                                        |
| Buyer document                  | The gateway receipt; the payment page says no GST was charged                                                                                                                                         | A numbered consumer tax invoice and credit notes ([GST invoices and credit notes](02-gst-invoices-and-credit-notes.md)) |
| Invoice minting and healing     | `mintConsumerInvoice` declines; `heal-consumer-invoices` mints nothing; the daily ops digest runs the turnover alarm                                                                                  | Mints and heals as usual                                                                                                |
| Organisation rails              | Checkout on `WALLET`, `INVOICE` or `LICENSE` funding and a wallet top-up refuse with `GST_REGISTRATION_REQUIRED` (403); `createOrgInvoice` refuses; the invoice rollup and subscription invoices skip | Available                                                                                                               |
| Personal (member-paid) checkout | Available                                                                                                                                                                                             | Available                                                                                                               |

The checkout pages show tax and the total only once that context has loaded (`taxContextStatus` from `useCheckoutTaxContext`, rendered through `TaxContextGate`), because their defaults cannot know the regime; a failed load shows a retry instead of a guessed 18 %.

### Where the regime is stamped

Every Payment creation that computes tax stamps the regime it priced under. The column is nullable for rows that predate it.

- The direct checkout row: `calculateAmountAndValidate` (`lib/payments/checkout/pricing.ts`) resolves the regime once and `writeCheckoutPayment` (`lib/payments/checkout/commit/payment-row.ts`) writes it.
- Approval and trial pay-links: `priceWithTax` and the pre-mint and re-mint writes in `lib/payments/operations/approval-payment.ts`. A live pay-link minted under the other regime is re-minted rather than reused.
- Replays and digital products: the purchase routes write `gstRegime` into the order notes, and the capture handlers (`lib/payments/webhooks/recording-purchase.ts`, `digital-product-purchase.ts` and the shared `standalone-sale-capture.ts`) copy it onto the Payment, so the stamp is the regime the order was minted under even if the capture lands after a switch.
- Overage side-payments: `lib/payments/billing/overage-settlement.ts`.

The pending-checkout page re-derives the total under the current regime (`lib/data/pending-checkout.ts`), so an order minted before a switch-over reads as `TAX_CHANGED`.

### Invoices never become retroactive

`CONSUMER_INVOICEABLE_PAYMENT_WHERE` (`lib/payments/billing/consumer-invoice.ts`) admits only rows stamped `REGISTERED` or legacy rows with no stamp, and `mintConsumerInvoice` declines a row stamped `UNREGISTERED`. The healer and the monthly outward-register export both read through that filter, so a payment taken while unregistered never gets a tax invoice later, even after `PLATFORM_GSTIN` is set. A legacy row with no stamp keeps today's behaviour.

## 4. The turnover alarm

While unregistered, the daily ops digest (`ops-digest`, once a day at 09:20 IST on the ticker) calls `checkGstRegistrationTurnover` (`lib/compliance/gst-turnover.ts`) from its "GST registration" section. It sums the current Indian financial year's succeeded, non-mock payments sold since 1 April IST, dated by `capturedAt` (or `createdAt` for rails confirmed at checkout, which have no capture; a re-mint resets `capturedAt`, so a reused row is dated by its real sale): the amount charged less any GST and less succeeded refunds, plus the referral credit still spent on those payments. Credit comes from `ReferralCreditUsage.amount`, which `reverseCreditsForPayment` reduces, or deletes, as a refund restores the credit, so a fully refunded ₹900 cash plus ₹100 credit sale counts as zero. When that reaches `GST_TURNOVER_ALARM_PAISE` (₹15,00,000) it sends one Sentry warning, fingerprinted so every day groups into one issue, naming the ₹20,00,000 threshold and the duty to apply within 30 days of crossing it; the digest email lists the same line as a new item. Below the alarm the section shows the figure as a note. Running on the once-daily digest keeps the alarm to at most one Sentry event a day against the shared 5,000-event monthly quota.

**Worked example.** By 10 January 2027 the platform has captured ₹15,40,000 of payments and ₹60,000 of referral credits in the financial year that began on 1 April 2026, and refunded ₹80,000 of them. The alarm reads 15,40,000 + 60,000 − 80,000 = ₹15,20,000, which is above ₹15,00,000, so the next morning's digest raises the warning. At the current pace the platform crosses ₹20 lakh within weeks, which leaves time for the roughly seven working days a registration takes.

One Postgres database serves dev and prod, so test-mode payments that are not flagged as mock also count. The alarm errs early, never late.

## 5. Switch-over runbook

1. **Register before ₹20 lakh.** Apply on the GST portal as soon as the alarm fires, and no later than 30 days after crossing ₹20 lakh. With Aadhaar authentication the GSTIN usually arrives in about seven working days. Confirm the registration's state is Haryana (state 06), the registered office in `lib/company.ts`.
2. **Set `PLATFORM_GSTIN` in Netlify production.** Set it for the production context only and redeploy. A typo or a GSTIN from another state makes checkout refuse with `GST_CONFIG_INVALID`, which is deliberate: fix the value rather than unset it.
3. **Check the first orders.** A ₹1,000 checkout now quotes and charges ₹1,180, and the new Payment reads `gstRegime = REGISTERED`. Run `heal-consumer-invoices` from System Jobs: it should complete without a config skip and mint invoices only for the new orders.
4. **Old orders keep their stamp.** Orders sold before the switch stay `UNREGISTERED`, carry no GST and never receive a tax invoice; nothing backfills them.
5. **Organisation rails unlock.** Wallet, invoice and licence checkouts, wallet top-ups and organisation invoices work from the same deploy. The subscription-invoice job bills any subscriptions that fell due while it was skipping.
6. **Update the price display.** Once registered, public prices show the all-in price including GST (a separate pull request).

## Invariants

| Rule                                                       | Enforcer                                                                                                      | Test                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| No GST is charged while unregistered                       | `determineTax` with `gstRegistered: false`                                                                    | `__tests__/payments/pricing-levers-invariants.test.ts`               |
| A malformed GSTIN never prices at 0 %                      | `currentGstRegime` throws `GST_CONFIG_INVALID`                                                                | `__tests__/payments/pricing-levers-invariants.test.ts`               |
| The preview equals the charge in both regimes              | `calculatePricing` reads `gstRegistered` from the checkout context                                            | `__tests__/payments/pricing-levers-invariants.test.ts`               |
| An unregistered sale never gets a tax invoice              | `CONSUMER_INVOICEABLE_PAYMENT_WHERE` and `mintConsumerInvoice`                                                | `__tests__/payments/gst-unregistered-invoicing.test.ts`              |
| Organisation billing waits for registration                | `assertOrgBillingAvailable`, `createOrgInvoice`, `rollupOrgInvoiceAccruals`, `generate-subscription-invoices` | `__tests__/payments/pricing-levers-invariants.test.ts` (the refusal) |
| The turnover alarm reports once a day at most, at ₹15 lakh | `checkGstRegistrationTurnover` in the `ops-digest` job                                                        | `__tests__/payments/gst-unregistered-invoicing.test.ts`              |

## Where in code

- `lib/pdf/supplier.ts`: `isPlatformGstRegistered`, `getPlatformSupplier`, `platformSupplierForJob`.
- `lib/payments/tax/gst-regime.ts`: `currentGstRegime`, `assertOrgBillingAvailable` and the two refusal codes.
- `lib/payments/tax/tax-engine.ts`: `determineTax`.
- `lib/compliance/gst-turnover.ts`: the turnover alarm and its constants; `lib/observability/ops-digest.ts` runs it.
- `lib/payments/billing/consumer-invoice.ts` and `consumer-invoice-healer.ts`.

## Related

- [Tax on the platform, in plain language](01-tax-explainer.md)
- [Checkout and pricing](../10-money-in/01-checkout-and-pricing.md), for the profitability floor that caps every promotion
- [The go-live skill](../../../.claude/skills/go-live/SKILL.md), for where registration sits in the launch order

## Deprecated & Superseded Approaches

- **18 % on every domestic order.** Before the regime existed, `determineTax` charged 18 % whether or not `PLATFORM_GSTIN` was set, and every un-invoiced payment waited for the healer to mint its invoice once a GSTIN appeared. A payment is now stamped with its regime, and an unregistered one is never invoiced.
- **Organisation invoices without a supplier GSTIN.** The org invoice paths used to fall back to the registered office's state and issue GST invoices with no GSTIN. They now refuse or skip while unregistered.
