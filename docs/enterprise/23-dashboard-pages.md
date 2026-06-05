# Dashboard pages

Every organization-scoped dashboard page lives under
`app/dashboard/organization/[orgId]/**`. Roles are gated server-side
via `requireOrgAccess` at the API layer; the pages themselves do a
thin `requireOrgAccess` check plus role-driven conditional rendering.

## Page tree

The list below is the actual `page.tsx` set under
`app/dashboard/organization/[orgId]/` (verified 2026-06-05).

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
/dashboard/organization/[orgId]/home           → state-aware activation center
                                                  (action banners + Getting-Started
                                                  checklist + stat grid). BILLING_ADMIN
                                                  sees the finance overview; sub-MANAGER
                                                  deep-links see a role-specific
                                                  consumer card. See "/home" below.
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
/dashboard/organization/[orgId]/contracts      → contracts + linked programs;
                                                  term-edit drawer (locked vs editable)
/dashboard/organization/[orgId]/programs       → programs + assignments;
                                                  config-lock-aware edit dialog
/dashboard/organization/[orgId]/purchase-orders → PO list + 3-way match view
/dashboard/organization/[orgId]/billing        → BillingAccount + WalletTab +
                                                  invoices (single surface; see below)
/dashboard/organization/[orgId]/reimbursements → PERSONAL-funded reimbursement
                                                  report (#714)
/dashboard/organization/[orgId]/payouts        → OrganizationPayout list + TDS
                                                  summary (host-side only)
/dashboard/organization/[orgId]/analytics      → rollups (bookings, revenue,
                                                  earnings, wallet burn-down)
/dashboard/organization/[orgId]/appointments   → org-scoped appointment view
/dashboard/organization/[orgId]/trials         → trial-plan management
/dashboard/organization/[orgId]/waitlist       → waitlist management
/dashboard/organization/[orgId]/recordings     → session-recording library
/dashboard/organization/[orgId]/disputes       → payment-dispute tracker
/dashboard/organization/[orgId]/reimbursements → (see above)
/dashboard/organization/[orgId]/documents      → org document storage
/dashboard/organization/[orgId]/audit          → per-org OrgAuditLog (rich filters)
/dashboard/organization/[orgId]/consent        → ConsentArtifact roster + DPDP
                                                  withdraw/grant (DPDP §6(4))
/dashboard/organization/[orgId]/integrations/data-exports → DPDP §11 right-to-access
                                                  export jobs (OrgDataExportJob)
/dashboard/organization/[orgId]/integrations/scim    → SCIM provisioning config
/dashboard/organization/[orgId]/integrations/webhooks → outbound webhook config
/dashboard/organization/[orgId]/settings       → branding + policy
/dashboard/organization/[orgId]/settings/sso   → SSO policy + providers +
                                                  domain claims
```

There is **no `/credits` route** — the wallet view is a tab inside `/billing`
(see "Billing surface" below). The old `/plans` org-catalog page was removed in
the legacy-stub cleanup; discovery now reads the per-type plans' visibility (see
[public pages & discovery](24-public-pages-and-discovery.md)).

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

Visibility here is the **capability** gate only. Every tab is **also** role-gated — see the "Min role" column. "Min role" reflects what the page itself enforces via `useRequireOrgAccess` / `useRequireOrgRole` (or, for pages that have no page-level gate, the API gate that fails first). The canonical API gate matrix lives in `03-roles-and-permissions.md:63-134`.

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
| `/billing`     | ✅      | —    | ✅     | MANAGER   | yes (if `canSponsor`) | BillingAccount summary + wallet (`WalletTab`) + invoices — one unified surface (no `/credits` split; see below). |
| `/payouts`     | —       | ✅   | ✅     | MANAGER   | yes (if `canHost`) | Host-side only. |
| `/analytics`   | ✅      | ✅   | ✅     | MANAGER   | yes | Rollups respect capability — host-side numbers hidden when `canHost = false` and vice versa. |
| `/settings`    | ✅      | ✅   | ✅     | MAINTAINER| yes | Branding + policy. |
| `/settings/sso`| ✅      | ✅   | ✅     | **OWNER** | no — reached from inside /settings | SSO policy + providers + domain claims. |
| `/contracts`   | ✅      | —    | ✅     | MAINTAINER (page + API) | **yes** under `canSponsor && MAINTAINER+` | Round-2 close-out added `useRequireOrgAccess({minimumRole: "MAINTAINER", canSponsor: true})` + sidebar entry. |
| `/purchase-orders` | ✅  | —    | ✅     | MAINTAINER (page + API) | **yes** under `canSponsor && MAINTAINER+` | Receipt icon. |
| `/consent`     | ✅      | ✅   | ✅     | MANAGER (page + API) | **yes** under `MANAGER+` | ShieldCheck icon; DPDP artifact roster. |

> The `/plans` page (previous "org catalog" over the removed
> `OrganizationPlan` model) is gone. Discovery now reads each per-type
> plan's `OrgPlanVisibility` directly — see
> [public pages & discovery](24-public-pages-and-discovery.md). The matrix
> rows for the other recently-added surfaces (`/disputes`, `/documents`,
> `/trials`, `/waitlist`, `/recordings`, `/reimbursements`, `/audit`,
> `/integrations/*`) follow the same capability+role gating as their
> siblings and are enumerated in the page tree above.

### Billing surface

`/billing` is the **single** BillingAccount surface (invoices + payment terms +
pending charges); the wallet view is a tab (`billing/WalletTab.tsx`), not a
separate page. **There is no `/credits` route** — the old `/credits` alias was
collapsed, so the prior "two-page split" TODO is resolved: one URL, one route
guard, a `WalletTab` for WALLET-funded orgs. The NET-60 StatCard is conditional
on `fundingSource !== "WALLET"`.

## `/home` — the state-aware activation center

`/home` is not a static dashboard; it renders the org's **real next actions**
from one derived model. `home/page.tsx` is a thin server shell that renders
`HomePageClient`, which fetches `GET …/analytics` (+ `…/activity`), maps the
payload → an `OrgActivationSnapshot`, and runs two **pure** derivations from
`lib/enterprise/org-activation.ts`:

- **`deriveActionCenter(snapshot, orgId)`** → severity-ordered banners
  (`critical` / `warning` / `info`) for conditions that need action *now*:
  pending verification, suspended, overdue invoices, credit-pool cap ≥ 80%,
  contract expiring within 30 days, pending overages, **stuck payouts**, low
  wallet (< ₹1,000 `WALLET_LOW_BALANCE_PAISE`). Only conditions whose backing
  data exists today render — dunning/dispute banners arrive with their crons.
- **`deriveActivationChecklist(snapshot, orgId)`** → the Getting-Started steps,
  capability-aware: a SPONSOR runs verify → KYB(INVOICE) → billing → contract →
  program → invite → assign; a HOST-only org collapses to verify → invite. The
  checklist auto-hides once every applicable step is done.

Branching: `BILLING_ADMIN` gets a finance-tuned overview (`FinanceLeadViewCard`);
a sub-MANAGER who deep-links here sees a role-specific consumer card (deep-link
to `/my-program` or `/my-arrangement`); MANAGER+ gets the operator stat grid +
checklist + activity feed.

> **Honest "pending platform enablement" payout copy.** While
> `ENABLE_LIVE_PAYOUTS=false`, the server counts `PROCESSING` payouts and the
> action center renders *"N payouts pending platform enablement — payout
> disbursement isn't live yet; these are held, not failed."* The flag is read
> **server-side** (in `resolveActivationSignals`); when it's on, the stuck-payout
> count is forced to 0 so the banner disappears. The copy never calls a held
> payout a failure (see [feature flags](25-feature-flags-and-rollout.md)).

The derivations are pure (unit-testable without a DB); the few extra reads the
analytics payload doesn't carry (`hasContract`, expiring-soon count, KYB,
pending-overage sum, stuck-payout count, cap-near %) are done by
`resolveActivationSignals(orgId)`, which the analytics route merges in.

## Program / contract safe-field edit UI (config-lock)

The program and contract edit surfaces are **lock-aware** so an operator can't
even attempt a money-field edit that the server would 409. Both GET routes
return a derived `locked` boolean alongside the row (no second round-trip):

- **Programs** (`programs/page.tsx`): the edit dialog reads `program.locked`
  (`?? true` — fail-safe: lock until known). When locked it disables every money
  input, shows a `LockedHint` ("money config is locked — only the name can be
  changed"), and sends `name` alone. The server re-checks via
  `getProgramLockState` and 409s `PROGRAM_CONFIG_LOCKED` on any money field that
  slips through. Locking is triggered by the first assignment
  (`Program.configLockedAt`) — see [programs](21-programs.md).
- **Contracts** (`contracts/page.tsx`): the term-edit drawer disables the locked
  term fields (`effectiveFrom`, `effectiveTo`, `paymentTermsDays`) when the
  contract is in use; `autoRenew` stays editable (forward-looking). The server
  enforces `CONTRACT_TERMS_LOCKED` — see [contract lifecycle](26-contract-lifecycle.md).

The UI is convenience; the server is authoritative in both cases.

## DPDP data-export & consent surfaces

Two compliance surfaces sit under the org dashboard:

- **`/integrations/data-exports`** — DPDP §11 right-to-access. OWNER +
  BILLING_ADMIN request a bundle (rate-limited 1/24h via `orgDataExportLimiter`);
  a worker picks up the `OrgDataExportJob` within ~10 min, uploads to Supabase
  Storage, and the page exposes a 7-day signed-URL download. The page polls every
  15s while `PENDING`/`PROCESSING` and stops on terminal states
  (`READY`/`FAILED`/`EXPIRED`). (Model is `OrgDataExportJob` — not `OrgDataExport`.)
- **`/consent`** — DPDP consent-artifact roster. Lists active + withdrawn
  `ConsentArtifact`s and lets an admin grant/withdraw on a member's behalf, with
  withdraw at the same prominence as grant (DPDP §6(4)). Gated via
  `useRequireFinanceSurface` (OWNER + MAINTAINER + BILLING_ADMIN + MANAGER),
  mirroring the MANAGER floor on `…/consent`.

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
- `03-roles-and-permissions.md` — role gates at the API layer.
- `40-api-reference.md` — the route each page calls.
- [`25-feature-flags-and-rollout.md`](25-feature-flags-and-rollout.md) — the capability/flag gates that drive page visibility.
- [`26-contract-lifecycle.md`](26-contract-lifecycle.md) — the contract term-lock the edit drawer reflects.
