# V0 Lockdown — End-to-End Test Guide

This walkthrough exercises every surface touched by the `feat/enterprise-v0-lockdown` mega PR (#768 + #769). It assumes the DB has been reset and reseeded from `prisma/seedFiles/*` and the dev server is running. Use it as the manual-acceptance checklist before merging into `feature/enterprise`.

---

## 1 — Prerequisites

```bash
# 1. Pull the lockdown branch.
git fetch origin feat/enterprise-v0-lockdown
git checkout feat/enterprise-v0-lockdown

# 2. Install deps (idempotent).
npm install

# 3. Generate Prisma client + run the single v0 migration.
npx prisma migrate dev --name v0_lockdown

# 4. Reset + reseed. The seed orchestrator creates ~6 demo orgs and
#    routes them through the 7 reachable funding paths.
npx prisma db seed

# 5. Start the dev server.
npm run dev
```

If `migrate dev` reports drift, run `npx prisma migrate reset --force` first — pre-MVP no production data is at risk.

---

## 2 — Test credentials

All seeded users share `SeedPass123!` as password (override via `SEED_PASSWORD` env).

| Persona | Email | Use in tests |
|---|---|---|
| Platform admin | `admin@familiarise.work` | Maintenance windows, system events, admin-only routes |
| Wipro org owner (SPONSOR + INVOICE + LICENSED_SEAT) | `wipro-owner@familiarise.work` | Funding path 3.4 |
| Wipro learner | `wipro-learner-01@familiarise.work` | Bookings under Wipro path |
| Tata org owner (HOST only) | `tata-owner@familiarise.work` | Funding path 3.6 |
| Infosys org owner (HYBRID) | `infosys-owner@familiarise.work` | Funding path 3.7 |
| IIT Madras (SPONSOR + WALLET + CREDIT_POOL) | `iit-owner@familiarise.work` | Funding path 3.2 |
| PERSONAL consultee | `priya.personal@familiarise.work` | Reimbursement flow |
| Expert (consultant) | `expert.demo@familiarise.work` | Receives payouts |

Membership-role variants:
- BILLING_ADMIN: `billing-admin@wipro.familiarise.work`
- MANAGER: `manager@wipro.familiarise.work`
- LEARNER: any `wipro-learner-NN@...`

---

## 3 — Walk all 7 reachable funding paths

The reachable-paths matrix is canonical: see `lib/enterprise/reachable-paths.ts`. The seed creates one representative org per path.

### 3.1 PERSONAL tag-only

1. Sign in as `priya.personal@familiarise.work`.
2. Visit `/explore/experts` → book any consultation paying with her own card (test mode).
3. Verify the resulting `Payment.organizationId` is set to her org membership (the org sees her spend in `/dashboard/organization/[orgId]/reimbursements`).
4. Confirm `Appointment.organizationId` is also stamped (per the booking-org-stamping fix; see §7).

### 3.2 SPONSOR + WALLET + CREDIT_POOL (IIT Madras)

1. Sign in as `iit-owner@familiarise.work`.
2. `/dashboard/organization/[orgId]/billing` — verify wallet balance > 0 (seeded ₹50,000 credits).
3. Sign in as an IIT learner. Book a consultation → wallet debits at checkout. Verify `BookingUtilization.priceAtBookingPaise > 0` in DB.

### 3.3 SPONSOR + INVOICE + CREDIT_POOL

1. Use the same Tata or Wipro path with `creditPoolConfig.creditsPerCycle = 100` and `overageBehavior = BLOCK`.
2. Each booking accrues to `OrganizationInvoice` at month-end via `jobs/billing/generate-subscription-invoices.ts`.

### 3.4 SPONSOR + INVOICE + LICENSED_SEAT (Wipro)

1. `wipro-owner@familiarise.work` → `/dashboard/organization/[orgId]/programs` shows the Engineer Leadership Program with `coveredEngagementsPerCycle = 12`.
2. Wipro learner books a class → check `ProgramAssignment.engagementsUsed += N`.
3. Wait until cycle close → `OrganizationInvoice` row appears with `lineItems` rows (one per accrued booking).

### 3.5 SPONSOR + LICENSE + LICENSED_SEAT

1. Same flow as 3.4 with `fundingSource = LICENSE`. Flat-fee subscription cron generates ONE invoice per cycle (no overage line items).

### 3.6 HOST only (Tata)

1. Sign in as `tata-owner@familiarise.work`.
2. `/dashboard/organization/[orgId]/payouts` — list shows `OrganizationPayout` rows due to Tata-hosted consultant earnings.
3. Verify a Tata-hosted consultant has Earnings rows with `consultantSharePaise` (renamed from `consultantShare` in lockdown #9).

### 3.7 HYBRID (Infosys)

1. Combination of 3.2 + 3.6.
2. A booking routed through Infosys generates BOTH a wallet debit AND a consultant earnings row, with a RateCard-driven split.

---

## 4 — Coming Soon surface inventory

Visit each route signed in as an org admin who would naturally use it; confirm the UI renders the `<ComingSoonBadge>` and the API returns 501 with `code: "FEATURE_PENDING"`.

| Surface | Route | Feature key |
|---|---|---|
| Overage charging | `/dashboard/organization/[orgId]/programs` action menu | `overage_charging` |
| SCIM | `/dashboard/organization/[orgId]/settings/integrations/scim` | `scim` |
| HRIS | `/dashboard/organization/[orgId]/settings/integrations/hris` | `hris` |
| DPDP self-serve erasure | `/dashboard/consultee/[id]/settings/privacy` | `dpdp_erasure_self_serve` |
| Refund v2 | `/dashboard/organization/[orgId]/billing/refunds/new` | `refund_v2` |
| Credit notes | `/dashboard/organization/[orgId]/billing/invoices/[id]` | `credit_notes` |
| TDS automation | `/dashboard/organization/[orgId]/payouts/settings` | `tds_automation` |
| Form 26Q | `/dashboard/organization/[orgId]/compliance/tax-filings` | `form_26q_export` |

Each 501 response writes an `OrgAuditLog` row (`feature` in `details`) for demand signal.

> **Note:** the per-route wiring of these stubs is deferred — the helper (`lib/api/feature-pending.ts:respondFeaturePending`) and component (`components/enterprise/ComingSoonBadge.tsx`) are shipped, but each surface needs a wrapper route returning 501. Track per-surface progress in #768 Comment 10 Wave 4 closeout.

---

## 5 — DPDP §7 consent withdrawal

1. Sign in as `priya.personal@familiarise.work`.
2. Navigate to `/settings/consent` (route deferred to follow-up PR; verify the existing admin DPDP §11 export still works at `/settings/data-export`).
3. Trigger a consent grant + withdrawal via the existing `ConsentArtifact` admin path.
4. Verify the row appears in `ConsentArtifact` table with `withdrawnAt` stamped.

---

## 6 — OverageEvent verification

1. As Wipro owner, set a program with `licensedSeatConfig.coveredEngagementsPerCycle = 2` and `overageBehavior = CHARGE_ORG`, `maxOveragePerCyclePaise = 100000` (₹1,000).
2. Have a Wipro learner book 3 consultations (1 over cap).
3. Inspect the DB:
   - The 3rd booking generates a `BookingUtilization` row with `wasOverage = true`.
   - An `OverageEvent` row is created with `settledAt = null` and `marginalPaise > 0`.
   - The total `OverageEvent.marginalPaise` for the cycle is below the circuit-breaker ceiling.
4. Have a 4th booking attempt to push past `maxOveragePerCyclePaise` → circuit breaker activates; the booking falls back to BLOCK (returns the standard cap-exceeded error).

> **Note:** the cycle-close cron (`jobs/billing/settle-overage-events.ts`) that converts `OverageEvent` rows into `InvoiceLineItem` rows is deferred to a follow-up PR. The schema foundation + circuit breaker land in this PR.

---

## 7 — Booking-org-stamping verification (#19)

1. **SUBSCRIPTION lazy allocation:** Wipro learner subscribes to a plan with `callsPerWeek = 1` → consultant allocates 4 weekly slots → every `Appointment.organizationId` = Wipro's id (was null before fix).
2. **CLASS pre-allocation:** Expert creates a 6-session class against an Infosys-hosted ClassPlan → all 6 stub Appointments carry `organizationId = Infosys.id` (host wins per #768 design decision).
3. **CLASS enrolment:** Wipro learner enrols in Infosys-hosted class → enrolment links the learner to existing slots; the slot's org tag stays Infosys (locked host). Wipro funding visible via `Payment.organizationId`.
4. **WEBINAR (shared):** Wipro learner registers for a Tata-hosted webinar → webinar `Appointment.organizationId` = Tata (shared per design). Wipro's funding visible via `Payment.organizationId`.
5. Run `SELECT * FROM appointments WHERE organization_id = '<wipro-id>'` — count matches expected (consultations + subscription allocations + class enrolments under Wipro, excluding shared webinars/classes).

Test contract: `__tests__/enterprise/appointment-org-stamping.test.ts`.

---

## 8 — Schema lockdown verification

```bash
# These greps MUST return nothing — they assert each lockdown drop landed.
grep -E "FundingSource\.PROJECT|ProgramType\.PROJECT|ProgramType\.RETAINER" prisma/schema.prisma
grep -E "capabilitiesExtra|^\s*pan\s+String|^model Invoice\s|^model Payout\s|^model HrisConfig" prisma/schema.prisma
grep -E "Contract\.terms|MaintenanceWindow.*metadata|Organization\.metadata\b" prisma/schema.prisma

# Each of the renames + adds MUST appear at least once.
grep -E "^model ConsultantPayout|^model InvoiceLineItem|^model OrgBrandingProfile|^model OverageEvent" prisma/schema.prisma
grep -E "consultantSharePaise|platformFeePaise|amountPaise" prisma/schema.prisma | head -3
grep -E "panEncrypted|panLast4|taxJurisdiction|kybVerifiedAt|sumsubApplicantId" prisma/schema.prisma | head -10

# Per-type OrgPlan child models.
grep -E "OrgConsultationPlanConfig|OrgSubscriptionPlanConfig|OrgWebinarPlanConfig|OrgClassPlanConfig" prisma/schema.prisma | head -5

# Prisma schema must be valid.
npx prisma validate
```

```bash
# Tests
npm test -- __tests__/enterprise/

# Specific new tests
npm test -- __tests__/enterprise/appointment-org-stamping.test.ts
npm test -- __tests__/enterprise/reachable-paths.test.ts
```

```bash
# Static analysis
NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit
npm run lint
```

---

## 9 — What stays parked for follow-up PRs

These items from the #768 lockdown checklist are intentionally deferred to keep the mega PR reviewable. Each will land as a focused follow-up:

- **OverageEvent cycle-close cron** (`jobs/billing/settle-overage-events.ts`) — schema landed; cron is its own PR.
- **DPDP §7 withdrawal UI** (`/settings/consent` page + cron) — surface area benefits from focused review.
- **Outbound webhook signature rotation grace** (~200 LoC across `lib/webhooks/outbound/`) — customer-facing feature.
- **Per-surface wiring of the 8 Coming Soon stubs** — helper + component shipped; per-route stubs are mechanical.
- **35→12 docs restructure** — purely doc-mechanical; will land as a separate doc PR for clean review.
- **#715 overage charging logic** — stays parked per original spec.
- **#716 refund v2 / payout reversal / credit notes** — stays parked.
- **#735 OrgAdmin → OrgWorkspace mechanical rename** — stays parked (360 files; ship post-lockdown).

---

## 10 — Auto-close mapping (PR description checklist)

When the PR is merged, GitHub will auto-close:

- `Closes #768` — Enterprise mega-audit — v0 schema freeze decisions
- `Closes #769` — Enterprise compliance via vendor APIs — build vs buy matrix per area
- `Closes #674` — Personal vs org scope split (RFX-7 dashboard scope filter rename)
- `Part of #687` — Invoice fraud threat model (KYB stub closes part)
- `Part of #708` — Redundancy/dedup tracker (legacy Invoice drop)
- `Part of #745` — Enterprise simplification successor
- `Part of #746` — Enterprise additions roadmap

Each linked issue's open follow-up scope is tracked under the parked-items list in #9.
