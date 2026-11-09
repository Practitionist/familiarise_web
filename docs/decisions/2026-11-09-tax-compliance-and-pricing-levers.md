# ADR: Tax compliance and pricing levers — the GST registration regime, the profitability floor and one order pipeline

- **Status**: Accepted (owner decisions, 2026-11-08 and 2026-11-09). Items marked **(shipped)** land in the tax-regime pull request (`feat/tax-regime-profit-floor`); items marked **(planned)** are built by the pull request named beside them; **(no code)** items are recorded positions.
- **Date**: 2026-11-09
- **Author**: Platform engineering
- **Related**: [GST registration and the tax regime](../finance/60-tax/05-gst-registration-and-tax-regime.md), [Tax on the platform, in plain language](../finance/60-tax/01-tax-explainer.md), [Checkout and pricing](../finance/10-money-in/01-checkout-and-pricing.md), [ADR 26, the GST principal model](../enterprise/70-design-decisions/26-gst-principal-model.md), [Growth — waitlist, newsletter and referrals](2026-11-08-growth-waitlist-newsletter-referrals.md)

## Context

The platform launches before 1 January 2027, with January to March 2027 as the fallback. Three facts shaped this record. First, `determineTax` charged 18 % GST on every domestic order whether or not `PLATFORM_GSTIN` was set, so an unregistered platform would have collected a tax it had no registration to remit, and every consumer payment would have waited for a tax invoice that could never be issued. Second, every pricing lever (a platform discount code, the referral welcome discount and referral credits) is funded by the platform out of its fee on the list price, and discount codes had no cap at all, so a generous code could make an order lose money. Third, `Payment` recorded nothing about the regime an order was priced under, so a later registration could not tell which orders had been sold without GST.

The design was researched on 2026-11-08 and 2026-11-09 against the code, the live database and Indian law, India-first, and the owner turned it into the decisions below.

## One order, one pipeline

Each lever has exactly one slot, one funder and one cap, so combinations never multiply. `deriveCheckoutAmount` (`lib/payments/pricing/derive-checkout-amount.ts`) applies the steps in this order on the server, and `calculatePricing` (`app/checkout/plans/math.ts`) applies the same steps in the checkout preview.

| Step | Lever                                                                                                                      | Funded by    | Cap                                                                       | GST effect                                                                                         | TDS (194-O) effect                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1    | The list price (an early-bird price inside its window is planned, P2)                                                      | —            | —                                                                         | The start of the value                                                                             | The gross base is the expert's sale price                                  |
| 2    | At most one pre-tax modifier: a platform code or the referral welcome discount (an expert-funded host code is planned, P2) | The platform | Platform-funded total at most the platform fee minus the gateway estimate | Reduces the taxable value (s.15(3)(a)); the invoice shows a Discount row                           | None for a platform-funded modifier, because the base stays the list price |
| 3    | GST at 18 %, or 0 % while unregistered                                                                                     | The buyer    | —                                                                         | Computed here only, by `determineTax`                                                              | Excluded from the base                                                     |
| 4    | Referral credits, after tax                                                                                                | The platform | Shares the step 2 cap                                                     | None: the credit is consideration, so GST stays on the pre-credit value (Circular 243/37/2024-GST) | None                                                                       |
| 5    | The platform fee: the marketplace or own-link rate; a waiver makes it 0                                                    | —            | A waiver or host-organisation order gets no platform promo                | —                                                                                                  | —                                                                          |

Never allowed: a platform code together with the welcome discount, a promo on a fee-waiver or host-organisation order, a negative platform margin, a fake countdown, or a strike-through price without the 30-day prior price.

### Worked example

A referred friend books a marketplace consultation listed at ₹1,000 (100,000 paise) while the platform is registered, under a 2,000 bps marketplace fee. The numbers are exactly what `deriveCheckoutAmount` returns, and the invariant suite `__tests__/payments/pricing-levers-invariants.test.ts` pins them.

| Step                                                          |  Paise |  Rupees |
| ------------------------------------------------------------- | -----: | ------: |
| Platform fee, 20 % of the list price                          | 20,000 | ₹200.00 |
| Gateway estimate, 3.54 % of ₹1,180 rounded up                 |  4,178 |  ₹41.78 |
| Platform-funded cap (`platformFundedCapPaise`)                | 15,822 | ₹158.22 |
| Welcome discount: 20 % would be ₹200, the cap holds it to     | 15,822 | ₹158.22 |
| Taxable value                                                 | 84,178 | ₹841.78 |
| GST 18 %                                                      | 15,152 | ₹151.52 |
| The buyer pays                                                | 99,330 | ₹993.30 |
| Referral credits (the cap is used up)                         |      0 |   ₹0.00 |
| The expert's share, on the list price                         | 80,000 | ₹800.00 |
| Actual gateway cost, worst case 3.54 % of ₹993.30, rounded up |  3,517 |  ₹35.17 |
| Platform margin: 99,330 − 15,152 − 80,000 − 3,517             |    661 |   ₹6.61 |

On a domestic card or UPI payment at 2.36 % the gateway would cost 2,345 (₹23.45) and the margin would be 1,833 (₹18.33); the floor is sized for the costliest method, so the margin is never negative. TDS is computed on the ₹1,000 gross. Unregistered, the estimate is 3,540 (₹35.40) on ₹1,000, the cap is 20,000 − 3,540 = 16,460 (₹164.60), the buyer pays ₹835.40 with no GST and gets a receipt, and the platform keeps 83,540 − 80,000 − 2,958 = 582 (₹5.82) after the gateway's worst case. On the own-link rate of 1,000 bps the cap is 10,000 − 4,178 = 5,822 (₹58.22) registered, or 10,000 − 3,540 = 6,460 (₹64.60) unregistered. A planned host-funded 10 % coupon (P2) would make the sale ₹900, the fee ₹180, the expert's share ₹720, GST on ₹900, and allow no welcome discount, because an order carries one modifier only.

## Decisions

1. **Launch basis.** The target is before 1 January 2027, with January to March 2027 as the fallback. The E-Commerce (Amendment) Rules 2026 items that apply from 1 January 2027 are P0, due on 31 December. **(no code)**
2. **GST registration.** The platform launches unregistered while its aggregate turnover is under ₹20 lakh (CGST s.22). Section 24(x) does not force registration, because under the principal model the platform collects no s.52 TCS.
   - The regime is derived from `PLATFORM_GSTIN` alone (`isPlatformGstRegistered` in `lib/pdf/supplier.ts`, `currentGstRegime` in `lib/payments/tax/gst-regime.ts`). A valid GSTIN from the registered office's state means registered at 18 %. An unset one means 0 % GST, a receipt instead of a tax invoice, and the organisation-funded rails refused with `GST_REGISTRATION_REQUIRED`. A GSTIN that is set but malformed or from another state refuses checkout with `GST_CONFIG_INVALID` instead of silently charging 0 %. **(shipped)**
   - Each Payment stamps its regime in `Payment.gstRegime`. **(shipped; the owner runs `db:push` at merge)**
   - A payment whose `gstRegime` is NULL (a sale before the stamp existed) counts as unregistered, because production never had a GSTIN: only a `REGISTERED` stamp is invoiced. `CONSUMER_INVOICEABLE_PAYMENT_WHERE` and `mintConsumerInvoice` (`lib/payments/billing/consumer-invoice.ts`) enforce it for the consumer series, and `rollupOrgInvoiceAccruals` (`lib/payments/billing/invoice-rollup.ts`) and `settle-invoice-accruals` (`jobs/billing/settle-invoice-accruals.ts`) for the organisation series. A credit note needs the original consumer invoice, so such a payment gets no credit note either. **(shipped)**
   - While `PLATFORM_GSTIN` is unset, the GST jobs' `PLATFORM_GSTIN not configured` skips are expected: the daily ops digest lists them as a note and keeps them out of the summary that `/api/health/jobs` reads, so they never page. Once the GSTIN is set, any config skip pages again. **(shipped)**
   - An alarm fires once the financial year's turnover reaches ₹15 lakh (`checkGstRegistrationTurnover`, run once a day by the ops digest while unregistered, so at most one Sentry event a day). Turnover means the full sale value, because the platform is the principal supplier. **(shipped)**
   - The platform registers before crossing ₹20 lakh; registration takes about seven working days with Aadhaar authentication. **(owner action)**
   - Caveat for the record: if the chartered accountant rejects the principal model, registration becomes compulsory from the first rupee.
3. **All-in price display.** Once registered, buyers see prices including GST; while unregistered, the list price is the all-in price. The expert still sets the price before GST. `buyerDisplayPricePaise` (`lib/payments/pricing/display-price.ts`) computes the shown price, `BuyerPriceProvider` in `app/explore/layout.tsx` and `app/checkout/layout.tsx` carries the regime to the client, and the pricing page uses it. Terms section 4.4 (`app/(pages)/terms/page.tsx`) says the price shown is the full amount paid and that it includes GST once the platform is registered. **(shipped)**
4. **Platform codes.** Codes are capped by the shared profitability floor, and refused with `DISCOUNT_NOT_APPLICABLE` on an order whose take cannot fund promo (a fee waiver or a host organisation), without spending a redemption. A fee waiver is never spent on an order that carries a discounting code. The five active seed codes are deactivated, not deleted, through the Supabase SQL gate with the owner approving the statement, because 41 seed payments point at them. **(shipped for the cap; the deactivation is an owner action)**
5. **Profitability floor.** The platform-funded spend on one order (code, welcome discount and credits together) is at most the platform fee minus the estimated gateway cost. The gateway cost is the constant `GATEWAY_COST_BPS = 354`, Razorpay's worst-case rate of 3 % (international cards, Amex, Diners and EMI) plus 18 % GST on that fee. The first value, 236, covered only the 2 % methods, so an order paid by a costlier method could lose money; the floor now holds at the costliest method. One shared function, `platformFundedCapPaise` (`lib/payments/pricing/platform-funded-cap.ts`), computes it for the server, the checkout preview and the discount preview route. **(shipped)**
6. **Stacking.** The base price (the early-bird price inside its window once it exists), plus at most one pre-tax modifier, plus credits after tax under the same cap. A code still suppresses the welcome discount. **(shipped)**
7. **Host coupons (P2).** Host-funded coupons compute the platform fee, the expert's share and the TDS base on the net price. **(planned, post-launch)**
8. **Early-bird (P2).** One optional price with a real deadline per webinar or class plan. People on the waitlist pay the price that is current when they buy. **(planned, post-launch)**
9. **Section 194R.** Own-link rates and fee waivers are price terms of the platform's commission, not perquisites, so 194R does not apply; the chartered accountant confirms. **(no code)**
10. **Minors.** The platform is for people aged 18 and over: a Terms clause, privacy section 8 aligned, an onboarding disclaimer with a confirmation checkbox, and a server-side refusal of an under-18 date of birth. `lib/compliance/age.ts` holds the age rule, and the nullable `User.adultConfirmedAt` is stamped by `claimOnboardingCompletion` (`utils/onboarding-completion.ts`) on the wizard, the gate and the organisation-create paths; the owner runs `db:push`. **(shipped)**
11. **Signal retention.** `Referral.ipHash` and `Referral.userAgent` are nulled 180 days after the referral is terminal and on erasure; `Payment.payerVpaHash` and `Payment.payerPhoneHash` are nulled two years after capture. Both run in the existing `prune-audit-logs` job (`lib/compliance/signal-retention.ts`). A referral that never settles (`SIGNED_UP`, `QUALIFIED`, `QUALIFYING` or `HELD`) has its signals nulled 180 days after `createdAt`. **(shipped)**
12. **Consent artifacts.** The seven-year audit retention from the growth record stays. The basis is proof of consent under DPDP s.6(10) plus the limitation periods; counsel confirms. **(no code)**
13. **Chartered accountant.** The platform waits for its one engaged accountant. The CA pack is prepared in #2231 and a reply is drafted in the existing email thread, never sent by an agent. **(owner action)**
14. **Carry-overs.** #1115 is closed with its evidence, and #2538 (the digital-products toast) lands. The six older UI pull requests and the newsletter smoke row are left as they are. **(owner action)**

## Verified and falsified

**Verified against the code and the live database (2026-11-08 and 2026-11-09).** The pricing order and the invoice Discount row (`lib/pdf/invoice-renderer.tsx`). Every lever is platform-funded on `originalAmount`, and codes were uncapped. `PlatformFeeSchedule` has no approved row, so the own-link rail pays the 20 % fallback today (`readActiveFeeSchedule`, `FALLBACK_BPS`). The WEBINAR10 button on the webinar checkout is a fake code. The become-an-expert page shows only the 20 % rate. Five seed codes are active. No public price says "+ GST". `determineTax` charged 18 % regardless of `PLATFORM_GSTIN`. `Payment` had no regime column. `checkConsent` ignores `version`. The privacy page names Stripe and Neon, and the Terms have no 18+ clause. The signal hashes have no retention. Nothing in the code implements 194R.

**Falsified, with the text to fix.** #2042's claim that the supplier is in Karnataka: the code uses Practitionist (OPC), Haryana, state 06 (`lib/company.ts`). #1711's "flat 20 % today" and its stale paths. The backup-interest purge claimed in `docs/compliance/02-dpdp-and-privacy.md`. Docs that said `TDS_ENGINE` defaults to `LEGACY` or that consultants are withheld at a flat 10 % under 194J: `resolveDueTds` (`lib/payments/payouts/consultant-tds.ts`) defaults to `194O`, and the flat-10 % `calculateTDS` (`lib/payments/tax/tds-service.ts`) has since been deleted along with its two rate constants; this pull request corrects them. ADR 26's "the consumer invoice models do not exist": `ConsumerInvoice` and `ConsumerCreditNote` have shipped.

**Also found while building.** Organisation invoices (`createOrgInvoice`, `rollupOrgInvoiceAccruals`, `generate-subscription-invoices`) computed GST from the registered office's state when no GSTIN was set, so they would have issued GST invoices with no supplier GSTIN; they now refuse or skip while unregistered. The consumer payment page promised that a tax invoice would appear for every payment; a payment stamped `UNREGISTERED` now says it has a receipt instead.

## Roadmap

**P0, before launch.**

1. The GST regime by `PLATFORM_GSTIN`, the regime stamp, the invoice exclusion and the ₹15 lakh alarm (this pull request).
2. The profitability floor and the code cap (this pull request), and the deactivation of the seed codes through the SQL gate.
3. Owner actions: approve the fee schedule; obtain a TAN before the first payout; get the accountant's answer to #2231 question 1 before `ENABLE_LIVE_PAYOUTS`; pin `TDS_ENGINE` and `ENABLE_TDS_194O_GROSS`; name the grievance officer (#2288).
4. Legal copy accuracy and the 18+ gate (the legal-copy pull request).
5. The 1 January 2027 rules: the dark-pattern self-audit and the displayed certificate, due on 31 December (a new issue).

**P1, before launch.** The all-in price display, the WEBINAR10 removal, both rates on become-an-expert and the discount rupee amounts on the payment detail (the price-display pull request); signal retention (the legal-copy pull request); docs, skills and Notion inside each pull request; the #2538 toast.

**P2, after launch.** Host-funded coupons with a `DiscountCodeUse` audit and per-user limits; early-bird prices; codes on digital products and replays; the consent notice-text hash and version check and the breach-lifecycle closure, due before about 13 May 2027 and tracked in #2468.

**P3.** Section 15(3)(b) post-sale discount credit notes on organisation invoices; subscription duration tiers; deleting the dead `lib/compliance/form15.ts`, `dtaa-rates.json` and the s.197 branch.

**Deferred.** IRP e-invoicing until aggregate turnover nears ₹5 crore, LUT exports, s.195 for non-residents, country pricing, an order bump and mixed packages.

**No work.** Section 9(5) and s.52 TCS under the principal model, 194R tracking, Razorpay Offers, a cart, pay-what-you-want and a "statutory monthly grievance report" (that duty falls only on significant social media intermediaries).

## Sources

- Consumer Protection (E-Commerce) (Amendment) Rules, 2026, notified as G.S.R. 789(E) and in force from 1 January 2027: a periodic dark-pattern self-audit with a displayed certificate, and a 30-day prior price shown beside any price reduction.
- Finance Act, 2026, sections 153 and 154, which insert the new CGST s.15(3)(b) for post-sale discounts, in force from 1 November 2026 by Notification 03/2026-Central Tax.
- CBIC Circular 243/37/2024-GST on vouchers, which treats a platform-issued credit as consideration, not a reduction of the taxable value.
- CBDT Circular 12/2022 on section 194R, which excludes sales discounts, rebates and price concessions from the perquisite net.
- CGST Act s.22 (registration above ₹20 lakh aggregate turnover for a services supplier in Haryana), s.24(x) (compulsory registration for a supplier through an operator that must collect TCS under s.52) and s.32 (no person who is not registered may collect any amount by way of tax).

## Consequences

The platform can launch without a GST registration and charge buyers the honest price, while the turnover alarm and the go-live skill keep the registration deadline visible. Orders sold while unregistered, and old orders with no stamp, never get a retroactive tax invoice. Organisation billing waits for the registration. No promotion can make an order lose money, at the cost of smaller welcome discounts and credits than the programme configuration alone would allow: on a ₹1,000 marketplace order the welcome discount is ₹158.22 rather than ₹200.

## Deprecated & Superseded Approaches

- **18 % GST on every domestic order regardless of registration.** `determineTax` used to take no regime input; it now takes `gstRegistered` and returns `UNREGISTERED_S22_THRESHOLD` with no tax while unregistered.
- **Separate per-lever caps.** Discount codes were uncapped, and the welcome discount and credits were held only by the programme's `discountBps`, `discountMaxPaise` and `redemptionCapBps`. Those config caps remain as additional limits under the one shared floor.
- **A flat-percentage consultant TDS calculator.** `calculateTDS` and the `TDS_RATE_WITH_PAN` and `TDS_RATE_WITHOUT_PAN` constants in `lib/payments/tax/tds-service.ts` were deleted; `resolveDueTds` (`lib/payments/payouts/consultant-tds.ts`) decides consultant withholding.
- **A gateway estimate of 2.36 %.** It covered only 2 % payment methods; `GATEWAY_COST_BPS` is now 354.
