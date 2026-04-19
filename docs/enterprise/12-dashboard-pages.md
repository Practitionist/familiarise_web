# Dashboard pages

Every organization-scoped dashboard page lives under
`app/dashboard/organization/[orgId]/**`. Roles are gated server-side
via `requireOrgAccess` at the API layer; the pages themselves do a
thin `requireOrgAccess` check plus role-driven conditional rendering.

## Page tree

```
/dashboard/organization                        → switcher + "create org" CTA
/dashboard/organization/create                 → org-creation wizard
/dashboard/organization/[orgId]                → redirects to /home
/dashboard/organization/[orgId]/home           → overview: capability badges,
                                                  counts, quick actions
/dashboard/organization/[orgId]/members        → unified Membership list
/dashboard/organization/[orgId]/consultants    → filtered list (role=EXPERT)
/dashboard/organization/[orgId]/learners       → filtered list (role=LEARNER)
/dashboard/organization/[orgId]/invitations    → pending/accepted/revoked
/dashboard/organization/[orgId]/contracts      → contracts + linked programs
/dashboard/organization/[orgId]/programs       → programs + assignments
/dashboard/organization/[orgId]/purchase-orders → PO list + 3-way match view
/dashboard/organization/[orgId]/billing        → BillingAccount + top-ups + invoices
/dashboard/organization/[orgId]/credits        → legacy alias for /billing
                                                  (wallet view; kept for redirects)
/dashboard/organization/[orgId]/plans          → org catalog (OrganizationPlan)
/dashboard/organization/[orgId]/payouts        → OrganizationPayout list + TDS
                                                  summary (host-side only)
/dashboard/organization/[orgId]/analytics      → rollups (bookings, revenue,
                                                  earnings, wallet burn-down)
/dashboard/organization/[orgId]/consent        → ConsentArtifact roster +
                                                  DPDP breach log
/dashboard/organization/[orgId]/settings       → branding + policy
/dashboard/organization/[orgId]/settings/sso   → SSO policy + providers +
                                                  domain claims
```

A few additional surfaces are not in the org-scoped tree:

- `/organizations/invite/[token]` — invite-accept landing
  (`app/organizations/invite/[token]/page.tsx`).
- `/dashboard/admin/**` — the platform admin surface that can verify,
  suspend, or deactivate any org. Lives outside this doc set.

## Visibility by capability

| Page           | SPONSOR | HOST | HYBRID | Notes |
|----------------|---------|------|--------|-------|
| `/home`        | ✅      | ✅   | ✅     | — |
| `/members`     | ✅      | ✅   | ✅     | — |
| `/consultants` | —       | ✅   | ✅     | Hidden when `canHost = false`. |
| `/learners`    | ✅      | —    | ✅     | Hidden when `canSponsor = false`. |
| `/invitations` | ✅      | ✅   | ✅     | — |
| `/contracts`   | ✅      | —    | ✅     | Contracts are a sponsor concept. |
| `/programs`    | ✅      | —    | ✅     | Program subtypes only apply to sponsored bookings. |
| `/purchase-orders` | ✅  | —    | ✅     | — |
| `/billing`     | ✅      | —    | ✅     | BillingAccount summary + wallet + invoices. |
| `/plans`       | ✅      | —    | ✅     | Org catalog. |
| `/payouts`     | —       | ✅   | ✅     | Host-side only; hidden when `canHost = false`. |
| `/analytics`   | ✅      | ✅   | ✅     | Rollups respect capability — host-side numbers hidden when `canHost = false` and vice versa. |
| `/consent`     | ✅      | ✅   | ✅     | DPDP artifact roster; not capability-gated. |
| `/settings`    | ✅      | ✅   | ✅     | — |
| `/settings/sso`| ✅      | ✅   | ✅     | — |

## Navigation source of truth

The sidebar under `app/dashboard/organization/[orgId]/page.tsx` reads
capability booleans from the session and hides navigation items that
would 404 or 501. It does NOT re-derive from `deriveCapabilityKind()`
— the booleans are consumed directly.

## Wizard

`/dashboard/organization/create` uses the self-service narrowers from
`lib/labels/org-labels.ts`:

- `SelfServiceFundingSourceSchema` limits the dropdown to `PERSONAL |
  WALLET | INVOICE | LICENSE` (no PROJECT).
- `SelfServiceMemberRoleSchema` limits the default-role selector to
  `OWNER | MAINTAINER | MANAGER | LEARNER`.

The wizard POSTs `{ canSponsor, canHost, fundingSource, ... }` to
`/api/organizations`. An INERT-result body (both booleans false) is
blocked at the Zod layer before reaching the server.

## Session refetch on membership change

Any API call that flips a membership role (e.g.
`PATCH /members/[memberId]`) returns a fresh `Membership` shape. The
dashboard shell listens for the response and re-fetches the session
via BetterAuth's session client so `organizationMemberships[]` is
updated without a full reload.

## Related docs

- `00-overview.md` — the session shape each page consumes.
- `01-organization-types.md` — capability behaviour that drives
  visibility.
- `04-roles-and-permissions.md` — role gates at the API layer.
- `21-api-reference.md` — the route each page calls.
