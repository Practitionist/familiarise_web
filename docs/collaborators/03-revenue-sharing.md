# Collaborator Revenue Sharing — Detailed Guide

## Overview

When a service (webinar or class) has accepted collaborators, payments for that service are split among all parties. The platform takes its 20% fee from each party's share independently.

---

## Rules

| Rule                              | Value                           | Enforcement                                               |
| --------------------------------- | ------------------------------- | --------------------------------------------------------- |
| Minimum host share                | 10%                             | Validated at invite time: total collaborator shares ≤ 90% |
| Maximum single collaborator share | 90%                             | By extension of the above rule                            |
| Platform fee                      | 20% of each party's gross share | Applied independently per earning                         |
| Host share calculation            | 100% - sum(collaborator shares) | Automatic remainder                                       |

---

## Revenue Split Calculation

### Formula

```
For a payment of amount P with N collaborators:

  collaborator_i_gross = P * (collaborator_i_share / 100)
  collaborator_i_fee   = collaborator_i_gross * 0.20
  collaborator_i_net   = collaborator_i_gross - collaborator_i_fee

  total_collab_share   = sum(all collaborator share percentages)
  host_share_pct       = 100 - total_collab_share
  host_gross           = P * (host_share_pct / 100)
  host_fee             = host_gross * 0.20
  host_net             = host_gross - host_fee
```

### Example

**Setup**: Webinar priced at ₹1,000. Two collaborators accepted:

- Co-Host A: 25% share
- Moderator B: 15% share
- Host gets remainder: 100% - 25% - 15% = 60%

```
┌──────────────────────────────────────────────────────────────┐
│                    REVENUE SPLIT                              │
│                    Total: ₹1,000                             │
├──────────────┬──────────┬──────────┬──────────┬─────────────┤
│ Party        │ Share %  │ Gross    │ Fee (20%)│ Net Payout  │
├──────────────┼──────────┼──────────┼──────────┼─────────────┤
│ Host         │ 60%      │ ₹600     │ ₹120     │ ₹480        │
│ Co-Host A    │ 25%      │ ₹250     │ ₹50      │ ₹200        │
│ Moderator B  │ 15%      │ ₹150     │ ₹30      │ ₹120        │
├──────────────┼──────────┼──────────┼──────────┼─────────────┤
│ TOTAL        │ 100%     │ ₹1,000   │ ₹200     │ ₹800        │
└──────────────┴──────────┴──────────┴──────────┴─────────────┘

Platform revenue: ₹200 (20% of ₹1,000)
```

---

## Validation Logic

### At Invitation Time

```typescript
// lib/collaborators/service.ts — validateRevenueShares()

function validateRevenueShares(
  planType: "webinar" | "class",
  planId: string,
  newSharePercentage: number,
  excludeCollaboratorId?: string, // For updates
): boolean {
  // 1. Get all active collaborators (PENDING + ACCEPTED, excluding removed/declined)
  const existing = getCollaborators(planType, planId)
    .filter((c) => c.status === "PENDING" || c.status === "ACCEPTED")
    .filter((c) => c.id !== excludeCollaboratorId);

  // 2. Sum existing shares
  const existingTotal = existing.reduce(
    (sum, c) => sum + c.revenueSharePercentage,
    0,
  );

  // 3. Check: existing + new ≤ 90%
  return existingTotal + newSharePercentage <= 90;
}
```

**Why PENDING counts**: If a collaborator is invited with 25% but hasn't responded yet, that 25% is reserved. Otherwise the host could over-allocate by inviting multiple people whose shares overlap.

### Revenue Split Preview

```typescript
// lib/collaborators/service.ts — calculateRevenueSplit()

function calculateRevenueSplit(
  planType: "webinar" | "class",
  planId: string,
  totalAmount: number,
) {
  const collaborators = getAcceptedCollaborators(planType, planId);
  const PLATFORM_FEE_RATE = 0.2;

  const totalCollabShare = collaborators.reduce(
    (sum, c) => sum + c.revenueSharePercentage,
    0,
  );
  const ownerSharePct = 100 - totalCollabShare;

  const splits = [
    // Owner
    {
      role: "OWNER",
      sharePercentage: ownerSharePct,
      grossAmount: Math.round((totalAmount * ownerSharePct) / 100),
      platformFee: Math.round(
        ((totalAmount * ownerSharePct) / 100) * PLATFORM_FEE_RATE,
      ),
      netAmount: Math.round(
        ((totalAmount * ownerSharePct) / 100) * (1 - PLATFORM_FEE_RATE),
      ),
    },
    // Collaborators
    ...collaborators.map((c) => ({
      role: "COLLABORATOR",
      sharePercentage: c.revenueSharePercentage,
      grossAmount: Math.round((totalAmount * c.revenueSharePercentage) / 100),
      platformFee: Math.round(
        ((totalAmount * c.revenueSharePercentage) / 100) * PLATFORM_FEE_RATE,
      ),
      netAmount: Math.round(
        ((totalAmount * c.revenueSharePercentage) / 100) *
          (1 - PLATFORM_FEE_RATE),
      ),
    })),
  ];

  return splits;
}
```

---

## ConsultantEarnings Records

### Before Collaborators (1:1)

```
Payment ──── 1:1 ──── ConsultantEarnings
                       role: OWNER
                       sharePercentage: 100
                       paymentId: UNIQUE
```

### After Collaborators (1:many)

```
Payment ──── 1:many ──── ConsultantEarnings[]
                          ├── role: OWNER,        share: 60%
                          ├── role: COLLABORATOR,  share: 25%
                          └── role: COLLABORATOR,  share: 15%
                          paymentId: INDEX (not unique)
```

### Migration Impact

The `@unique` constraint on `paymentId` was removed. This was the riskiest schema change because every location in the codebase that accessed `payment.earnings` (singular) needed to be updated to handle `payment.earnings[]` (array).

**Affected files**:

- `lib/payments/payouts/earnings-service.ts` — `refundEarnings()` now uses `findMany` + iterates
- `scripts/refunds/cascade-refund-earnings.ts` — Array iteration
- `scripts/disputes/handle-lost-disputes.ts` — Array iteration
- `scripts/earnings/sync-payment-earnings.ts` — `{ none: {} }` instead of `null`

---

## Payout Processing

Each `ConsultantEarnings` record is processed independently by the existing payout system:

1. **Hold period**: All earnings have a `holdUntil` date (typically 7 days after payment)
2. **Batch grouping**: Payouts are grouped by `consultantProfileId` — so each consultant gets their own payout
3. **No cross-dependency**: Host's payout is independent of collaborator payouts

```
Payout Batch Run:
  ├── Consultant A (Host):
  │    ├── Earning from Webinar 1 (OWNER, 60%, ₹480)
  │    ├── Earning from Webinar 2 (OWNER, 100%, ₹800)
  │    └── Total payout: ₹1,280
  │
  ├── Consultant B (Collaborator):
  │    ├── Earning from Webinar 1 (COLLABORATOR, 25%, ₹200)
  │    └── Total payout: ₹200
  │
  └── Consultant C (Collaborator):
       ├── Earning from Webinar 1 (COLLABORATOR, 15%, ₹120)
       └── Total payout: ₹120
```

---

## Earnings Dashboard

The consultant earnings dashboard now shows a "Role" column:

| Date   | Service       | Role         | Share | Gross | Fee  | Net  | Status  |
| ------ | ------------- | ------------ | ----- | ----- | ---- | ---- | ------- |
| Feb 10 | React Webinar | Owner        | 60%   | ₹600  | ₹120 | ₹480 | Pending |
| Feb 10 | React Webinar | Collaborator | 25%   | ₹250  | ₹50  | ₹200 | Pending |

Role badges:

- **Owner** — Zinc/gray badge
- **Collaborator** — Purple badge with percentage (e.g. "Collaborator (25%)")

---

## Edge Cases

| Scenario                                  | Behavior                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| No collaborators accepted                 | Standard 1:1 earnings (role: OWNER, share: 100%)                          |
| Collaborator removed after payment        | Existing earnings for past payments remain; future payments use new split |
| Collaborator declined after being pending | Share freed up, no earnings created                                       |
| Rounding errors                           | `Math.round()` applied to each share; total may differ by ±1 paise        |
| Free service (price = 0)                  | No earnings created for anyone                                            |
| Refund on collaborative service           | All earnings (owner + collaborators) refunded                             |
