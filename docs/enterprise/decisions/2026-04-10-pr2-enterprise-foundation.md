# ADR: PR2 Enterprise Foundation Design

**Date**: 2026-04-10
**Status**: Accepted
**PR**: feature/enterprise (PR2), targeting `dev`

## Context

Familiarise needs an enterprise tier so schools, corporates, and (eventually) consultant agencies can sponsor consultations/webinars/classes for their students or employees. This ADR documents the four key decisions locked for PR2.

## Decisions

### 1. Dashboard layout — same dashboards + OrganizationSwitcher

**Decision**: Keep the existing `/dashboard/consultant/*` and `/dashboard/consultee/*` dashboards untouched. Add an `OrganizationSwitcher` dropdown to the existing `DashboardNavbar` (consultant + consultee) and the admin/staff layouts. Clicking an org navigates to `/dashboard/organization/[orgId]/home`.

**Rationale**: The user is one identity. Personal data lives in their personal dashboard; org-level data (seats, billing, members) lives in the org dashboard. No layout changes, no filter toggles, no branding overlays. Zero structural impact on the 22+ existing personal dashboard pages. The OrgSwitcher self-hides for users with zero org memberships.

**Alternatives rejected**: Separate org-branded layouts, org-specific theme overlays, org-scoped filter toggles in personal dashboards.

### 2. PROVIDER deferred via feature flag

**Decision**: The schema includes full PROVIDER models (`OrganizationKind.PROVIDER`, `OrganizationPayoutAccount`, `OrganizationPayout`, `OrganizationEarnings`, `ORG_CONSULTANT` role). Code paths exist but are gated behind the `ENABLE_PROVIDER_ORGS` env flag (default `false`). When false: API rejects PROVIDER org creation with 501; UI hides PROVIDER from the org-create form; earnings split takes the BUYER (unchanged) path.

**Rationale**: Single env toggle to flip the feature on for the first PROVIDER customer. No schema migration needed. No dead code branches in the meantime — the 501 responses serve as explicit "upgrade required" signals the dashboard can render.

**See**: `lib/feature-flags.ts`, Issue #646.

### 3. All three BUYER billing modes

**Decision**: Implement TAG_ONLY, SEAT_PACK, and INVOICED_MONTHLY in PR2.

- **TAG_ONLY**: learner pays at checkout; payment is tagged with `organizationProfileId` for org reporting. Default mode.
- **SEAT_PACK**: org owner pre-purchases credits; learner checkouts deduct from the credit pool instead of hitting the gateway.
- **INVOICED_MONTHLY**: learners book freely; the org gets a NET-X invoice at month-end (manual trigger via API; Inngest cron is a follow-up).

**Rationale**: All three modes require the same schema foundation (OrganizationProfile, OrganizationMemberProfile, OrgCreditPool, OrganizationInvoice). Implementing them together avoids revisiting the checkout branching logic. The manual invoice generation endpoint covers testing without waiting for the Inngest cron.

### 4. Full SSO admin UI in PR2

**Decision**: Enable BetterAuth's SSO plugin, add per-org SAML/OIDC config via the `ssoProvider` table, build the `/settings/sso` dashboard page, and expose a domain-check API endpoint for signin routing.

**Rationale**: SSO is a hard requirement for enterprise customers (schools with Google Workspace, corporates with Okta/Azure AD). The `@better-auth/sso` plugin provides the SAML/OIDC machinery; we add the org-scoped policy layer (`OrganizationSSOSettings`) and the admin UI. Domain-based signin routing is implemented via a lightweight `/api/auth/sso/domain-check` endpoint rather than middleware Prisma queries (which aren't edge-compatible).

## Consequences

- PR2 adds ~90 files (schema, 25 API routes, 15 dashboard pages, OrgSwitcher, invite page, checkout/refund extensions, SSO endpoint, docs).
- The Inngest monthly invoice cron is deferred to a follow-up.
- Invoice PDF rendering deferred to Issue #438.
- PROVIDER earnings split enforcement deferred to the flag flip.
- The existing B2C experience is unchanged — the OrgSwitcher is invisible for users with no org memberships.
