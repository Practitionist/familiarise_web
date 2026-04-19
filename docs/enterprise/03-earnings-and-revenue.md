# Earnings and revenue

Every booking on the host side produces an `OrganizationEarnings` row
and (independently) a `ConsultantEarnings` row. The split is driven by
a `RateCard` resolved at booking time, not at settlement time — a
retroactive rate change must not rewrite history.

## `RateCard` (schema.prisma)

```prisma
model RateCard {
  id              String           @id @default(uuid())
  ownerOrgId      String?
  ownerContractId String?
  ownerContract   Contract?        @relation("RateCardOwnerContract", ...)
  planType        CoveredPlanType?  // null = any
  planId          String?           // null = any

  minGrossPaise   Int?
  maxGrossPaise   Int?

  // Basis points (sum must equal 10000). Integer math; no float drift.
  platformBps   Int
  orgBps        Int
  consultantBps Int

  effectiveFrom DateTime  @default(now())
  effectiveTo   DateTime?
  ...
}
```

Two scoping columns (`ownerOrgId`, `ownerContractId`) let rate cards
live at either the org level (default across every contract) or at the
contract level (negotiated per-customer split). A card never belongs to
both: only one of the owners is set.

## Time-scoped rate changes

A rate change is **never** modelled as an UPDATE to an existing
`RateCard`. Instead:

1. The previous card is closed by setting `effectiveTo = now()`.
2. A new card is inserted with `effectiveFrom = now()`.

Both operations run in the same Prisma transaction, via
`bumpRateCard()` in `lib/api/organizations/rate-card.ts`. This keeps
the historical `(platformBps, orgBps, consultantBps)` triple queryable
at any instant: the settlement path for a booking that happened
yesterday finds the card where
`effectiveFrom <= booking.createdAt < effectiveTo` — even if the live
card has since been bumped.

## Resolution order

`resolveEffectiveRateCard()` in `lib/api/organizations/rate-card.ts`
walks the override chain from most-specific to least:

1. `Membership.rateCardOverride` — a per-expert override, set when an
   internal/salaried expert negotiates a different split.
2. Contract-scoped card that also matches the plan's `planId`.
3. Org-scoped card that also matches the plan's `planId`.
4. Contract-scoped card for the `CoveredPlanType` (plan-agnostic).
5. Org-scoped card for the `CoveredPlanType`.
6. Contract-scoped default (planType=null, planId=null).
7. Org-scoped default (planType=null, planId=null).
8. Hardcoded `DEFAULT_RATE_CARD` = 10% / 10% / 80% (platform / org /
   expert). `rateCardId = null` on the result is the sentinel the
   downstream code uses to mean "no RateCard applied; defaults were
   used".

## bps snapshot fields

Both earnings tables carry snapshot columns so later rate changes
cannot retroactively rewrite an earnings row:

```prisma
model OrganizationEarnings {
  rateCardIdApplied    String?
  platformBpsApplied   Int?
  orgBpsApplied        Int?
  consultantBpsApplied Int?
  ...
}

model BookingUtilization {
  platformBpsAtBooking   Int?
  orgBpsAtBooking        Int?
  consultantBpsAtBooking Int?
  ...
}
```

Settlement and payout code always reads from the `*Applied` /
`*AtBooking` columns. The live `RateCard` row is *never* consulted
during payout generation — that's the whole point of keeping snapshots.

## The bps invariant

`platformBps + orgBps + consultantBps === 10000` on every row. The
invariant is not enforced by a Postgres CHECK constraint in v1 (follow-up
PR); it is enforced at the creation site by `bumpRateCard()` and by the
POST handlers in `app/api/organizations/[orgId]/rate-cards/route.ts`.

## Default split

```
Platform: 10% (1000 bps)
Org:      10% (1000 bps)
Expert:   80% (8000 bps)
```

The org-vs-expert split is a negotiable number — the default is what
self-service orgs get until an OWNER inserts a bump via
`POST /api/organizations/[orgId]/rate-cards`.

## `PayoutRecipient` interaction

`Membership.payoutRecipient` toggles whether the expert or the org
receives the expert-share leg:

- `SELF` (default, marketplace case) — `consultantSharePaise` is booked
  to `ConsultantEarnings` for the expert's own payout pipeline.
- `ORGANIZATION` — the expert is internal/salaried; the expert-share
  leg is *also* booked against the org, collapsing the three-way split
  into a two-way (platform + org) flow for that booking.

See `07-payout-pipeline.md` for the downstream reconciliation and
`06-expert-lifecycle.md` for how an org flips an expert to
`ORGANIZATION` on approval.

## Related docs

- `06-expert-lifecycle.md` — how experts join the host-side flow.
- `07-payout-pipeline.md` — how earnings roll up into payouts.
- `15-concurrency-and-locking.md` — atomic rate-card bump pattern.
- `19-harness-verdict.md` — the scenarios that exercise the
  rate-card resolver.
