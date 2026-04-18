# Arch 4-Modified — Changelog & Migration Notes

**Status:** Issue #681, April 2026. Pre-MVP clean-slate.

## TL;DR

The enterprise layer was redesigned as a capability-driven,
contract-based, program-typed system. Five architectures were debated;
**Arch 4-Modified** won per user-survey (see Issue #681 comments).

### Kind mapping

| Old `OrganizationKind` | New |
|---|---|
| `BUYER` | `canSponsor=true, canHost=false` |
| `PROVIDER` | `canSponsor=false, canHost=true` |
| `HYBRID` | `canSponsor=true, canHost=true` |

### Billing-mode mapping

| Old `OrganizationBillingMode` | New mechanics |
|---|---|
| `TAG_ONLY` | No Program. `Payment.organizationId` tag only. `BillingAccount` optional. |
| `SEAT_PACK` | `Program(type=CREDIT_POOL)` + `BillingAccount.fundingSource=WALLET`. Single `WalletEntry` ledger replaces `OrgCreditPool`+`OrgCreditLedger`+`OrgCreditPurchase`. |
| `INVOICED_MONTHLY` | `BillingAccount.fundingSource=INVOICE` + `Contract.paymentTermsDays=60` + optional `Program(LICENSED_SEAT|CREDIT_POOL)`. PurchaseOrder first-class. Invoice carries IRN + GST. |
| `PREPAID_UNLIMITED` | `Program(type=LICENSED_SEAT)` with `coveredSessionsPerCycle=null` + `BillingSubscription(model=FLAT_FEE)`. |

## HYBRID money direction

- `canSponsor=true` → org **PAYS** when members book.
- `canHost=true` → org **EARNS** when consultees book its consultants.
- For HYBRID, both flows run independently via the 3-ledger discipline
  (Usage / Funding / Settlement).
- Internal bookings (HYBRID member → HYBRID consultant):
  `Membership.payoutRecipient=ORGANIZATION` makes the consultant
  salaried (org absorbs consultant slice).

## Cohort elimination

Per user-survey decision in Issue #681: **no `Cohort` model**. The
existing `Class` / `ClassPlan` already expresses cohort-like group
learning (multi-participant, scheduling period, waitlist, curriculum).
Adding a `Cohort` model would duplicate that structure.

## Eliminated models / enums

- `OrganizationProfile` — merged into `Organization`
- `OrganizationMemberProfile` — unified into `Membership`
- `OrgCreditPool` + `OrgCreditLedger` + `OrgCreditPurchase` — replaced by
  `WalletEntry` + `FundingLedgerEntry`
- `OrganizationKind` enum — capability booleans
- `OrganizationBillingMode` enum — `FundingSource` + `Program.type`
- `OrgMemberRole` enum — `MemberRole` (role values renamed: `ORG_OWNER`→
  `OWNER`, `ORG_LEARNER`→`MEMBER`)
- `EarningsRecipient` enum — `PayoutRecipient`
- `PayoutFrequency` enum — absorbed into `BillingCycle` where needed

## New models added

- `Membership` — unified typed member (supersedes BetterAuth `Member` +
  `OrganizationMemberProfile`)
- `BillingAccount` — funding source decoupled from org
- `Contract` — negotiated commercial relationship
- `BillingSubscription` — PER_SEAT (renamed from PEPM) or FLAT_FEE
- `WalletEntry` — credit/debit ledger
- `Program` + `LicensedSeatConfig` + `CreditPoolConfig` — typed offerings
- `ProgramAssignment` + `BookingUtilization` — per-member entitlement
- `RateCard` — basis-point splits with plan/tier scope
- `PurchaseOrder` — India AP 3-way match
- `UsageLedgerEntry` + `FundingLedgerEntry` + `SettlementLedgerEntry` —
  three-ledger discipline
- `ConsentArtifact` + `DataBreach` — DPDP
- `HrisConfig` + `HrisSyncJob` + `HrisEmployeeMap` — HRIS scaffold

## New enum values (reserved for v2)

- `ProgramType.PROJECT` + `ProgramType.RETAINER` — Catalant/Toptal
  engagement types; no sub-config tables in v1, checkout returns 501
  if encountered.
- `PayoutArrangement.AOR` + `PayoutArrangement.EOR` — Agent-of-Record +
  Employer-of-Record (MBO Partners model). v1 supports DIRECT only.

## Deferred (not in v1)

- Parent-child org tree UI (columns exist, no UI)
- Full `ConsultingFirm` agency tier
- Scope + 6 Policy entities + PersonaAssignment/RoleAssignment split (Arch 2/5)
- Live IRN uploader + TDS engine + MSME alerts + Form 15 workflow

## India compliance surface

All 9 India primitives are schema-final with stubbed logic. See
[`docs/compliance/india/07-stubs-and-implementation-plan.md`](../compliance/india/07-stubs-and-implementation-plan.md)
for the live-implementation checklist.

## Files touched in this PR (summary)

- **Schema:** `prisma/schema.prisma` — 875 insertions / 401 deletions, schema validates cleanly.
- **Seed:** `prisma/seedFiles/15a-create-organizations.ts` — rewritten for 4 org shapes.
- **Server libs:** 10 new files in `lib/compliance/**` and
  `lib/api/organizations/{hierarchy,wallet,program-helpers}.ts`.
- **API routes:** 35 handlers stubbed to 501 with `@arch4-stub` markers;
  critical lib flows (checkout, earnings, onboarding) rewritten for new schema.
- **Dashboard:** 4 new scaffold pages (contracts/programs/purchase-orders/consent);
  existing pages continue to work via session-shape compat shim.
- **Cron stubs:** `jobs/compliance/**` × 3 + `jobs/billing/generate-subscription-invoices.ts` (real).
- **Docs:** `docs/compliance/india/**` new series + this changelog.

## Verification

- `npx prisma validate` — ✅ clean
- `npx tsc --noEmit` — ✅ exit 0 (zero errors)
- `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` — produces 3536-line init migration.
- `npm run db:seed` — pending user DB reset (migrations are gitignored per repo policy).

## Production-readiness snapshot

| Axis | Score / 20 | Notes |
|---|---|---|
| Schema finality | 18 | All fields locked; only v2 Program subtypes left |
| Business logic coverage | 10 | WALLET debit + LICENSED_SEAT entitlement wired; API routes stubbed |
| India compliance depth | 8 | Schema final + stubs + extensive docs; live crons deferred |
| Test coverage | 4 | Existing tests not re-run; new flows pending E2E |
| Documentation | 18 | Extensive (this file + compliance series + plan file) |
| **Total** | **58/100** | Projected; rises with Phase 2b PRs |

Phase-2b roadmap:
- `+8` when 35 stubbed routes rehydrate (→ 66)
- `+10` when India cron stubs go live (→ 76)
- `+10` when E2E test suite re-passes (→ 86)
- `+10` when ConsultingFirm + AOR/EOR + PROJECT/RETAINER ship (→ 96)
- Final 4 reserved for post-launch hardening.
