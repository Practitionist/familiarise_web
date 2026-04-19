# Roles and permissions

Every membership row carries a typed `MemberRole`. The enum is unified —
there is exactly one role namespace, with values chosen to avoid any
collision with the platform-level `UserRole` enum.

## `MemberRole` (schema.prisma)

```prisma
enum MemberRole {
  OWNER
  MAINTAINER
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
- `EXPERT` was `CONSULTANT`. Renamed to avoid collision with
  `UserRole.CONSULTANT` (platform consultant user).
- `LEARNER` chosen over `MEMBER` for an explicit "receives sessions"
  semantic.

## Rank ladder

`lib/auth-helpers.ts` exports `ORG_ROLE_RANK`:

| Role         | Rank | Typical responsibility |
|--------------|------|-------------------------|
| `OWNER`      | 100  | Billing, contracts, payouts, settings, organization delete. |
| `MAINTAINER` | 80   | Members, invites, programs, rate cards (view-only), settings. |
| `MANAGER`    | 60   | Team analytics, seat management, read-only views of invoices/earnings/payouts/rate-cards. |
| `EXPERT`     | 40   | Delivers services on behalf of the org. |
| `SUPPORT`    | 30   | Views support tickets and assists members. No billing. |
| `LEARNER`    | 20   | Consumes services through the org's programs. |

`orgRoleSatisfies(actual, minimum)` returns `rank[actual] >= rank[minimum]`.

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
| `/api/organizations/[orgId]/programs` | `GET` | any active member |
| `/api/organizations/[orgId]/programs` | `POST` | MAINTAINER |
| `/api/organizations/[orgId]/programs/[programId]` | `GET` | any active member |
| `/api/organizations/[orgId]/programs/[programId]` | `PATCH`, `DELETE` | MAINTAINER |
| `/api/organizations/[orgId]/programs/[programId]/assignments` | `GET` | any active member |
| `/api/organizations/[orgId]/programs/[programId]/assignments` | `POST` | MAINTAINER |
| `/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | `GET` | any active member |
| `/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | `PATCH`, `DELETE` | MAINTAINER |
| `/api/organizations/[orgId]/billing-account` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account` | `PATCH` | OWNER |
| `/api/organizations/[orgId]/billing-account/wallet` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/wallet/top-ups` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/wallet/top-ups` | `POST` | OWNER |
| `/api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/invoices` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/invoices` | `POST` | OWNER |
| `/api/organizations/[orgId]/billing-account/invoices/[invoiceId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/invoices/[invoiceId]` | `PATCH` | OWNER |
| `/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay` | `POST` | OWNER |
| `/api/organizations/[orgId]/billing-account/purchase-orders` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/purchase-orders` | `POST` | OWNER |
| `/api/organizations/[orgId]/billing-account/purchase-orders/[poId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/billing-account/purchase-orders/[poId]` | `PATCH`, `DELETE` | OWNER |
| `/api/organizations/[orgId]/rate-cards` | `GET` | MANAGER |
| `/api/organizations/[orgId]/rate-cards` | `POST` | OWNER |
| `/api/organizations/[orgId]/rate-cards/[cardId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/rate-cards/[cardId]` | `PATCH` | OWNER |
| `/api/organizations/[orgId]/payout-account` | `GET` | MANAGER |
| `/api/organizations/[orgId]/payout-account` | `PUT` | OWNER |
| `/api/organizations/[orgId]/earnings` | `GET` | MANAGER |
| `/api/organizations/[orgId]/payouts` | `GET` | MANAGER |
| `/api/organizations/[orgId]/payouts` | `POST` | OWNER |
| `/api/organizations/[orgId]/payouts/[payoutId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/payouts/[payoutId]` | `PATCH` | OWNER |
| `/api/organizations/[orgId]/sso` | `GET` | MANAGER |
| `/api/organizations/[orgId]/sso` | `PATCH` | OWNER |
| `/api/organizations/[orgId]/sso/providers` | `GET` | MANAGER |
| `/api/organizations/[orgId]/sso/providers` | `POST` | OWNER |
| `/api/organizations/[orgId]/sso/providers/[providerId]` | `GET` | MANAGER |
| `/api/organizations/[orgId]/sso/providers/[providerId]` | `DELETE` | OWNER |
| `/api/organizations/[orgId]/domain-claims` | `GET` | MANAGER |
| `/api/organizations/[orgId]/domain-claims` | `POST` | OWNER |
| `/api/organizations/[orgId]/domain-claims/[domain]` | `DELETE` | OWNER |
| `/api/organizations/[orgId]/hris` | `GET` | MANAGER |
| `/api/organizations/[orgId]/hris` | `PUT`, `DELETE` | OWNER |
| `/api/organizations/[orgId]/hris/sync` | `GET` | MANAGER |
| `/api/organizations/[orgId]/hris/sync` | `POST` | OWNER |
| `/api/organizations/[orgId]/hris/csv-upload` | `POST` | OWNER |
| `/api/organizations/[orgId]/consent` | `GET`, `POST` | MANAGER |
| `/api/organizations/[orgId]/analytics` | `GET` | MANAGER |
| `/api/organizations/[orgId]/activity` | `GET` | MANAGER |
| `/api/organizations/[orgId]/catalog` | `GET` | MANAGER |
| `/api/organizations/[orgId]/catalog` | `POST`, `DELETE` | OWNER |
| `/api/organizations/[orgId]/catalog/search` | `GET` | MANAGER |
| `/api/organizations/[orgId]/settings` | `GET` | MANAGER (read-only wrapper) |
| `/api/organizations/[orgId]/images` | `POST` | (org-scoped; see file) |
| `/api/admin/organizations/[orgId]/verify` | `POST` | platform ADMIN |

## Legacy role aliases

The old pre-Arch-4 role names (and the intermediate Checkpoint-6 draft
names) are still accepted by `normalizeLegacyRole()` in
`lib/auth-helpers.ts`:

| Legacy value | Canonical |
|--------------|-----------|
| `ORG_OWNER` | `OWNER` |
| `ORG_ADMIN`, `ADMIN` | `MAINTAINER` |
| `ORG_MANAGER` | `MANAGER` |
| `ORG_CONSULTANT`, `CONSULTANT` | `EXPERT` |
| `ORG_LEARNER`, `MEMBER` | `LEARNER` |
| `ORG_SUPPORT` | `SUPPORT` |

The mapping is read at the invite-accept and onboarding boundaries so
persisted payloads from before the rename keep working. New code must
never emit a legacy value.

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
`canHost=true` plus the application workflow (see
`06-expert-lifecycle.md`), the second is an operator role that only an
existing OWNER can assign from Settings.

## Related docs

- `05-organization-lifecycle.md` — what a membership looks like in
  each org status.
- `06-expert-lifecycle.md` — how EXPERT gets populated.
- `08-sso-and-authentication.md` — `defaultRoleForAutoJoin` on
  `OrganizationSSOSettings`.
- `21-api-reference.md` — exhaustive table with the audit actions
  each route emits.
