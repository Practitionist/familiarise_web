---
title: Roles and permissions
band: 00-foundations
audience: sde1
status: live
last-reviewed: 2026-09-28
---

# Roles and permissions

Every membership row carries a typed `MemberRole`. How the membership role combines with the platform identity (`User.role`) and the organisation's capabilities — which pairs the invite and accept routes allow, refuse, or route through the wizard's add mode — is the matrix in [docs/onboarding/02-identity-and-org-permutations.md](../../onboarding/02-identity-and-org-permutations.md). The enum is unified —
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
  It sits between `MAINTAINER` and `MANAGER` in the display order, and it
  reaches the finance surfaces because the finance matrix keys (such as
  `billing.manage` and `payouts.manage`) list it, not because of its rank
  (see below).
- `EXPERT` was `CONSULTANT`. Renamed to avoid collision with
  `UserRole.CONSULTANT` (platform consultant user).
- `LEARNER` chosen over `MEMBER` for an explicit "receives sessions"
  semantic.

## Authorization is a permission matrix, not a rank ladder

Every org route under `app/api/organizations/**` names one key from the permission matrix in `lib/auth/org-permissions.ts` and passes it to `requireOrgAccess(orgId, { permission: "<key>" })` in `lib/auth-helpers.ts`. A caller whose role does not hold the key gets a 403 whose message is `Forbidden — your role does not grant <key>`, and a list of keys means that any one of them is enough. The dashboard's sidebar, page guards and buttons read the same keys through `useOrgRole().can`, so a surface cannot show a tab that its page or API then refuses. Since #1860 (#1851) the old rank helpers are gone, and a jest pin, `__tests__/enterprise/org-route-matrix-pin.test.ts`, walks every `route.ts` under `app/api/organizations`, fails on any rank comparison, and fails on any handler that names no matrix key and has no allowlist entry with a reason.

A matrix replaced the rank ladder because privilege in an organization is not one-dimensional. An organization has an operations track (MANAGER and SUPPORT), a finance track (BILLING_ADMIN) and member roles (EXPERT and LEARNER), so BILLING_ADMIN sits above MANAGER numerically yet must see less of the operations surfaces, and SUPPORT sits below EXPERT yet sees more of them. `ORG_ROLE_RANK` in `lib/auth/role-ranks.ts` still exists, but only as a display order; it picks the most operator-like organization to land on and chooses one role when a SCIM user sits in several mapped groups, and nothing reads it to decide what a role may do.

Platform admins (`UserRole.ADMIN`) pass every org gate as a synthetic OWNER. `requireOrgAccess` returns a stub membership whose id is `__admin_stub_<userId>`, so that admin-initiated writes still produce valid `OrgAuditLog.actorMembershipId` values. Capability gates such as `canSponsor`, `canHost`, `requiresPO` and `fundingSource` describe the organization's shape rather than the member's role, so they stay outside the matrix and are checked separately at each route.

The next section is the literal output of `npx tsx scripts/utils/print-org-role-matrix.ts`, and it replaces the hand-written gate matrix this page used to carry. To change it, edit `lib/auth/org-permissions.ts`, re-run the script, and paste the new output over it.

## Org role matrix

This table is generated from `lib/auth/org-permissions.ts` by `scripts/utils/print-org-role-matrix.ts`, so edit the code and regenerate rather than editing the table.
Each row is one permission key, and a tick means the role holds it.
A platform admin passes every org gate as a synthetic Owner.
Capability gates such as `canSponsor` and `canHost` are checked separately at each route, so a tick is necessary but not always sufficient.

### `activity`

The key below governs the `activity` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `activity.read` | ✓ | ✓ | — | ✓ | — | — | — |

### `appointments`

The 4 keys below govern the `appointments` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `appointments.actForOrg.cancel` | ✓ | ✓ | — | — | — | — | — |
| `appointments.actForOrg.reschedule` | ✓ | ✓ | — | ✓ | — | — | — |
| `appointments.allocate.calendarRead` | ✓ | ✓ | — | — | — | — | — |
| `appointments.unscheduled.read` | ✓ | ✓ | — | ✓ | — | — | — |

### `audit`

The 3 keys below govern the `audit` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `audit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `audit.read.money` | ✓ | ✓ | ✓ | — | — | — | — |
| `audit.read.ops` | ✓ | ✓ | — | ✓ | ✓ | — | — |

### `billing`

The 3 keys below govern the `billing` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `billing.fundingSource.switch` | ✓ | — | ✓ | — | — | — | — |
| `billing.manage` | ✓ | — | ✓ | — | — | — | — |
| `billing.read` | ✓ | ✓ | ✓ | ✓ | — | — | — |

### `catalog`

The key below governs the `catalog` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `catalog.manage` | ✓ | ✓ | — | ✓ | — | — | — |

### `consent`

The 2 keys below govern the `consent` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `consent.read` | ✓ | ✓ | — | ✓ | — | — | — |
| `consent.requestWithdrawal` | ✓ | ✓ | — | ✓ | — | — | — |

### `contracts`

The 2 keys below govern the `contracts` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `contracts.manage` | ✓ | — | — | — | — | — | — |
| `contracts.read` | ✓ | ✓ | ✓ | — | — | — | — |

### `dataExports`

The 2 keys below govern the `dataExports` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `dataExports.finance` | ✓ | — | ✓ | — | — | — | — |
| `dataExports.people` | ✓ | ✓ | — | — | — | — | — |

### `disputes`

The key below governs the `disputes` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `disputes.read` | ✓ | ✓ | ✓ | ✓ | — | — | — |

### `identity`

The 2 keys below govern the `identity` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `identity.manage` | ✓ | — | — | — | — | — | — |
| `identity.read` | ✓ | ✓ | — | — | — | — | — |

### `integrations`

The key below governs the `integrations` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `integrations.manage` | ✓ | — | ✓ | — | — | — | — |

### `invitations`

The key below governs the `invitations` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `invitations.manage` | ✓ | ✓ | — | — | — | — | — |

### `materials`

The key below governs the `materials` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `materials.manage.orgPlan` | ✓ | ✓ | — | ✓ | — | — | — |

### `memberContent`

The key below governs the `memberContent` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `memberContent.delete` | — | — | — | — | — | — | — |

### `members`

The 7 keys below govern the `members` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `members.directory` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `members.manage` | ✓ | ✓ | — | — | — | — | — |
| `members.payoutRecipient.change` | ✓ | — | ✓ | — | — | — | — |
| `members.read` | ✓ | ✓ | — | ✓ | ✓ | — | — |
| `members.remove.force` | ✓ | — | — | — | — | — | — |
| `members.role.grant.governance` | ✓ | — | — | — | — | — | — |
| `members.role.grant.operational` | ✓ | ✓ | — | — | — | — | — |

### `messaging`

The key below governs the `messaging` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `messaging.read` | ✓ | ✓ | — | ✓ | — | — | — |

### `myArrangement`

The key below governs the `myArrangement` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `myArrangement.read` | — | — | — | — | — | ✓ | — |

### `myProgram`

The key below governs the `myProgram` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `myProgram.read` | — | — | — | — | — | — | ✓ |

### `operations`

The key below governs the `operations` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `operations.read` | ✓ | ✓ | — | ✓ | ✓ | — | — |

### `org`

The key below governs the `org` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `org.delete` | ✓ | — | — | — | — | — | — |

### `payouts`

The 4 keys below govern the `payouts` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `payouts.account.manage` | ✓ | — | — | — | — | — | — |
| `payouts.approve` | ✓ | — | ✓ | — | — | — | — |
| `payouts.manage` | ✓ | — | ✓ | — | — | — | — |
| `payouts.read` | ✓ | ✓ | ✓ | — | — | — | — |

### `programs`

The 4 keys below govern the `programs` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `programs.assign` | ✓ | ✓ | — | ✓ | — | — | — |
| `programs.manage` | ✓ | ✓ | — | — | — | — | — |
| `programs.read` | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `programs.seat.period` | ✓ | ✓ | — | — | — | — | — |

### `purchaseOrders`

The 2 keys below govern the `purchaseOrders` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `purchaseOrders.manage` | ✓ | — | ✓ | — | — | — | — |
| `purchaseOrders.read` | ✓ | ✓ | ✓ | ✓ | — | — | — |

### `quality`

The key below governs the `quality` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `quality.read` | ✓ | ✓ | — | ✓ | ✓ | — | — |

### `reimbursements`

The key below governs the `reimbursements` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `reimbursements.read` | ✓ | ✓ | ✓ | ✓ | — | — | — |

### `settings`

The 4 keys below govern the `settings` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `settings.cancellationPolicy.publish` | ✓ | — | — | — | — | — | — |
| `settings.manage` | ✓ | ✓ | — | — | — | — | — |
| `settings.ownerFields` | ✓ | — | — | — | — | — | — |
| `settings.verification.resubmit` | ✓ | ✓ | — | — | — | — | — |

### `supportRequests`

The key below governs the `supportRequests` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `supportRequests.org` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |

### `webhooks`

The 3 keys below govern the `webhooks` surface.

| Key | Owner | Maintainer | Billing admin | Manager | Support | Expert | Learner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `webhooks.delete` | ✓ | — | — | — | — | — | — |
| `webhooks.rotateSecret` | ✓ | — | — | — | — | — | — |
| `webhooks.subscribe.memberEvents` | ✓ | — | — | — | — | — | — |

## The org PATCH field gate

`PATCH /api/organizations/[orgId]` is the one route whose gate is per field, because a single organization row mixes identity, branding, billing, tax and capability fields. A caller holding `settings.ownerFields` (OWNER) may set every field. Any other caller may touch only the fields inside its remit, and the route returns `403 FIELD_RBAC_FORBIDDEN` naming the offending fields otherwise; the table below lists each remit and the key that grants it.

| Key | Holders | Fields it opens |
| --- | --- | --- |
| `settings.ownerFields` | OWNER | Every field, including the slug, `canSponsor` and `canHost`, `gstin`, `pan`, `gstStateCode`, `requiresPO`, the policies and `isPublic`. |
| `settings.manage` | OWNER, MAINTAINER | `name`, `description`, `industry`, `website`, `sizeBucket`, `logo`, `bannerImage`, `primaryColor` and `secondaryColor`. |
| `billing.manage` | OWNER, BILLING_ADMIN | `billingEmail` and `paymentTermsDays`. |

## Who may grant, change or remove which role

A MAINTAINER may grant, change or remove only the operational roles, which are MANAGER, SUPPORT, EXPERT and LEARNER, through the `members.role.grant.operational` key. Anything that touches an OWNER, MAINTAINER or BILLING_ADMIN row, or that grants one of those three roles, needs `members.role.grant.governance`, which only the OWNER holds, and this applies to role changes, status changes, removal and invitations alike (#1854, #1851 decision 6). The refusal is `ROLE_REQUIRES_OWNER` from `assertActorMayManage` in `lib/enterprise/membership-guards.ts`, and the members page mirrors the rule by hiding the options a MAINTAINER cannot use.

Nobody changes their own role or status or removes themselves (`SELF_CHANGE`), and the organization's last ACTIVE OWNER cannot be demoted, suspended or removed (`LAST_OWNER`). There is no ownership transfer yet, so an OWNER who wants to leave must first make another member an OWNER; the transfer flow is tracked in #1844.

Three more changes are finance or governance decisions rather than roster edits, and each has its own key. Changing where an EXPERT's organization share is paid needs `members.payoutRecipient.change` (OWNER or BILLING_ADMIN) and writes a `PAYOUT_RECIPIENT_CHANGED` audit row in the PAYOUT category. Changing a program seat's period needs `programs.seat.period` (OWNER or MAINTAINER), because extending a seat re-arms sponsored spend, while a MANAGER keeps seat assign and unassign through `programs.assign`. Removing a member who still has obligations needs `members.remove.force`, which only the OWNER holds.

## The ownership principle

#1851 sorts every record an organization can reach into three classes, and each class has its own rule. The table below lists them.

| Class | Records | Rule |
| --- | --- | --- |
| Org-owned | The catalog, programs, contracts, purchase orders, billing, payouts, settings, integrations and data exports. | An explicit role × action matrix decides every create, read, update, delete and special verb. |
| Member-owned content | Messages, support chats, a member's uploads and recording content. | Org roles can never change or delete this content, and their oversight is metadata only (ADR 20). A legal or compliance takedown is handled by platform staff in the back office, never by the organization, which is why `memberContent.delete` deliberately holds no role. |
| Members' bookings and seats | Appointments, occurrences and program seats. | Org roles act only through named, audited verbs, each shown behind an "Acting for <Org>" banner. |

The act-for-org verbs reach only 1:1 and subscription bookings that the organization funds. `resolveOrgActor` in `lib/booking/org-actor.ts` refuses a webinar or class seat, because an org-hosted group session carries the host organization's id and moving or cancelling it would change every attendee's seat; the host changes such a session from Catalog as a whole instead. Rescheduling for the organization needs `appointments.actForOrg.reschedule` (OWNER, MAINTAINER or MANAGER), and cancelling needs `appointments.actForOrg.cancel` (OWNER or MAINTAINER), because a cancel refunds money. Each act-for-org cancel or reschedule request writes an `OrgAuditLog` row in the booking's transaction, with the action `APPOINTMENT_CANCELLED_FOR_ORG` or `APPOINTMENT_RESCHEDULE_REQUESTED_FOR_ORG` in the MEMBER category, because the booking is the member's record.

Plan materials follow the same split. An org role manages materials only on org-owned plans through `materials.manage.orgPlan`, because an expert's personal plan has no organization id and so is never reachable through an org key. Each org change writes a `PLAN_MATERIAL_ADDED`, `PLAN_MATERIAL_UPDATED` or `PLAN_MATERIAL_REMOVED` row in the CATALOG category that targets the delivering expert's membership, and the offering editor's Materials tab shows the expert a "Changed by <Org> · <who> · <when>" line on each file the organization added or replaced, with a removed file kept in the list and struck through.

## Payout approval: the two-person rule

An organization payout batch is paid only after approval, and approving it needs `payouts.approve` (OWNER or BILLING_ADMIN). Org › Payouts › Runs labels a PENDING batch "Awaiting approval", offers an "Awaiting approval (n)" filter, and shows Approve to holders of the key. The member who created a batch cannot approve it while the organization has another ACTIVE holder of `payouts.approve`, and the refusal is `PAYOUT_SECOND_APPROVER_REQUIRED`. In a one-person organization the sole approver approves their own batch by typing the organization's slug as `confirmSelfApproval`, and the audit row carries `selfApproved: true`. The full payout state machine is in the [payout pipeline](../10-money-and-ledger/07-payout-pipeline.md), and a plain-language summary is in [how payouts work](../../payments/payouts/00-how-payouts-work.md).

## Webhook member events

Only the OWNER, through `webhooks.subscribe.memberEvents`, may subscribe an outbound webhook endpoint to `member.*` or `program.assigned`, or edit an endpoint that already carries those events. Editing is covered too, because repointing the URL of such an endpoint would reroute member data. A BILLING_ADMIN, who otherwise manages integrations, no longer sees or redelivers those deliveries, and the event picker hides the member events from anyone without the key.

## Audit categories for finance edits

Billing-account edits moved from the SETTINGS category to INVOICE in #1860, so an operations-only audit reader no longer sees a credit limit. The same change added money-category rows for edits that used to leave no trace: `FUNDING_SOURCE_CHANGED`, `BILLING_ACCOUNT_UPDATED`, `PURCHASE_ORDER_UPDATED`, `PURCHASE_ORDER_DELETED`, `INVOICE_UPDATED` and `REIMBURSEMENTS_EXPORTED`, all in the INVOICE category. The member detail GET also stopped returning `payoutRecipient` and `rateCardOverrideId` to a caller without `payouts.read`, matching the member list.

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

`MemberStatus` controls whether a role is live. The table below gives one row per
enum value and explains what each status means for access; `requireOrgAccess`
rejects anything that is not `ACTIVE`.

| Value       | Meaning |
|-------------|---------|
| `PENDING`   | The member was HRIS auto-provisioned, or is a legacy row from a bulk import made before #1854, and the membership is not yet active. Only accepting an invitation makes such a row ACTIVE; the members PATCH refuses PENDING to ACTIVE with `PENDING_REQUIRES_ACCEPT`. |
| `ACTIVE`    | The role is live. |
| `SUSPENDED` | The membership is temporarily blocked, and the API returns a 403 with `"Membership is suspended"`. |
| `REMOVED`   | The member was removed, and the row is retained for audit. REMOVED is not terminal: accepting a new invitation reactivates the same row with the invited role, which keeps its downstream foreign keys. The members PATCH and SCIM can never move a row out of REMOVED. |
| `ERASED`    | DPDP §12 tombstone, set by the erasure pipeline when a user exercises right-to-erasure. The row remains for audit and financial-trail integrity, but the user identifiers are scrubbed to pseudonymous values (see `User.erasedAt`). |

## Zod narrowers for self-service

`lib/labels/org-labels.ts` exposes the subset of roles allowed at self-service
onboarding:

```ts
SelfServiceMemberRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "LEARNER",
]);
```

`EXPERT` and `SUPPORT` are deliberately excluded from the self-service set. `EXPERT`
needs `canHost=true` plus the invite-driven EXPERT entry (see `expert-lifecycle`),
and `SUPPORT` is an operator role that only an existing OWNER can assign from
Settings. `BILLING_ADMIN` is in the self-service set because an org that delegates
its finance surface needs to be able to invite that role through the ordinary
member flow.

## LEARNER ↔ EXPERT is disjoint

LEARNER and EXPERT are treated as disjoint roles on a single
`Membership`. The server refuses `PATCH /members/[memberId]`
when the requested transition is `LEARNER → EXPERT` or `EXPERT → LEARNER`.
The policy lives in
`lib/enterprise/role-transitions.ts::isBlockedRoleTransition`, which the
shared guard `assertRoleChangeAllowed` in
`lib/enterprise/membership-guards.ts` calls; callers that violate it
receive a `409 ROLE_TRANSITION_BLOCKED`, which the
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

### The three layers, and which cross-setups are allowed

Confusion recurs here because three layers share vocabulary, so this
section records the model and the decision explicitly. The platform
profiles (`ConsultantProfile`, `ConsulteeProfile`) are global, per-User
identities and are **not** mutually exclusive: one person can both
deliver and consume on the platform, and each profile is unique per
user. The workspace roles are the `MemberRole` enum on `Membership`,
and EXPERT/LEARNER are the two enum values that bridge a workspace
membership to one of those global profiles; the operator roles (OWNER,
MAINTAINER, BILLING_ADMIN, MANAGER, SUPPORT) carry no profile linkage
at all. The following table states what is allowed across those layers.

| Setup | Allowed? | Why |
|---|---|---|
| One user holds both profiles platform-wide | Yes | Profiles are global and non-exclusive. |
| EXPERT in org A while LEARNER in org B | Yes | Each org gets its own Membership row with its own role and profile link; multi-org experts and learners are first-class (see the scenarios doc). |
| EXPERT and LEARNER inside the same org | No — by decision (2026-06-07) | `@@unique([userId, organizationId])` allows one role per org, and the LEARNER↔EXPERT transition is blocked. Allowing a dual-side membership would make `ProgramAssignment` attribution ambiguous and open self-dealing (an expert consuming their own org's sponsored budget). The remediation is remove + re-invite, or a second org for genuinely separate capacities. |
| Operator role plus sponsored consumption in the same org | No | Same single-role constraint; operators have no consumer profile linkage. An operator who needs sponsored sessions takes a LEARNER membership in a different org or books personally funded sessions. |

A fourth layer is easy to mistake for a gate on the three above, so it is worth stating plainly that it is not one. `UserRole` is a single nullable scalar on `User` holding one of CONSULTANT, CONSULTEE, ADMIN, STAFF or ORG_WORKSPACE, and it decides two things only: which dashboard a newly onboarded user lands on, and which back-office surfaces they reach through `lib/auth/backoffice-permissions.ts`. No code anywhere reads it when assigning a `MemberRole`. Identity on this platform is driven by which profiles exist, not by that field, which is why the dashboard switcher offers every facet a user holds rather than the single one `UserRole` names. A user whose `UserRole` is CONSULTANT can therefore hold a LEARNER membership without contradiction, and does so routinely.

Acquiring the two profiles is deliberately asymmetric, and the asymmetry is the safeguard rather than an inconsistency. Consuming is cheap to grant, so accepting a LEARNER invitation lazy-creates a `ConsulteeProfile` on the spot — the click is the user's own consenting action and the profile carries nothing that needs verifying. Delivering is not, so accepting an EXPERT invitation refuses to lazy-create a `ConsultantProfile` and fails with `NOT_A_CONSULTANT`; a consultant identity carries domain, rates, verification state and payout prerequisites that no invitation click can substitute for. The practical effect is that a consultant can become a learner in a single step, while a consultee becomes an expert only by building the delivering identity first.

One consequence of that openness needed its own guard. Because the two profiles are independent, a member can hold a `ConsultantProfile` with plans of their own while holding a LEARNER membership in a sponsoring organization, and nothing about that combination is blocked or should be. What must be blocked is the specific act it enables: booking one's own plan. The same-org EXPERT/LEARNER rule in the table above does not reach it, because that rule governs a single `Membership` row and this needs no EXPERT membership at all — only a consultee profile and a plan. Left unguarded, a sponsored member could book their own session against the organization's credit pool and route the sponsor's money into their own payout account. `revalidateInsideLock` in `lib/payments/operations/checkout.ts` therefore refuses any checkout where the plan's owning `ConsultantProfile` is the booking user's own, under the same distributed lock that enforces the ADR 18 panel and exclusivity checks, and for every funding path rather than only the sponsored ones.

### Who creates the identity: the who-is-acting rule

Identity creation follows one rule, settled in #819: **creating a profile
requires the user's own action, while an admin acting on someone else's
behalf requires the identity to already exist.** Concretely, the admin
direct-add surface is gone since #1854: `POST /members` answers 405,
because members join by invitation and acceptance only, and a role
change into EXPERT through the members PATCH refuses with
`NOT_A_CONSULTANT` when the person has no expert profile yet, because an
org admin's click must never mint a platform identity for somebody else.
Invitation accept is the user's own consenting click, so it lazy-creates
the lightweight `ConsulteeProfile` for LEARNER (this is one of the
sanctioned creation points named in `lib/auth.ts`) but still refuses
EXPERT when no `ConsultantProfile` exists, because a consultant identity
carries domain, rate, verification, and payout prerequisites that no
invite click can substitute for. SSO JIT auto-join keeps its own
lazy-create path as a separately authorized provisioning channel.

### Role changes and removal go through one guard (#1854)

Every role and status move, from the dashboard and from bulk
import, now goes through the shared guard in
`lib/enterprise/membership-guards.ts`. Operator roles switch freely
within the grant rules above. A LEARNER or EXPERT who already has
bookings, seats, deliveries or earnings at the organization cannot change
role in place and is refused with `REMOVE_AND_REINVITE`, so the operator
removes the member and re-invites them with the new role. The members
PATCH runs at Serializable isolation with the house retry, so two OWNERs
demoting or suspending each other cannot both succeed.

Removing a member checks their obligations first. The Remove dialog reads
`GET /api/organizations/[orgId]/members/[memberId]/obligations`, which
counts upcoming org sessions as learner or deliverer, live program seats
and money still moving at this organization, and a non-OWNER is refused
with `MEMBER_HAS_OBLIGATIONS` while any of them is open. An OWNER can
force the removal, which the dialog confirms by having the OWNER type the
member's email, and the route receives it as `?force=true`; live seats
then close at once and the audit row records the forced removal and the
obligations it overrode.

A member created by SSO JIT has not
agreed to the sign-up terms, so the org dashboard shows a first sign-in
consent step (`JoinConsentGate`) to a member with no core-processing
consent record at all, and an invitation accepted by such an account
shows the sign-up consent inline and records it in the accept
transaction.

## Per-role landing in `/dashboard/organization/[orgId]`

The bare org route is no longer a one-way bounce-to-personal for consumer
roles. The entry-point router at `app/dashboard/organization/[orgId]/page.tsx` chooses the
destination from the role. The table below reads one role per row and gives the
page it lands on and the reason for that choice.

| Role | Lands on | Why |
|------|----------|-----|
| `OWNER` / `MAINTAINER` / `MANAGER` / `SUPPORT` | `/home` | Operator overview (analytics, members, billing). |
| `LEARNER` | `/my-program` | Per-cycle ProgramAssignment + utilization. The only in-org consumer surface for sponsored bookings. |
| `EXPERT` | `/compensation` | Membership.payoutRecipient, the expert's own split and recent earnings on org-tagged payments. Since #1860 the split is only the card that applies to this expert, resolved by `resolveEffectiveRateCard` as their membership override, else the org default, else the platform default, and the page never lists the org's other rate cards. |
| no membership | personal dashboard fallback (`resolvePersonalDashboardHref` → `/dashboard`) | Stranger to this org — bounce out entirely. |

Both `/my-program` and `/compensation` are read-only in v1. A LEARNER
cannot self-assign to a Program; an EXPERT cannot flip their own
`payoutRecipient`. Mutations remain on operator pages. Membership also
carries an `exclusiveEngagement` boolean (ADR 18) recording an
org-declared exclusivity arrangement for internal consultants. This was
an unenforced schema stub when it landed, but it is no longer: as of
2026-07-11 checkout rejects a booking of the consultant's independent
plans when an `ACTIVE` membership carries the flag (#982), and the
schema comment says the same. What remains unbuilt is the other half of
exclusivity — filtering those plans out of marketplace listings — so the
flag still must not surface in any UI that implies discovery is
suppressed. The "Personal
Dashboard" footer chip on the sidebar (`resolvePersonalDashboardHref`)
stays so consumers can hop back to their personal surface without
hunting for the URL.

## Related docs

The [organization-lifecycle](05-organization-lifecycle.md) doc describes what a
membership looks like in each org status, and the
[expert-lifecycle](../30-programs-and-lifecycle/03-expert-lifecycle.md) doc explains
how the EXPERT role gets populated. The
[sso-and-authentication](../20-iam-and-security/01-sso-and-authentication.md) doc
covers `defaultRoleForAutoJoin` on `OrganizationSSOSettings`, and the
[API reference](../50-operations/01-api-reference.md)
carries the exhaustive table of the audit actions each route emits.
