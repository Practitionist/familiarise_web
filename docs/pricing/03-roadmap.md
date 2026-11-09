---
title: Pricing — Roadmap
type: reference
status: live
last-reviewed: 2026-11-09
---

# Pricing roadmap

Every pricing item with its priority and phase. Priority runs P0 (blocks launch) to P4 (nice to have); BS means an owner step with no code, and defer means do nothing until a trigger appears. The launch target is before 1 January 2027, with January to March 2027 as the fallback. Anything with a 1 January 2027 legal date is therefore P0 and due on 31 December. "Done when" is the check that closes the item. Prices, rates and the reasoning behind them are never written here: value kept in Notion (Familiarise / Finance).

## Pre-launch

| #   | Item                                                                                                                        | Priority | Phase      | Status                                        | Done when                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | GST regime derived from `PLATFORM_GSTIN`, a regime stamp on each payment, the invoice healer skipping unregistered payments | P0       | pre-launch | shipped in the tax-regime pull request        | A ₹1,000 checkout charges ₹1,000 with `PLATFORM_GSTIN` unset and ₹1,180 with it set.           |
| 2   | One profitability floor over codes, the welcome discount and credits; deactivate the seed codes                             | P0       | pre-launch | shipped; the owner approves the seed-code SQL | A promo order's platform margin is at least zero in the invariant test.                        |
| 3   | Approve the `PlatformFeeSchedule` row so the own-link rate takes effect                                                     | BS       | pre-launch | owner step                                    | `readActiveFeeSchedule()` returns a non-null `id`.                                             |
| 4   | The 1 January 2027 consumer rules: dark-pattern self-audit, a displayed certificate and the prior-price display             | P0       | pre-launch | open issue, due 31 December                   | The certificate page is live and the audit record exists.                                      |
| 5   | All-in buyer price on every plan card, explore card, expert page, plan page and digital-product and replay card             | P1       | pre-launch | shipped in the price-display pull request     | With `PLATFORM_GSTIN` set, every buyer price reads "incl. GST" and equals the checkout charge. |
| 6   | Remove the fake suggested codes from the checkout pages                                                                     | P1       | pre-launch | shipped in the price-display pull request     | `rg -n "WEBINAR10\|CLASS15\|SUB20" app` finds nothing.                                         |
| 7   | Both platform rates on `become-an-expert`, read from the active schedule                                                    | P1       | pre-launch | shipped in the price-display pull request     | The page's rates equal `readActiveFeeSchedule()`.                                              |
| 8   | The rupee discount and the welcome discount on the buyer's payment detail                                                   | P1       | pre-launch | shipped in the price-display pull request     | A payment with a code shows the code and the rupees it took off.                               |
| 9   | Discount-code refusals shown inline in the code field, never as a toast                                                     | P1       | pre-launch | shipped in the price-display pull request     | A refused code shows its reason under the input and stays until the code is edited.            |
| 10  | Checkout summary rows show paise when the amount is not a whole rupee                                                       | P1       | pre-launch | shipped in the price-display pull request     | The total on screen equals the gateway charge to the paisa.                                    |
| 11  | One shared checkout shell for the four plan types                                                                           | P1       | pre-launch | shipped in the price-display pull request     | The four route files are thin wrappers over `PlanCheckoutShell`.                               |

## Post-launch

| #   | Item                                                                            | Priority | Phase       | Status     | Done when                                                                                                  |
| --- | ------------------------------------------------------------------------------- | -------- | ----------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| 12  | Host-funded coupons with fee, expert share and TDS on the net price             | P2       | post-launch | open issue | The pipeline page's variant D reproduces in a test.                                                        |
| 13  | A `DiscountCodeUse` audit row and a per-buyer limit enforced by the database    | P2       | post-launch | open issue | A second live redemption by the same buyer fails on the partial unique index; a voided use frees the slot. |
| 14  | One early-bird price and a real deadline per webinar or class plan              | P2       | post-launch | open issue | An order minted after the deadline is charged the list price.                                              |
| 15  | Discount codes on digital products and replays                                  | P2       | post-launch | open issue | A code applied to a digital product reduces the charge in the preview and at the mint.                     |
| 16  | Post-sale discounts as credit notes on organisation invoices (section 15(3)(b)) | P3       | post-launch | open issue | A post-sale discount produces a credit note that reduces the taxable value.                                |
| 17  | Subscription duration tiers                                                     | P3       | post-launch | open issue | A longer subscription term lists a lower per-month price from one plan.                                    |

## Deferred and not planned

- **Deferred:** e-invoicing and the invoice registration portal until turnover nears ₹5 crore; a letter of undertaking for exports; country-based pricing; an order bump; mixed packages.
- **Not planned:** a cart, pay-what-you-want, platform-run payment-gateway offers, and any fake urgency.

## Deprecated & Superseded Approaches

- **Treating the profitability floor as a per-feature cap.** Earlier drafts capped the welcome discount and credits by the take rate and left codes uncapped. Item 2 replaces that with one shared function; do not extend the old per-lever caps.
- **A pricing roadmap kept in the growth roadmap.** Referral reward mechanics stay in [the growth roadmap](../growth/05-roadmap.md). This page owns only the levers that change what an order costs.
