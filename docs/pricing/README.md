---
title: Pricing — Index
type: reference
status: live
last-reviewed: 2026-11-09
---

# Pricing

Pricing is everything that decides what a buyer sees, what a buyer is charged and what the platform and the expert keep from one order: the list price, discount codes, the referral welcome discount, referral credits, GST, the platform fee and its waivers. This folder is the subsystem documentation. The checkout mechanics and the ledger stay in [finance](../finance/README.md); this folder explains how the levers fit together and where each one is capped.

Items that are not built yet are marked **(planned)**; the host-funded coupon, the early-bird price and codes on digital products are the only planned levers. The owner's decisions are recorded in [Tax compliance and pricing levers](../decisions/2026-11-09-tax-compliance-and-pricing-levers.md), and the GST registration rules are in [GST registration and the tax regime](../finance/60-tax/05-gst-registration-and-tax-regime.md).

## The pages

| #   | Page                                                     | Type        | Read it to learn                                                                                                                  |
| --- | -------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 00  | [Overview and current state](./00-overview.md)           | explanation | Every pricing lever as it exists today, with the file and function that implement it, and what does not exist yet.                |
| 01  | [One order, one pipeline](./01-one-order-pipeline.md)    | reference   | The five slots every order passes through, who funds each, the "never" rules, and the worked ₹1,000 example in four variants.     |
| 02  | [Coupons and early-bird](./02-coupons-and-early-bird.md) | explanation | The target design for host-funded coupons and the early-bird price **(planned)**, and the rule that keeps a reduced price honest. |
| 03  | [Roadmap](./03-roadmap.md)                               | reference   | Every pricing item with its priority, whether it is pre-launch or post-launch, and the check that closes it.                      |

## What is not in this repository

The repository holds mechanisms, invariants, configuration field names and the terms a user sees on screen. The reasons for the chosen price levels, the unit economics and the competitor coupon practice are kept in the owner's Notion workspace: value kept in Notion (Familiarise / Finance and Pricing / 09 Pricing Strategy). A page here that needs one of those values says so instead of stating it.

## Related documents

- [Checkout and pricing](../finance/10-money-in/01-checkout-and-pricing.md) for how `handleCheckout` commits an order.
- [Referrals](../referrals/00-overview.md) and the [referral credits ledger](../finance/20-ledger/07-referral-credits.md).
- [Rate cards and overage](../finance/50-b2b/03-rate-cards-and-overage.md) for host-organisation splits.
- The [finance skill](../../.claude/skills/finance/SKILL.md) and the [growth skill](../../.claude/skills/growth/SKILL.md).

## Deprecated & Superseded Approaches

- **A flat 20% platform fee as the only rate.** The fee was one constant (`PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE`). It is now the fallback inside `readActiveFeeSchedule`, used only while no `PlatformFeeSchedule` row is approved; the `/pricing` and `/become-an-expert` pages read the schedule, not the constant. New code reads the schedule, never the constant.
- **Suggested discount codes written into the checkout pages.** The webinar, class and subscription checkout pages advertised codes (`WEBINAR10`, `CLASS15`, `SUB20`) that were never rows in `DiscountCode`. They are removed; the generic code input is the only entry point. Do not add a suggested-code row for a code that is not a live database row.
