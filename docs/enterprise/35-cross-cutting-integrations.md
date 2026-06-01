# Cross-cutting integrations — enterprise surface map

The enterprise subsystem is not a self-contained module. It plumbs
itself through every existing pre-enterprise subsystem so that an org
operator gets one coherent dashboard view of work their members do,
and so that platform-side jobs (billing crons, payout batches, audit
sweeps, retention sweeps) can treat the org as a tenant.

This doc is the single reference for which subsystems are wired into
enterprise, which are explicitly **not** wired (and why), and which
specific code paths/schema columns connect them. Use it as the answer
to "should this new feature touch enterprise?" and as a triage map
when an org operator reports "X feels broken — does this even know
about orgs?".

## How to read this doc

Every subsystem has a status row:

| Marker | Meaning |
|---|---|
| ✅ Wired | Production-ready org-aware. New work should keep this contract. |
| 🟡 Partial | Some surfaces are org-aware; others still single-tenant. PR or follow-up issue should close. |
| 🔴 Skipped | Deliberately NOT org-aware. The rationale below explains why; reopen only with explicit customer demand. |
| ⏸ Parked | Org-aware path exists but is gated behind a flag or deferred until a customer asks. |

Each section also lists:

- **Schema** — Prisma models + key columns that link to `Organization`
- **Code paths** — main `lib/`, `actions/`, `app/api/`, or `jobs/` files
- **Org dashboard surface** — which `/dashboard/organization/[orgId]/*` route exposes it (if any)
- **Why** — the design reason, in one paragraph
- **Future work** — open GitHub issue numbers (no URLs — GitHub autolinks)

---

## A. Booking & appointment plane

### A.1 Appointments — ✅ Wired

- **Schema:** `Appointment.organizationId` (denorm, `#674` scope split). Stamped at checkout when the booker is an org-funded membership.
- **Code paths:** [`lib/payments/operations/checkout.ts`](../../lib/payments/operations/checkout.ts) (1737–1805 derives org context); [`app/api/organizations/[orgId]/appointments`](../../app/api/organizations/[orgId]/appointments) (org-scoped read).
- **Org dashboard surface:** `/dashboard/organization/[orgId]/appointments`
- **Why:** Appointment is the lowest-cardinality booking artifact. Tagging it directly (rather than back-deriving from `Payment.organizationId`) keeps org-scoped queries on a single composite index and unblocks per-org appointment audit dashboards.
- **Future work:** none open.

### A.2 Bookings (checkout flow) — ✅ Wired

- **Schema:** `Payment.organizationId`, `Payment.billingAccountId`, `Payment.billableToOrgInvoiceId`, `BookingUtilization.programAssignmentId` → `Program.contractId` → `Contract.organizationId`. Wallet debits via `walletDebit()` (`lib/api/organizations/wallet.ts`).
- **Code paths:** [`lib/payments/operations/checkout.ts`](../../lib/payments/operations/checkout.ts) routes the four funding modes (PERSONAL/WALLET/INVOICE/LICENSE) — see §02 for the rules. `BookingUtilization` is written inside the same `tx` as the appointment create so program-cap state and the booking commit together.
- **Org dashboard surface:** `/billing`, `/reimbursements`, `/programs`.
- **Why:** Money and entitlement state share one Serializable transaction so a crash mid-booking can never produce a debit without a booking or a booking without a debit.
- **Future work:** `#716` refund/payouts/pricing epic (parked).

### A.3 Documents-for-review — ✅ Wired

- **Schema:** Inherited via `AppointmentDocument.appointmentId → Appointment.organizationId`. No direct FK on the document row.
- **Code paths:** [`lib/api/scope/list-documents.ts`](../../lib/api/scope/list-documents.ts); [`app/dashboard/organization/[orgId]/documents/page.tsx`](../../app/dashboard/organization/[orgId]/documents/page.tsx).
- **Org dashboard surface:** `/documents`
- **Why:** Documents are 1:1 (or 1:N) with appointments. Inheritance avoids drift between document and parent-appointment tenancy. Bulk-review queries must filter on `Appointment.organizationId`, never application-side.
- **Future work:** none open.

### A.4 Bookings — Stream meeting/video — 🟡 Partial → ✅ as of `#674` C.4

- **Schema:** `MeetingSession.organizationId` (denorm, added in C.4 migration `20260528_meeting_session_organization_id_denorm`). `Recording.organizationId` already denormalized in PR `#655`.
- **Code paths:** [`actions/stream/meetings/meeting.action.ts`](../../actions/stream/meetings/meeting.action.ts) writes `organizationId` at create; [`app/api/organizations/[orgId]/stream/calls/route.ts`](../../app/api/organizations/[orgId]/stream/calls/route.ts) indexes directly on `(organizationId, createdAt)` instead of joining through `SlotOfAppointment`.
- **Org dashboard surface:** `/recordings`
- **Why:** Org admins need audit + retention queries that are constant-time per page load. Network round-trips to Stream's `queryCalls` are too slow for a dashboard list view; the local join-free path is what makes the surface viable.
- **Future work:** Stream transcription retention enforcement remains global; per-org retention only applies to recordings today.

---

## B. Money plane

### B.1 Payments — ✅ Wired

- **Schema:** `Payment.organizationId`, `Payment.fundingSource` (via webhook attribution), `Payment.billingAccountId`. Razorpay order `notes` now carry `organizationId` + `fundingSource` on org-sponsored bookings (C.1, `#687`).
- **Code paths:** [`lib/payments/core/razorpay.ts`](../../lib/payments/core/razorpay.ts); [`lib/payments/operations/checkout.ts:buildPaymentMetadata`](../../lib/payments/operations/checkout.ts); [`app/api/webhooks/utils.ts`](../../app/api/webhooks/utils.ts) reads `notes.organizationId` for credit-purchase, invoice-payment, and refund flows.
- **Why:** The gateway notes are a server-side proof that the booker's claimed org matches the gateway's record. Without them, a `#687` invoice-fraud reconciler would need a DB lookup per webhook to verify org attribution; with them, the verification is a string compare inside the webhook handler.
- **Future work:** PR-3 webhook reconciler to cross-check `notes.organizationId` against `Payment.organizationId` and surface drift in `SystemEvent`.

### B.2 Wallet — ✅ Wired

- **Schema:** `BillingAccount.walletBalance` (derived cache), `WalletTopUp` (top-up lifecycle, keyed by `providerOrderId @unique`), and the org's WALLET `LedgerAccount` (credit-normal) holding one `LedgerEntry` per cash movement.
- **Code paths:** [`lib/api/organizations/wallet.ts`](../../lib/api/organizations/wallet.ts) — `walletDebit()`/`walletCredit()` move the cached balance; `initiateTopUp()`/`confirmTopUp()` drive the `WalletTopUp` lifecycle. A confirmed top-up posts one balanced `LedgerTransaction` (`Dr CASH / Cr WALLET`) via [`postLedgerTxn`](../../lib/payments/ledger/post.ts) inside the same `tx`.
- **Org dashboard surface:** `/billing`
- **Why:** The journal (`08-ledger-and-postings.md`) is the source of truth; `walletBalance` is a cache asserted against the WALLET account by the reconciler (`WALLET_BALANCE_DRIFT`). `LedgerAccount.currency` exists so a future multi-currency wallet (`#711`) doesn't need a backfill against historical postings.
- **Future work:** Multi-currency wallets (`#711`, parked).

### B.3 Payouts — ✅ Wired (HOST orgs)

- **Schema:** `OrganizationPayout`, `OrganizationEarnings`, `OrganizationPayoutAccount` (encrypted account number). TDS columns on the payout row.
- **Code paths:** [`scripts/payouts/create-payout-batch.ts`](../../scripts/payouts/create-payout-batch.ts) loops per canHost org; [`lib/payments/payouts/org-payout-service.ts:markOrgPayoutCompleted`](../../lib/payments/payouts/org-payout-service.ts) does the idempotent PROCESSING → COMPLETED transition and fires the Novu notify (`#718`).
- **Org dashboard surface:** `/payouts`
- **Why:** Payouts run as a weekly batch; per-org idempotency keys ensure re-running the cron in the same window is a no-op. The Novu fan-out is co-located with the status transition so a future status-change call site cannot silently forget to notify.
- **Future work:** Live RazorpayX submission + Stripe Connect `transfers` (PR-3 territory, deferred). Webhook reconciler.

### B.4 Invoicing — ✅ Wired

- **Schema:** `OrganizationInvoice` (per-org sequential numbering via `OrgInvoiceCounter`). GST breakdown columns (`igstPaise`/`cgstPaise`/`sgstPaise`/`placeOfSupply`). IRP fields (`irn`, `ackNumber`, `signedQrPayload`, `irpStatus`, `irpRetryCount`).
- **Code paths:** [`app/api/organizations/[orgId]/billing-account/invoices/route.ts`](../../app/api/organizations/[orgId]/billing-account/invoices/route.ts) (POST with race-safe PO decrement); [`jobs/billing/generate-subscription-invoices.ts`](../../jobs/billing/generate-subscription-invoices.ts) (cycle billing).
- **Org dashboard surface:** `/billing`
- **Why:** Atomic counter under `(organizationId, fiscalYear)` makes concurrent invoice issuance race-safe. The PO balance decrement is wrapped in the same transaction with a `gte` overflow guard so two simultaneous issuances cannot overdraw an authorised PO.
- **Future work:** Form 26Q quarterly TDS filing; multi-attendee per-place-of-supply billing (both parked).

### B.5 Purchase Orders — ✅ Wired

- **Schema:** `PurchaseOrder.organizationId`, `PurchaseOrder.remainingAmountPaise` (race-safe decrement at invoice issuance; race-safe increment on void/cancel).
- **Code paths:** [`app/api/organizations/[orgId]/billing-account/purchase-orders/route.ts`](../../app/api/organizations/[orgId]/billing-account/purchase-orders/route.ts); invoice-side decrement in [`app/api/organizations/[orgId]/billing-account/invoices/route.ts`](../../app/api/organizations/[orgId]/billing-account/invoices/route.ts) (lines 210-230).
- **Org dashboard surface:** `/purchase-orders`
- **Why:** Indian enterprise orgs frequently require a PO before an invoice can be issued. The atomic decrement pattern mirrors the wallet-debit `where: { remaining: { gte: amount } }` discipline.
- **Future work:** none open.

### B.6 BillingSubscription (LICENSE recurring) — ✅ Wired

- **Schema:** `BillingSubscription` (linked 1:1 to `Contract`). `BillingSubscription.renewalReminderSentAt` (once-per-cycle gate for renewal-upcoming notification, C.5).
- **Code paths:** [`jobs/billing/generate-subscription-invoices.ts`](../../jobs/billing/generate-subscription-invoices.ts) — `sendRenewalReminders()` at job entry then the existing cycle-advance + invoice transaction (invoice-paid postings land via `postLedgerTxn` when the payment confirms).
- **Org dashboard surface:** `/billing` (Annual License panel)
- **Why:** Single daily cron handles both renewal-upcoming notification (7 days before `nextInvoiceDate`) and renewal-day invoice creation. Same idempotency pattern (conditional `updateMany` claim) for both steps.
- **Future work:** GH Actions schedule for `generate-subscription-invoices` (currently local-only).

### B.7 Double-entry ledger discipline — ✅ Wired

- **Schema:** money journal — `LedgerAccount` (10 kinds: CASH, WALLET, PLATFORM_FEE, PLATFORM_PROMO, DISCOUNT, CONSULTANT_PAYABLE, ORG_PAYABLE, ORG_RECEIVABLE, TDS_PAYABLE, GST_PAYABLE) / `LedgerTransaction` (`idempotencyKey @unique`) / `LedgerEntry` (DEBIT|CREDIT, `amountPaise` BigInt) — plus the usage ledger `UsageLedgerEntry` and `LedgerReconciliationReport`.
- **Code paths:** every money-moving site posts one balanced `LedgerTransaction` (`Σ DEBIT == Σ CREDIT`) via [`postLedgerTxn`](../../lib/payments/ledger/post.ts). Reconcile cron [`scripts/reconcile/reconcile-ledgers.ts`](../../scripts/reconcile/reconcile-ledgers.ts) (also the `jobs/reconcile/reconcile-ledgers.ts` entry point) asserts journal + aggregate invariants nightly.
- **Why:** See `08-ledger-and-postings.md`. Two ledgers (money journal + `UsageLedgerEntry`), not three. The journal is append-only; any reversal is a balanced counter-transaction, never an update of the original.
- **Future work:** none open.

---

## C. Membership & access

### C.1 Roles & Permissions — ✅ Wired

- **Schema:** `Membership.role` (7-role ladder: OWNER → MAINTAINER → BILLING_ADMIN → MANAGER → EXPERT → SUPPORT → LEARNER). `MemberRole` enum.
- **Code paths:** [`lib/auth-helpers.ts:requireOrgAccess`](../../lib/auth-helpers.ts) + [`lib/auth/billing-admin-gate.ts`](../../lib/auth/billing-admin-gate.ts). Role-transition reconciliation in [`lib/api/organizations/membership-transitions.ts`](../../lib/api/organizations/membership-transitions.ts).
- **Why:** Role rank decides not just permission but profile reconciliation — LEARNER lazy-creates `ConsulteeProfile`, EXPERT lazy-creates `ConsultantProfile`. The bridge ensures consultant earnings and consultee bookings work the moment a role flip commits.
- **Future work:** none open.

### C.2 Invitations — ✅ Wired

- **Schema:** BetterAuth `Invitation` table bridged to `Membership` at accept time. `OrgDomainClaim` for SSO auto-join.
- **Code paths:** [`app/api/organizations/[orgId]/invitations/route.ts`](../../app/api/organizations/[orgId]/invitations/route.ts). `HostInvitableMemberRoleSchema` extends the standard list with EXPERT when the org is `canHost=true` (`#729`).
- **Org dashboard surface:** `/invitations`
- **Why:** Self-service add of EXPERT is gated to canHost orgs at the schema level so a sponsor-only org cannot accidentally onboard a consultant.
- **Future work:** Partial-unique index on `(email, organizationId)` waiting on Prisma 7 GA (`#747`).

### C.3 OrgWorkspace (cross-org operator) — ✅ Wired

- **Schema:** `OrgWorkspaceProfile` (1:1 with `User`, mirrors `ConsultantProfile`/`StaffProfile`). Preference columns: `defaultLandingOrganizationId`, `notificationRoutingMode`, `locale`, `currencyDisplayCode`.
- **Code paths:** [`app/dashboard/org-workspace/`](../../app/dashboard/org-workspace) — 5 pages.
- **Why:** A single human can operate multiple orgs (consultancy with several clients). The workspace profile lets the session carry the operator's preferences across the orgs they have access to, without polluting `Membership` (which is per-org).
- **Future work:** none open.

### C.4 SSO + Domain Claims — ✅ Wired

- **Schema:** `OrganizationSSOSettings`, `OrgDomainClaim` (DNS TXT verification), SAML provider rows.
- **Code paths:** [`lib/sso/provider-schemas.ts`](../../lib/sso/provider-schemas.ts) — `validateSamlCert` PEM check that fails closed before BetterAuth sees a malformed cert (closeout fix). [`app/api/auth/sso/domain-check/route.ts`](../../app/api/auth/sso/domain-check/route.ts).
- **Org dashboard surface:** `/settings/sso`, `/domain-claims`
- **Why:** Domain verification via TXT + cert PEM validation means the org provisioning surface fails fast and friendly instead of crashing BetterAuth at first assertion.
- **Future work:** OIDC live deployment (`#670`/`#672`, deferred); cert auto-rotation runbook.

### C.5 SCIM provisioning — ⏸ Parked (stubbed 501)

- **Schema:** `ScimToken`, `ScimGroupMapping`.
- **Code paths:** Routes return 501 by default.
- **Why:** Schema is ready for the first customer that asks. Zero customers today, so the route handlers are stubbed instead of implemented — saves ~500 LoC of speculative provisioning code while keeping the option open.
- **Future work:** Implement when a customer commits to SCIM.

---

## D. Programs & rate plans

### D.1 Programs — ✅ Wired (LICENSED_SEAT + CREDIT_POOL)

- **Schema:** `Program`, `LicensedSeatConfig`, `CreditPoolConfig`, `ProgramAssignment`, `BookingUtilization`.
- **Code paths:** [`lib/api/organizations/program-helpers.ts:recordBookingUtilization`](../../lib/api/organizations/program-helpers.ts) — the cap-enforce + engagement-debit path. PR-1e cap counting (`#710`) handled in [`lib/payments/operations/checkout.ts`](../../lib/payments/operations/checkout.ts) where `engagementsForCap` is derived per-plan-type.
- **Org dashboard surface:** `/programs`
- **Why:** Cap enforcement modes (BLOCK/CHARGE_MEMBER/CHARGE_ORG) and the engagement-counter pattern are described in `21-programs.md`. The booking transaction owns both the cap decision and the appointment commit.
- **Future work:** Programs v2 (PROJECT/RETAINER) parked behind `PROGRAM_TYPE_NOT_AVAILABLE` rejection guard (`#681` parked).

### D.2 RateCards — ✅ Wired (canHost orgs)

- **Schema:** `RateCard` with FK `ownerOrgId → organizations(id)` (`#728` fix landed in PR `#682`-era migration `20260427052712`). 7-level override chain (org-default → contract → plan-type → plan-id → membership-override).
- **Code paths:** [`lib/api/organizations/rate-card.ts:bumpRateCard`](../../lib/api/organizations/rate-card.ts) — append-only `effectiveFrom` writes, never UPDATE. BPS snapshot on `BookingUtilization` so a rate-card change doesn't retroactively alter historical revenue split.
- **Org dashboard surface:** `/settings/rate-cards` (canHost only)
- **Why:** Settlement reads the BPS snapshot from the utilization row, not the live rate card, so an org changing its split doesn't restate past earnings.
- **Future work:** none open.

### D.3 Contracts — ✅ Wired

- **Schema:** `Contract` (status machine DRAFT → ACTIVE → EXPIRED/TERMINATED), `paymentTermsDays`, `autoRenew`.
- **Code paths:** [`app/api/organizations/[orgId]/contracts/route.ts`](../../app/api/organizations/[orgId]/contracts/route.ts) handles LICENSE-funded create as an atomic Contract + BillingSubscription write so the org dashboard never sees half-configured LICENSE state (`#756`).
- **Org dashboard surface:** `/contracts`
- **Why:** A LICENSE contract without a BillingSubscription is incoherent; bundling them in one transaction means the Get-Started checklist on `/home` doesn't need a retry path.
- **Future work:** none open.

---

## E. Stream chat & video

### E.1 Stream consultation/webinar/class channels — ✅ Wired

- **Schema:** No Prisma fields — Stream stores channels externally. Org tagging is `custom.organization_id` on the Stream channel.
- **Code paths:** [`actions/stream/chat/channel.action.ts`](../../actions/stream/chat/channel.action.ts) — `createConsultationChannel`, `createSubscriptionChannel`, `createWebinarChannel`, `createClassChannel`. Each accepts an optional `organizationId` override; otherwise falls back through `plan.organizationId` → `appointment.organizationId` (C.3) → null.
- **Why:** Plan-level org covers org-hosted plans; appointment-level org covers org-funded bookings on platform plans. Combined, the chain catches the 2 customer-relevant cases without false positives on personal bookings.
- **Future work:** none open.

### E.2 Stream DM (direct message) channels — 🔴 Skipped

- **Code paths:** [`actions/stream/chat/channel.action.ts:createDirectMessageChannel`](../../actions/stream/chat/channel.action.ts).
- **Why:** DMs are private 1:1 communication. Tagging them with org context creates a surveillance surface (org admins could query "DMs my members had with consultants"). Org-tagged consultation channels already cover the legitimate audit need.
- **Future work:** none. Reopen only if a customer with a documented compliance requirement asks.

### E.3 Stream video / MeetingSession — ✅ Wired (C.4)

See A.4. Recording retention sweeps per-org via `Organization.streamRecordingRetentionDays` in [`scripts/cleanup/cleanup-old-stream-recordings.ts`](../../scripts/cleanup/cleanup-old-stream-recordings.ts).

---

## F. Compliance

### F.1 GST — ✅ Wired

- **Schema:** `Organization.gstin`, `Organization.gstStateCode`, GST columns on `OrganizationInvoice`.
- **Code paths:** [`lib/compliance/gst.ts:deriveGstBreakdown`](../../lib/compliance/gst.ts).
- **Why:** Place-of-supply rules require supplier vs buyer state comparison; the helper returns either CGST+SGST (intra-state) or IGST (inter-state). The supplier state is env-overridable so a registered office move doesn't require code changes.
- **Future work:** Live GSTIN registry verification API (format-only validation today, parked).

### F.2 TDS — ✅ Wired (Section default + derivation)

- **Schema:** TDS columns on `OrganizationPayout` (`tdsSectionApplied`, `tdsAmountPaise`, `form15caPartCRef`, etc.).
- **Code paths:** [`lib/compliance/tds.ts:computeTdsForPayout`](../../lib/compliance/tds.ts).
- **Why:** Section selection (194J vs 194O vs 194C) currently defaults to 194O; PR-2 will wire the full derivation including expert-status checks.
- **Future work:** Section selection logic (`#713`-1); Form 26Q quarterly filing (parked).

### F.3 MSME — ✅ Wired

- **Schema:** `Organization.msmeStatus` enum; `OrganizationPayout.mustPayByDate`.
- **Code paths:** [`lib/compliance/msme.ts:computeMsmePaymentDeadline`](../../lib/compliance/msme.ts); [`jobs/compliance/msme-payment-alerts.ts`](../../jobs/compliance/msme-payment-alerts.ts).
- **Why:** Section 43B(h) of the Income Tax Act requires MSME payments within 15/45 days. The deadline cron alerts before a default would lock the org's expense deduction.
- **Future work:** none open.

### F.4 DPDP — ConsentArtifact + DataExport + DataBreach — 🟡 Partial

- **Schema:** `ConsentArtifact`, `OrgDataExportJob`, `DataBreach`.
- **Code paths:** [`scripts/cleanup/process-data-exports.ts`](../../scripts/cleanup/process-data-exports.ts) — 7-day signed-URL export bundles, in-app Novu notify to OWNERs (C.6). [`jobs/compliance/databreach-deadline-alerts.ts`](../../jobs/compliance/databreach-deadline-alerts.ts) — 72-hour DPDP breach reporting clock.
- **Why:** The export bundle is JSON-only (not zipped JSON+CSV) — compliance reviewers prefer JSON, and integrators can convert via `jq -r '@csv'`. Bundle URL expiry matches the typical post-export ETL window.
- **Future work:** Erasure cascade workflow (DPDP §12), retention dashboard UI, withdrawal-of-consent enforcement (`#701`).

### F.5 IRP / e-invoice — 🟡 Partial (env-gated)

- **Schema:** `OrganizationInvoice.irn`, `ackNumber`, `signedQrPayload`, `irpStatus`, `irpRetryCount`.
- **Code paths:** [`jobs/compliance/irp-uploader.ts`](../../jobs/compliance/irp-uploader.ts) ClearTax connector with retry telemetry.
- **Why:** Production approval pending; the env-gate (`ENABLE_IRP_LIVE=false`) keeps the connector exercised in dev without firing real IRP submissions.
- **Future work:** Production approval + sandbox proof (PR-2).

### F.6 HRIS provisioning — ⏸ Parked

- **Schema:** `HrisConfig`.
- **Code paths:** Routes return 404 when `ENABLE_HRIS=false` (default).
- **Why:** No design-partner customer has asked. Schema is reserved; connector implementation deferred.
- **Future work:** Build when a customer commits (`#744` E3).

---

## G. Operational plane

### G.1 Audit log — ✅ Wired

- **Schema:** `OrgAuditLog` (append-only, org-visible). 9 categories. Read-side scrubbing via [`lib/enterprise/audit-sanitize.ts`](../../lib/enterprise/audit-sanitize.ts).
- **Code paths:** Every mutation site writes an `OrgAuditLog` row. CSV export at [`app/api/organizations/[orgId]/audit/export/route.ts`](../../app/api/organizations/[orgId]/audit/export/route.ts) with a 200k-row ceiling.
- **Org dashboard surface:** `/audit`
- **Why:** Org-visible audit log must not leak engineering noise (stack traces, Prisma error syntax). The three-layer defense — write-side discipline, read-side scrub, channel separation — is documented in `44-system-events.md`.
- **Future work:** none open.

### G.2 SystemEvent (admin-only) — ✅ Wired

See `44-system-events.md`. Raw engineering payloads go here, never to `OrgAuditLog`.

### G.3 Notifications (Novu) — ✅ Wired

- **Schema:** No Prisma — Novu is external. Roster derived from `Membership` at trigger time.
- **Code paths:** [`lib/novu/org-workflows.ts`](../../lib/novu/org-workflows.ts) — 12 helpers. Workflow IDs in [`lib/novu/workflows.ts`](../../lib/novu/workflows.ts).
- **Why:** Each `notifyOrg*` helper queries the relevant `Membership` roster (OWNER-only for finance events; all-active for membership events) and triggers Novu. Non-throwing — Novu downtime never blocks the underlying mutation.
- **Future work:** Workflow template body/email/digest config in the Novu dashboard (ops track).

### G.4 Outbound webhooks — ✅ Wired

- **Schema:** `WebhookEndpoint`, `OutboundWebhookDelivery` (HMAC-SHA256 signed).
- **Code paths:** [`lib/enterprise/outbound-webhooks/`](../../lib/enterprise/outbound-webhooks).
- **Why:** Integrators receive signed delivery events for org lifecycle changes; redeliver path is idempotency-keyed on `(endpointId, eventId)`.
- **Future work:** none open.

### G.5 MaintenanceWindow — ✅ Wired (read-side, C.2)

- **Schema:** `MaintenanceWindow.organizationId` (nullable; NULL = platform-wide).
- **Code paths:** [`lib/maintenance.ts:getActiveOrgMaintenanceWindow`](../../lib/maintenance.ts); [`scripts/payouts/create-payout-batch.ts`](../../scripts/payouts/create-payout-batch.ts) skips a single tenant on an active OFFLINE window.
- **Why:** Per-org maintenance lets ops pause finance jobs for one tenant (e.g. mid-migration, mid-audit) without affecting the rest of the batch.
- **Future work:** Admin write API, per-org Redis keys, Novu on window start/end, wire into `generate-subscription-invoices.ts` (filed as follow-up under `#746`).

---

## H. Org dashboard surfaces (25 routes)

Each route lives at `/dashboard/organization/[orgId]/<slug>`. All are MANAGER+ unless noted; BILLING_ADMIN gets the finance-tuned `/home` variant.

| Route | Surface |
|---|---|
| `/home` | Stat grid (members / programs / wallet / invoices / reimbursements (PERSONAL only, C.B.4) / earnings) + Get Started checklist + activity feed |
| `/members` | Roster + invite role gating + role-transition guards |
| `/my-program` | LEARNER-only view of their own ProgramAssignment |
| `/my-arrangement` | EXPERT-only view of their rate-card + earnings |
| `/programs` | LICENSED_SEAT / CREDIT_POOL CRUD + assignment + overage view |
| `/contracts` | Contract CRUD + LICENSE flat-fee on-create flow |
| `/purchase-orders` | PO CRUD + remainingAmountPaise display |
| `/billing` | Wallet / invoices / Annual License panel (LICENSE only) |
| `/payouts` | OrganizationPayout list (canHost only) |
| `/settings` | Org metadata, branding, GSTIN, payment terms |
| `/settings/sso` | SAML provider + domain claim |
| `/audit` | OrgAuditLog list + CSV export |
| `/consent` | ConsentArtifact register |
| `/analytics` | Cross-section aggregates (driven by `/api/organizations/[orgId]/analytics`) |
| `/appointments` | Org-tagged appointment list |
| `/waitlist` | Org-tagged waitlist entries |
| `/trials` | Org-tagged trial sessions |
| `/documents` | Bulk-review surface for org-scoped AppointmentDocuments |
| `/recordings` | Recordings by org, governed by `streamRecordingRetentionDays` |
| `/reimbursements` | PERSONAL spend dashboard (date filter + CSV export — C.B.4) |
| `/domain-claims` | DNS TXT verification |
| `/invitations` | Pending invitations |
| `/experts` | EXPERT roster (canHost only) |
| `/learners` | LEARNER roster |
| `/integrations` | SCIM tokens, webhook endpoints, data-exports |

OrgWorkspace cross-org operator pages live separately at `/dashboard/org-workspace/*` — 5 pages (`/home`, `/activity`, `/billing`, `/settings`, `/create`).

---

## I. Skipped subsystems — explicit non-integration list

These are not org-aware, by design. The rationale is in the row.

| Subsystem | Reason for skipping |
|---|---|
| **Referrals** | User-growth mechanic, not B2B procurement. Org-scoping adds schema columns and credit-routing logic without a customer demand signal. Reopen if an affiliate/reseller org requests it. |
| **Discount codes** | No org-owned codes today — all platform-wide. Adding `DiscountCode.organizationId` is a cheap forward step when the first B2B customer asks for volume codes; doing it pre-demand risks shipping unused complexity. |
| **Disputes** | `Dispute.paymentId → Payment.organizationId` join already provides queryability. Denormalising adds write-side overhead and is premature optimization until per-org dispute dashboards are demanded. |
| **Stream DM channels** | See E.2 — privacy / surveillance concern. |
| **Reviews & ratings** | Personal feedback artifact. Org-scoped quality control surfaces through OrgAuditLog (engagement complaints) and `/experts` roster status, not through `Review` rows. |
| **Affiliates** | Same rationale as referrals. |
| **Public marketplace search** | Org-private discovery lives at `/explore/enterprise/organisations` already; public search stays user-scoped to avoid mixing trust models. |
| **Consultation templates / types** | Platform-defined. Org-specific templates would enable vertical deployments (healthcare/legal) but no customer has asked. |
| **Calendar / availability** | Member-scoped via `Membership`. No separate org calendar concept — orgs view their members' calendars through the `/appointments` aggregate, not a dedicated route. |
| **Support tickets** | Currently global routing. Org-scoped ticket routing is a sensible v2 feature; deferred until ticket volume justifies the per-org SLA infrastructure. |

The combined SKIP rationale: every one of these would add 100–500 LoC of org-scoping plumbing and at least one schema migration with no concrete customer demand. The cost of "reopen if asked" is low (each is a clean forward addition); the cost of "ship pre-demand" is the maintenance burden of unused code.

---

## J. Future work index

Numbers are GitHub issues — refer to those for the canonical spec.

- `#674` — org scope split (umbrella; many sub-tasks)
- `#687` — invoice-fraud mitigation (Razorpay notes verification pending)
- `#701` — DPDP full workflow (erasure cascade, retention UI, consent withdrawal)
- `#709` — cron schedule audit (per-org maintenance wiring is one half of this)
- `#711` — multi-currency wallets (parked)
- `#713` — TDS section derivation
- `#715` — overage charging epic (parked)
- `#716` — refund / payouts / pricing consolidation (parked)
- `#735` — OrgAdmin → OrgWorkspace mechanical rename (parked)
- `#744` — post-MVP defer list (HRIS, multi-attendee billing)
- `#745` — Enterprise simplification flagship (parked)
- `#746` — Enterprise additions flagship (parked) — most "deferred" items here roll up
- `#747` — Invitation partial-unique index (blocked on Prisma 7 GA)

---

**Owner:** enterprise platform team
**Last touched:** 2026-05-28 (post-PR `#655` closeout + C-series cross-cutting wiring)
**Review cadence:** at each major enterprise PR landing.
