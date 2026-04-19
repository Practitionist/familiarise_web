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
| 11 | `11-public-pages-and-discovery.md` | Catalog, search, and the `/organizations/public` route. |
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
| — | `org-billing-playbook-sales.md` | Non-technical pitch framed around capability pairs + funding. |
| — | `org-billing-playbook-technical.md` | Technical playbook for every capability × funding combo. |
| — | `sso-testing-guide.md` | Mock IdP recipes for local + CI SSO tests. |

## Ground-truth files

Every doc below defers to the following files when the prose drifts:

- `prisma/schema.prisma` — the schema is the source of truth. Docs cite
  model and field names verbatim.
- `lib/labels/org-labels.ts` — capability, role, status, and funding-source
  labels + Zod narrowers consumed by dashboard and wizard code.
- `lib/enterprise/audit-actions.ts` — the typed constant object that backs
  every `OrgAuditLog.action` string we emit.
- `lib/auth.ts` (the `customSession` hook) — the live session payload.
- `lib/auth-helpers.ts` — `requireOrgAccess`, `requireOrgOwner`,
  `ORG_ROLE_RANK`, and `normalizeLegacyRole`.
- `lib/api/organizations/{wallet,program-helpers,rate-card,hierarchy}.ts`
  — the transactional primitives referenced across the ledger, program,
  rate-card, and hierarchy docs.

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
