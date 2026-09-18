---
title: Dual take rate and no cart
band: 70-design-decisions
audience: sde3
status: accepted
last-reviewed: 2026-09-18
---

# ADR 33 — Dual take rate and no cart

## Context

A 2026-09-18 competitive pass over Topmate, Preplaced, Propeers, SuperProfile, Stan Store, MentorCruise and ADPList, reconciled against `dev` at `e0fe4f6d6` and recorded in #1711, found a contradiction inside our own system: the code charges a flat 20% platform fee (`lib/payments/payouts/constants.ts:11`, read at `lib/payments/payouts/earnings-service.ts:620`), the public `become-an-expert` page renders that same 20% (`app/(pages)/become-an-expert/page.tsx:33,224`), and every go-to-market document says 10% (`docs/sales-marketing/00-master-gtm-strategy.md:62,173,240,245,255,346`, `04-sales-marketing-playbook.md:49`). Topmate, the platform those documents were written against, has itself moved: it now charges 10% on bookings from the expert's own link and 20% on marketplace-sourced bookings, plus a 2% transaction fee on INR (verified 2026-09-18, topmate.io/pricing and the payout-guidelines help article). No platform in the category — Topmate, Stan Store, SuperProfile — has a multi-item cart; the closest is Stan's single order-bump checkbox per product.

## Decision

**Adopt Topmate's dual rate exactly: 10% when the buyer arrives via the expert's own link, 20% when the marketplace sourced the buyer.** The referral-cookie rail already captures a code at landing and applies it at checkout (`app/r/[code]/page.tsx`, `lib/pending-referral.ts`, `lib/referrals/service.ts`); every consultant gets a share link on the same rail, and a payment is `OWN_LINK` when the pending code belongs to the consultant being booked, `MARKETPLACE` otherwise, including explore and search. A repeat purchase from the same expert, with no cookie present, should probably also count as `OWN_LINK` — an expert should not be taxed at the marketplace rate for retaining a client they already won — but this sub-rule is **to confirm** before #1711 item 0 ships, and is not yet decided.

**No multi-item cart.** A buyer-assembled basket would break the one-`Payment`-per-`(userId, appointmentId)` invariant (`prisma/schema.prisma:5342`), the `payment_legs_sum_to_amount` trigger, per-line GST place-of-supply, and per-consultant earnings splits, since a two-expert basket is multi-merchant settlement with two TDS counterparties. Revisit only if PostHog (#378) shows buyers purchasing two items from the same expert in one session.

**No consumer credits wallet.** The org side already has `CREDIT_POOL`; a consumer balance would reopen the #1161/#1347/#1500 class of credit-funded refund problems for a mechanism no consumer competitor sells.

**Packages are a presentation of `SubscriptionPlan` with duration tiers, not a new model.** `SubscriptionPlan.durationInMonths / sessionsPerWeek / totalSessions` and the existing proration path (`lib/payments/operations/cancellation-policy.ts:232-252`) already carry what the category calls a package; only the duration-tier presentation is missing. The mixed-type bundle (sessions plus Priority DM plus a download) stays deferred behind #1135, since a bundle of sessions alone can ship first.

## Consequences

In code, `lib/payments/payouts/constants.ts` moves from a single `PLATFORM_FEE_PERCENTAGE` to a map keyed by attribution source, with the marketplace rate kept as the default; `Payment` gains one nullable enum column recording the source (additive; `ConsultantEarnings.platformFeePaise` already stores the resolved paise, so no earnings-table change); `lib/payments/operations/checkout.ts` stamps the source before the earnings call; and `app/(pages)/become-an-expert/page.tsx` renders both rates. None of this has shipped yet — the code still charges a flat 20% until #1711 item 0 lands.

In docs, the competition and sales-marketing documents now state the dual rate and cite #1711 instead of a flat 10%, and the finance pricing documents record the dual rate as the live decision with the old flat-rate models kept as the marketplace-sourced case.

This decision is reversible on the rate numbers themselves — they are configuration, not schema — but the no-cart and no-wallet decisions are load-bearing for the invariants above and should not be revisited without a corresponding change to the `Payment` and ledger model.

## Sources

Issue #1711; `lib/payments/payouts/constants.ts`; `lib/payments/payouts/earnings-service.ts`; `app/(pages)/become-an-expert/page.tsx`; `app/r/[code]/page.tsx`; `lib/pending-referral.ts`; `lib/referrals/service.ts`; `prisma/schema.prisma`; `lib/payments/operations/cancellation-policy.ts`; topmate.io/pricing (verified 2026-09-18); topmate.io payout-guidelines help article (verified 2026-09-18).
