# Competitive commerce verdict of 2026-09-18: what bundles, digital products and a cart would cost us

**Date:** 2026-09-18 · **Scope:** docs only; no code changed here. Follow-up work is tracked in #1711.

A competitive pass over Topmate, Preplaced, Propeers, SuperProfile, Stan Store, MentorCruise and ADPList, reconciled against `dev` at `e0fe4f6d6`, answered one question: do we need bundles, digital products and a cart, and what should the value proposition be. Every external fact was read on the competitor's own page unless marked third-party; the full dated report is filed locally and untracked, same as the other audits. The answer is recorded as #1711 and as ADR 33.

## The four decisions

The platform adopts a dual take rate — 10% on bookings from the expert's own link, 20% on marketplace-sourced bookings — which is exactly Topmate's current pricing and resolves a live contradiction between the code's flat 20% (`lib/payments/payouts/constants.ts:11`), the public `become-an-expert` page, and every go-to-market document's 10%. The platform will not build a multi-item cart, because no competitor in the category has one and a buyer-assembled basket would break the one-`Payment`-per-appointment invariant, the payment-legs sum trigger, per-line GST, and per-consultant earnings splits. The platform will not build a consumer credits wallet, because it would reopen the credit-funded refund problems the org side already lives with, for a mechanism no consumer competitor sells. A mixed-type bundle of sessions, Priority DM, and downloads stays deferred behind #1135, because a sessions-only package can ship first as a duration-tiered presentation of the existing `SubscriptionPlan`.

## Docs corrected

`docs/competition/00-executive-summary.md`, `01-threat-matrix.md`, `03-feature-battlecard.md`, `04-pricing-strategy.md`, `competitors/01-topmate-io.md`, `docs/sales-marketing/00-master-gtm-strategy.md`, `04-sales-marketing-playbook.md`, and `docs/finances/09-pricing-strategy.md` and `02-revenue-distribution.md` all carried stale claims: Topmate as Stripe-only with no UPI, an effective 16-18% take rate, and SuperProfile's "₹99 flat, zero commission" line, none of which survive the 2026-09-18 review. SuperProfile's own pricing page returned an HTTP 429 during the review, so its fee figures are marked third-party throughout rather than corrected to a single number.

## Now tracked in #1711

The attribution logic that reads a `Payment`'s source and charges the right rate (item 0), the duration-tiered package presentation of `SubscriptionPlan` (item 1), the three amendments to #1135's digital-product design (item 2), the order-bump checkout (item 3), consultant-owned coupons (item 4), country-based pricing (item 5), and payer-differs-from-consumer purchases (item 6) are all ranked by revenue impact against build cost in the issue.

## Open sub-rule

Whether a repeat purchase from the same expert, with no referral cookie present, should count as `OWN_LINK` is **not yet decided**. The argument for yes is that an expert should not be taxed at the marketplace rate for retaining a client they already won; this needs to be confirmed and written into `docs/finances/` before #1711 item 0 ships.
