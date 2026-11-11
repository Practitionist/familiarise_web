---
title: Pricing — Overview and current state
type: explanation
status: live
last-reviewed: 2026-11-09
---

# Pricing: overview and current state

This page describes every pricing lever as it exists on `dev` today. Each lever names the file and function that implement it, so a reader can find the rule without searching. Behaviour that is decided but not built is marked **(planned)**; everything else is on `dev`. How the levers combine on one order is on the next page, [one order, one pipeline](./01-one-order-pipeline.md).

## The shape of a price

An expert sets one **list price** per plan, before GST. A buyer's order starts there and passes through up to five steps: an optional discount, GST, optional referral credits, and the platform fee that is taken out of the expert's side. All money is integer paise (₹1 = 100 paise). The platform charges in INR only.

A buyer-facing price is shown in one of two ways, chosen by whether the platform is GST-registered:

- **Unregistered:** the list price is the all-in price, and no GST text appears.
- **Registered (a valid `PLATFORM_GSTIN`):** every buyer price is shown all-in, for example "₹1,180 incl. GST" for a ₹1,000 list price. The expert still types the ex-GST price.

The display is computed by `buyerDisplayPricePaise()` in `lib/payments/pricing/display-price.ts`, which rounds the GST exactly as the checkout does (`determineTax()` in `lib/payments/tax/tax-engine.ts`), so the number on a card equals the number the buyer is charged. The registration flag is read on the server with `isPlatformGstRegistered()` in `lib/pdf/supplier.ts` and handed to client components through `BuyerPriceProvider` (`components/pricing/BuyerPriceProvider.tsx`), mounted by `app/explore/layout.tsx` and `app/checkout/layout.tsx`. A client component never reads `PLATFORM_GSTIN` itself.

## The levers today

### The derivation pipeline

`deriveCheckoutAmount()` in `lib/payments/pricing/derive-checkout-amount.ts` is the single order of operations, used by checkout, the price preview, digital products and replays. It is a pure function of its inputs apart from one callback that resolves the credit balance. The order is fixed:

1. Start from `basePaise`, the list price (stored as `Payment.originalAmount`).
2. Subtract the discount: the code discount (`computeDiscountPaise()`) plus the welcome discount. A welcome discount is dropped whenever a code is present, so at most one pre-tax modifier applies.
3. Charge GST on the discounted base (`determineTax()`); stored as `Payment.taxAmount`.
4. Subtract referral credits from the tax-inclusive total; the result is `Payment.amount`, the gateway charge.

### Discount codes

The `DiscountCode` model (`prisma/schema.prisma`) holds `code`, `discountType` (`PERCENTAGE` or `FIXED_AMOUNT`), `discountValue`, `currency`, `isActive`, `expiresAt`, `maxUses`, `currentUses` and `maxDiscount`. Its limits are the ones a reader should know before relying on it:

- A code is platform-wide. It has no owner, no funder, no plan or expert scope, no minimum order and no per-buyer limit.
- `maxDiscount` caps a percentage code only; a fixed code is capped by the list price. The platform-funded cap (`platformFundedCapPaise`) holds the code discount, the welcome discount and the credits together to the platform fee minus the gateway estimate, so no code can push an order's platform margin below zero. A code is refused with `DISCOUNT_NOT_APPLICABLE` on an order whose take cannot fund promo.
- Use is counted in `currentUses`, incremented inside the payment transaction (`lib/payments/checkout/commit/payment-legs.ts`) and returned by `returnDiscountUse()` (`lib/payments/checkout/discount-use.ts`) when a pending payment ends unpaid. There is no per-use audit row.
- Nothing in the application creates a code; rows come from the seed or from SQL the owner approves.
- Codes apply to consultations, subscriptions, webinars and classes. Digital products and replays call `deriveCheckoutAmount()` with no discount, so a code cannot be used on them.
- The code is validated twice: the preview route `POST /api/payments/discounts/validate` and again, authoritatively, inside `calculateAmountAndValidate()` (`lib/payments/checkout/pricing.ts`).
- The discount is platform-funded: the expert's earnings base is `originalAmount`, the undiscounted list price, so the expert is paid as if no code were used.

### The referral welcome discount

A buyer who signed up through a consumer referral gets a pre-tax discount on their first marketplace purchase. `resolveCheckoutAttribution()` (`lib/referrals/attribution.ts`) decides eligibility and builds the `WelcomeDiscount` (basis points, a rupee ceiling and a minimum order); `computeWelcomeDiscountPaise()` and `keepsWelcomeDiscount()` (`lib/referrals/promo-math.ts`) apply it. Its percentage is `min(ReferralProgramConfig.discountBps, platform fee bps)`, so it never exceeds the order's take rate. The amount is stored in `Payment.welcomeDiscountPaise`. The database holds the "one live welcome-discounted order per buyer" slot as the unique index `Payment_live_welcome_discount_user_key`; losing the race returns the typed 409 `WELCOME_DISCOUNT_IN_USE`. The program thresholds are configuration; their approved values are kept in Notion (Familiarise / Growth & Marketing / Growth & Marketing Lever Register).

### Referral credits

Credits are money a referrer has earned, spent after tax. `creditCapPaise()` (`lib/referrals/promo-math.ts`) limits credits plus the welcome discount to `creditCapBps` of the list price, where `creditCapBps = min(ReferralProgramConfig.redemptionCapBps, platform fee bps)`. Credits are redeemable only when the tax-inclusive total reaches `MIN_CREDIT_REDEMPTION_PAISE` (₹500, `lib/referrals/constants.ts`). A spent credit is a `REFERRAL_CREDIT` payment leg. The leg is excluded from the `payment_legs_sum_to_amount` trigger sum because `Payment.amount` is already net of it (`prisma/sql/payment-legs-triggers.sql`). Credits do not reduce the GST base: they are consideration, so GST stays on the pre-credit value.

### The platform fee: two rates and attribution

`PlatformFeeSchedule` holds two rates in basis points, `marketplaceBps` and `ownLinkBps`, versioned with a maker and a checker; the active row is the latest approved one whose `effectiveFrom` has passed (`readActiveFeeSchedule()` in `lib/payments/pricing/platform-fee.ts`). While no row is approved both rates fall back to 20%. The owner approving a schedule is a go-live step; the approved values are kept in Notion (Familiarise / Finance and Pricing / Finance Lever Register) and the reasoning in Notion (Familiarise / Finance and Pricing / Pricing Strategy).

Which rate applies to an order depends on **attribution**, stamped on the payment as `attributionSource`:

- `MARKETPLACE`: the buyer found the expert through the platform.
- `OWN_LINK`: the buyer arrived through the expert's signed `?via=` link.
- `CONSUMER_REFERRAL`: a consumer referral on the buyer's first purchase.

`ExpertCustomerRelationship` makes the first attribution for an expert and buyer pair permanent: a later purchase from the same buyer keeps the original source. `feeBpsForSource()` picks `ownLinkBps` for `OWN_LINK` and `marketplaceBps` for the other two.

The public `become-an-expert` page renders both rates from the active schedule through `describeFeeRates()` and `readActiveFeeSchedule()`, so the page states "You keep 80–90%" only when the schedule says so, and "You keep 80%" while both rates are the fallback. The page is incrementally regenerated hourly, so a newly approved schedule appears within the hour. The `/pricing` page (`app/(pages)/pricing/page.tsx`) reads the marketplace rate from the same schedule through `readActiveFeeSchedule()` and `describeFeeRates()`, wrapped in `withBuildTimeRetry`, with the same hourly regeneration (`revalidate = 3600`); it no longer hard-codes `PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE`.

### Fee waivers

`ConsultantFeeWaiver` grants an expert a 0% platform fee on their next N sessions, created by the referral program for the referred and the referring expert. A waiver is consumed by compare-and-set in the capture transaction (`consumeFeeWaiver()` in `lib/payments/pricing/platform-fee.ts`). An order that carries a welcome discount or a credit leg does not consume a waiver, because the platform's take must fund that promo. Conversely `takeCannotFundPromo()` in `lib/referrals/attribution.ts` removes the welcome discount and the credit cap from any order whose expert has a live waiver, or belongs to a host organisation while `ENABLE_HOST_ORGS` is on.

### Host-organisation rate cards

When an expert sells under a hosting organisation, the split is set by the organisation's `RateCard` (`platformBps`, `orgBps`, `consultantBps`, summing to 10,000) rather than by the marketplace fee. The effective card is resolved by `resolveEffectiveRateCard()` in `lib/api/organizations/rate-card.ts`, and settlement is in `lib/payments/payouts/earnings-service.ts`. The detail is in [rate cards and overage](../finance/50-b2b/03-rate-cards-and-overage.md).

### GST on the order

`determineTax()` (`lib/payments/tax/tax-engine.ts`) takes the regime from `currentGstRegime()` (`lib/payments/tax/gst-regime.ts`), which reads `PLATFORM_GSTIN` alone. Registered, it charges 18% GST on the discounted base for an Indian buyer. Unregistered, it charges 0%, the payment is stamped `Payment.gstRegime = UNREGISTERED`, and the buyer gets a receipt instead of a tax invoice. A payment with no stamp predates the column and is treated as unregistered, so only a `REGISTERED` stamp is ever tax-invoiced. A GSTIN that is set but malformed or from another state refuses checkout with `GST_CONFIG_INVALID` rather than charging 0%; `GET /api/checkout/context` answers the same typed refusal (503) without a Sentry event. The rules and the turnover alarm are in [GST registration and the tax regime](../finance/60-tax/05-gst-registration-and-tax-regime.md).

## What does not exist yet

- Host-funded (expert) coupons, a `DiscountCodeUse` audit row and per-buyer use limits **(planned)**; see [coupons and early-bird](./02-coupons-and-early-bird.md).
- An early-bird price with a real deadline **(planned)**.
- Codes on digital products and replays **(planned)**.
- A struck-through "was" price, and the 30-day offered-price history (the lowest price offered, not charged) that would have to back it **(planned, with early-bird)**.
- Country-based pricing, a cart, pay-what-you-want and order bumps. These are deliberately not built.

## Where in code

| Concern                                   | File and function                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buyer display price and its note          | `lib/payments/pricing/display-price.ts`, `components/pricing/BuyerPriceProvider.tsx`                                                                                   |
| Registration flag (server only)           | `isPlatformGstRegistered()` in `lib/pdf/supplier.ts`                                                                                                                   |
| The pipeline                              | `deriveCheckoutAmount()`, `computeDiscountPaise()`                                                                                                                     |
| Discount validation                       | `app/api/payments/discounts/validate/route.ts`, `calculateAmountAndValidate()`                                                                                         |
| Welcome discount and credit cap           | `lib/referrals/attribution.ts`, `lib/referrals/promo-math.ts`                                                                                                          |
| Fee schedule, waiver, attribution         | `lib/payments/pricing/platform-fee.ts`, `ExpertCustomerRelationship`                                                                                                   |
| Host-organisation rate card               | `lib/api/organizations/rate-card.ts`                                                                                                                                   |
| The checkout page for all four plan types | `PlanCheckoutShell` and the per-type adapters in `app/checkout/plans/` (`adapters/`, `components/`), with `DiscountCodeField` for the code input and its inline errors |
| Buyer payment detail (discount amounts)   | `paymentDiscountBreakdown()` in `lib/appointments/payment-display.ts`                                                                                                  |

## Deprecated & Superseded Approaches

- **Per-page price formatting for buyers.** Each explore and plan page used to format `plan.price` itself, so no page could say "incl. GST". Buyer prices now go through `useBuyerPrice()` or `BuyerPrice` on the client, and `buyerPriceLabelInr()` in server components. Do not format a buyer-facing list price directly.
- **A "+ GST" suffix on digital product cards.** `productPriceLabel()` used to print the list price followed by "+ GST" whatever the platform's registration. It now returns the all-in price with "incl. GST" once registered and the plain price before.
- **Treating the welcome discount as a discount code.** The welcome discount is its own field (`Payment.welcomeDiscountPaise`) and is dropped when a code is present. Do not store it as a `DiscountCode` row or add it to `discountCodeId`.
