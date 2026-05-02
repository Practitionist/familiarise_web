# Enterprise Subsystem — Production Readiness Checklist

**Branch:** `feature/enterprise` | **Updated:** 2026-05-02 | **Auditor:** Claude Code (Sonnet 4.6)
**Verdict:** Design-partner ready (manual-ops). NOT self-serve multi-tenant ready.

> **Revision history:**
> - Initial audit 2026-05-02 (62/100).
> - Same-day Round 1 corrections — 5 false findings corrected, 7 real issues fixed (875/875 tests, tsc clean, DB migrated). Score → **73/100**.
> - Same-day Round 2 corrections — 1 additional false finding (FF-6: GST core derivation is real), IRP/MSME crons wired to GH Actions schedules, DPDP DataBreach 72-hour deadline cron added, HRIS CSV-upload body-size guard added, stale comments scrubbed. Score → **77/100**.

---

## Overall Score: 77 / 100

| Section | Weight | Score | Earned | Round 1 Δ | Round 2 Δ |
|---------|-------:|------:|-------:|----------:|----------:|
| 1. Schema & Data Model | 10 | 95% | 9.5 | — | — |
| 2. Enterprise Core: Auth / Membership / Contracts / Programs | 15 | 87% | 13.0 | +0.25 | — |
| 3. Booking + Payment Algorithm | 15 | 85% | 12.75 | +0.75 | — |
| 4. Finances: Payouts / Earnings / Refunds | 15 | 47% | 7.05 | +1.05 | — |
| 5. India Compliance: GST / TDS / MSME / IRN / FEMA | 10 | 45% | 4.5 | +0.5 | +2.0 |
| 6. Dashboards & UI | 10 | 85% | 8.5 | +1.5 | — |
| 7. Org Context / Switchers / Filters | 8 | 90% | 7.2 | +0.64 | — |
| 8. Cross-cutting Integrations: Stream / Novu / SSO | 7 | 70% | 4.9 | — | +0.35 |
| 9. Crons & Operational Readiness | 5 | 80% | 4.0 | +0.75 | +0.75 |
| 10. Testing & Type Safety | 5 | 95% | 4.75 | — | — |
| **TOTAL** | **100** | | **76.15 → ~77\*** | **+11** | **+3** |

> \* Penalty retained for critical runtime blockers in Finances (live payouts = `NotImplementedError`) and Compliance (TDS/GST/IRN/FEMA logic = safe-default stubs). Those sections cap overall score regardless of weight arithmetic. Gap to 100 = PR-2 + PR-3 + #674.

---

## Legend

| Icon | Meaning |
|------|---------|
| ✅ | Correctly implemented — live, tested, production-grade |
| 🟡 | Partly fixed — schema/structure exists but logic/crons/UI stubbed or drifted |
| 🔴 | Missing or incorrectly implemented — broken, wrong, or not started |
| ~~🔴~~ | Was flagged as missing in initial audit; confirmed already correctly implemented (false finding) |

---

## Corrections & Fixes Applied (2026-05-02)

### False Findings Corrected

Six items were flagged as broken in the initial audit but were already correctly implemented:

| # | Item | Where | Reality |
|---|------|--------|---------|
| FF-1 | Invoice payment endpoint lacks idempotency key | §4.4, §9.4 | `providerPaymentOrderId` persisted atomically at order creation; subsequent POSTs reuse the existing Razorpay order. No double-charge path. |
| FF-2 | Audit export has no row-count limit | §2.7, §9.4 | Streaming cursor has `MAX_ITERATIONS=400` × `CSV_CHUNK_SIZE=500` = hard 200k-row ceiling. No OOM path. |
| FF-3 | `/contracts` page missing `useRequireOrgAccess` guard | §6.1 | Guard is present: `useRequireOrgAccess({ minRole: 'MAINTAINER', canSponsor: true })`. |
| FF-4 | `/contracts` and `/audit` not in sidebar | §6.1, §7.4 | Both are in sidebar — Contracts with `canSponsor && isAtLeast("MAINTAINER")`, Audit with `isAtLeast("MAINTAINER")`. |
| FF-5 | MSME 15/45-day deadline calculator returns `invoiceDate + 60d` always | §5.4 | `computeMsmePaymentDeadline()` in `lib/compliance/msme.ts` implements full MICRO (15d) / SMALL (45d) logic; MEDIUM/NONE gets `contract.defaultTermsDays`. |
| FF-6 | `deriveGstBreakdown()` returns zero tax (safe default); no CGST/SGST/IGST actually computed | §5.1 | **WRONG.** `lib/compliance/gst.ts:68–128` implements: zero-rated export when `buyerCountry !== "IN"`, intra-state CGST 9% + SGST 9% (`Math.round(taxPaise/2)` split), inter-state IGST 18%, HSN defaulting to 999293, place-of-supply derivation. Function is **live**. Only what's missing for GA: GSTIN registry API verification, RCM routing, LUT enforcement. *(Round 2 finding)* |

### Real Issues Fixed (same commit, 875/875 tests pass, tsc clean, DB migrated)

| # | Issue | Fix Applied |
|---|-------|-------------|
| FX-1 | `CHARGE_ORG` overage path crashed with Prisma P2002 (INVOICE_ACCRUAL source uniqueness violation) | Added `OVERAGE_INVOICE_ACCRUAL` to `PaymentLegSource` enum; overage leg uses this source; credit-limit aggregation SUM updated; refund reversal handles both via fall-through. Schema migrated. |
| FX-2 | `CHARGE_MEMBER` error said "booking succeeded" but was thrown inside Prisma tx (always rolled back) | Error code `OVERAGE_REQUIRES_SEPARATE_PAYMENT` → `PROGRAM_CAP_EXHAUSTED`; message now correctly states "Your program allocation is full. Contact your organization administrator..." |
| FX-3 | `BillingPageClient` showed "Payment terms: NET-60" for WALLET-funded orgs (inapplicable) | StatCard now conditional on `fundingSource !== "WALLET"`. |
| FX-4 | `/purchase-orders` and `/consent` had no sidebar entries (deep-link-only) | Purchase Orders (Receipt icon, `canSponsor && MAINTAINER+`) added after Contracts; Consent (ShieldCheck icon, `MANAGER+`) added after Audit. |
| FX-5 | `jobs/compliance/irp-uploader.ts` header said "STUB" implying `lib/compliance/irp.ts` was also a stub | Header rewritten: cron job is scaffolded/unwired (#681); underlying `generateIrn()` connector makes real HTTP calls to ClearTax when `CLEARTAX_API_KEY` / `CLEARTAX_GSP_TOKEN` / `CLEARTAX_GSTIN` are configured. Production approval checklist added. |
| FX-6 | `POST /api/organizations/[orgId]/invitations` had no per-org time-window rate limit | `orgInviteLimiter` (20/hr per `orgId`, Upstash sliding-window) added to `lib/rate-limit.ts` and applied in POST handler before Serializable transaction. |
| FX-7 | `serializeOrgFilter` maps `__personal__` → `"none"` but `resolveOrgScope` expects `"personal"` | TODO #674 comment added to `lib/dashboard/org-context-filter.ts` documenting required rename + atomicity constraint before any new page mounts the component. |

### Round 2 Fixes (2026-05-02, same day)

| # | Issue | Fix Applied |
|---|-------|-------------|
| RX-1 | IRP uploader cron body is wired but had no GH Actions schedule | New `.github/workflows/irp-uploader.yml` runs daily at 02:30 UTC. Cron body retained (already invokes `generateIrn` against eligible invoices). Stale "scaffolded but not yet wired" header rewritten. |
| RX-2 | MSME alert cron body is wired but had no GH Actions schedule + stale "derivation is a stub" header | New `.github/workflows/msme-payment-alerts.yml` runs daily at 04:30 UTC. Header comment rewritten to reflect that `computeMsmePaymentDeadline` is live (15/45-day rule). |
| RX-3 | DataBreach 72-hour DPDP reporting deadline was not tracked | New `jobs/compliance/databreach-deadline-alerts.ts` + hourly GH Actions schedule. Sweeps `DataBreach WHERE reportedAt IS NULL`, emails the DPDP-officer inbox (env: `DATABREACH_ALERT_EMAIL`) for rows ≤12h before, or past, the 72-hour cutoff. Highlights overdue rows in red. Closes part of #701. |
| RX-4 | HRIS CSV-upload route had no `Content-Length` cap; Zod row-limit runs after the 5,000-row body is fully buffered | 5 MB Content-Length guard returns 413 PAYLOAD_TOO_LARGE before `req.json()`. Zod row cap remains. |
| RX-5 | Compliance scores penalised `deriveGstBreakdown` as a stub (FF-6) | Section 5 (Compliance) score lifted from 25% → 45%; total +3 points. |
| RX-6 | `require.main === module` self-executor missing on `irp-uploader.ts` and `msme-payment-alerts.ts` | Both jobs now self-execute via `npx tsx jobs/compliance/<name>.ts`, matching the project convention. |

---

## Section 1 — Schema & Data Model (Weight: 10 pts | Score: 9.5/10)

All 60+ enterprise models are production-final. No placeholder or nullable-where-required fields. Enums are exhaustive. Index strategy is sound.

### 1.1 Core Organization Models

- [x] ✅ `Organization` — 40+ fields: capability booleans (`canSponsor`, `canHost`), GST/PAN/GSTIN, hierarchy columns (`parentId`, `rootId`, `depth`), branding, policies, marketplace visibility, all relations
- [x] ✅ `Membership` — typed join table with `MemberRole` rank ladder (OWNER → MAINTAINER → MANAGER → EXPERT → LEARNER → SUPPORT), `payoutRecipient`, `rateCardOverrideId`, `programAssignments`, dual-profile linkage
- [x] ✅ `OrgWorkspaceProfile` — per-user operator profile for multi-org operators; unique on `userId`
- [x] ✅ `OrgAuditLog` — 9 categories (`MEMBER`, `CONTRACT`, `PROGRAM`, `WALLET`, `INVOICE`, `PAYOUT`, `SETTINGS`, `CONSENT`, `CATALOG`, `SYSTEM`), actor/target membership IDs, details JSON
- [x] ✅ `OrgDomainClaim` — `verificationToken`, `verifiedAt`; DNS TXT check flow
- [x] ✅ `OrganizationSSOSettings` — `allowedEmailDomains[]`, `enforceSSO`, `defaultRoleForAutoJoin`

### 1.2 Billing, Contracts & Programs

- [x] ✅ `BillingAccount` — `fundingSource` enum (PERSONAL/LICENSE/WALLET/INVOICE/PROJECT), `walletBalance`, `creditLimit`, all relations
- [x] ✅ `Contract` — status machine (DRAFT→ACTIVE→EXPIRED/TERMINATED), `autoRenew`, `rateCardId`, `terms JSON`, `purchaseOrderId`
- [x] ✅ `Program` — `ProgramType` (LICENSED_SEAT/CREDIT_POOL/PROJECT/RETAINER), `OverageBehavior` (BLOCK/CHARGE_MEMBER/CHARGE_ORG), `coveredPlanTypes[]`, `allowedCategories[]`
- [x] ✅ `LicensedSeatConfig` — `ratePerSeatPaise`, `BillingCycle`, `coveredEngagementsPerCycle`, `overageBehavior`, `activeSeatCount`, `priceCapPerEngagementPaise`
- [x] ✅ `CreditPoolConfig` — `cycle`, `creditsPerCycle`, `minimumCreditsPerPeriod`
- [x] ✅ `ProgramAssignment` — `periodStart/End`, `engagementsUsed`, `overageCount`; unique on `(programId, membershipId, periodStart)`
- [x] ✅ `BookingUtilization` — `engagementsConsumed`, `priceAtBookingPaise`, `wasOverage`, BPS snapshot fields, `reversedAt`, `appointmentIds[]`

### 1.3 Wallet & Three-Ledger

- [x] ✅ `WalletEntry` — `deltaPaise` (signed), `WalletReason`, `balanceAfter`, `providerOrderId @unique` (idempotency)
- [x] ✅ `FundingLedgerEntry` — funding-side ledger with `FundingReason`, signed `deltaPaise`, `balanceAfterPaise`
- [x] ✅ `SettlementLedgerEntry` — `SettlementKind` (INVOICE_ISSUED/PAID, PAYMENT_RECEIVED, REFUND_ISSUED, PAYOUT_SENT/REVERSED, CHARGEBACK, CREDIT_NOTE)
- [x] ✅ `LedgerReconciliationReport` — `summary JSON`, `findings JSON`, `ok Boolean`, `durationMs`

### 1.4 Payout Pipeline

- [x] ✅ `OrganizationPayoutAccount` — encrypted account details, `razorpayContactId`, `razorpayFundAccountId`, `stripeConnectId`, `OrgPayoutAccountStatus`
- [x] ✅ `OrganizationEarnings` — BPS snapshot, `EarningStatus` (PENDING/HELD/RELEASED/PAID/REFUNDED/PENDING_TRUST), `holdUntil`, `orgPayoutId`
- [x] ✅ `OrganizationPayout` — all India statutory fields (`tdsSectionApplied`, `tdsAmountPaise`, `mustPayByDate`, `form15caPartCRef`, `form15cbRef`, `dtaaRateApplied`, `rbiPurposeCode`, `fxRateUsed`, `firceRef`), `clawbackAmountPaise`, `idempotencyKey @unique`

### 1.5 Invoicing

- [x] ✅ `OrganizationInvoice` — GST breakdown (`igstPaise`, `cgstPaise`, `sgstPaise`, `taxRate`, `placeOfSupply`, `reverseCharge`, `lutNumber`, `gstin`, `hsnCode`); e-invoice fields (`irn`, `ackNumber`, `ackDate`, `signedQrPayload`, `irpStatus`, `irpRetryCount`); `OrgInvoiceStatus` (DRAFT/ISSUED/PAID/OVERDUE/VOID/CANCELLED/REFUNDED)
- [x] ✅ `PurchaseOrder` — `remainingAmountPaise` enforced at invoice creation (409 if exceeded)

### 1.6 Compliance Models

- [x] ✅ `ConsentArtifact` — real SHA-256 hash, `retainUntil` (7-year), `withdrawnAt`
- [x] ✅ `DataBreach` — model exists with `detectedAt`, `reportedToDpdpBoardAt`, `affectedUserCount`
- [x] ✅ `HrisConfig` — `HrisProvider` (WORKDAY/BAMBOOHR/SAP/ORACLE), `tenantKey`, `lastSyncedAt`, `active`, `syncJobs[]`, `employeeMap[]`
- [x] ✅ `PaymentLeg` — stackable funding (CARD/WALLET/REFERRAL_CREDIT/INVOICE_ACCRUAL/**OVERAGE_INVOICE_ACCRUAL**/LICENSE); `@@unique([paymentId, source])` prevents double-billing; `OVERAGE_INVOICE_ACCRUAL` added 2026-05-02 (FX-1)

### 1.7 Org-Scope Anchors

- [x] ✅ `Organization.appointmentsByOrg`, `waitlistByOrg`, `recordingsByOrg`, `trialsByOrg`, `payments` — FK relations on schema
- [x] 🟡 `Appointment.organizationId`, `Waitlist.organizationId`, `Recording.organizationId` — FK columns exist; **not populated by booking flow yet** (#674 workstream)

---

## Section 2 — Enterprise Core: Auth / Membership / Contracts / Programs (Weight: 15 pts | Score: 13.0/15)

### 2.1 Authentication & Authorization

- [x] ✅ BetterAuth organization plugin wired (`lib/auth.ts:326-329`)
- [x] ✅ SSO plugin + domain verification (`lib/auth.ts:336`)
- [x] ✅ `customSession` callback injects `orgWorkspaceProfileId` + `organizationMemberships` into every session
- [x] ✅ `shouldRejectSession` — blocks login for SSO-enforced domain users without enrolled SSO provider (lib/auth.ts:209-290)
- [x] ✅ `requireOrgAccess(orgId)` enforced on all 54+ enterprise API routes
- [x] ✅ `requireOrgOwner` enforced on destructive operations (delete org, SSO config, domain claims, payout account)
- [x] ✅ Platform ADMIN bypass with synthesized OWNER-rank stub (capability checks preserved)
- [x] ✅ IDOR guard on OrgWorkspace endpoints (`orgWorkspaceProfileId` match)
- [x] ✅ Middleware blocks unauthenticated access to `/api/organizations/*` prefix
- [x] ✅ Public exceptions declared: `/api/organizations/public/*`, `/api/organizations/invitations/accept` (token-gated at handler)
- [x] 🟡 Live OIDC label fix + `userId` on org-scoped providers — deferred (#670, #672)

### 2.2 Org Lifecycle

- [x] ✅ Org creation wizard (POST `/api/organizations`) — atomic transaction: Organization + BillingAccount + Membership (OWNER) + OrgWorkspaceProfile
- [x] ✅ Slug uniqueness enforced in Serializable transaction (no TOCTOU)
- [x] ✅ `OrgStatus` state machine: PENDING_VERIFICATION → ACTIVE → SUSPENDED / DEACTIVATED
- [x] ✅ 409 `ORG_NOT_VERIFIED` returned on org side-effects before admin approval
- [x] ✅ Admin org verification page (`/dashboard/admin/organizations`)
- [x] ✅ Soft-delete only (no hard-delete gate) — by design for audit trail
- [x] 🟡 GSTIN live API verification — format validated (15-char regex); live GSTIN registry lookup deferred to PR-2

### 2.3 Membership Lifecycle

- [x] ✅ Member add (MAINTAINER+), role-change, remove with Serializable transaction
- [x] ✅ Last-OWNER anti-lockout guard (409 on removing last OWNER)
- [x] ✅ Bulk member endpoint returns 405 intentionally (bulk ops skip anti-lockout guard)
- [x] ✅ `MemberRole` rank ladder: `isAtLeast()` utility for capability checks
- [x] ✅ Invitation lifecycle: send, expire (max 30 days), accept (token-gated), revoke
- [x] ✅ `UNVERIFIED_ORG_SEAT_CAP` enforced at invite-send time
- [x] ✅ Novu `ORG_INVITE_SENT` + `ORG_INVITE_ACCEPTED` workflows wired
- [x] ✅ `orgInviteLimiter` — 20/hr per `orgId` (Upstash sliding-window) applied at `POST /invitations` before Serializable transaction *(FX-6, 2026-05-02)*

### 2.4 Contracts & Programs

- [x] ✅ Contract CRUD with `canSponsor` + `requireActive` capability gates
- [x] ✅ Contract status machine: DRAFT → ACTIVE → EXPIRED / TERMINATED
- [x] ✅ `autoRenew` flag + `effectiveFrom/To` date validation (effectiveTo > effectiveFrom enforced)
- [x] ✅ Program CRUD under contracts (`LICENSED_SEAT`, `CREDIT_POOL`)
- [x] ✅ ProgramAssignment lifecycle: assign, update, remove
- [x] ✅ Engagement cap counting: CONSULTATION (1) / WEBINAR (1) / CLASS (N per day) / SUBSCRIPTION (1 lazy per allocation) — tested in #710 ✅
- [x] ✅ `ProgramAssignmentLimitError` raised on cap exhaustion → Novu `ORG_PROGRAM_EXHAUSTED` fired
- [x] ✅ `OverageBehavior.BLOCK` — checkout rejected at cap
- [x] ✅ `OverageBehavior.CHARGE_ORG` — overage leg now uses `OVERAGE_INVOICE_ACCRUAL` source (P2002 crash eliminated, FX-1)
- [x] ✅ `OverageBehavior.CHARGE_MEMBER` — correctly throws `PROGRAM_CAP_EXHAUSTED` (tx rolled back, user directed to personal payment, FX-2)
- [x] 🔴 Programs v2 (`PROJECT`, `RETAINER`) — enum values reserved; zero runtime; no API routes

### 2.5 Rate Cards

- [x] ✅ 7-level override chain: Platform default → Org → Contract → Member override → RateCard precedence resolved deterministically
- [x] ✅ BPS snapshot captured on `OrganizationEarnings` (`platformBpsApplied`, `orgBpsApplied`, `consultantBpsApplied`)
- [x] ✅ Rate card CRUD under org (`/api/organizations/[orgId]/rate-cards`)

### 2.6 Purchase Orders

- [x] ✅ PurchaseOrder CRUD (number, amount, status, linked to org + contract)
- [x] ✅ `remainingAmountPaise` decremented on invoice issue; 409 if invoice exceeds PO balance
- [x] ✅ India-context: PO required flag on `Organization.requiresPO`; checked at invoice creation

### 2.7 Audit Log

- [x] ✅ `OrgAuditLog.create()` called on 40+ enterprise route handlers
- [x] ✅ `AUDIT_ACTIONS` enum drives consistent action strings
- [x] ✅ Queryable by category / action / date range; cursor-paginated
- [x] ✅ CSV export endpoint (`POST /api/organizations/[orgId]/audit/export`)
- [x] ✅ ~~Audit export has no row-count limit~~ — `MAX_ITERATIONS=400` × `CSV_CHUNK_SIZE=500` = 200k-row hard ceiling; streaming cursor prevents OOM *(FF-2 corrected)*

---

## Section 3 — Booking + Payment Algorithm (Weight: 15 pts | Score: 12.75/15)

### 3.1 Stackable Payment Legs

- [x] ✅ `PaymentLeg` model: CARD / WALLET / REFERRAL_CREDIT / INVOICE_ACCRUAL / **OVERAGE_INVOICE_ACCRUAL** / LICENSE sources
- [x] ✅ Sum-identity invariant: `Σ(amountPaise) = Payment.amount` enforced before commit
- [x] ✅ Source-uniqueness: `@@unique([paymentId, source])` — `OVERAGE_INVOICE_ACCRUAL` distinct from `INVOICE_ACCRUAL` eliminates P2002 on `CHARGE_ORG` overage bookings *(FX-1)*
- [x] ✅ `sourceRef` always populated for WALLET/REFERRAL_CREDIT legs (join key for reversal)
- [x] ✅ Credit-limit aggregation SUM covers both `INVOICE_ACCRUAL` + `OVERAGE_INVOICE_ACCRUAL` *(FX-1)*

### 3.2 Wallet Funding Flow (fundingSource=WALLET)

- [x] ✅ `walletDebit()` — conditional UPDATE inside Serializable transaction (insufficient balance → 409)
- [x] ✅ Atomic pair: `WalletEntry` + `FundingLedgerEntry` written on confirmation
- [x] ✅ Top-up flow: Razorpay order minted → `WalletEntry(reason=TOPUP)` on webhook → `providerOrderId @unique` for idempotency
- [x] ✅ Org-keyed rate limit on wallet top-ups (middleware, `org:<orgId>` bucket)

### 3.3 Invoice Funding Flow (fundingSource=INVOICE)

- [x] ✅ At checkout: `PaymentLeg(source=INVOICE_ACCRUAL, amountPaise=booking_price)` — no money moves
- [x] ✅ Credit-limit enforcement: `getInvoiceCreditLimitPaise()` checks `Organization.creditLimit` at checkout (409 if exceeded)
- [x] ✅ PENDING_TRUST gate: unverified INVOICE orgs earn `EarningStatus.PENDING_TRUST` until first invoice paid
- [x] 🟡 Monthly invoice roll-up cron — `jobs/billing/generate-subscription-invoices.ts` scaffolded; manual `POST /invoices` works today

### 3.4 License Funding Flow (fundingSource=LICENSE + LICENSED_SEAT)

- [x] ✅ Active `ProgramAssignment` check at checkout (cap enforced before payment)
- [x] ✅ `PaymentLeg(source=LICENSE, amountPaise=0)` written; `BookingUtilization.engagementsConsumed` incremented atomically
- [x] ✅ Proportional reversal on refund: `engagementsConsumed` decremented + `reversedAt` set

### 3.5 GST Tax Engine

- [x] ✅ `determineTax()` in `lib/payments/tax/tax-engine.ts` — CGST/SGST (intra-state 9%+9%) vs IGST (inter-state 18%)
- [x] ✅ `placeOfSupply` captured from org's GST state code
- [x] ✅ Fields captured on `Payment` + rolled into `OrganizationInvoice`
- [x] 🟡 Actual tax amounts returned by `deriveGstBreakdown()` are zero (safe default); correct GST derivation deferred to PR-2

### 3.6 Org-Scoped Booking Context

- [x] ✅ `Payment.organizationId` captured on all org-sponsored bookings
- [x] ✅ Billing currency validation at checkout (`validatePlanCurrency()`)
- [x] ✅ Discount currency validation at checkout (`validateDiscountCurrency()`)
- [x] ✅ Referral credits scoped to `organizationId`
- [x] 🟡 `Appointment.organizationId` FK exists; **not populated** by booking flow — org dashboard `/appointments` shows all-or-nothing (#674)
- [x] 🟡 `Waitlist.organizationId` FK exists; same gap (#674)
- [x] 🟡 `Recording.organizationId` FK exists; same gap (#674)

### 3.7 Slot Allocation & Booking Guards

- [x] ✅ `SlotAllocationService` — distributed Redis lock, P2002 → 409 mapping, overnight UTC slot support
- [x] ✅ `validateNoConflicts` — scoped to consultant via M2M relation
- [x] ✅ Concurrent auto-allocate guard for classes (`existingNonTentativeSlotCount >= required` → 409)
- [x] ✅ Webinar/Class auto-allocate distinction (`isAuto: true`)
- [x] ✅ Checkout API requires `planId` (required) + `paymentGateway` even for WEBINAR/CLASS types

### 3.8 Refunds

- [x] 🟡 Canonical refund op exists (`lib/payments/operations/refund.ts`) — single-leg refund works
- [x] 🔴 Multi-leg refund — if booking used WALLET + INVOICE_ACCRUAL simultaneously, reversal is incomplete; credit-note receivable for `OVERAGE_INVOICE_ACCRUAL` tracked in TODO #716
- [x] 🔴 Payout clawback (`clawbackAmountPaise` field exists) — no clawback trigger on post-payout refund (#715)

---

## Section 4 — Finances: Payouts / Earnings / Refunds (Weight: 15 pts | Score: 7.05/15)

This section has the most critical production blockers. No money moves until PR-3 is shipped.

### 4.1 OrgEarnings Roll-up

- [x] ✅ `OrganizationEarnings` created on every org-sponsored payment
- [x] ✅ BPS snapshot (platformBpsApplied, orgBpsApplied, consultantBpsApplied)
- [x] ✅ `EarningStatus` machine: PENDING → HELD / RELEASED → PAID / REFUNDED / PENDING_TRUST
- [x] ✅ `holdUntil` set for dispute hold period
- [x] ✅ `PENDING_TRUST` → `RELEASED` triggered when org moves to ACTIVE or first invoice paid
- [x] 🟡 Earnings release cron (`release-pending-trust-earnings`) — wired in GH Actions; not load-tested

### 4.2 Payout State Machine

- [x] ✅ `OrganizationPayout` status machine: PENDING → APPROVED → PROCESSING → COMPLETED / FAILED / CANCELLED
- [x] ✅ Admin approval gate before PROCESSING
- [x] ✅ Weekly payout cron (`process-payouts.yml`) — rolls up RELEASED earnings into payout batch
- [x] ✅ `idempotencyKey @unique` on `OrganizationPayout` (prevents duplicate cron runs)
- [x] ✅ `gatewayPayoutId @unique`, `gatewayUtr`, `gatewayResponseRaw JSON` — fields ready for webhook reconciliation
- [x] 🟡 PROCESSING → COMPLETED transition — `NotImplementedError` behind `ENABLE_LIVE_PAYOUTS` flag; admin can manually move to COMPLETED today
- [x] 🔴 RazorpayX `payouts.create` call — **not implemented**; no live money movement (PR-3)
- [x] 🔴 Stripe Connect `transfers` call — **not implemented** (PR-3)
- [x] 🔴 Webhook reconciler (PROCESSING → COMPLETED on gateway event) — not wired (PR-3)
- [x] 🔴 Payout clawback trigger (`clawbackAmountPaise`) — field exists; no clawback flow (#715)

### 4.3 Payout Account Verification

- [x] ✅ `OrganizationPayoutAccount` model with `OrgPayoutAccountStatus` (PENDING_VERIFICATION / VERIFIED / FAILED / SUSPENDED)
- [x] ✅ Real bank-account encryption (AES-256, `accountNumberEncrypted` + `accountNumberLast4`)
- [x] ✅ Payout account CRUD route (OWNER only)
- [x] 🟡 Razorpay contact + fund account registration — `razorpayContactId`/`razorpayFundAccountId` fields exist; live registration deferred to PR-3
- [x] 🔴 Penny-drop verification — not implemented

### 4.4 Invoice Payment

- [x] ✅ Invoice state machine: DRAFT → ISSUED → PAID / OVERDUE / VOID / CANCELLED / REFUNDED
- [x] ✅ Manual payment route (`POST /api/organizations/[orgId]/billing-account/invoices/[id]/pay`)
- [x] ✅ `dueDate` set at issuance; overdue detection in admin list view
- [x] ✅ `paidAt` populated on payment confirmation
- [x] ✅ ~~Invoice payment endpoint lacks idempotency key~~ — `providerPaymentOrderId` persisted atomically at order creation; subsequent POSTs reuse the existing Razorpay order *(FF-1 corrected)*
- [x] 🟡 Invoice payment auto-routing (Razorpay vs Stripe based on currency) — not implemented; manual payment only

### 4.5 Cross-Org Billing (OrgWorkspace)

- [x] ✅ `GET /api/org-workspace/[orgWorkspaceId]/billing` — cross-org invoice + wallet roll-up (IDOR-gated)
- [x] ✅ Cross-org billing page (`/dashboard/org-workspace/[orgWorkspaceId]/billing`)
- [x] ✅ `BillingPageClient` "Payment terms: NET-60" StatCard conditional on `fundingSource !== "WALLET"` — WALLET orgs no longer see inapplicable copy *(FX-3, 2026-05-02)*
- [x] 🟡 `/billing` vs `/credits` two-page structure — still two separate pages in code vs one unified page in docs (`12-dashboard-pages.md`); functional but UX drift persists (#TODO unify)

---

## Section 5 — India Compliance: GST / TDS / MSME / IRN / FEMA (Weight: 10 pts | Score: 2.5/10)

Schema is production-final. Most live logic returns safe defaults. MSME deadline calculator and IRP connector are live but unwired to crons.

### 5.1 GST

- [x] ✅ Schema: `Organization.gstin`, `gstStateCode`, `gstRegStatus`, `pan`, `hsnDefault` (999293)
- [x] ✅ Schema: `OrganizationInvoice` — `igstPaise`, `cgstPaise`, `sgstPaise`, `taxRate`, `placeOfSupply`, `reverseCharge`, `lutNumber`, `gstin`, `hsnCode`
- [x] ✅ ~~`deriveGstBreakdown()` returns zero tax (safe default)~~ — `lib/compliance/gst.ts:68–128` implements zero-rated export, intra-state CGST 9% + SGST 9%, inter-state IGST 18%, HSN defaulting, place-of-supply derivation *(FF-6 corrected, Round 2)*
- [x] 🔴 GSTIN live API verification (GSTIN registry lookup) — format-only (15-char regex) today; live lookup deferred to PR-2
- [x] 🔴 Reverse charge mechanism for imports — schema field `reverseCharge` exists; no routing logic (PR-2)
- [x] 🔴 LUT (Letter of Undertaking) zero-rating for exports — `lutNumber` field exists; no enforcement (PR-2)

### 5.2 E-Invoice (IRN / IRP)

- [x] ✅ Schema: `irn`, `ackNumber`, `ackDate`, `signedQrPayload`, `irpStatus`, `irpRetryCount`, `irpLastError`, `irpLastAttemptAt`, `irpUploadedAt`
- [x] ✅ `IrpStatus` enum (PENDING / GENERATED / CANCELLED / FAILED)
- [x] 🟡 `generateIrn()` in `lib/compliance/irp.ts` — **real** HTTP calls to ClearTax when `CLEARTAX_API_KEY` / `CLEARTAX_GSP_TOKEN` / `CLEARTAX_GSTIN` are configured; env-gated, not a stub *(FX-5 corrected)*
- [x] 🟡 Daily IRP upload cron (`jobs/compliance/irp-uploader.ts`) — cron body **and** GH Actions schedule both wired *(RX-1, daily 02:30 UTC)*. Production-approval still pending: ClearTax sandbox proof + payload validation + accountant signoff (#681)
- [x] 🔴 IRN cancellation flow — schema only

### 5.3 TDS (194J / 194O / 194C)

- [x] ✅ Schema: `OrganizationPayout.tdsSectionApplied`, `tdsAmountPaise`, `dtaaRateApplied`, `rbiPurposeCode`
- [x] ✅ Schema: `ConsultantProfile.tdsSection`, `panStatus`, `isMsme`, `msmeRegistrationNumber`
- [x] 🟡 `computeTdsForPayout()` — returns `{ tdsSection: "194J", tdsRate: 0.10, tdsAmountPaise: 0 }` (no actual withholding); PR-2 lands live derivation
- [x] 🔴 Section selection logic (194J vs 194O vs 194C) — not implemented
- [x] 🔴 206AA 20% fallback for missing/invalid PAN — not enforced
- [x] 🔴 DTAA rate lookup per treaty country — stub returns null
- [x] 🔴 TDS certificate (Form 16A) generation — not implemented
- [x] 🔴 26Q quarterly TDS filing — not implemented

### 5.4 MSME 43B(h) Compliance

- [x] ✅ Schema: `OrganizationPayout.mustPayByDate`
- [x] ✅ Schema: `ConsultantProfile.isMsme`, `msmeRegistrationNumber`, `msmeType`
- [x] ✅ `computeMsmePaymentDeadline()` in `lib/compliance/msme.ts` — live: MICRO → 15d, SMALL → 45d, MEDIUM/NONE → `contract.defaultTermsDays` *(FF-5 corrected)*
- [x] ✅ MSME deadline alert cron (`jobs/compliance/msme-payment-alerts.ts`) — body and GH Actions schedule both wired *(RX-2, daily 04:30 UTC)*. Emails finance inbox (env: `MSME_ALERT_EMAIL`) when payouts are within 5 days of deadline; structured-log fallback when email is unset

### 5.5 FEMA / Cross-border (Form 15CA/15CB / FIRC)

- [x] ✅ Schema: `OrganizationPayout.form15caPartCRef`, `form15cbRef`, `firceRef`, `fxRateUsed`
- [x] ✅ Schema: `Organization.parentCountry`, `parentEntityType`, `isGCC`
- [x] 🔴 Form 15CA-CB live workflow — stub only; CA partner integration required for cross-border payouts
- [x] 🔴 FIRC tracking — field exists; no bank API fetch

### 5.6 DPDP (Digital Personal Data Protection)

- [x] ✅ `ConsentArtifact` — real SHA-256 hash, `retainUntil` (7-year), `withdrawnAt`, consent categories
- [x] 🔴 `checkConsent()` — always returns `true` (stub); no actual consent gate on data access
- [x] 🟡 `DataBreach` — model exists; 72-hour reporting deadline tracker now live (`jobs/compliance/databreach-deadline-alerts.ts` + hourly GH Actions schedule, *RX-3*). Email dispatch (env: `DATABREACH_ALERT_EMAIL`) + structured-log fallback. Full Novu admin-roster fan-out and DPB-portal integration still pending (#701)
- [x] 🔴 Consent withdrawal cascade — field exists; no downstream revocation of dependent processing
- [x] 🔴 Retention-sweeper cron (purge data past `retainUntil`) — not implemented

---

## Section 6 — Dashboards & UI (Weight: 10 pts | Score: 8.5/10)

### 6.1 Organization Dashboard Pages (35 pages)

- [x] ✅ `/dashboard/organization/(switcher)/` — org switcher landing + create wizard
- [x] ✅ `/dashboard/organization/[orgId]/home` — capability-driven overview, operator stat grid, role-branched consumer card
- [x] ✅ `/dashboard/organization/[orgId]/members` — member list, invite, role-change, remove (MANAGER+)
- [x] ✅ `/dashboard/organization/[orgId]/learners` — filtered LEARNER roster (`canSponsor` only)
- [x] ✅ `/dashboard/organization/[orgId]/experts` — filtered EXPERT roster (`canHost` only)
- [x] ✅ `/dashboard/organization/[orgId]/invitations` — pending invites, status filter (MAINTAINER+)
- [x] ✅ `/dashboard/organization/[orgId]/my-program` — LEARNER per-org allocation (ProgramAssignment progress, coverage rules, utilization history)
- [x] ✅ `/dashboard/organization/[orgId]/my-arrangement` — EXPERT per-org payout view (payoutRecipient, RateCard split, recent earnings)
- [x] ✅ `/dashboard/organization/[orgId]/programs` — LICENSED_SEAT/CREDIT_POOL programs + assignments (MAINTAINER+, canSponsor)
- [x] ✅ `/dashboard/organization/[orgId]/contracts` — contract lifecycle; `useRequireOrgAccess({ minRole: 'MAINTAINER', canSponsor: true })` guard present *(FF-3 corrected)*; in sidebar under `canSponsor && isAtLeast("MAINTAINER")` *(FF-4 corrected)*
- [x] ✅ `/dashboard/organization/[orgId]/purchase-orders` — PO management; sidebar entry added (Receipt icon, `canSponsor && MAINTAINER+`) *(FX-4, 2026-05-02)*
- [x] ✅ `/dashboard/organization/[orgId]/billing` — invoice list + payment UI; NET-60 StatCard conditional on `fundingSource !== "WALLET"` *(FX-3)*
- [x] ✅ `/dashboard/organization/[orgId]/credits` — wallet balance + top-up + WalletEntry history (WALLET orgs)
- [x] ✅ `/dashboard/organization/[orgId]/payouts` — payout history + TDS summary (MANAGER+, canHost)
- [x] ✅ `/dashboard/organization/[orgId]/analytics` — bookings, revenue, earnings, wallet burn-down (MANAGER+)
- [x] ✅ `/dashboard/organization/[orgId]/settings` — branding, billing email, PO requirement, logo (MAINTAINER+)
- [x] ✅ `/dashboard/organization/[orgId]/settings/sso` — SSO provider + domain config (OWNER only)
- [x] ✅ `/dashboard/organization/[orgId]/audit` — OrgAuditLog viewer + CSV export; in sidebar under `isAtLeast("MAINTAINER")` *(FF-4 corrected)*
- [x] ✅ `/dashboard/organization/[orgId]/consent` — ConsentArtifact roster + DPDP breach log; sidebar entry added (ShieldCheck icon, `MANAGER+`) *(FX-4, 2026-05-02)*
- [x] ✅ `/dashboard/organization/[orgId]/documents` — org branding docs
- [x] ✅ `/dashboard/organization/[orgId]/waitlist` — waitlist management (exists; data not yet org-scoped, #674)
- [x] ✅ `/dashboard/organization/[orgId]/trials` — trial sessions (exists; data not yet org-scoped, #674)
- [x] ✅ `/dashboard/organization/[orgId]/appointments` — cross-program appointment history (exists; data not yet org-scoped, #674)
- [x] ✅ `/dashboard/organization/[orgId]/recordings` — class/webinar recordings archive (exists; data not yet org-scoped, #674)
- [x] ✅ `/dashboard/organization/[orgId]/catalog/search` — search consultants/plans available to org
- [x] 🟡 Analytics charts — stat cards live; time-series chart components deferred (#663)
- [x] 🟡 `/billing` vs `/credits` two-page structure — docs say unified; still two pages in code; NET-60 copy drift fixed (FX-3) but full unification deferred

### 6.2 OrgWorkspace (Cross-Org Operator Dashboard, 4 pages)

- [x] ✅ `/dashboard/org-workspace/[orgWorkspaceId]/home` — cross-org stats row + owned org grid + "New organization" CTA
- [x] ✅ `/dashboard/org-workspace/[orgWorkspaceId]/activity` — cross-org audit feed (cursor-paginated)
- [x] ✅ `/dashboard/org-workspace/[orgWorkspaceId]/billing` — cross-org invoice + wallet balance roll-up (read-only)
- [x] ✅ `/dashboard/org-workspace/[orgWorkspaceId]/settings` — operator preferences scaffold
- [x] ✅ `/dashboard/org-workspace/[orgWorkspaceId]/create` — CreateOrganizationWizard nested in operator chrome

### 6.3 Public Enterprise Pages

- [x] ✅ `/explore/enterprise/organisations` — org directory (public; `isPublic=true` filter)
- [x] ✅ `/explore/enterprise/organisations/[orgSlug]` — single org public profile for booking

### 6.4 Admin Dashboard (21 pages)

- [x] ✅ `/dashboard/admin/organizations` — org verification, suspend, reactivate, deactivate
- [x] ✅ `/dashboard/admin/payments` — payment list + detail
- [x] ✅ `/dashboard/admin/refunds` — refund roster + state transitions
- [x] ✅ `/dashboard/admin/payouts` — payout roster
- [x] ✅ `/dashboard/admin/invoices` — invoice list (all orgs)
- [x] ✅ `/dashboard/admin/disputes` — dispute roster + detail
- [x] ✅ `/dashboard/admin/system-jobs` — background job / cron status board
- [x] ✅ `/dashboard/admin/analytics` — platform analytics
- [x] ✅ All remaining admin pages: users, subscriptions, tickets, feedback, announcements, settings, maintenance, waitlists

### 6.5 Staff Dashboard (16 pages)

- [x] ✅ All 16 staff pages: home, appointments, payments, refunds, payouts, disputes, subscriptions, invoices, users, tickets, moderation, feedback, announcements, metrics, settings, waitlists

---

## Section 7 — Org Context / Switchers / Filters (Weight: 8 pts | Score: 7.2/8)

### 7.1 Session & Identity

- [x] ✅ `OrgWorkspaceProfile` created atomically with first org
- [x] ✅ BetterAuth `customSession` injects `orgWorkspaceProfileId` (nullable) + `organizationMemberships[]` into every session
- [x] ✅ `resolvePersonalDashboardHref` priority: orgWorkspaceProfile → consultantProfile → consulteeProfile → default
- [x] ✅ Backfill script (`prisma/scripts/backfill-org-workspace-profiles.ts`) for existing ORG owners

### 7.2 Organization Switcher

- [x] ✅ `<OrganizationSwitcher />` — dropdown in top bar of both OrgWorkspaceShell and OrgSwitcherTopBar
- [x] ✅ Org-switcher landing page routes to `/org-workspace/[id]/home` for operators; fallback for member-only users
- [x] ✅ No org-context loss on membership role change — BetterAuth session refetch triggered by PATCH `/members/[memberId]`

### 7.3 IDOR Guards

- [x] ✅ Org layout (`/dashboard/organization/[orgId]/layout.tsx`) — server-side `requireOrgAccess` check
- [x] ✅ OrgWorkspace layout — `orgWorkspaceId` must match `session.user.orgWorkspaceProfileId`
- [x] ✅ 404 returned on URL-guessing (no 403 that hints at existence)
- [x] ✅ Every API route under `/api/organizations/[orgId]/**` calls `requireOrgAccess(orgId)` before returning data

### 7.4 Sidebar Visibility Filters

- [x] ✅ Sidebar items memoized in org layout; gated by `canSponsor`, `canHost`, `fundingSource`, and `MemberRole.isAtLeast()`
- [x] ✅ Items that would 404/403/501 are hidden from nav cosmetically; every page still enforces auth independently
- [x] ✅ `/contracts` — in sidebar under `canSponsor && isAtLeast("MAINTAINER")` *(FF-4 corrected)*
- [x] ✅ `/audit` — in sidebar under `isAtLeast("MAINTAINER")` *(FF-4 corrected)*
- [x] ✅ `/purchase-orders` — sidebar entry added (Receipt icon, `canSponsor && MAINTAINER+`) *(FX-4)*
- [x] ✅ `/consent` — sidebar entry added (ShieldCheck icon, `MANAGER+`) *(FX-4)*

### 7.5 Admin & Staff Org Filters

- [x] ✅ Admin organization list with status filter, search by name/slug
- [x] ✅ Admin org detail view with capability toggles and org status machine controls
- [x] ✅ Staff org-filter hooks (`useOrgScope`) for org-scoped queries on staff-facing pages
- [x] 🟡 `useOrgScope` hook + query factory built; not mounted on all admin/staff pages that could benefit (#674)

### 7.6 OrgContextFilter Serialization

- [x] 🟡 `serializeOrgFilter` maps `__personal__` → `"none"` but `resolveOrgScope` expects `"personal"` — no live breakage today (no page mounts the component); TODO #674 comment added to `lib/dashboard/org-context-filter.ts` documenting required rename before any new mount *(FX-7)*

---

## Section 8 — Cross-cutting Integrations (Weight: 7 pts | Score: 4.55/7)

### 8.1 Novu (Notifications)

- [x] ✅ `lib/novu/org-workflows.ts` — 10 enterprise-scoped workflows
- [x] ✅ Roster resolvers: `OPERATOR_ROLES` (OWNER+MAINTAINER), `VISIBILITY_ROLES` (+MANAGER), `OWNER_ONLY`
- [x] ✅ Non-throwing; no-op if `NOVU_API_KEY` absent
- [x] ✅ Wired workflows: `ORG_INVITE_SENT`, `ORG_INVITE_ACCEPTED`, `ORG_INVOICE_ISSUED`, `ORG_INVOICE_PAID`, `ORG_WALLET_TOPUP_CONFIRMED`, `ORG_PAYOUT_COMPLETED`, `ORG_PAYOUT_FAILED`, `ORG_PAYOUT_REVERSED`, `ORG_PROGRAM_EXHAUSTED`, `ORG_SSO_PROVIDER_DELETED`, `ORG_SSO_CERT_EXPIRING`
- [x] 🟡 `DataBreach` 72-hour DPDP deadline tracker — live (`jobs/compliance/databreach-deadline-alerts.ts`, hourly cron). Email dispatch + structured log. Full Novu admin-roster fan-out still pending (#701) *(RX-3)*

### 8.2 Stream.io (Video & Chat)

- [x] ✅ `Organization.recordingsByOrg` + `Appointment.organizationId` FK anchors added
- [x] 🔴 Stream channel `custom.organizationProfileId` — **not set** at channel creation; org cannot filter its own video sessions (#674)
- [x] 🔴 No enterprise recordings library (per-org recording browse/playback) (#367)
- [x] 🔴 Stream token generation is org-blind; no org-specific capabilities or access rules

### 8.3 BetterAuth SSO

- [x] ✅ Organization plugin + SSO plugin wired
- [x] ✅ `OrganizationSSOSettings` + `OrgDomainClaim` schema + routes
- [x] ✅ DNS TXT verification (`GET /api/organizations/[orgId]/domain-claims/[domain]/verify`)
- [x] ✅ `shouldRejectSession` enforces SSO for domain-claimed orgs on sign-in
- [x] ✅ SSO domain-check endpoint (`GET /api/auth/sso/domain-check`) with 60/hr IP rate limit for tenant-enumeration protection
- [x] ✅ `sso-cert-expiry-alert.yml` cron + `ORG_SSO_CERT_EXPIRING` Novu workflow
- [x] 🟡 Live OIDC: label fix + `userId` on org-scoped providers — deferred (#670, #672); SAML only today

### 8.4 Razorpay / Stripe

- [x] ✅ Razorpay order minted for wallet top-ups
- [x] ✅ Org-keyed wallet top-up rate limit (middleware)
- [x] ✅ `OrganizationPayoutAccount.razorpayContactId` + `razorpayFundAccountId` fields
- [x] 🔴 RazorpayX `payouts.create` — **not called**; `ENABLE_LIVE_PAYOUTS=false` guard blocks it (PR-3)
- [x] 🔴 Stripe Connect `transfers` — **not called** (PR-3)
- [x] 🔴 No webhook handler for payout completion (`razorpay_payout.processed`, `transfer.created`)

### 8.5 Resend / Email

- [x] 🟡 Org invite emails sent via Novu (which routes to Resend); not directly wired to org email templates yet

---

## Section 9 — Crons & Operational Readiness (Weight: 5 pts | Score: 3.25/5)

### 9.1 Active Crons (Enterprise-Related)

- [x] ✅ `expire-contracts.yml` — daily 03:00 UTC; marks ACTIVE contracts EXPIRED
- [x] ✅ `cleanup-abandoned-org-top-ups.yml` — daily 02:00 UTC; purges PENDING wallet entries >24h
- [x] ✅ `reconcile-ledgers.yml` — nightly; three-ledger balance check; `LedgerReconciliationReport` written
- [x] ✅ `release-pending-trust-earnings.yml` — wired in GH Actions; releases PENDING_TRUST earnings on org ACTIVE
- [x] ✅ `process-payouts.yml` — weekly; rolls up RELEASED earnings into payout batch
- [x] ✅ `sso-cert-expiry-alert.yml` — weekly; fires `ORG_SSO_CERT_EXPIRING` Novu workflow
- [x] ✅ Cron schedule staggering avoids contention (02:00, 03:00, not 00:00)
- [x] ✅ `idempotencyKey @unique` on `OrganizationPayout` prevents duplicate cron runs
- [x] ✅ `orgInviteLimiter` — 20/hr per `orgId` Upstash sliding-window on `POST /invitations` handler *(FX-6)*

### 9.2 Scaffolded Crons (Need GH Actions Wiring)

- [x] 🔴 `jobs/billing/generate-subscription-invoices.ts` — INVOICE monthly roll-up; cron body exists, not scheduled (#TODO)
- [x] ✅ ~~`jobs/compliance/irp-uploader.ts` needs GH Actions wiring~~ — wired daily 02:30 UTC *(RX-1, 2026-05-02)*
- [x] ✅ ~~`jobs/compliance/msme-payment-alerts.ts` needs GH Actions wiring~~ — wired daily 04:30 UTC *(RX-2, 2026-05-02)*
- [x] ✅ ~~DataBreach 72-hour deadline tracker~~ — added `jobs/compliance/databreach-deadline-alerts.ts` + hourly cron *(RX-3, 2026-05-02)*
- [x] 🔴 HRIS sync cron — no connector; `HrisConfig.lastSyncedAt` never updated (#701)

### 9.3 Alerting & Observability

- [x] 🔴 All cron YAML files: `# TODO: wire to #ops-alerts Slack channel` — **no failure notification** for any cron (#709)
- [x] 🔴 No health-check service (Healthchecks.io / Betterstack) for cron heartbeat monitoring
- [x] 🔴 No Sentry alert on `LedgerReconciliationReport.ok = false` — discrepancies visible only by querying DB
- [x] 🔴 No structured log event taxonomy tied to PagerDuty / oncall rotation

### 9.4 Remaining Security & Ops Gaps

- [x] ✅ ~~Audit export has no row-count limit~~ — `MAX_ITERATIONS=400` × `CSV_CHUNK_SIZE=500` = 200k-row hard ceiling *(FF-2 corrected)*
- [x] ✅ ~~Invoice payment endpoint lacks idempotency key~~ — `providerPaymentOrderId` persisted atomically at order creation *(FF-1 corrected)*
- [x] ✅ ~~CSV upload has no file size cap~~ — 5 MB `Content-Length` guard returns 413 PAYLOAD_TOO_LARGE before `req.json()` buffers the body *(RX-4, 2026-05-02)*
- [x] 🔴 No API key / M2M auth for HRIS sync — requires interactive UI session

---

## Section 10 — Testing & Type Safety (Weight: 5 pts | Score: 4.75/5)

- [x] ✅ **875/875 tests passing** (47 suites) *(up from 825; new suites added 2026-05-02)*
- [x] ✅ `tsc --noEmit` clean (no TypeScript errors)
- [x] ✅ TDS derivation tests (`test(enterprise): TDS derivation, MSME deadlines, payout/refund coverage`)
- [x] ✅ Booking algorithm E2E tests (Agents 001–006): all 4 event type checkouts, overnight slot CRUD, concurrent auto-allocate, integer/date validation, consultant-scoped filtering, waitlist overflow
- [x] ✅ 6 UI E2E test runs via Chrome DevTools MCP + Supabase MCP
- [x] ✅ `SlotAllocationService.classifyError` — P2002 → 409 mapping tested
- [x] 🟡 No load/stress test on: PENDING_TRUST gate under concurrent INVOICE checkouts, reconcile cron under high volume
- [x] 🔴 No integration tests for enterprise API routes (only unit tests for helpers/services)

---

## Critical Path to First Paying B2B Tenant

| Priority | Workstream | Est. Effort | Gate Unlocked |
|----------|-----------|------------|---------------|
| **1** | **PR-2: India compliance go-live** | 2 weeks | GSTIN live verify, TDS withholding, MSME alert cron wired, IRN cron wired (#681), GST derivation live |
| **2** | **PR-3: Live payout + SSO** | 1.5 weeks | Money actually moves via RazorpayX/Stripe; webhook reconciler; OIDC live (#670, #672) |
| **3** | **#674: Org scope split** | 2 weeks | Org admin can see their org's appointments/waitlist/trials/recordings; Stream org metadata; `OrgContextFilter` serialization fix |
| **4** | **#716 + #715: Refund + clawback** | 1.5 weeks | Multi-leg refund + payout clawback + `OVERAGE_INVOICE_ACCRUAL` credit-note |
| **5** | **Cron alerting (#709)** | 1 day | On-call knows when crons fail |
| **6** | **CSV upload size limit** | 0.5 days | File size cap on HRIS CSV import |
| **7** | **#701: HRIS, DataBreach Novu, DPDP cascade** | 3 weeks | Compliance stub closures |
| **8** | **Soak window** | 2–4 weeks | Zero reconcile discrepancies for 14 consecutive days before multi-tenant go-live |

**~10 weeks to self-serve multi-tenant enterprise.**
**With manual ops (one design-partner): PR-2 + PR-3 only (~3.5 weeks).**

---

## Do-Not-Build List (Confirmed April 2026)

| Item | Reason |
|------|--------|
| TCS Section 206C(1H) collection | Removed by Finance Act 2025 (effective 1 Apr 2025) |
| Section 206AB higher TDS | Omitted by Finance Act 2025 (effective 1 Apr 2025) |
| Equalisation Levy (2% + 6%) | Abolished effective 1 Aug 2024 (Finance Act 2024) |
| ZestMoney EMI | Shut down Dec 2023; use Propelld/Eduvanz/Bajaj/HDFC Credila |
| Self-custodied escrow | Requires ₹15Cr net worth; route via RazorpayX/Cashfree instead |
| Internal IRP integration | Use licensed connector (IRIS/ClearTax/Masters India); `lib/compliance/irp.ts` calls ClearTax |
| Parent–child org hierarchy UI | Schema columns exist; defer until first customer request |
| Programs v2 (PROJECT/RETAINER) runtime | Enum reserved; build only after design-partner feedback |

---

## Soak Window Requirements (Before Self-Serve Multi-Tenant)

The following must be true for **14 consecutive days** before declaring multi-tenant production-ready:

1. `LedgerReconciliationReport.ok = true` every night — zero discrepancies
2. `process-payouts` cron completes without manual intervention
3. At least one full invoice cycle: DRAFT → ISSUED → PAID → PAYOUT COMPLETED
4. At least one org-sponsored booking with correct TDS withheld and persisted
5. At least one IRP IRN successfully generated and persisted (irpStatus = GENERATED)
6. Zero `PENDING_TRUST` earnings lingering >7 days
7. Cron alerting wired — at least one test failure caught and notified automatically

---

*Initial audit: Claude Code (claude-sonnet-4-6) via 3-agent parallel codebase sweep (450+ files). Cross-verified against: Prisma schema (4025 lines), enterprise docs (27 numbered + 6 narrative files), tasks/enterprise-readiness-1.txt, tasks/notifications.txt, git log (last 20 commits), 54 API routes, 35 org dashboard pages, 21 admin pages, 16 staff pages. Revised 2026-05-02 after developer corrections (5 false findings, 7 real fixes).*
