# Enterprise layer — overview

> **Scope:** organization primitives, programs, wallets, contracts, invoices,
> payouts, SSO, consent, HRIS, audit log.
> **Audience:** engineers working on anything under `app/api/organizations/**`,
> `app/api/admin/organizations/**`, `app/dashboard/organization/**`, and the
> related `lib/api/organizations/**`, `lib/labels/org-labels.ts`,
> `lib/enterprise/**` modules.

The enterprise layer is a capability-driven B2B surface on top of the
marketplace. Every organization is defined by two orthogonal booleans and
(if it sponsors) one funding source; every API gate reads from a typed
`Membership` row rather than from BetterAuth's own member table.

## Mental model

An organization is described by two axes:

1. **Capability** — what the org is allowed to do.
   - `canSponsor`: pays for its members' sessions.
   - `canHost`: hosts experts who earn through the org.
   - Both true → HYBRID. Both false → INERT (transitional; rejected at
     create time).
2. **FundingSource** — *how* sponsored sessions are paid for. Set on the
   single `BillingAccount` row that belongs to a sponsor org. Values:
   `PERSONAL`, `WALLET`, `INVOICE`, `LICENSE`, `PROJECT` (v2-reserved).

The third primitive — **Program** — is where the commercial terms live.
Every booking that an org sponsors is attributed to a Program, and every
Program subtype (`LICENSED_SEAT`, `CREDIT_POOL`) is a row in its own
config table. See `16-programs.md`.

### `OrgAdminProfile`

Orthogonal to Membership: `OrgAdminProfile` is a per-user profile row
(mirrors `StaffProfile` / `AdminProfile`) that exists for any user who
operates at least one org. `POST /api/organizations` provisions one
inside the creation transaction; `prisma/scripts/backfill-org-admin-profiles.ts`
covers existing OWNERs. The profile id surfaces on the BetterAuth
session and backs the operator home at
`/dashboard/org-admin/:orgAdminId/home`, which redirects single-org
operators straight into that org, shows a chooser for multi-org
operators, and a "create an organization" CTA for operators whose
orgs have all been deactivated. See
`docs/onboarding/onboarding-system-reference.md` §0 for the full
profile-model roster.

```
Organization                       BillingAccount (at most one per org)
┌──────────────────────────────┐   ┌──────────────────────────────────┐
│ canSponsor, canHost          │1:1│ fundingSource                     │
│ status                       │◄──┤ walletBalance (WALLET only)       │
│ capabilitiesExtra (Json)     │   │ creditLimit   (INVOICE only)      │
│ parentId/rootId/depth        │   └────────┬─────────────────────────┘
└──────────────┬───────────────┘            │
               │ memberships[]             contracts[]
               │                            ▼
        ┌──────┴────────────┐       ┌─────────────────────────────────┐
        │ Membership        │       │ Contract                         │
        │ role (MemberRole) │       │ effectiveFrom/To, paymentTerms  │
        │ status            │       │ rateCardId, programs[]          │
        │ payoutRecipient   │       └──────────┬──────────────────────┘
        │ rateCardOverride  │                  │
        └────────┬──────────┘                  ▼
                 │                       ┌──────────────────────────┐
                 │ programAssignments[]  │ Program (LICENSED_SEAT | │
                 └──────────────────────►│         CREDIT_POOL)      │
                                         │   licensedSeatConfig     │
                                         │   creditPoolConfig       │
                                         └──────────────────────────┘
```

## Index

| # | Doc | Focus |
|---|-----|-------|
| 00 | `00-overview.md` | This file. |
| 01 | `01-organization-types.md` | Capability booleans, the INERT guard, HYBRID semantics. |
| 02 | `02-funding-and-programs.md` | `FundingSource` enum and Program subtypes; old-name mapping. |
| 03 | `03-earnings-and-revenue.md` | `RateCard` resolution, bps math, snapshot fields. |
| 04 | `04-roles-and-permissions.md` | Unified `MemberRole` rank ladder + every API gate. |
| 05 | `05-organization-lifecycle.md` | `OrgStatus` state machine; contract and program lifecycles. |
| 06 | `06-expert-lifecycle.md` | Expert apply/approve; `PayoutRecipient`. |
| 07 | `07-payout-pipeline.md` | Earnings roll-up, `OrganizationPayout` cron, India statutory fields. |
| 08 | `08-sso-and-authentication.md` | `OrganizationSSOSettings`, `SsoProvider`, `OrgDomainClaim`. |
| 09 | `09-wallet-and-ledger.md` | `WalletEntry`, `FundingLedgerEntry`, atomic debit. |
| 10 | `10-invoicing.md` | `OrganizationInvoice`, GST breakdown, IRN, PO 3-way match. |
| 11 | `11-public-pages-and-discovery.md` | Org catalog, ILIKE search, and how org identity surfaces on the marketplace explore page. |
| 12 | `12-dashboard-pages.md` | Every page under `app/dashboard/organization/[orgId]/**`. |
| 13 | `13-feature-flags-and-rollout.md` | `ENABLE_PROVIDER_ORGS` + capability-gated UI. |
| 14 | `14-scenarios-and-examples.md` | Four worked end-to-end scenarios. |
| 15 | `15-concurrency-and-locking.md` | Atomic patterns in `lib/api/organizations/**`. |
| 16 | `16-programs.md` | Program / assignment / `BookingUtilization` internals. |
| 17 | `17-hierarchy.md` | `parentId` / `rootId` / `depth` columns; UI deferred. |
| 18 | `18-three-ledger-discipline.md` | Usage / Funding / Settlement ledger invariants. |
| 19 | `19-harness-verdict.md` | Scenario-by-scenario verdict table. |
| 20 | `20-payment-legs.md` | `PaymentLeg` model and stackable funding. |
| 21 | `21-api-reference.md` | Exhaustive route table with roles and audit actions. |
| 22 | `22-route-migration-table.md` | Old-route → new-route map. |
| 23 | `23-runbooks.md` | Incident-response procedures + scheduled operational tasks. |
| 24 | `24-monitoring.md` | Log event taxonomy, alert thresholds, dashboards. |
| 25 | `25-idempotency-keys.md` | Every side-effect endpoint's idempotency key + anti-patterns. |

### `explainers/` — narrative high-level docs

| File | Purpose |
|------|---------|
| `explainers/business.md` | Non-technical pitch & business context for the enterprise subsystem. |
| `explainers/technical-assessment.md` | Engineering assessment of the enterprise architecture. |
| `explainers/complete-guide.md` | End-to-end walkthrough across all enterprise concepts. |
| `explainers/billing-architecture.md` | Billing-account / funding-source / contract / program architecture. |

### `reference/` — lookup-style docs

| File | Purpose |
|------|---------|
| `reference/money-glossary.md` | Plain-English definitions of Refund / Reimbursement / Payout / Referral / Credits + all ~45 money-related models and enums. **Start here if a money term is confusing.** |
| `reference/schema-diagram.md` | Visual map of the enterprise Prisma schema. |

### `playbooks/` — actionable how-tos

| File | Purpose |
|------|---------|
| `playbooks/billing-sales.md` | Non-technical pitch framed around capability pairs + funding. |
| `playbooks/billing-technical.md` | Technical playbook for every capability × funding combo. |
| `playbooks/sso-testing.md` | Mock IdP recipes for local + CI SSO tests. |

## Ground-truth files

Every doc below defers to the following files when the prose drifts:

- `prisma/schema.prisma` — the schema is the source of truth. Docs cite
  model and field names verbatim.
- `lib/labels/org-labels.ts` — capability, role, status, and funding-source
  labels + Zod narrowers consumed by dashboard and wizard code.
- `lib/enterprise/audit-actions.ts` — the typed constant object that backs
  every `OrgAuditLog.action` string we emit.
- `lib/enterprise/role-transitions.ts` — `isBlockedRoleTransition`, the
  single source of truth for the disjoint LEARNER ↔ EXPERT rule.
- `lib/labels/personal-dashboard.ts` — `resolvePersonalDashboardHref`
  (priority: `orgAdminProfile → consultantProfile → consulteeProfile`).
- `lib/labels/org-errors.ts` — humanized copy for `ORG_NOT_VERIFIED`
  and `ROLE_TRANSITION_BLOCKED` (surfaced via `humanizeOrgError`).
- `lib/profiles/ensure-consultee-profile.ts` — lazy
  `ensureConsulteeProfile(db, userId)` called from checkout, slot
  request-for-approval, and LEARNER invite accept.
- `lib/auth.ts` (the `customSession` hook) — the live session payload;
  also the `databaseHooks.user.create.after` hook, which no longer
  force-creates a `ConsulteeProfile` on signup.
- `lib/auth-helpers.ts` — `requireOrgAccess`, `requireOrgOwner`,
  `orgRoleSatisfies`, and `ORG_ROLE_RANK`.
- `lib/api/organizations/{wallet,program-helpers,rate-card,hierarchy}.ts`
  — the transactional primitives referenced across the ledger, program,
  rate-card, and hierarchy docs.
- `types/org-details.ts` — shared `OrgDetailsResponse` shape +
  `flattenOrgDetails` helper; consumed by the org layout and
  `useOrgRole`.

## Session shape

The customSession hook flattens each active membership into:

```
{
  organizationId,
  organizationName,
  organizationSlug,
  organizationLogo,
  role,                // MemberRole
  departmentLabel,
  canSponsor,
  canHost,
  fundingSource,       // FundingSource | null
  walletBalance        // int paise | null
}
```

There is no `kind`, `billingMode`, `creditBalance`, `contractEndDate`, or
`organizationProfileId` on the session anymore. UI code derives the badge
via `deriveCapabilityKind(canSponsor, canHost)` and reads fundingSource
directly — labels come from `lib/labels/org-labels.ts`.

At the user level (outside the `organizationMemberships[]` list) the
session also carries the four profile-id FKs — `consultantProfileId`,
`consulteeProfileId`, `staffProfileId`, `adminProfileId`,
`orgAdminProfileId` — surfaced from `lib/auth.ts` so client code can
resolve the "Personal Dashboard" href via
`resolvePersonalDashboardHref` without re-querying the DB.

## Seed / production-shaped grid

For local development, tour rehearsals, and any agent reasoning about
"what the dashboard should look like for a real org", refer to the
deterministic cohort below. Slugs and emails are stable handles —
prefer them over raw IDs in tests, prompts, and docs (IDs change
across `prisma migrate reset`). Source: `prisma/seedFiles/15a-create-organizations.ts`.

| Slug | Capability | Funding | Program | Notes |
|---|---|---|---|---|
| `wipro` | Sponsor (canSponsor=true, canHost=false) | INVOICE | LICENSED_SEAT | PO + draft monthly invoice; pure buyer-side. |
| `learnpro-academy` | Host (canSponsor=false, canHost=true) | — | — | Payout account + 10/10/80 RateCard + EXPERT memberships. |
| `iit-madras` | Hybrid (canSponsor=true, canHost=true) | WALLET | CREDIT_POOL | Both money flows live in parallel. |
| Rahul's solo org | Host (canSponsor=false, canHost=true) | — | — | Single-consultant convenience org; dynamic slug. |

**Tour owner:** `tour-owner@familiarise.dev`, password from
`SEED_PASSWORD` (default `SeedPass123!`). Created with
`UserRole = ORG_ADMIN` and `OrgAdminProfile`; OWNER of `wipro` so
the operator portfolio (`/dashboard/org-admin/<id>/home`) renders
populated on first sign-in.

`19-harness-verdict.md` cross-references this grid for the harness
table; if a row here changes, update both files together.
