# Roles and permissions

Every membership row carries a typed `MemberRole`. The enum is unified —
there is exactly one role namespace, with values chosen to avoid any
collision with the platform-level `UserRole` enum.

## `MemberRole` (schema.prisma)

```prisma
enum MemberRole {
  OWNER
  MAINTAINER
  BILLING_ADMIN
  MANAGER
  EXPERT
  LEARNER
  SUPPORT
}
```

Prisma comments on the enum call out why the names differ from the
intuitive ones:

- `MAINTAINER` was `ADMIN`. Renamed to avoid collision with
  `UserRole.ADMIN` (platform admin).
- `BILLING_ADMIN` is the finance-team role added by PR #655 (May 2026).
  Sits between `MAINTAINER` and `MANAGER` on the rank ladder; gates
  financial routes via the dedicated `requireOrgBillingAdminOrOwner`
  helper rather than a rank comparison (see below).
- `EXPERT` was `CONSULTANT`. Renamed to avoid collision with
  `UserRole.CONSULTANT` (platform consultant user).
- `LEARNER` chosen over `MEMBER` for an explicit "receives sessions"
  semantic.

## Rank ladder

`lib/auth/role-ranks.ts` exports `ORG_ROLE_RANK`:

| Role            | Rank | Typical responsibility |
|-----------------|------|-------------------------|
| `OWNER`         | 100  | Everything: billing, contracts, payouts, settings, SSO, org delete. |
| `MAINTAINER`    | 80   | Members, invites, plans, programs, contracts (read), branding/identity fields, settings. **No billing, no deletion** — and SSO / domain-claims / capability + tax fields stay OWNER-only (see `MEMBER_ROLE_DESCRIPTION` in `lib/labels/org-labels.ts`: _"Members, plans, programs, and settings. No billing or deletion."_). |
| `BILLING_ADMIN` | 70   | Invoices, POs, payouts, rate cards, wallet top-ups, outbound webhooks. **No member or SSO changes.** |
| `MANAGER`       | 60   | Team analytics, seat management, read-only views of invoices/earnings/payouts/rate-cards. |
| `EXPERT`        | 40   | Delivers services on behalf of the org. |
| `SUPPORT`       | 30   | Views support tickets and assists members. No billing. |
| `LEARNER`       | 20   | Consumes services through the org's programs. |

`isAtLeastRole(actual, minimum)` (`lib/auth/role-ranks.ts`) returns
`ORG_ROLE_RANK[actual] >= ORG_ROLE_RANK[minimum]`.

### How a request resolves to allow / deny

A new dev's first question is "given a role and a route, what actually
decides?" Three mechanisms, applied per route family. The flowchart traces an
org-scoped request through all three:

```mermaid
flowchart TD
  REQ["request hits<br/>app/api/organizations/[orgId]/**"] --> AUTH{authenticated<br/>+ ACTIVE member?}
  AUTH -- no --> D401["401 / 403<br/>(not a live member)"]
  AUTH -- "yes (or ADMIN stub)" --> KIND{route family?}

  KIND -- "most routes" --> RANK["requireOrgAccess(minRole)<br/>rank: RANK[actual] >= RANK[min]"]
  RANK --> RANKOK{passes?}
  RANKOK -- yes --> OK["✅ handler runs"]
  RANKOK -- no --> D403R["403 INSUFFICIENT_ROLE"]

  KIND -- "whole-surface financial<br/>(billing-account, payouts,<br/>invoices, POs, rate-cards,<br/>webhooks, data-exports)" --> DISJ["requireOrgBillingAdminOrOwner<br/>LEARNER floor → then disjunction"]
  DISJ --> DISJOK{role == OWNER<br/>OR BILLING_ADMIN?}
  DISJOK -- yes --> OK
  DISJOK -- "no (incl. MAINTAINER!)" --> D403B["403 BILLING_ADMIN_OR_OWNER_REQUIRED"]

  KIND -- "org PATCH<br/>(mixed-field row)" --> FIELD["field allowlist per touched key"]
  FIELD --> FOWNER{role == OWNER?}
  FOWNER -- yes --> OK
  FOWNER -- no --> FALLOW{every touched field<br/>in caller's set?<br/>MAINTAINER_FIELDS ∪<br/>BILLING_ADMIN_FIELDS}
  FALLOW -- yes --> OK
  FALLOW -- no --> D403F["403 FIELD_RBAC_FORBIDDEN<br/>(names offending fields)"]
```

The load-bearing subtlety lives in the two right-hand branches: a
higher-ranked `MAINTAINER` is **denied** on the financial branch (it's not
`OWNER`/`BILLING_ADMIN`) and **excluded from billing fields** on the PATCH
branch (`billingEmail` / `paymentTermsDays` aren't in `MAINTAINER_FIELDS`).
Rank alone never reaches the finance surface.

### Why BILLING_ADMIN uses a disjunction gate, not a rank gate

A naïve `requireOrgAccess(orgId, { minimumRole: "BILLING_ADMIN" })`
would let `MAINTAINER` (rank 80) through on the rank comparison —
which is wrong, because `MAINTAINER` explicitly does not have billing
rights per the role description. The two roles are
governance-orthogonal: `MAINTAINER` is the org-admin surface,
`BILLING_ADMIN` is the finance surface.

The dedicated helper `requireOrgBillingAdminOrOwner` at
`lib/auth/billing-admin-gate.ts` encodes this. It first runs
`requireOrgAccess` with a `LEARNER` floor (so capability checks like
`canSponsor` still run), then applies the load-bearing role disjunction:

```ts
const role = access.member.role;
if (role !== "OWNER" && role !== "BILLING_ADMIN") {
  return {
    error: NextResponse.json(
      { error: "Forbidden", code: "BILLING_ADMIN_OR_OWNER_REQUIRED" },
      { status: 403 },
    ),
  } as const;
}
```

It deliberately does NOT pass `minimumRole: "BILLING_ADMIN"`, because that
would let `MAINTAINER` (rank 80) through on the rank comparison. Pin-down
regression: `__tests__/enterprise/billing-admin-gate.test.ts` asserts that
`MAINTAINER` is **denied** even though its rank is higher.

### Design story: why rank-70 touches billing that rank-80 cannot

This looks upside-down the first time you see it: `BILLING_ADMIN` (rank 70)
can PATCH the wallet and cut payouts, while `MAINTAINER` (rank 80) — *higher*
on the ladder — gets a 403 on those exact routes. It is deliberate, and the
reasoning is recorded in `lib/auth/billing-admin-gate.ts`:

> _"The two roles are governance-orthogonal: one is the org-admin surface,
> the other is the finance surface. A rank-based gate would conflate them.
> Hence the explicit disjunction here."_

The driver (from `MEMBER_ROLE_DESCRIPTION` in `lib/labels/org-labels.ts`):
large orgs delegate AP/GL to a finance team that needs invoice + payout +
rate-card + wallet rights **without** the ability to touch SSO, the member
roster, or org status. So the ladder ranks `BILLING_ADMIN` *above* `MANAGER`
(it has more financial privilege) but *below* `MAINTAINER` on the org-admin
axis — and the rank number is then **never used** to gate billing. Billing
routes use the OWNER ∨ BILLING_ADMIN disjunction; SSO/member routes gate at
`MAINTAINER`+ and so auto-deny `BILLING_ADMIN`. The two surfaces don't
overlap by construction.

`BILLING_ADMIN` was added by **PR #655** (the enterprise foundation; the gate
helper was wired in `f7133eaa`). The regression that pins the counter-intuitive
half down is `__tests__/enterprise/billing-admin-gate.test.ts`, which asserts
`MAINTAINER` is denied **despite** its higher rank — if someone "simplifies"
the gate to `minimumRole: "BILLING_ADMIN"` later, that test goes red.

**Who holds what at Wipro (seeded `wipro` org).** A concrete read of the three
operator tiers:

| Role | At Wipro | Sees / can do |
|------|----------|----------------|
| `OWNER` | the corporate-ops admin who created the org (the seeded `tour-owner@familiarise.dev` is an OWNER of `wipro`) | everything — capability flips, GSTIN/PAN, SSO, member roster, delete, **and** all billing |
| `BILLING_ADMIN` | a hypothetical AP clerk in Wipro's finance team | the ₹50L PO, the draft `INV-WIP-2026-0001`, NET-60 terms, rate cards, wallet — but **not** the member roster or SSO |
| `MANAGER` | a hypothetical L&D lead running the Engineer Leadership Program | team analytics, seat management, **read-only** views of invoices/earnings/payouts — no money mutation, no roster changes |

(Wipro is seeded with one OWNER membership + three LEARNERs; the
BILLING_ADMIN and MANAGER rows above are illustrative — the seed doesn't
populate every operator tier, but the gate matrix below applies the moment
one is invited.)

### Two enforcement shapes: route-level gate vs field-level gate

There are two distinct mechanisms, and both are live:

1. **Route-level disjunction gate** (`requireOrgBillingAdminOrOwner`) —
   used by routes whose *entire* surface is financial: the `billing-account`
   PATCH, wallet top-ups, invoices, POs, payouts, rate-cards, outbound
   webhook create/update/redeliver, and **data-exports**. The whole route
   is OWNER ∨ BILLING_ADMIN.

2. **Field-level gate** (per-field allowlist) — used by the org
   `PATCH /api/organizations/[orgId]` handler, where a single row mixes
   identity, branding, billing, tax, and capability fields. OWNER passes
   everything; a non-OWNER's touched fields must each fall inside the
   caller's remit or the route returns `403 FIELD_RBAC_FORBIDDEN` naming
   the offending fields:

   | Caller | May set | Source set |
   |--------|---------|------------|
   | `OWNER` | every field (incl. `canSponsor`/`canHost`, `gstin`, `pan`, `gstStateCode`, `requiresPO`, policies, `isPublic`) | — (bypass) |
   | `MAINTAINER` | `name`, `description`, `industry`, `website`, `sizeBucket`, `logo`, `bannerImage`, `primaryColor`, `secondaryColor` | `MAINTAINER_FIELDS` |
   | `BILLING_ADMIN` | `billingEmail`, `paymentTermsDays` | `BILLING_ADMIN_FIELDS` |

   The point of the disjunction surfaces here too: `MAINTAINER` (the higher
   rank) is the identity/branding surface and is deliberately **excluded
   from billing fields** (`billingEmail`, `paymentTermsDays`) — those sit
   with `BILLING_ADMIN`. Tax fields (`gstin`/`pan`/`gstStateCode`) and
   capability flips stay OWNER-only because they're in neither allowlist.

### BILLING_ADMIN gate matrix

| Route family | Verb | Gate |
|---|---|---|
| `billing-account` | PATCH | OWNER or BILLING_ADMIN |
| `billing-account/purchase-orders` | POST | OWNER or BILLING_ADMIN |
| `billing-account/purchase-orders/[poId]` | PATCH / DELETE | OWNER or BILLING_ADMIN |
| `billing-account/invoices` | POST | OWNER or BILLING_ADMIN |
| `billing-account/invoices/[invoiceId]` | PATCH | OWNER or BILLING_ADMIN |
| `billing-account/invoices/[invoiceId]/pay` | POST | OWNER or BILLING_ADMIN |
| `billing-account/wallet/top-ups` | POST | OWNER or BILLING_ADMIN |
| `payouts` | POST | OWNER or BILLING_ADMIN |
| `payouts/[payoutId]` | PATCH | OWNER or BILLING_ADMIN |
| `rate-cards` | POST | OWNER or BILLING_ADMIN |
| `rate-cards/[cardId]` | PATCH | OWNER or BILLING_ADMIN |
| `webhooks` (Batch 3) | POST | OWNER or BILLING_ADMIN |
| `webhooks/[endpointId]` | PATCH | OWNER or BILLING_ADMIN |
| `webhooks/[endpointId]/deliveries/[deliveryId]/redeliver` | POST | OWNER or BILLING_ADMIN |
| `data-exports` | GET / POST | OWNER or BILLING_ADMIN |
| `data-exports/[exportId]/download` | GET | OWNER or BILLING_ADMIN |

### Surfaces that stay OWNER-only

- `[orgId]` DELETE (org delete + ownership transfer)
- `sso/**` (provider CRUD, settings)
- `domain-claims/**`
- `members/**` (invite, role change, removal)
- `invitations/**`
- `scim/tokens/**` (Batch 4)
- `webhooks/[endpointId]` DELETE + `webhooks/[endpointId]/rotate-secret` POST (governance-sensitive)
- `sso/break-glass` POST + DELETE (temporary SSO-enforcement bypass; see [sso-and-authentication](../20-iam-and-security/01-sso-and-authentication.md))
- `contracts/[contractId]/supersede` POST (mints the successor contract)

## `requireOrgAccess` / `requireOrgOwner`

Every API route under `app/api/organizations/[orgId]/**` uses one of
two gates from `lib/auth-helpers.ts`:

```ts
await requireOrgAccess(orgId, "LEARNER");      // any active member
await requireOrgAccess(orgId, "MAINTAINER");   // promotes
await requireOrgOwner(orgId);                  // OWNER-only
```

Platform admins (`UserRole.ADMIN`) bypass membership checks entirely;
`requireOrgAccess` returns a synthesized OWNER-rank stub membership so
admin-initiated writes still produce valid `OrgAuditLog.actorMembershipId`
values (the stub id is `__admin_stub_<userId>`).

## Gate matrix — every org-scoped API route

| Route | Verbs | Gate |
|-------|-------|------|
| `/api/organizations` | `GET` | any authenticated user |
| `/api/organizations` | `POST` | any authenticated user (creator becomes OWNER) |
| `/api/organizations/[orgId]` | `GET` | `LEARNER` |
| `/api/organizations/[orgId]` | `PATCH`, `DELETE` | OWNER |
| `/api/organizations/[orgId]/members` | `GET` | any active member |
| `/api/organizations/[orgId]/members` | `POST` | MAINTAINER |
| `/api/organizations/[orgId]/members/[memberId]` | `GET`, `PATCH`, `DELETE` | MAINTAINER |
| `/api/organizations/[orgId]/invitations` | `GET`, `POST` | MAINTAINER |
| `/api/organizations/[orgId]/invitations/[invitationId]` | `GET`, `DELETE` | MAINTAINER |
| `/api/organizations/invitations/accept` | `POST` | any authenticated user |
| `/api/organizations/[orgId]/contracts` | `GET` | MAINTAINER |
| `/api/organizations/[orgId]/contracts` | `POST` | OWNER |
| `/api/organizations/[orgId]/contracts/[contractId]` | `GET` | MAINTAINER |
| `/api/organizations/[orgId]/contracts/[contractId]` | `PATCH`, `DELETE` | OWNER |
| `/api/organizations/[orgId]/contracts/[contractId]/supersede` | `POST` | OWNER |
| `/api/organizations/[orgId]/programs` | `GET` | any active member |
| `/api/organizations/[orgId]/programs` | `POST` | MAINTAINER |
| `/api/organizations/[orgId]/programs/[programId]` | `GET` | any active member |
| `/api/organizations/[orgId]/programs/[programId]` | `PATCH`, `DELETE` | MAINTAINER |
| `/api/organizations/[orgId]/programs/[programId]/assignments` | `GET` | any active member |
| `/api/organizations/[orgId]/programs/[programId]/assignments` | `POST` | MAINTAINER |
| `/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | `GET` | any active member |
| `/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | `PATCH`, `DELETE` | MAINTAINER |
| `/api/organizations/[orgId]/billing-account` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account` | `PATCH` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/billing-account/wallet` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/wallet/top-ups` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/wallet/top-ups` | `POST` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/invoices` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/invoices` | `POST` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/billing-account/invoices/[invoiceId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/invoices/[invoiceId]` | `PATCH` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay` | `POST` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/billing-account/purchase-orders` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/purchase-orders` | `POST` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/billing-account/purchase-orders/[poId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/purchase-orders/[poId]` | `PATCH`, `DELETE` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/rate-cards` | `GET` | MANAGER |
| `/api/organizations/[orgId]/rate-cards` | `POST` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/rate-cards/[cardId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/rate-cards/[cardId]` | `PATCH` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/payout-account` | `GET` | MANAGER |
| `/api/organizations/[orgId]/payout-account` | `PUT` | OWNER |
| `/api/organizations/[orgId]/earnings` | `GET` | MANAGER |
| `/api/organizations/[orgId]/payouts` | `GET` | MANAGER |
| `/api/organizations/[orgId]/payouts` | `POST` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/payouts/[payoutId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/payouts/[payoutId]` | `PATCH` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/sso` | `GET` | MANAGER |
| `/api/organizations/[orgId]/sso` | `PATCH` | OWNER |
| `/api/organizations/[orgId]/sso/providers` | `GET` | MANAGER |
| `/api/organizations/[orgId]/sso/providers` | `POST` | OWNER |
| `/api/organizations/[orgId]/sso/providers/[providerId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/sso/providers/[providerId]` | `DELETE` | OWNER |
| `/api/organizations/[orgId]/sso/break-glass` | `POST`, `DELETE` | OWNER |
| `/api/organizations/[orgId]/domain-claims` | `GET` | MANAGER |
| `/api/organizations/[orgId]/domain-claims` | `POST` | OWNER |
| `/api/organizations/[orgId]/domain-claims/[domain]` | `DELETE` | OWNER |
| `/api/organizations/[orgId]/hris` | `GET` | MANAGER |
| `/api/organizations/[orgId]/hris` | `PUT`, `DELETE` | OWNER |
| `/api/organizations/[orgId]/hris/sync` | `GET` | MANAGER |
| `/api/organizations/[orgId]/hris/sync` | `POST` | OWNER |
| `/api/organizations/[orgId]/hris/csv-upload` | `POST` | OWNER |
| `/api/organizations/[orgId]/consent` | `GET`, `POST`, `DELETE` | MANAGER |
| `/api/organizations/[orgId]/analytics` | `GET` | MANAGER |
| `/api/organizations/[orgId]/activity` | `GET` | MANAGER |
| `/api/organizations/[orgId]/catalog` | `GET` | MANAGER |
| `/api/organizations/[orgId]/catalog` | `POST`, `DELETE` | OWNER |
| `/api/organizations/[orgId]/catalog/search` | `GET` | MANAGER |
| `/api/organizations/[orgId]/settings` | `GET` | MANAGER (read-only wrapper) |
| `/api/organizations/[orgId]/webhooks` | `GET` | MANAGER |
| `/api/organizations/[orgId]/webhooks` | `POST` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/webhooks/[endpointId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/webhooks/[endpointId]` | `PATCH` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/webhooks/[endpointId]` | `DELETE` | OWNER |
| `/api/organizations/[orgId]/webhooks/[endpointId]/rotate-secret` | `POST` | OWNER |
| `/api/organizations/[orgId]/webhooks/[endpointId]/deliveries/[deliveryId]/redeliver` | `POST` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/data-exports` | `GET`, `POST` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/data-exports/[exportId]/download` | `GET` | OWNER or BILLING_ADMIN |
| `/api/organizations/[orgId]/checkout/overage-preview` | `GET` | any active member |
| `/api/organizations/[orgId]/verification/resubmit` | `POST` | MAINTAINER |
| `/api/admin/organizations/[orgId]/verify` | `POST` | platform ADMIN (`action: VERIFY \| REJECT \| SUSPEND \| REACTIVATE \| DEACTIVATE`) |

## Role narrowing at the API boundary

`MemberRole` is the single vocabulary — no aliases, no back-compat
mapping. Strings crossing the API boundary (BetterAuth `Invitation.role`,
query params) are narrowed via `MemberRoleSchema` from
`lib/labels/org-labels.ts`:

```ts
import { MemberRoleSchema } from "@/lib/labels/org-labels";

const parsed = MemberRoleSchema.safeParse(invitation.role);
if (!parsed.success) {
  return NextResponse.json({ error: "Unknown role" }, { status: 400 });
}
// parsed.data is typed as MemberRole here.
```

No legacy `ORG_*` aliases are accepted. The DB is pre-MVP and will be
reset; seeded roles use canonical values.

## Membership status

`MemberStatus` controls whether a role is live:

| Value       | Meaning |
|-------------|---------|
| `PENDING`   | Invitation accepted or HRIS auto-provisioned but not yet activated (rare). |
| `ACTIVE`    | The role is live. |
| `SUSPENDED` | Temporarily blocked. API returns 403 with `"Membership is suspended"`. |
| `REMOVED`   | Terminal. Row is retained for audit. |

`requireOrgAccess` rejects anything that isn't `ACTIVE`.

## Zod narrowers for self-service

`lib/labels/org-labels.ts` exposes the subset roles allowed at
self-service onboarding:

```ts
SelfServiceMemberRoleSchema = z.enum(["OWNER", "MAINTAINER", "MANAGER", "LEARNER"]);
```

`EXPERT` and `SUPPORT` are deliberately excluded — the first needs
`canHost=true` plus the invite-driven EXPERT entry (see
`expert-lifecycle`), the second is an operator role that only an
existing OWNER can assign from Settings.

## LEARNER ↔ EXPERT is disjoint

LEARNER and EXPERT are treated as disjoint roles on a single
`Membership`. The server refuses `PATCH /members/[memberId]` and the
reactivation branch of `POST /members` when the requested transition
is `LEARNER → EXPERT` or `EXPERT → LEARNER`. The policy lives in
`lib/enterprise/role-transitions.ts::isBlockedRoleTransition`; callers
that violate it receive a `409 ROLE_TRANSITION_BLOCKED`, which the
dashboard translates through `humanizeOrgError` (see
`lib/labels/org-errors.ts`) into: _"Members cannot switch between
Learner and Expert roles. Remove the member and re-invite them with
the new role instead."_

The two roles wire the user up to different profile models
(`ConsulteeProfile` vs `ConsultantProfile`) and different earnings
flows, so flipping them in place would leave stale FKs. Removing +
re-inviting forces a fresh Membership row with the right profile
links and a clean audit trail. The pre-Arch-4 "apply to deliver"
workflow — which used to live on `Membership.applicationNote /
appliedAt / approvedAt / approvedBy` — was removed alongside this
rule; those columns are gone (see `expert-lifecycle`).

## Per-role landing in `/dashboard/organization/[orgId]`

The bare org route is no longer a one-way bounce-to-personal for consumer
roles. The entry-point router at
`app/dashboard/organization/[orgId]/page.tsx` chooses the destination
from the role:

| Role | Lands on | Why |
|------|----------|-----|
| `OWNER` / `MAINTAINER` / `MANAGER` / `SUPPORT` | `/home` | Operator overview (analytics, members, billing). |
| `LEARNER` | `/my-program` | Per-cycle ProgramAssignment + utilization. The only in-org consumer surface for sponsored bookings. |
| `EXPERT` | `/my-arrangement` | Membership.payoutRecipient + RateCard split + recent earnings on org-tagged payments. |
| no membership | personal dashboard fallback (`resolvePersonalDashboardHref` → `/dashboard`) | Stranger to this org — bounce out entirely. |

Both `/my-program` and `/my-arrangement` are read-only in v1. A LEARNER
cannot self-assign to a Program; an EXPERT cannot flip their own
`payoutRecipient`. Mutations remain on operator pages. The "Personal
Dashboard" footer chip on the sidebar (`resolvePersonalDashboardHref`)
stays so consumers can hop back to their personal surface without
hunting for the URL.

## Related docs

- `organization-lifecycle` — what a membership looks like in
  each org status.
- `expert-lifecycle` — how EXPERT gets populated.
- `sso-and-authentication` — `defaultRoleForAutoJoin` on
  `OrganizationSSOSettings`.
- `api-reference` — exhaustive table with the audit actions
  each route emits.
