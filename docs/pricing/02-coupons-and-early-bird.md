---
title: Pricing — Coupons and early-bird (target design)
type: explanation
status: designed-not-active
last-reviewed: 2026-11-09
---

# Coupons and early-bird

This page is the **target design (planned)** for two post-launch pricing features: coupons that an expert or host funds, and one early-bird price per event plan. Nothing here is built. The current behaviour is in the [overview](./00-overview.md); the slot each feature occupies is in [one order, one pipeline](./01-one-order-pipeline.md). The owner decided the rules on 2026-11-09; the decision record is [Tax compliance and pricing levers](../decisions/2026-11-09-tax-compliance-and-pricing-levers.md). The reasons for choosing these levers, and what competitors do, are kept in Notion (Familiarise / Finance).

## Why a second kind of coupon

Today's `DiscountCode` is platform-funded and platform-wide, with no owner and no audit row. An expert who wants to run a promotion on their own plan cannot, and the only way to give a discount is a platform code that costs the platform money. The target is a coupon the **expert funds**: the expert chooses the percentage, the reduction comes out of the expert's side, and the platform never pays for it.

## Host-funded coupons

### The rule

A host-funded coupon changes the **sale price**. Every number that follows is computed on the net price, not on the list price:

- the platform fee is the fee rate times the net price;
- the expert's share is the net price minus that fee;
- GST is charged on the net price;
- the TDS base under section 194-O is the net price.

A ₹1,000 plan with a 10% host coupon sells at ₹900. At the 20% marketplace rate the fee is ₹180 and the expert earns ₹720. The worked example is variant D on the [pipeline page](./01-one-order-pipeline.md). Because the coupon is the one pre-tax modifier, a buyer who holds it gets no welcome discount on the same order.

This is the opposite of a platform code, whose base stays the list price. The two must never be confused in code: a platform-funded reduction keeps `originalAmount` as the earnings base, and a host-funded one lowers it.

### The data

- **A coupon model that names its owner.** It extends or sits beside `DiscountCode` with an owner (the expert's `ConsultantProfile` or a host `Organization`), the plans it covers, a percentage ceiling, a validity window and a use limit. It is created by the owner of the plan, not by SQL.
- **A `DiscountCodeUse` row per use.** One row per redemption, written in the payment transaction, replaces the bare `currentUses` counter as the audit trail and as the source for the counter. A row is voided, not deleted, when a pending payment ends unpaid (the job `returnDiscountUse()` does today for the counter).
- **A per-buyer limit.** A partial unique index on the coupon and the buyer over live uses only (a `WHERE` on the non-voided state, kept in `prisma/sql/` as a sidecar), enforced by the database rather than by a read in application code. Two concurrent checkouts cannot both succeed, and a use voided when its payment ends unpaid frees the slot while its audit row stays.

### Validation

Validation stays server-side and runs twice, as it does now: a preview call for the buyer's screen and an authoritative re-check inside the checkout transaction. The coupon must be active, inside its window, under its use limit, under its per-buyer limit, and for this plan. A failure is a typed error with a buyer-readable message, never a silent fall-through to full price.

## Early-bird price

### The rule

A webinar or class plan may carry **one** optional early-bird price and **one** real deadline. Before the deadline the base price (step 1 of the pipeline) is the early-bird price; after it the base is the normal list price. There is no second tier and no countdown that resets.

- **Waiters pay the current price.** A buyer who joins the waitlist or taps "Notify me" is promised nothing. If they buy after the deadline they pay the list price; if they buy before it, the early-bird price. The checkout seat gate decides who gets a seat, as it does today; pricing never reserves one.
- **The deadline is data, not a timer.** The deadline is a timestamp on the plan. The server decides which price applies when the order is minted, using its own clock, so a buyer cannot extend the window by leaving a tab open and the page cannot show a window the server will not honour.
- **It is the base, not a modifier.** The early-bird price is step 1, so a platform code or the welcome discount can still be the single step 2 modifier on top of it, under the same cap.

### The prior-price rule

From 1 January 2027 the E-Commerce (Amendment) Rules 2026 (G.S.R. 789(E)) apply to consumer-facing sellers. They require that a price shown as reduced also shows a prior price, defined as the lowest price at which the service was offered in the 30 days before the reduction was announced ([PIB, 2026](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2308759&lang=2&reg=48)); and they require a dark-pattern self-audit and a displayed certificate. The compliance docs in `docs/compliance/` hold the legal detail. The consequences for pricing are:

1. A "was" or struck-through price shows the lowest price at which the plan was offered in the preceding 30 days, whether or not anyone bought at it. This needs an offered-price history per plan (every price change with its effective time), which does not exist yet.
2. An early-bird price is therefore stated as "early-bird price until <date>", with the later price named, and never as a discount from an invented higher number.
3. **No fake countdowns and no fake scarcity.** A timer, a "3 seats left" label or a "price rises soon" notice appears only when it reflects a real deadline or a real seat count read from the database.

## Codes on digital products and replays

Digital products and replays call `deriveCheckoutAmount()` without a discount, so a code cannot apply to them today. Enabling codes there means passing the validated code through the digital-product and replay order mints and the matching preview. It is a separate, small change that waits for the coupon model so that it is built once.

## Deprecated & Superseded Approaches

- **A fixed "suggested code" button on checkout.** The checkout pages once showed a one-click code that was not a database row. The only entry point is the generic code input, and a code appears in the interface only as a live row the buyer typed or was sent.
- **An expert-funded reduction implemented as a platform code.** A platform code leaves the expert's earnings on the list price, so giving an expert a "their own" code through the platform tooling would silently make the platform pay. The host coupon above is the replacement and must price the sale net.
