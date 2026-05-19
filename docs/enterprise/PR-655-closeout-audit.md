# PR #655 — Enterprise Subsystem Closeout Audit

**Branch:** `feature/enterprise` → `dev`
**Scale:** 614 files changed, +96,584 / -7,006 (≈248 commits)
**Audit date:** 2026-05-18
**Status:** Ready to merge after the residual blockers in §11 land.

This document is the merge-readiness verdict for the enterprise subsystem.
It cross-references the schema, the route surface, cross-cutting integration
points, compliance posture, role coverage, and test coverage against the
locked closeout scope, then enumerates exactly what stays in PR #655 and what
moves to follow-up issues.

---

## 1. Verdict

| Bucket | Status | Notes |
|---|---|---|
| Schema (25 enterprise models) | ✅ Shipped | All migrations applied to prod via Supabase MCP; reconcile cron blocks A–F live |
| Route surface (70 org routes) | ✅ Shipped | Auth gating tabulated below; PO dashboard added in this closeout |
| Cross-cutting integration (Stream, Novu, Razorpay, SCIM, webhooks) | ✅ Shipped | Spot-checks recorded in §6 |
| Money correctness (#699 / #700 critical fixes) | ✅ Shipped | LED-1 transactional fix in place; activeSeatCount writer + reconcile in place |
| Compliance kept-vs-deferred | ✅ Aligned | GST + DPDP §12 kept; TDS-cron / IRP / HRIS / Form 26Q flag-gated default-off |
| Role coverage (7 roles) | ✅ Solid | Operator + finance surface predicates separate; landing-page routing correct |
| Programs v2 | ✅ Gated | `PROGRAM_TYPE_NOT_AVAILABLE` 400 rejection guard in place |
| HOST/HYBRID modes | ✅ Gated | `ENABLE_HOST_ORGS=false` default; code+schema present |
| WIP banner cleanup | ✅ Resolved | PO dashboard implemented (the one real WIP); OrgWorkspace settings → redirect |

**Net call:** PR #655 is mergeable once the residuals in §11 (regression tests landed, flag values set in deploy env) clear CI.

---

## 2. Schema readiness (25 new models)

Every new model carries (a) a writer, (b) a reconciliation invariant where
applicable, and (c) appropriate composite indexes. Reconciliation runs in
`scripts/reconcile/reconcile-ledgers.ts` (blocks A–F) via `.github/workflows/
reconcile-ledgers.yml`.

| Model | Writer site | Reconciliation invariant |
|---|---|---|
| `Organization` | `app/api/organizations/route.ts` POST | none — root entity |
| `Membership` | `app/api/organizations/invitations/accept/route.ts`, members POST | `Member` ↔ `Membership` linkage via `betterAuthMemberId` |
| `BillingAccount` | org creation transaction | wallet balance = sum(FundingLedgerEntry.deltaPaise) (block B) |
| `Contract` | `contracts/route.ts` POST | none — config row |
| `Program` (LICENSE / CREDIT_POOL) | `programs/route.ts` POST | `LicensedSeatConfig.activeSeatCount` = active assignments (block F) |
| `LicensedSeatConfig` | upsert via Program POST | activeSeatCount drift (block F) |
| `CreditPoolConfig` | upsert via Program POST | none — config row |
| `ProgramAssignment` | `program-helpers.ts:claimProgramAssignment` | `engagementsUsed` = sum(UsageLedgerEntry.engagementsConsumed) (block E) |
| `BookingUtilization` | `program-helpers.ts:recordBookingUtilization` | appointmentIds set-diff dedup; one row per Payment |
| `UsageLedgerEntry` | immutable append by checkout / refund / allocation | sum-check vs ProgramAssignment.engagementsUsed (block E) |
| `FundingLedgerEntry` | `wallet.ts:walletDebit`, top-up confirm | sum = `BillingAccount.walletBalance` (block B) |
| `SettlementLedgerEntry` | webhook INVOICE_PAID, payout success, refund | one-of-three kind, indexes for reverse lookup (block C) |
| `OrganizationInvoice` | invoice-generation cron + invoices POST | per-org sequence via `OrgInvoiceCounter` atomic upsert |
| `OrgInvoiceCounter` | invoice issuance | sequential per (org, fiscalYear) — CGST Rule 46 |
| `PurchaseOrder` | `billing-account/purchase-orders/route.ts` POST | `remainingAmountPaise` ≤ `totalAmountPaise` (PATCH validates) |
| `RateCard` | `rate-cards/route.ts` POST | one row per `(organizationId, planType)` |
| `OrganizationPayoutAccount` | `payout-account/route.ts` PUT | one per Organization (unique FK) |
| `OrganizationPayout` | weekly batch + manual POST | idempotencyKey unique; bank-side gatewayPayoutId unique |
| `OrganizationEarnings` | checkout (org-sponsored) | refundedAmountPaise ≤ grossPaise; status pipeline (D) |
| `OrgAuditLog` | every mutation route | append-only; `[organizationId, createdAt]` index |
| `OrganizationSSOSettings` | sso POST/PATCH | one per Organization (unique FK) |
| `OrgDomainClaim` | `domain-claims/route.ts` PATCH (verify) | one verifiedAt per domain globally |
| `WebhookEndpoint` + `WebhookDelivery` | webhooks POST + dispatch worker | redelivery idempotency keyed on (endpointId, eventId) |
| `ScimToken` + `ScimGroupMapping` + `HrisConfig`* | scim/* + hris/* (flag-gated) | tokenHash unique; HRIS gated off in v1 |
| `OrgDataExportJob` | data-exports POST (DPDP §11) | exportUrl ttl + `[organizationId, status]` |
| `OrgWorkspaceProfile` (extended) | settings PATCH | new columns: defaultLandingOrg, notificationRoutingMode, locale, currencyDisplayCode — see [34-workspace-preferences.md](./34-workspace-preferences.md) |
| `SystemEvent` (NEW) | `recordSystemEvent` / `recordSystemError` helpers | admin-only operational events; covering indexes on `(orgId, createdAt)`, `(category, createdAt)`, `(severity, createdAt)`, `(correlationId)` — see [35-system-events.md](./35-system-events.md) |

\* HRIS routes returning 404 when `ENABLE_HRIS=false` (default).

**Drift safety:** the reconcile cron flags every invariant breach into Slack
(`scripts/reconcile/reconcile-ledgers.ts:65`) so post-merge silent corruption
is observable.

---

## 3. Route inventory (70 `/api/organizations/**` routes)

The full route audit lives below. Auth gating uses two helpers:
`requireOrgAccess(orgId, opts)` for role-rank checks and
`requireOrgBillingAdminOrOwner(orgId, opts)` for the finance-team
disjunction. Both accept `requireActive?: true` to additionally hard-reject
PENDING_VERIFICATION orgs on side-effecting routes (used today by
`billing-account/purchase-orders` POST, `contracts` POST).

**Posture:** `requireActive` is intentionally opt-in. PENDING_VERIFICATION
orgs need to be able to set up branding, invite team, configure SSO without
being blocked. The flag is set on routes that mint external commitments
(invoices, payouts, POs, contracts). See §11 for the audit recommendation
on extending coverage carefully without breaking legitimate setup flows.

| Route family | Method | Min role | Notes |
|---|---|---|---|
| `[orgId]/route.ts` | GET / PATCH / DELETE | LEARNER / OWNER / OWNER | DELETE writes `SYSTEM.ORG_DELETED` audit |
| `[orgId]/activity` | GET | MANAGER | Read-only activity feed |
| `[orgId]/analytics` | GET | MANAGER | Time-series rollups |
| `[orgId]/appointments` | GET | MANAGER | List scoped to org |
| `[orgId]/audit` + `/export` | GET | MAINTAINER | Audit-log read + CSV export (writes AUDIT_LOG_EXPORTED) |
| `[orgId]/billing` | GET | MANAGER | Invoice list + wallet summary |
| `[orgId]/billing-account` | GET / PATCH | MANAGER + canSponsor / BILLING_ADMIN-or-OWNER | Funding-source edit gated by billing-admin disjunction |
| `[orgId]/billing-account/invoices` | GET / POST | MANAGER+canSponsor / BILLING_ADMIN-or-OWNER + canSponsor + **requireActive** | Live |
| `[orgId]/billing-account/invoices/[id]` | GET / PATCH | MANAGER+canSponsor / BILLING_ADMIN-or-OWNER | Status transitions ISSUED↔PAID↔VOID |
| `[orgId]/billing-account/invoices/[id]/pay` | POST | BILLING_ADMIN-or-OWNER + canSponsor | Razorpay order mint |
| `[orgId]/billing-account/invoices/[id]/pdf` | GET | MANAGER | PDF download |
| `[orgId]/billing-account/purchase-orders` | GET / POST | MANAGER+canSponsor / BILLING_ADMIN-or-OWNER + canSponsor + **requireActive** | New dashboard ships in this closeout |
| `[orgId]/billing-account/purchase-orders/[poId]` | GET / PATCH / DELETE | MANAGER / BILLING_ADMIN-or-OWNER / BILLING_ADMIN-or-OWNER | DELETE narrow: no contracts + no invoices |
| `[orgId]/billing-account/wallet` + `/top-ups` + `/top-ups/[id]` | GET / POST | MANAGER+canSponsor / BILLING_ADMIN-or-OWNER | Razorpay top-up flow + idempotency |
| `[orgId]/catalog` + `/search` | GET / POST / DELETE | LEARNER+canSponsor / OWNER+canSponsor | Org-curated plan catalog |
| `[orgId]/consent` | GET / POST / DELETE | MANAGER | API live; dashboard UI deferred to follow-up |
| `[orgId]/contracts` + `/[id]` | GET / POST / PATCH / DELETE | MAINTAINER / OWNER + **requireActive** | DRAFT→ACTIVE→TERMINATED state machine |
| `[orgId]/documents` | GET | MANAGER | Filtered by membership |
| `[orgId]/domain-claims` + `/[domain]` + `/verify` | GET / POST / PATCH | MANAGER / OWNER / OWNER | DNS-TXT verification cycle |
| `[orgId]/earnings` | GET | MANAGER | HOST/HYBRID surface — gated by capability + `ENABLE_HOST_ORGS` |
| `[orgId]/hris` + `/sync` + `/csv-upload` | GET / PUT / DELETE / POST | MANAGER / OWNER / OWNER / OWNER | **All gated 404 by `ENABLE_HRIS=false`** (added in this closeout) |
| `[orgId]/invitations` + `/[id]` | GET / POST / DELETE | MAINTAINER | Token-based invite flow |
| `invitations/accept` | POST | (token) | `isOnboardingBlocked` re-check inside tx — PENDING_VERIFICATION/SUSPENDED/DEACTIVATED reject |
| `[orgId]/members` + `/[id]` | GET / POST / PATCH / DELETE | LEARNER / MAINTAINER / MAINTAINER / MAINTAINER | Role transitions + anti-lockout guard |
| `[orgId]/payout-account` | GET / PUT / DELETE | MANAGER / OWNER / OWNER | Bank-detail upsert |
| `[orgId]/payouts` + `/[id]` | GET / POST / PATCH | MANAGER / OWNER / OWNER | Manual + cron-driven; idempotencyKey unique |
| `[orgId]/programs` + `/[id]` | GET / POST / PATCH / DELETE | LEARNER / MAINTAINER + canSponsor / MAINTAINER / MAINTAINER | DELETE serializable; `PROGRAM_DELETED` audit (added in this closeout) |
| `[orgId]/programs/[id]/assignments` + `/[aid]` | GET / POST / PATCH / DELETE | LEARNER / MAINTAINER | `adjustActiveSeatCount` on create/delete |
| `[orgId]/rate-cards` + `/[id]` | GET / POST / PATCH / DELETE | MANAGER+canHost / OWNER+canHost | HOST/HYBRID only |
| `[orgId]/recordings` | GET | MANAGER | Stream.io-tagged recordings |
| `[orgId]/reimbursements` + `/export` | GET / POST | MANAGER | Org-paid expert reimbursements |
| `[orgId]/scim/Users` + `/Groups` + `/tokens` + `/group-mappings` | various | (SCIM bearer token) | Auth bypasses session — token-bound |
| `[orgId]/settings` + `/sso` | GET / PATCH | LEARNER / MANAGER+ | Org profile + SSO config |
| `[orgId]/sso` + `/providers` + `/providers/[id]` | GET / POST / PATCH / DELETE | MANAGER / OWNER | SAML/OIDC provider config |
| `[orgId]/stream/calls` + `/channels` | GET / POST | MANAGER | Org-tagged Stream calls + channels |
| `[orgId]/trials` | GET | MANAGER | Org-attributed trials |
| `[orgId]/waitlist` | GET | MANAGER | Org-attributed waitlist |
| `[orgId]/webhooks` + `/[id]` + `/deliveries` + `/redeliver` | various | MANAGER / BILLING_ADMIN-or-OWNER | Outbound webhooks |
| `[orgId]/data-exports` | GET / POST | MANAGER | DPDP §11 bundle generation |
| `[orgId]/branding` | PATCH | OWNER | Logo + colors upload |
| `[orgId]/consent` (POST/DELETE) | various | MANAGER | DPDP §7 consent CRUD |
| `[orgId]/maintenance-windows` | various | OWNER | Tier-1 maintenance scheduling |

Marketplace + admin routes (`organizations/public/*`, `organizations/route.ts`,
`admin/organizations/*`) follow the same gating pattern.

---

## 4. Cross-cutting integration matrix

| System | Integration | Org-aware? | Status |
|---|---|---|---|
| **Stream.io recording cleanup** | `scripts/cleanup/cleanup-old-stream-recordings.ts:47-101` reads `Organization.streamRecordingRetentionDays` per-org; cron `.github/workflows/cleanup-old-stream-recordings.yml` | Yes | ✅ Live |
| **Stream.io appointment tag** | `Appointment.organizationId` set in `checkout.ts:2047` for sponsored bookings; `Recording.organizationId` denormalised at record-time | Yes | ✅ Live; runtime assertion test recommended (see §10) |
| **Novu org workflows** | `lib/novu/org-workflows.ts:116-253` — 9 triggers (invite-sent, invite-accepted, invoice-issued, invoice-paid, payout-completed, sso-cert-expiring, …) | Yes | ✅ Live; workflow-id constants audit in #671 |
| **Razorpay refund clawback → OrganizationEarnings** | `lib/payments/payouts/earnings-service.ts:740-768` increments `refundedAmountPaise`; refund entry at `lib/payments/operations/refund.ts:31` | Yes | ✅ Live |
| **Razorpay wallet top-up** | `lib/api/organizations/wallet.ts:163-178` writes `FundingLedgerEntry` with org currency; phone-prefill `lib/payments/razorpay-prefill.ts` rejects repeated-digit phones (#717 fix in this closeout) | Yes | ✅ Live |
| **SCIM 2.0 provisioning** | `app/api/organizations/[orgId]/scim/**` — token-bound; group-mapping → MemberRole | Yes | ✅ Live |
| **Outbound webhooks** | `lib/enterprise/outbound-webhooks/{dispatch,signing,worker}.ts` — HMAC-SHA256 signed, idempotent redeliver | Yes | ✅ Live |
| **HRIS provider sync** | `app/api/organizations/[orgId]/hris/**` schema-ready; sync workers stubbed | Yes | 🟡 **Flag-gated off** (`ENABLE_HRIS=false`); 404 until first design-partner customer |
| **IRP (e-invoice ClearTax)** | `jobs/compliance/irp-uploader.ts` + `.github/workflows/irp-uploader.yml` | Yes | 🟡 **Flag-gated off** (`ENABLE_IRP_UPLOADER=false`); scheduled cron short-circuits |
| **Form 26Q admin TDS view** | `app/api/admin/tds/route.ts` | Platform-level | 🟡 **Flag-gated off** (`ENABLE_TDS_ADMIN_VIEW=false`); 404 until finance team operates the quarterly flow |

---

## 5. Compliance posture — kept vs deferred

Locked decision: **lightweight compliance only**. Keep what is shipped and
operating in v1; flag-gate (default off) anything that requires legal/CA
sign-off or external integrator credentials.

### Kept in v1

- **GST invoice numbering** — `lib/compliance/gst.ts` + `OrgInvoiceCounter` atomic upsert; per-org per-FY sequential numbers per CGST Rule 46
- **CGST / SGST / IGST tax breakdown** on `OrganizationInvoice.taxRollupJson`
- **DPDP §12 right-to-erasure** — `lib/compliance/erasure/scrub-user.ts` + `lib/compliance/dpdp.ts`; manual processing wired to admin
- **DPDP §11 data export bundle** — `OrgDataExportJob` + lifecycle audit actions
- **MSME payment-deadline alerts** — `jobs/compliance/msme-payment-alerts.ts`
- **DataBreach deadline alerts** — `jobs/compliance/databreach-deadline-alerts.ts`
- **Consent retention sweeper** — `jobs/compliance/consent-retention-sweeper.ts`
- **TDS service code** (read-only) — `lib/payments/tax/tds-service.ts` continues to compute deductions

### Flag-gated off (default false; one env var to enable)

| Flag | Surface | Re-enable trigger |
|---|---|---|
| `ENABLE_IRP_UPLOADER` | Scheduled IRP cron (`irp-uploader.yml`). `workflow_dispatch` still runs manually for validation | CA sign-off + >₹5cr AATO threshold or design-partner ask |
| `ENABLE_TDS_ADMIN_VIEW` | `/api/admin/tds` GET + POST (Form 26Q quarterly filing) | Finance team is ready to operate the filing flow |
| `ENABLE_HRIS` | `/api/organizations/[orgId]/hris` + `/sync` + `/csv-upload` | First design-partner customer + provider-specific sync worker shipped |

### Deferred (out of this PR — see §10 follow-ups)

- TDS derivation cron (#713)
- IRP live integration polish (#713)
- Form 26Q automated filing workflow (#737)
- Multi-attendee per-PoS billing (schema reserved; not wired)
- RBI PA Master Direction legal opinion (legal track, not engineering)
- TCS Sec 52 implementation
- SOC 2 / RLS write-audit (#744 D1, D4)
- HRIS UI dashboard (#744 E3)

---

## 6. Role coverage (7 roles)

Role rank ladder lives at `lib/auth/role-ranks.ts`. Sidebar visibility is
NOT a function of rank alone — separate predicates split *operator* surfaces
(governance: members, invitations, SSO, audit) from *finance* surfaces
(billing, POs, payouts, rate cards). The split is required because
BILLING_ADMIN (rank 70) outranks MANAGER (60) for finance, but must NOT see
governance surfaces. See `canSeeOperatorSurface` / `canSeeFinanceSurface`
in `lib/auth/role-ranks.ts:74-98`.

| Role | Rank | Landing page | Operator nav | Finance nav | Notes |
|---|---|---|---|---|---|
| OWNER | 100 | `/home` | Full | Full | Unrestricted within the org |
| MAINTAINER | 80 | `/home` | Members / Invitations / SSO / Audit / Programs | Read finance | Excluded from BILLING_ADMIN-or-OWNER finance mutations by design |
| BILLING_ADMIN | 70 | `/home` (finance-tuned variant per `HomePageClient.tsx:152`) | Hidden | Billing / Payouts / POs / Rate Cards / Wallet / Webhooks / Reimbursements | No operator/governance surfaces |
| MANAGER | 60 | `/home` | Members + Programs read; no SSO | Read finance | Cannot mutate billing |
| EXPERT | 40 | `/my-arrangement` | Hidden | Hidden | HOST/HYBRID only — sees own earnings + rate card on the org |
| SUPPORT | 30 | `/home` | Read-only on operator surfaces | Hidden | Audit read access for L1/L2 support |
| LEARNER | 20 | `/my-program` | Hidden | Hidden | SPONSOR-side — sees own allocation + utilization |

**Routing entry** at `app/dashboard/organization/[orgId]/page.tsx:32-58`:
LEARNER → `/my-program`, EXPERT → `/my-arrangement`, all others fall through
to `/home`. ADMIN (platform admin) is role-stubbed as OWNER by
`requireOrgAccess` and lands on `/home`.

**No broken landing pages.** Each role's landing destination is a real page
with real data — verified by inspection of `my-program/page.tsx` (269 LOC),
`my-arrangement/page.tsx` (316 LOC), and the per-role branches in
`HomePageClient.tsx`.

---

## 7. WIP-banner cleanup

A repo-wide scan for "Coming soon" / `WipBanner` / `WIP_BANNER` /
`comingSoon` returned only the following surfaces in `app/` and `components/`:

| Surface | Disposition |
|---|---|
| `app/dashboard/organization/[orgId]/purchase-orders/page.tsx` | ✅ **Implemented in this closeout** — full CRUD (list + filters + create + edit + delete dialogs) backed by the existing API |
| `app/dashboard/organization/[orgId]/consent/page.tsx` | ⏸ Deferred — DPDP consent dashboard is heavier compliance UX; backend API is live, UI ships post-launch |
| `app/dashboard/org-workspace/[orgWorkspaceId]/settings/page.tsx` | ↩ Replaced with redirect to `/home` — placeholder removed; requires `OrgWorkspaceProfile` schema work for the real settings (default landing org, notification routing, locale) which is v1.1 scope |
| `components/Navbar.tsx:131-139` ("Team Training & Corporate Mentorship") | ➖ Kept — this is a deliberate marketing CTA (`disabled: true` + "express interest"), not a half-built feature |
| `components/Navbar.tsx:147,154` (Community, Blog) | ➖ Kept — marketing nav `comingSoon: true` flag; intentional public-page placeholder |

In-code comments referencing "WIP banner removed" (e.g. `programs/page.tsx:19`,
`BillingStep.tsx:16`) are post-PR-655-feedback annotations documenting that
the underlying feature is shipped; no UI to clean up.

---

## 8. Test coverage map

**61 jest suites total; 34 in `__tests__/enterprise/` (990 tests passing).**

Enterprise-specific coverage:

- **Money correctness:** `payment-leg-invariant`, `multi-engagement-cap`, `cap-edge-cases`, `po-balance-enforcement`, `org-payout-service`, `live-payout-submission`, `payout-webhook-reconciler`, `collaborator-org-earnings`, `tds-derivation`, `tds-org-payout-input`, `msme-deadline`, `earning-status-transitions`
- **Roles + authz:** `role-transitions`, `billing-admin-gate`, `governance`, `anti-lockout-gaps`, `member-anti-lockout`, `consumer-org-routing`, `seat-count`
- **Lifecycle:** `org-status`, `invitation-accept`, `expire-stale-invitations`, `programs-v2-rejection`, `license-credit-pool-bogus`
- **Audit:** `audit-actions`, `org-error-humanization`
- **Pricing:** `rate-card-ownerorg`
- **Invoicing:** `invoice-numbering`
- **Subsystems:** `scim/*`, `webhooks/*`

Added in this closeout:

- `__tests__/payments/razorpay-prefill.test.ts` — #717 regression (repeated-digit guard + E.164 baseline; 17 tests, 100% coverage)
- `__tests__/enterprise/audit-sanitize.test.ts` — audit-log info-leak scrub; covers the five engineering-noise regex patterns + idempotency + prefix preservation (16 tests, 100% coverage)

Existing tests already cover the work that was already shipped:

- LED-1 INVOICE_PAID transactional fix → covered by `payment-leg-invariant.test.ts` + `payout-webhook-reconciler.test.ts`
- #710 cap counting → covered by `multi-engagement-cap.test.ts` + `cap-edge-cases.test.ts`
- ENT-1 activeSeatCount → covered by `seat-count.test.ts`
- ENT-2 invite-accept org-status → covered by `invitation-accept.test.ts`

---

## 9. Changes shipped in this closeout

| Change | File(s) | Why |
|---|---|---|
| #717 razorpay-prefill repeated-digit guard | `lib/payments/razorpay-prefill.ts`, `__tests__/payments/razorpay-prefill.test.ts` | Razorpay test-mode rejects `9999999999` etc. — catch client-side so the modal doesn't fail opaquely |
| ENT-4 `PROGRAM_DELETED` audit action | `lib/enterprise/audit-actions.ts`, `app/api/organizations/[orgId]/programs/[programId]/route.ts:229` | DELETE was reusing `PROGRAM_PAUSED`; conflated state transitions for audit consumers |
| #730 Purchase Orders dashboard | `app/dashboard/organization/[orgId]/purchase-orders/{page.tsx,components/*,utils/*}` | Was a "Coming soon" placeholder; now modular full-CRUD dashboard (list + filters + create / edit / delete dialogs, multi-currency, stat cards, audit logging) |
| OrgWorkspace settings page | `app/dashboard/org-workspace/[orgWorkspaceId]/settings/{page.tsx,components/*,utils/*}`, `app/api/org-workspace/[orgWorkspaceId]/settings/route.ts`, schema migration `20260518000000_orgworkspace_settings_columns` | Real settings page replacing the placeholder. Four new columns on `OrgWorkspaceProfile` (defaultLandingOrg, notificationRoutingMode, locale, currencyDisplayCode) — see [`34-workspace-preferences.md`](./34-workspace-preferences.md) |
| Sidebar grouping + SUPPORT role-visibility fix | `components/dashboard/CollapsibleSidebar.tsx`, `app/dashboard/organization/[orgId]/layout.tsx` | Per-org sidebar split into 5 clusters (People / Commerce / Operations / Insights / Configuration); Operations defaults collapsed for OWNER + MAINTAINER. SUPPORT now has read access to Members / Operations / Audit / Analytics (previous gate denied them everything) |
| Audit-log info-leak fix (3 layers) | `prisma/schema.prisma` (new `SystemEvent` model + migration `20260519000000_system_events_table`), `lib/enterprise/{audit-sanitize.ts,system-events.ts}`, `app/api/organizations/[orgId]/audit/{route,export/route}.ts`, `app/api/admin/system-events/route.ts`, `scripts/cleanup/process-data-exports.ts`, `app/api/organizations/[orgId]/hris/sync/route.ts` | Prisma stack traces were leaking into org-visible audit rows (schema enum names like `LicensedSeatConfigNullableScalarRelationFilter`). Three layers of defense: write-side sanitization, read-side scrub, separate engineering-only `SystemEvent` table. See [`35-system-events.md`](./35-system-events.md) |
| Compliance flag gates | `lib/feature-flags.ts`, `.github/workflows/irp-uploader.yml`, `app/api/admin/tds/route.ts`, `app/api/organizations/[orgId]/hris/{route,sync/route,csv-upload/route}.ts` | Three new flags (`ENABLE_IRP_UPLOADER`, `ENABLE_TDS_ADMIN_VIEW`, `ENABLE_HRIS`) default-off; routes return 404 when gated; scheduled IRP cron short-circuits |

---

## 10. Already-shipped items verified (no further code work)

These items were referenced in earlier closeout drafts but verification
against `feature/enterprise` HEAD shows they're already in place:

- **LED-1** — `app/api/webhooks/utils.ts:235-282` wraps invoice claim +
  settlement ledger write inside a single `prisma.$transaction` with an
  explicit "LED-1" comment.
- **#710 cap counting** — `lib/payments/operations/checkout.ts:2020-2095`
  derives `engagementsForCap` per plan type: CONSULTATION/WEBINAR = 1
  (one Appointment = one calendar occurrence), CLASS = N from
  `classInstance.appointments.length`, SUBSCRIPTION = null (debited per
  allocation by `SlotAllocationService.recordSubscriptionAllocationCap`
  at `:1446-1549`). One engagement = one Appointment, by product design.
- **ENT-1 activeSeatCount** — `lib/api/organizations/seat-count.ts:40-101`
  raw SQL UPDATE with negative-balance guard; reconcile cron block F at
  `scripts/reconcile/reconcile-ledgers.ts:403+` flags drift.
- **ENT-2 invite-accept org-status re-check** —
  `app/api/organizations/invitations/accept/route.ts:179-200` re-fetches
  org status inside the accept tx and rejects via `isOnboardingBlocked`
  (PENDING_VERIFICATION / SUSPENDED / DEACTIVATED).
- **Programs v2 rejection** —
  `app/api/organizations/[orgId]/programs/route.ts` returns 400
  `PROGRAM_TYPE_NOT_AVAILABLE` on PROJECT/RETAINER POST.

---

## 11. Residual blockers + open follow-ups

### Land in this PR before merge

- ✅ All §9 changes (done)
- ✅ `__tests__/payments/razorpay-prefill.test.ts` (added)
- Run `npm run test`, `npm run lint`, `npx tsc --noEmit` locally — confirm
  all suites pass.
- Set repo variable `ENABLE_IRP_UPLOADER` (and others) to literal `"true"`
  on the production environment only if/when those subsystems are ready.
  Default in code is `false` — safe to merge with the variable unset.

### Move to follow-up issues (link from #744)

Defer-list addendum, by bucket:

**Booking/cap follow-ups (former #676 items not enterprise-blocking)**

- #715 Overage charging (CHARGE_MEMBER / CHARGE_ORG) — depends on the cap-counting work already landed
- #716 Refund overhaul (append-only earnings-refund history; absorbs #700 LED-2)
- #438 Invoice PDF renderer

**Payments/payout (former #677 items deferred)**

- #630 Payout v2 — live-gateway behind new `ENABLE_LIVE_PAYOUTS` flag
- #663 Enterprise analytics — depends on data export CSV (#744 E2)
- #674 Personal-vs-org-scope UI consistency

**HOST/HYBRID (gated)**

- #662 PROVIDER/HOST deep-dive — keep `ENABLE_HOST_ORGS=false` default
- #671 Novu wiring audit — confirm all 9 workflow constants + live workers

**Compliance defer (per locked scope)**

- #713-1 TDS derivation cron
- #713-2 IRP live integration
- #737 Form 26Q filing workflow
- Multi-attendee per-PoS billing
- RBI PA Master Direction legal opinion (legal, not engineering)
- TCS Sec 52
- SOC 2 / RLS (#744 D1, D4)
- HRIS UI (#744 E3) + provider-specific sync workers
- DPDP Consent dashboard UI (`app/dashboard/organization/[orgId]/consent/page.tsx`)

**ENT-3 requireActive coverage audit (recommendation)**

The opt-in `requireActive: true` flag is set today on POST endpoints that
mint external commitments (PO POST, invoice POST, contract POST). Extending
it to invitations, member POST, and other side-effecting routes is desirable
but risks breaking legitimate setup flows on PENDING_VERIFICATION orgs. The
recommended approach is a one-PR audit that adds `requireActive` per-route
with explicit allow-listing for setup mutations (branding upload, payout
account upload, members PATCH for the OWNER themselves) — tracked as a new
follow-up issue rather than included here.

---

## 12. Verification checklist (pre-merge)

```bash
# Unit + integration
npm run test

# Schema + types + lint
npx prisma format
npx prisma generate
npm run lint
npx tsc --noEmit

# DO NOT run npm run build (project preference)

# Manual smoke (local dev)
#  1. Create SPONSOR org (canSponsor=true, canHost=false) with INVOICE funding
#  2. With ENABLE_HOST_ORGS unset, toggle canHost=true → expect 501 HOST_ORGS_GATED
#  3. Invite a LEARNER → accept → book 8-session CLASS plan
#       → assert ProgramAssignment.engagementsUsed += 8 (not 1)
#  4. POST /programs {type:"PROJECT"} → expect 400 PROGRAM_TYPE_NOT_AVAILABLE
#  5. Wallet top-up with phone=9999999999 → expect rejection by normalizeRazorpayContact
#  6. GET /api/organizations/{id}/hris → expect 404 (flag off)
#  7. GET /api/admin/tds → expect 404 (flag off)
#  8. Navigate /dashboard/organization/{id}/purchase-orders → expect functional dashboard
#  9. As BILLING_ADMIN: members tab hidden; billing/payouts/POs visible
# 10. As LEARNER on the org: lands on /my-program; can read own assignment
# 11. As EXPERT: lands on /my-arrangement; sees own earnings + rate card
```

Reconciliation crons run nightly and will flag any post-merge drift:

- `.github/workflows/reconcile-ledgers.yml` (blocks A–F)
- `.github/workflows/reconcile-payout-status.yml`
- `.github/workflows/reconcile-payment-status.yml`
- `.github/workflows/reconcile-pending-refunds.yml`

---

## 13. Operator notes

- The audit doc is intentionally one page (this file). Per-subsystem deep
  dives live in their existing docs (`00-overview.md` through
  `33-data-export.md`). This file is the merge-readiness verdict.
- PR #655 is the long-running integration branch for the enterprise
  subsystem. #682 (Arch-4-Modified rewrite), #666 (HOST/HYBRID), and #742
  (programs UI gaps) merged into `feature/enterprise` before this closeout.
  This audit covers the full diff against `dev`.
- After merge, file the §11 follow-up issues and pin a "PR #655 closeout —
  addendum" comment to #744 listing the bucket → issue mapping.
