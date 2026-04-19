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

## How experts join an org

EXPERT and LEARNER are **disjoint roles** — a member cannot flip between
them on the same Membership (see `lib/enterprise/role-transitions.ts`).
That boundary removed the in-org "apply to deliver" workflow that used
to live on `Membership.applicationNote / appliedAt / approvedAt /
approvedBy`; those columns were dropped in
`prisma/migrations/20260420100000_drop_membership_application_fields`.

Today there are two entry points to EXPERT membership:

1. **Invitation** — an OWNER/MAINTAINER sends an EXPERT invite; on
   acceptance (`app/api/organizations/invitations/accept/route.ts`) the
   server creates a `Membership` row with `status = ACTIVE`, and
   auto-provisions a `ConsultantProfile` (placeholder `Domain "General"`,
   `scheduleType = WEEKLY`, `verificationStatus = PENDING_VERIFICATION`)
   if the user doesn't already have one. The org EXPERT completes
   their real domain + schedule selection from the consultant profile
   editor, and platform verification still gates their visibility in
   `/explore/experts`.
2. **Direct admin add** — a MAINTAINER posts to
   `POST /api/organizations/[orgId]/members` with `role = EXPERT`. This
   path requires the target user to already have a `ConsultantProfile`.

If the product decides later to bring back an in-org application queue,
build it around a dedicated model (e.g. `ExpertApplication`) rather than
re-adding fields to `Membership` — keeping join state separate from
membership state avoids the LEARNER↔EXPERT ambiguity this refactor
fixed.

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
