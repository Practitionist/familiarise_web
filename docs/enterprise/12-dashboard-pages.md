# Dashboard pages

Every organization-scoped dashboard page lives under
`app/dashboard/organization/[orgId]/**`. Roles are gated server-side
via `requireOrgAccess` at the API layer; the pages themselves do a
thin `requireOrgAccess` check plus role-driven conditional rendering.

## Page tree

```
/dashboard/organization                        → server-redirect (see § below):
                                                  OrgWorkspace → /dashboard/org-workspace/
                                                  <id>/home; everyone else → /dashboard
/dashboard/organization/create                 → org-creation wizard
/dashboard/organization/[orgId]                → role-aware redirect:
                                                  MANAGER+ / OWNER / SUPPORT → /home;
                                                  LEARNER → /my-program;
                                                  EXPERT  → /my-arrangement;
                                                  no membership → personal
                                                  dashboard via
                                                  resolvePersonalDashboardHref
/dashboard/organization/[orgId]/home           → overview: capability badges,
                                                  counts, quick actions (operator
                                                  view); sub-MANAGERs who deep-link
                                                  here see a ConsumerViewCard with
                                                  a role-specific deep link to
                                                  /my-program or /my-arrangement
/dashboard/organization/[orgId]/my-program     → LEARNER's per-org allocation:
                                                  ProgramAssignment progress,
                                                  coverage rules, utilization
                                                  history. canSponsor only.
/dashboard/organization/[orgId]/my-arrangement → EXPERT's per-org payout view:
                                                  Membership.payoutRecipient,
                                                  RateCard split, recent earnings
                                                  on org-tagged payments. canHost
                                                  only.
/dashboard/organization/[orgId]/members        → unified Membership list
/dashboard/organization/[orgId]/experts        → filtered list (role=EXPERT)
/dashboard/organization/[orgId]/learners       → filtered list (role=LEARNER)
/dashboard/organization/[orgId]/invitations    → pending/accepted/revoked
/dashboard/organization/[orgId]/contracts      → contracts + linked programs
/dashboard/organization/[orgId]/programs       → programs + assignments
/dashboard/organization/[orgId]/purchase-orders → PO list + 3-way match view
/dashboard/organization/[orgId]/billing        → BillingAccount + top-ups + invoices
/dashboard/organization/[orgId]/credits        → legacy alias for /billing
                                                  (wallet view; kept for redirects)
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
- `/dashboard/org-workspace/[orgWorkspaceId]/**` — **the operator (cross-org)
  dashboard.** Keyed on `OrgWorkspaceProfile.id`. Has its own sidebar
  (mirrors /dashboard/admin and /dashboard/staff) with four pages:
    - `/home` — cross-org stats row + grid of orgs you OWN + "+ New
      organization" CTA. Replaces the old `/dashboard/organization`
      switcher list (which now 308-redirects here for OrgWorkspaces).
    - `/activity` — cross-org audit feed aggregating `OrgAuditLog` rows
      across all owned orgs. Cursor-paginated. Distinct from per-org
      `/audit` which scopes to one org and supports rich filters.
    - `/billing` — cross-org outstanding invoices + wallet balance
      roll-up. Distinct from per-org `/billing` which mutates one org's
      wallet/invoices. Read-only.
    - `/settings` — operator-level preferences scaffold (default
      landing org, notification routing). Storage decision deferred to
      v1.1; the page exists so the sidebar route doesn't 404.
    - `/create` — same `<CreateOrganizationWizard />` as
      `/dashboard/organization/create`, but inside this dashboard's
      chrome (operators creating their 2nd, 3rd, … org never leave the
      chrome). Both entry points redirect to
      `/dashboard/organization/<newOrgId>/home` on success.
- `/dashboard/admin/**` — the platform admin surface that can verify,
  suspend, or deactivate any org. Lives outside this doc set.

The bare `/dashboard/organization` URL is now a server-redirect:
OrgWorkspace → `/dashboard/org-workspace/<id>/home`; non-OrgWorkspace → `/dashboard`.
The org grid that used to live there is gone — non-OrgWorkspace members
(LEARNER, EXPERT) navigate between orgs via the OrganizationSwitcher
dropdown in the top bar, which never required a list page.

## Visibility by capability

Visibility here is the **capability** gate only. Every tab is **also** role-gated — see the "Min role" column. "Min role" reflects what the page itself enforces via `useRequireOrgAccess` / `useRequireOrgRole` (or, for pages that have no page-level gate, the API gate that fails first). The canonical API gate matrix lives in `04-roles-and-permissions.md:63-134`.

| Page           | SPONSOR | HOST | HYBRID | Min role  | In sidebar? | Notes |
|----------------|---------|------|--------|-----------|-------------|-------|
| `/home`        | ✅      | ✅   | ✅     | any       | yes | Renders operator stat grid for MANAGER+; role-branched ConsumerViewCard for sub-MANAGER deep-links. |
| `/my-program`  | ✅      | —    | ✅     | any active member (page filters server-side to caller's assignments) | yes (LEARNER + canSponsor only) | Per-cycle ProgramAssignment progress, coverage rules, utilization history. 404 on canSponsor=false. |
| `/my-arrangement` | —    | ✅   | ✅     | any active member (page filters to caller's earnings) | yes (EXPERT + canHost only) | Membership.payoutRecipient, default RateCard split, recent earnings on org-tagged payments. 404 on canHost=false. |
| `/members`     | ✅      | ✅   | ✅     | MANAGER   | yes | — |
| `/experts`     | —       | ✅   | ✅     | MANAGER   | yes (if `canHost`) | Hidden when `canHost = false`. |
| `/learners`    | ✅      | —    | ✅     | MANAGER   | yes (if `canSponsor`) | Hidden when `canSponsor = false`. |
| `/invitations` | ✅      | ✅   | ✅     | MAINTAINER| yes | Send-invite button disabled pre-verification; uses `humanizeOrgError` for `ORG_NOT_VERIFIED`. |
| `/programs`    | ✅      | —    | ✅     | MAINTAINER| yes (if `canSponsor`) | Program subtypes only apply to sponsored bookings. |
| `/billing`     | ✅      | —    | ✅     | MANAGER   | yes (if `canSponsor`) | BillingAccount summary + wallet + invoices. See TODO below — code currently splits this into two pages (`/billing` + `/credits`), which diverges from the unified design described here. |
| `/payouts`     | —       | ✅   | ✅     | MANAGER   | yes (if `canHost`) | Host-side only. |
| `/analytics`   | ✅      | ✅   | ✅     | MANAGER   | yes | Rollups respect capability — host-side numbers hidden when `canHost = false` and vice versa. |
| `/settings`    | ✅      | ✅   | ✅     | MAINTAINER| yes | Branding + policy. |
| `/settings/sso`| ✅      | ✅   | ✅     | **OWNER** | no — reached from inside /settings | SSO policy + providers + domain claims. |
| `/contracts`   | ✅      | —    | ✅     | MAINTAINER (API) | **no — deep-link only** | Page has no `useRequireOrgAccess` gate today; relies on API rejection + sidebar omission. |
| `/purchase-orders` | ✅  | —    | ✅     | MANAGER (API) | **no — deep-link only** | Same as `/contracts` — page renders but API calls fail for sub-MANAGER. |
| `/consent`     | ✅      | ✅   | ✅     | MANAGER (API) | **no — deep-link only** | DPDP artifact roster; not capability-gated. |

> The `/plans` page (previous "org catalog" over `OrganizationPlan`)
> was removed in the legacy-stub cleanup; its capability-driven
> replacement (`/catalog`) is reserved in the sidebar with
> `show: false` and will re-enable when the page ships.

### TODO — `/billing` vs `/credits` unification (code drift)

This doc describes `/billing` as the single BillingAccount surface
(top-ups + invoices together), with `/credits` kept only as a
redirect alias for backward compatibility.

The code currently diverges from that design:

- `app/dashboard/organization/[orgId]/billing/BillingPageClient.tsx`
  (671 lines) ships the invoice / payment-terms / pending-charges
  view only.
- `app/dashboard/organization/[orgId]/credits/page.tsx` (475 lines)
  ships the wallet balance / top-up / WalletEntry history view as
  a distinct, non-redirecting page.
- The sidebar renders both as separate tabs under different gates
  (`layout.tsx:186-199`).

Impact: a WALLET-funded org's OWNER visits Credits to top up the
wallet but Billing to see receipts / invoices — two tabs for one
conceptual concern. Observed during manual testing: the Billing
page shows "NET-60 payment terms" and a "Create invoice" button
even for WALLET-funded orgs where neither applies.

Resolution options for the senior-dev owner:

1. **Preferred — unify (docs are right).** Fold the wallet UI from
   `/credits/page.tsx` into `BillingPageClient.tsx` as a
   `fundingSource`-branching section. Turn `/credits` into a
   server-side redirect to `/billing` (per the docs' "legacy alias
   kept for redirects"). Drop the separate Credits sidebar tab.

2. **Alternate — embrace the split.** If the separation is
   deliberate, update this doc to describe two first-class pages
   and clean up the BillingPage surface so non-WALLET-specific
   cards (NET terms, Create invoice) don't render on a WALLET
   org's `/billing`.

Do NOT legitimize the current drift by leaving both pages as-is —
the duplicate-purpose sidebar surface is a real UX bug.

> **Sidebar vs page-level note.** `/contracts`, `/purchase-orders`,
> and `/consent` exist as routes but are not listed in the sidebar
> memo (`layout.tsx:164-208`). They also lack page-level
> `useRequireOrgAccess` guards, so a sub-MANAGER who deep-links to
> them will see the page chrome load, then watch every API call
> fail. Worth adding either a `useRequireOrgAccess` guard + sidebar
> entry, or an explicit redirect — tracked as follow-up.

## Navigation source of truth

The sidebar is built in
`app/dashboard/organization/[orgId]/layout.tsx` (`sidebarItems`
memo) from three inputs: the org's `canSponsor` / `canHost` /
`fundingSource` booleans, and the current user's `MemberRole`
ranked via the local `isAtLeast()` helper (duplicated narrowly from
`lib/auth-helpers.ts` because the layout runs before the org query
cache is warm). The sidebar is cosmetic — it does not re-derive
from `deriveCapabilityKind()` and it does not enforce authorization.
Every page and API route still calls `requireOrgAccess` / `useRequireOrgAccess`
independently. Items that would 404/403/501 are simply hidden to
keep the nav tidy.

## Personal dashboard routing

The "Personal Dashboard" chip at the bottom of the org sidebar
resolves its href through a single helper,
`resolvePersonalDashboardHref` in `lib/labels/personal-dashboard.ts`.
Priority: `orgWorkspaceProfile → consultantProfile → consulteeProfile` —
operator identity wins over consumer identity, and
`ConsultantProfile` wins over `ConsulteeProfile` for users who have
both. If the user has none of the three, the chip is hidden. The same
resolver backs the invitations dialog, `OrgContextBar`, and the org
layout shell; do not inline a ternary.

## Invitations dialog polish

`/dashboard/organization/[orgId]/invitations` disables the "Send
invite" button with a tooltip when the org's status is
`PENDING_VERIFICATION`. Any `ORG_NOT_VERIFIED` error returned from
the POST is run through `humanizeOrgError` (`lib/labels/org-errors.ts`)
before it reaches the toast, so users see the friendly sentence
instead of the raw error code.

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
