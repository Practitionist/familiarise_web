# Expert lifecycle

EXPERT is the `MemberRole` value for anyone who delivers services on
behalf of an org (`canHost=true`). It replaces the pre-Arch-4 term
"Consultant" in the org-side vocabulary. The underlying
`ConsultantProfile` model is unchanged — the rename lives in the org
layer so logs and UI don't have to disambiguate platform consultants
from org experts.

## Prerequisites

An expert can only join an org whose `canHost = true`. The API
refuses EXPERT membership on sponsor-only orgs at
`POST /api/organizations/[orgId]/members` — the body's `role = EXPERT`
is rejected when the organization's capability booleans don't support
hosting.

Each expert still owns a personal `ConsultantProfile` on the platform.
The `Membership.consultantProfileId` foreign key links to that
profile, so the org side can read the expert's domain, reviews, and
availability without duplicating data.

## Application workflow

When an org is configured with
`Organization.autoApproveConsultants = false` (the default), an expert
applies rather than being added directly:

1. The expert clicks "Apply to join" on the org's public page.
2. The server inserts a `Membership` row with:
   - `role = EXPERT`
   - `status = PENDING`
   - `appliedAt = now()`
   - `applicationNote = <free-form text>`
3. OrgAuditLog row emitted in the `MEMBER` category, action
   `EXPERT_APPLIED` (from `lib/enterprise/audit-actions.ts`).
4. A MAINTAINER approves or rejects via
   `PATCH /api/organizations/[orgId]/members/[memberId]`:
   - Approve → `status = ACTIVE`, `approvedAt = now()`,
     `approvedBy = <approver Membership.id>`.
   - Reject → `status = REMOVED`. The row is retained so re-application
     has a paper trail.
5. Approval/rejection emits `EXPERT_APPROVED` or `EXPERT_REJECTED`.

If `autoApproveConsultants = true`, the Membership is created directly
with `status = ACTIVE` and the EXPERT_APPROVED action is logged
automatically.

## `PayoutRecipient`

Every EXPERT membership carries `payoutRecipient: PayoutRecipient`:

```prisma
enum PayoutRecipient {
  SELF          // default marketplace case — expert keeps their share
  ORGANIZATION  // internal/salaried expert — org captures the share
}
```

The column is stored on `Membership`, not on the `ConsultantProfile`,
because the same expert can belong to two orgs with different
arrangements (a freelancer earning independently at one org and
salaried at another).

Settlement reads `payoutRecipient` at booking time:

- `SELF` — the expert's share lands in `ConsultantEarnings` and flows
  to the expert's own payout pipeline.
- `ORGANIZATION` — the expert's share is added to `OrganizationEarnings`
  and disappears from the expert's books for that booking. The org's
  `OrganizationPayout` cycle pays the expert separately through its
  own payroll.

`payoutRecipient` is set when the MAINTAINER approves the application
(MAINTAINER-editable), and may be flipped later via PATCH on the
member row. Flipping it mid-cycle does not retroactively rewrite
already-booked earnings (those carry the bps snapshot and their own
recipient decision).

## Rate-card overrides

`Membership.rateCardOverrideId` points at an optional per-expert
`RateCard`. When present, the rate-card resolver uses it at position 1
in the override chain (see `03-earnings-and-revenue.md`). Use cases:

- A star expert negotiates a 90/10 split instead of the default 80/20.
- An internal expert with `payoutRecipient = ORGANIZATION` gets a
  platform-only card (100 bps platform, 9900 bps org, 0 bps expert)
  so the split math still validates.

## Removal

`DELETE /api/organizations/[orgId]/members/[memberId]` sets
`status = REMOVED` and emits `MEMBER_REMOVED`. The `Membership` row is
retained — it back-references earnings (via
`OrganizationEarnings.orgPayoutId` chains to the expert's bookings) and
deleting it would orphan the audit trail.

An EXPERT's platform `ConsultantProfile` is untouched by org removal.
They continue to operate as an independent marketplace expert.

## `isIndependent` flag on `ConsultantProfile`

`ConsultantProfile.isIndependent: Boolean @default(true)` denotes that
a profile has no active EXPERT membership. Maintained by the membership
write path — when an expert's first ACTIVE membership lands, the flag
flips to false; when the last one is removed, it flips back to true.

The explore surface reads this flag to decide whether to render the
"hosted by <org>" badge on an expert card.

## Related docs

- `03-earnings-and-revenue.md` — rate-card resolution and the
  `payoutRecipient` fork.
- `04-roles-and-permissions.md` — where EXPERT sits on the rank ladder.
- `07-payout-pipeline.md` — how EXPERT earnings reconcile.
- `11-public-pages-and-discovery.md` — how the explore surface surfaces
  org-hosted experts.
