# Enterprise Production-Grade Checklist

Date: 2026-05-01

Scope: PR #655 (`feature/enterprise`), current unstaged enterprise work, `docs/enterprise`, Prisma schema, dashboard and API changes, finance/booking/payment algorithms, compliance helpers, Stream/recording/document scope work, PR comments, and all GitHub issues labelled `Enterprise`.

This supersedes the earlier root checklist as the active production-readiness board. It does not overwrite the previous checklist.

## Executive Readiness Score

| Readiness lens | Score | Confidence | Meaning |
|---|---:|---|---|
| Enterprise foundation PR readiness | 88 / 100 | Medium-high | The architecture, schema, docs, dashboard shells, org billing primitives, and many cross-cutting integrations are real. Still not a complete production enterprise product. |
| Current local code-read readiness | 86 / 100 | Medium | New unstaged scope/compliance/payout work improves coverage, but there are unresolved correctness risks around org activity stamping, scope semantics, docs drift, and unverified runtime flows. |
| Design-partner v1 readiness after P0 fixes and green checks | 92 / 100 | Medium | Suitable for controlled rollout if WIP areas are explicitly gated, not sold as complete, and monitored. |
| Broad self-serve enterprise GA readiness | 79 / 100 | Medium | Still needs SSO hardening, money correctness completion, compliance operations, retention, white-label/email, and support/admin evidence trails. |

### Top Improvements

- The enterprise architecture has moved from org-as-kind to capability + funding + contract + program + ledger. This is the right long-term model.
- Prisma now carries the important org scope anchors: `Organization`, `Membership`, `BillingAccount`, `Contract`, `Program`, `ProgramAssignment`, `BookingUtilization`, `OrganizationEarnings`, `OrganizationPayout`, org audit logs, org invoices, SSO settings, domain claims, and now appointment/waitlist/recording org IDs.
- Org dashboards have expanded from static org management to real activity surfaces: appointments, waitlist, trials, documents, recordings, reimbursements, stream/channels, programs, billing, payouts, audit, settings.
- Finance has moved toward proper leg accounting: `PaymentLeg`, org wallet, invoice accrual, licensed-seat usage, refund cascade, organization earnings, org payout lifecycle, gateway IDs, UTRs, and clawback fields.
- Compliance has moved from placeholders toward real derivation: TDS section selection, PAN fallback, DTAA rates, MSME deadlines, IRP/ClearTax scaffold, DPDP/retention scaffolding, audit action constants.
- The issue corpus is now much clearer. `#732`, `#730`, `#674`, `#716`, `#715`, `#713`, and `#670` are effectively the map to 100.

### Top Blockers

- **P0:** Fresh org-sponsored checkout appears to tag `Payment.organizationId` but not reliably stamp `Appointment.organizationId`, while org activity pages filter by `Appointment.organizationId`.
- **P0:** `OrgContextFilter` still presents "All activity" as a normal user option, while backend `orgScope=all` is staff/admin-only.
- **P0:** `#707` invoice PDF generation must be verified fixed in build/start or deploy-preview, not only assumed.
- **P0/P1:** SSO is not broadly production-complete until `#670` has a documented acceptance run through real IdP/domain-check/enforceSSO/session bridge/dashboard access.
- **P1:** `#715/#716` remain the main path to financial correctness at 100: overage charging, partial refunds, payout reversals/clawbacks, credit notes, subscription partial-delivery refund semantics, and pricing snapshots.
- **P1:** Compliance derivation is improved but still needs operational cron/job integration, legal/accounting sign-off, admin exception queues, and production monitoring.

### WIP Banner Policy

WIP banners are valuable because they prevent overclaiming. They are not production gates.

Each WIP banner should end in exactly one of three states:

- hard rejection in code
- feature flag with no live customer exposure
- fully implemented and tested workflow

This is the core of `#730`.

## Enterprise Issue Audit

GitHub currently reports **33 issues** with the `Enterprise` label. Their bodies and comments are production-readiness inputs, not just backlog notes.

### Direct Path To 100

| Issue | Current classification | Production-readiness verdict |
|---|---|---|
| `#732` Enterprise readiness backlog after `#674` | Still pending, master gap matrix | Treat as the living cross-cutting checklist. It explicitly calls out remaining gaps in dashboard scope, communication/recordings, retention, email branding, Novu topics, and org activity validation. |
| `#730` Production-grid lockdown | Still pending | Required before broad GA. Every visible partial permutation must become a hard gate, feature flag, or completed implementation. |
| `#716` Refunds + payouts + pricing epic | Partly implemented | Critical path to money correctness. Current refund cascade/org payout work is a strong v1 slice, but the issue still covers larger pricing/refund/payout consistency. |
| `#715` Enterprise overage charging | Partly implemented | Current checkout now reacts to overage in some paths, but the issue describes the complete financial surface. Needs acceptance tests across funding source x plan type x overage behavior. |
| `#713` Four outstanding gaps post-`#710` | Partly implemented | TDS/MSME helpers improved, live payouts improved, IRP scaffold exists. Still needs cron/ops/live connector completion and verification. |
| `#670` SSO signin flow | Partly implemented | Backend and settings exist; production readiness requires real signin page/domain-check/enforceSSO/IdP acceptance. |
| `#674` Personal vs org scope | Partly implemented | This is the core product/spec issue for scope across features. Current work implements many rows, but org activity stamping, Stream DMs, planner/request semantics, and remaining personal dashboards still need closure. |
| `#686` v1 scope audit | Still pending | Should be updated after the new checklist because the branch now has more org-scope work than the issue originally reflected. |
| `#707` invoice PDF verification | Still pending production gate | Keep as P0 until consumer and org invoice PDFs are verified against build/start or deploy preview. |
| `#717` wallet top-up blockers | Partly implemented / needs runtime proof | Migration drift may be fixed, but DB schema and Razorpay phone validation require actual top-up smoke verification. |
| `#725` BetterAuth plugin strategy | Security path to 100 | Not all Tier 1 controls are necessary for design-partner v1, but 2FA, captcha, last-login, HIBP, admin/RBAC migration, passkey/magic-link roadmap matter for GA. |

### Already Implemented Or Mostly Implemented But Issues Still Open

| Issue | Status | Checklist action |
|---|---|---|
| `#729` EXPERT UI for HOST/HYBRID | Appears implemented by dashboard/member/wizard work | Verify current UI supports adding EXPERT members and close/update issue. |
| `#728` RateCard ownerOrgId mis-link | Appears fixed by schema/API/wizard changes | Verify RateCard creation uses organization ID, not user ID; close/update issue. |
| `#726` plan visibility leak guard | Appears implemented by plan visibility enum/shared filters | Verify marketplace queries exclude `ORG_ONLY`; close/update issue. |
| `#718` notifyOrgPayoutCompleted | Appears implemented: `markOrgPayoutCompleted` calls `notifyOrgPayoutCompleted` | Verify webhook path calls helper and duplicate webhooks do not double-notify; close/update issue. |
| `#714` PERSONAL-funded reimbursement report | Newly added route/page exists | Classify as partial-to-implemented: report exists, but payroll workflow, export QA, and org payment/reimbursement lifecycle remain future work. |
| `#710` multi-engagement cap counting | Appears fixed for class and direct appointment flows; subscription deferred to allocation | Verify subscription allocation debits in slot-allocation path; close/update issue if tests pass. |
| `#687` invoice-fraud threat model | Mostly implemented via invoice credit limit/governance cap/pending trust earnings | Needs end-to-end fraud scenario test and docs update. |
| `#675` org creation governance | Mostly implemented by status/domain/verification gates | Verify self-serve surfaces and domain verification still match docs. |

### Production-Adjacent Or Deferred

| Issue | Status | Production relevance |
|---|---|---|
| `#727` schema future-proofing for referrals/trials/collaborators | Optional/future-proofing | Useful but not a v1 production blocker unless specific customer flow depends on it. |
| `#724` half-onboarded ORG_WORKSPACE state | Partial | Important UX/data consistency gap; not always a P0 if backstop route remains, but should be closed before GA. |
| `#709` cron schedule audit | Partial | Important for production stability. Needs schedule/load review across GitHub Actions/Supabase pooler. |
| `#708` redundancy cleanup | Optimization | Useful after merge; not a readiness blocker unless duplicate code causes divergent behavior. |
| `#706` Phase 3 table-stakes/deferred integrations | Roadmap | Do not count all of this against v1, but use as GA/product roadmap. |
| `#703` Phase 2 deferred work | Roadmap with production-relevant sections | Programs v2, DPDP erasure, invoice PDFs, reseller, org discounts, branded email, refund UI are important but many are post-v1. |
| `#684` Organization Plans gap audit | Partial/roadmap | Make sure plan visibility and org catalog behavior are not overclaimed. |
| `#663` analytics charts | Add-on | Useful for enterprise polish, not core correctness. |
| `#662` provider organizations | Partial/flagged | A canHost/provider path exists, but not all provider commercial workflows are GA-complete. |
| `#671` org Novu notifications | Partial | Production path when notifications become contractual. |
| `#367` recording library | Deferred feature | Foundation pieces exist; full curated recording library, collections, progress tracking, and retention controls remain future work. |

### Superseded / Historical Context

| Issue | Status | Treatment |
|---|---|---|
| `#681` Enterprise redesign | Implemented as Arch4-modified architecture record | Keep open only if used as architecture reference; otherwise close with docs link. |
| `#661` Enterprise remaining features | Closed, superseded | No action except preserving links. |
| `#646` Enterprise follow-up after original foundation | Closed, superseded | No action except preserving links. |

## P0 Production Gates

### 1. Stamp Org Context On The Right Runtime Rows

**Rightly implemented**

- `Payment.organizationId` is threaded into checkout.
- Prisma schema now has `Appointment.organizationId`, `Waitlist.organizationId`, and `Recording.organizationId`.
- Org dashboard activity routes correctly filter by org-specific scope.
- Backfill script exists for appointments/waitlist/recordings.

**Incorrectly implemented**

- Checkout code currently creates payments with `organizationId`, but the appointment creation helpers for consultation/subscription/webinar/class do not visibly stamp `Appointment.organizationId` for fresh org-sponsored bookings.
- Org dashboard activity pages filter by `Appointment.organizationId`, so fresh org-funded bookings can be missing from org dashboards even though the related payment is org-tagged.

**Partly implemented**

- Backfill handles historical data, but it does not solve runtime stamping for new data.
- Trial sessions already have org context, but the user activity model is not uniform across all appointment types.

**Still pending / not considered**

- Add runtime stamping at appointment creation/join time.
- For webinar/class umbrella appointments, decide whether `Appointment.organizationId` means the event's owner org, the registrant's sponsoring org, or is not suitable for multi-org attendance.
- Add test where a member checks out under org context and org dashboard immediately shows the appointment/document/recording after creation.
- Add multi-org attendee test for webinars/classes.

### 2. Fix Scope Semantics: "All Mine" vs Privileged "All Tenants"

**Rightly implemented**

- Backend `resolveOrgScope` correctly gates `orgScope=all` to `ADMIN`/`STAFF`.
- Org dashboard route-pinning prevents random URL params from leaking the org workspace into personal mode.

**Incorrectly implemented**

- `OrgContextFilter` still uses "All activity" in normal personal dashboards, and the hook maps it to `scope.kind === "all"`.
- Pages avoid sending `orgScope=all` by omitting the param, but this makes "all" mean different things in the UI and API.

**Partly implemented**

- The UI self-hides for B2C-only users, which is good.
- Query keys include scope, which is good.

**Still pending / not considered**

- Rename normal-user union mode to `mine` or `all_mine`.
- Reserve `all` for staff/admin tenant-global operations.
- Update label to `All mine`, not `All activity`.
- Add tests for regular user selecting each filter option.

### 3. Verify Invoice PDF Generation

**Rightly implemented**

- The renderer consolidation simplifies the PDF path.
- Org invoice and consumer invoice endpoints exist.

**Incorrectly implemented**

- `#707` recorded a real regression where org invoice PDF returned HTTP 500 in `next dev` due React/react-pdf reconciler mismatch.

**Partly implemented**

- The issue body argues build/start may differ from dev, but production readiness needs proof.

**Still pending / not considered**

- Verify consumer invoice PDF and org invoice PDF under `next build && next start` or Netlify preview.
- Confirm the generated PDF opens, has correct GST split, INR amount words, international export declaration where relevant, and org invoice fields.
- Add a smoke test or scripted manual runbook.

### 4. SSO Acceptance Must Be End-To-End

**Rightly implemented**

- Provider CRUD exists.
- SSO settings/domain claims exist.
- BetterAuth SSO plugin is wired.
- Domain-check endpoint exists.
- Session repair/enrichment exists.
- SSO settings UI exists.

**Incorrectly implemented**

- `#670` says the user-facing signin page historically did not drive domain-check and enforceSSO correctly. This must be rechecked against current code.

**Partly implemented**

- Backend primitives are not enough to claim working enterprise SSO.

**Still pending / not considered**

- Real IdP acceptance run:
  - claim domain
  - configure provider
  - attempt password/OAuth signin for enforced domain and verify block/redirect
  - complete SSO signin
  - confirm membership/session bridge
  - confirm dashboard access
  - confirm non-domain users fail open
  - confirm owner/admin anti-lockout path
- Add screenshots or runbook evidence to `docs/enterprise/sso-testing-guide.md`.

## Bucket 1: Data Model, Prisma Schema, Migrations, Indexes, Backfills

### Rightly Implemented

- Core Arch4 data model is strong: org capabilities, memberships, billing accounts, contracts, programs, program assignments, utilization, ledgers, invoices, payouts, audit logs, SSO settings, domain claims.
- Org activity scope has schema anchors on appointment, waitlist, and recording.
- Helpful indexes exist for org activity: `organizationId, createdAt` on appointments, waitlist, recordings.
- `ConsultantProfile.tdsRate` was moved to `Float`, reducing Next Server-to-Client serialization friction.
- Org payout gateway/clawback fields are modeled.
- Backfill scripts exist for appointment/waitlist/recording org IDs and independent consultant status.

### Incorrectly Implemented

- Runtime writes are not yet obviously aligned with new schema anchors. Adding columns and backfills is not enough if checkout never stamps them.
- Some docs/glossary references still describe old or inconsistent enum/status machines.

### Partly Implemented

- Backfill is intentionally conservative: single active membership gets stamped, zero/multi-org cases are skipped.
- This is safe but means the org dashboards can remain incomplete until skipped rows are classified.
- Historical webinar/class rows remain awkward because an umbrella event appointment may have multiple org-sponsored attendees.

### Still Pending / Not Considered

- Migration verification in a clean database and a realistic existing database.
- Backfill dry-run report stored as an artifact.
- Manual resolution workflow for skipped multi-org rows.
- Query-plan review for high-volume org activity lists.
- Define an explicit `scopeSource` concept for activity rows:
  - direct org field
  - payment-derived
  - plan-derived
  - membership-derived
  - manually classified

## Bucket 2: Org Identity, Roles, BetterAuth, Authorization, Rate Limiting

### Rightly Implemented

- `Membership` is the app's typed org access source of truth.
- `requireOrgAccess` and role-rank helpers centralize most org authorization.
- Domain claim uniqueness and SSO settings are modeled.
- Session shape includes active organization memberships.
- Privileged `orgScope=all` is server-gated.
- Many org routes use `requireOrgAccess` with minimum roles.
- BetterAuth docs were added under `docs/authentication/betterauth`.

### Incorrectly Implemented

- UI still conflates normal user's "all mine" with staff/admin `all`.
- Some issues remain open because the issue tracker has not been reconciled with implemented code. This creates false uncertainty for reviewers.

### Partly Implemented

- SSO backend exists, but `#670` still must be closed by end-to-end signin evidence.
- `#725` is mostly future security hardening, but Tier 1 controls become GA requirements:
  - 2FA
  - captcha
  - HIBP password check
  - last-login method
  - phased admin/RBAC migration

### Still Pending / Not Considered

- Route-by-route rate limit matrix for new org APIs.
- Staff/admin impersonation policy and audit.
- Session revocation on org suspension, member removal, user suspension, and SSO policy changes.
- SCIM/HRIS provisioning acceptance criteria if enterprise customers expect automated lifecycle management.
- API key strategy for enterprise integrations.

## Bucket 3: Booking And Checkout Algorithms

### Rightly Implemented

- Checkout verifies active membership before org-funded booking.
- Unsupported `PROJECT` funding source fails fast.
- INVOICE funding source has credit-limit/governance exposure checks.
- Non-PERSONAL funding requires active program assignment.
- Referral credits are blocked on org-funded bookings.
- Wallet/invoice/license skip gateway paths are explicit.
- Payment legs are written for card, wallet, invoice accrual, license, and referral credit paths.
- Serializable transaction and checkout locks reduce concurrency risk.

### Incorrectly Implemented

- Org-sponsored checkout likely does not stamp `Appointment.organizationId`.
- `CHARGE_MEMBER` overage path throws after creating transactional objects; transaction rollback is technically fine, but user copy says the booking succeeded and payment must be completed later. That is confusing and should be changed.
- Webinar/class org scope is not fully modeled for multi-org participants.

### Partly Implemented

- Overage handling has started:
  - `recordBookingUtilization` can detect `wasOverage`
  - checkout branches for `CHARGE_MEMBER` and `CHARGE_ORG`
  - `CHARGE_ORG` can add invoice accrual leg
- But `#715` describes a much larger compatibility matrix that is not fully proven.

### Still Pending / Not Considered

- Booking intent should carry org context before payment:
  - `scopeType`
  - `organizationId`
  - `programId`
  - `benefitId`
  - `paymentOwner`
  - overage behavior
- Request-stage org intent for consultant requests.
- Subscription allocation org debit tests.
- Checkout tests for every funding source:
  - PERSONAL
  - WALLET
  - INVOICE
  - LICENSE
  - unsupported PROJECT
  - unverified INVOICE within limit
  - unverified INVOICE over limit
  - multi-org member selecting org A vs org B

## Bucket 4: Payment Legs, Wallets, Invoices, Credit Pools, Licensed Seats, Overage

### Rightly Implemented

- `PaymentLeg` invariant exists and reconciliation scripts can detect mismatches.
- Wallet debit/credit helpers exist.
- Org top-up webhooks verify amount captured against gateway amount.
- Invoice payment webhook verifies captured amount before marking paid.
- Organization invoice, wallet, purchase order, billing-account routes exist.
- Reimbursement report for PERSONAL-funded orgs now exists.
- Pending-trust earnings reduce invoice-fraud exposure.

### Incorrectly Implemented

- `docs/enterprise/money-glossary.md` drifts from actual Prisma enums in places:
  - `RefundStatus` in Prisma is `PENDING | SUCCEEDED | FAILED | CANCELLED`, not `PENDING -> PROCESSING -> COMPLETED`.
  - `PayoutStatus` in Prisma does not include `REVERSED`, while glossary text says it does.
- Issue `#717` indicates wallet top-up runtime can fail if migrations are not actually applied in the target database.

### Partly Implemented

- `#714` reimbursement dashboard exists as a report, but full reimbursement lifecycle is still outside v1:
  - approval
  - payment to member
  - payroll export
  - status tracking
  - audit trail
- `#715` overage charging has a start but not the full matrix.

### Still Pending / Not Considered

- Org-scoped discount codes from `#703`.
- Owner-initiated refund UI for wallet top-ups/invoices from `#703`.
- Credit notes for invoice/GST adjustments.
- Pricing snapshot consistency across refunds, overage, and delayed subscription delivery.
- Production reconciliation dashboard for payment-leg mismatches.
- Automated alerting for stale invoice accruals and unpaid invoices.

## Bucket 5: Payouts, Earnings, Refunds, Clawbacks, Disputes, Reconciliation

### Rightly Implemented

- Consultant earnings and organization earnings are created from payments.
- Rate-card snapshots are persisted on org earnings.
- Collaborator org earnings are considered.
- Org payout batching is atomic with Redis lock + Serializable transaction.
- Gateway payout IDs, UTRs, raw response, failure state, and clawback fields exist.
- `processOrgPayout` submits RazorpayX after DB transaction.
- Webhook-time completion/failure/reversal helpers exist.
- Refund operation now handles payment legs, booking utilization, consultant earnings, organization earnings, wallet, invoice accrual, and clawbacks.

### Incorrectly Implemented

- Non-Razorpay org payout path still warns and leaves row in `PROCESSING`, which can look submitted even when no supported gateway call happened.
- Payout issue tracker still says some things are open that appear implemented. This needs triage or reviewers will not know what is real.

### Partly Implemented

- `#716` is only partially closed by the current refund cascade and payout work.
- Clawback is modeled on `OrganizationPayout`, but operational workflow is not complete:
  - clawback needed
  - clawback notified
  - clawback collected
  - clawback waived
  - clawback written off

### Still Pending / Not Considered

- Dispute cascade into org earnings and payout clawback.
- Credit note generation for refunded org invoices.
- Partial delivery subscription refunds.
- Duplicate webhook delivery tests for every payout/refund path.
- Staff/admin stuck payout dashboard.
- Gateway balance/low-balance retry behavior.
- Payout provider abstraction for Stripe Connect or manual transfer.

## Bucket 6: Compliance: TDS, DTAA, MSME, IRP/GST, DPDP, Audit Logs, Retention

### Rightly Implemented

- TDS derivation is now real and tested for:
  - valid PAN resident default
  - section override
  - PAN fallback
  - DTAA non-resident behavior
  - Section 197 certificate
- DTAA rates JSON exists.
- MSME deadline helper correctly models 15/45/60 day logic.
- IRP/ClearTax scaffold exists.
- Audit action constants have expanded.
- DPDP and retention are present in docs/issues as recognized production work.

### Incorrectly Implemented

- TDS classification must be legally/accounting locked. The code defaults to 194-O at 1%, while earlier docs/commentary discussed 194J-style resident treatment. This cannot be left implicit.
- IRP stub mode currently returns a failure-like status. In production operations, "provider not configured" should be distinguishable from "invoice reporting attempted and failed".
- MSME deadline logic is only meaningful if real counterparty MSME status and agreement status are wired into payout/invoice creation.

### Partly Implemented

- `#713` originally asked for derivation cron jobs and live connectors. Helpers exist now, but the operational layer is not fully proven.
- Compliance tests exist, but runtime integration and dashboards are not complete.

### Still Pending / Not Considered

- Daily compliance cron for TDS/MSME derivation if not already wired.
- Compliance exception dashboard:
  - PAN missing
  - invalid PAN
  - DTAA missing treaty data
  - MSME deadline approaching
  - IRP upload failed
  - invoice missing GST/HSN inputs
- DPDP §12 deletion/anonymization workflow from `#703`.
- Retention policy model and enforcement cron from `#732`.
- Audit log coverage matrix for:
  - role/membership changes
  - SSO settings/provider/domain mutations
  - exports
  - billing/account changes
  - refunds
  - payouts
  - admin/staff mutations

## Bucket 7: Org/Personal Context Filtering And Switching

### Rightly Implemented

- `useOrgScope` pins org dashboards to route org.
- Scope-aware APIs now exist for appointments, documents, recordings, trials, and waitlist.
- Consultee appointments and consultant requests/planner/documents have scope filter integrations.
- Staff/admin list APIs increasingly accept `orgId`.

### Incorrectly Implemented

- "All activity" is not a safe label or API state for regular users.
- Consultant planner is still filtered through appointment org context, which is the wrong source of truth for an inventory/authoring surface.
- Consultant requests only filter approved appointment-backed rows, not pending request intent.

### Partly Implemented

- Personal dashboards have scope toggles in some places but not all.
- `#732` explicitly says consultant appointments, recordings, and trials still need retrofits.
- Organization dashboards have new activity pages, but badge/filter semantics are not uniform.

### Still Pending / Not Considered

- Standardize modes:
  - `all_mine` for regular users
  - `personal`
  - `org:<id>`
  - `tenant_global` for staff/admin
- Add org badges to all mixed personal dashboard rows.
- Add route tests proving regular users cannot request another org.
- Add product decision for shared resources:
  - one appointment/event belongs to one org
  - one attendee's registration belongs to one org
  - one conversation may contain multiple org contexts

## Bucket 8: Dashboards Across All Roles

### Rightly Implemented

- Org dashboard has meaningful role/capability nav.
- Org-admin portfolio dashboard exists.
- Staff/admin dashboards are global operator surfaces, which is correct.
- New org pages cover activity, documents, recordings, waitlist, trials, reimbursements.
- Billing page has moved toward unified billing + wallet.
- WIP banners are used to avoid overclaiming.

### Incorrectly Implemented

- Sidebar may become too long as every org activity page becomes top-level.
- Mobile tabs in org layout are always visible by config comment, which risks discoverability over permission clarity if the pages fail after click.
- Personal dashboards still need consistent badge/filter semantics.

### Partly Implemented

- Consultant dashboard:
  - requests/planner/documents have filter
  - appointments/recordings/trials still need retrofit per `#732`
  - earnings/payouts need org-vs-personal separation
- Consultee dashboard:
  - appointments filter exists
  - payments/invoices/documents/recordings/resources need consistent filter/badge handling
- Staff/admin:
  - backend `orgId` filters are started
  - UI tenant filters/table columns are not fully assessed here

### Still Pending / Not Considered

- Recommended org IA:
  - Overview
  - People
  - Programs
  - Activity
  - Commercial
  - Compliance
  - Settings
- Staff/admin support workflow:
  - org filter/search
  - organization column
  - export audit
  - mutation audit
- Accessibility and responsive QA for 400-file PR dashboard changes.
- Empty states that explain org vs personal scope.

## Bucket 9: Stream, Chat, Video, Recordings, Documents

### Rightly Implemented

- Stream Chat channels can be tagged with `organization_id`.
- Stream Video calls can be tagged with `organizationId`.
- Org stream channel route exists.
- Stream chat backfill script exists.
- Recordings now have org ID in schema and scoped list helper.
- Documents inherit org scope from parent appointment.

### Incorrectly Implemented

- Consultation/subscription DMs are pair-scoped and first-org-wins. This is unsafe if the same consultant/consultee relationship spans personal plus multiple org contexts.
- Chat uses `organization_id`; Video uses `organizationId`. Provider conventions may justify this, but docs must normalize the product concept.
- Documents/recordings depend on correct appointment stamping.

### Partly Implemented

- Org chat channel listing exists; org video call listing is explicitly deferred.
- Recording library `#367` is still a feature follow-up, not complete.
- Retention policies from `#732` remain missing.

### Still Pending / Not Considered

- Decide one conversation model:
  - event-scoped conversations
  - relationship-scoped with per-message context
  - separate context-specific channels
- Add org video calls endpoint.
- Add recording retention settings UI.
- Add per-org document retention and export rules.
- Add tests for same consultant/consultee pair across personal, org A, and org B.

## Bucket 10: Notifications, Novu, Email, White Label

### Rightly Implemented

- Org payout completion/failure notification helpers exist.
- Wallet top-up and invoice payment org notifications exist.
- Org program exhausted notification exists.
- Org workflow files have expanded.

### Incorrectly Implemented

- `#718` issue remains open even though code appears to call `notifyOrgPayoutCompleted`. Issue tracker and implementation must be reconciled.

### Partly Implemented

- `#671` org notification lifecycle is partial.
- `#732` calls out per-org Novu topics and per-org email branding as missing.
- `#703` includes branded email templates and white-label from-address as later table-stakes.

### Still Pending / Not Considered

- Notification matrix by workflow:
  - trigger
  - recipient role
  - org context
  - sensitive fields included/excluded
  - retry behavior
- Per-org topic routing:
  - `org:<orgId>:owner`
  - `org:<orgId>:finance`
  - `org:<orgId>:manager`
  - `org:<orgId>:learner`
  - `org:<orgId>:expert`
- White-label email verification and fallback behavior.
- Email/notification audit records for compliance-sensitive events.

## Bucket 11: Docs, Runbooks, Production Operations

### Rightly Implemented

- `docs/enterprise` is extensive and useful.
- `00-overview.md` reflects the production seed grid.
- `money-glossary.md` is the right idea and should remain a central onboarding doc.
- Runbooks, monitoring, idempotency keys, API references, scenarios, and route migration docs exist.

### Incorrectly Implemented

- Docs drift remains:
  - refund/payout status machines in money glossary do not match Prisma.
  - dashboard page docs do not fully reflect the new org activity pages and nav grouping.
  - compliance docs need to reflect current TDS/MSME/IRP behavior and remaining stubs.

### Partly Implemented

- GitHub issue comments contain important specs that are not fully promoted into docs.
- `#732` currently acts like a missing addendum to `#674` and docs/enterprise.

### Still Pending / Not Considered

- Convert issue-comment specs into durable docs:
  - `#674` scope workstreams
  - `#681` Arch4 modified summary
  - `#703/#706` deferred roadmap slices
  - `#707` PDF verification runbook
  - `#367` recording library boundary
- Add a "Known Not GA" page listing all WIP-bannered features.
- Add "production acceptance checklist" to docs/enterprise.

## Things Not Yet Considered Enough

- Customer support SLA workflows for enterprise tenants.
- Data residency and regional processing commitments.
- SOC2 evidence collection for admin/staff actions.
- Export redaction and watermarking for org reports.
- Legal hold and retention override.
- Enterprise API keys, OAuth/OIDC provider mode, or SCIM provisioning.
- Impersonation/support access UX and audit.
- Organization-level incident communications.
- Organization-level data deletion/anonymization workflows.
- Accessibility QA for all new dashboard surfaces.
- Performance budgets for org dashboards with thousands of members/bookings.
- Billing reconciliation with real gateway settlement reports.
- Security review of org CSV uploads and file scanning.
- Multi-currency policy for invoices, payouts, refunds, and TDS reporting.
- Product packaging: which org capabilities are sold in design-partner v1 vs GA.

## Verification Status

This checklist creation did not run mutating commands, formatters, migrations, or codegen.

Current recommended verification commands:

```bash
npx tsc --noEmit --incremental false
npm test -- --runInBand __tests__/enterprise __tests__/payments
```

Targeted scenarios:

- org scope authorization:
  - personal
  - all-mine
  - specific org
  - staff/admin tenant-global
  - invalid org
  - inactive membership
- checkout appointment/payment org stamping:
  - consultation
  - subscription
  - webinar
  - class
  - trial
- personal/org dashboard filtering:
  - consultee appointments
  - consultant appointments
  - consultant requests
  - consultant planner
  - documents
  - recordings
- payout submission and webhook reconciliation:
  - live disabled
  - Razorpay success
  - Razorpay 4xx
  - duplicate webhook
  - failed/reversed webhook
- refund cascade and clawback:
  - partial refund
  - full refund
  - invoice accrual
  - paid invoice
  - completed org payout clawback
- compliance:
  - TDS section decision
  - PAN fallback
  - DTAA
  - lower-rate certificate
  - MSME deadlines
  - IRP configured/unconfigured/failure
- SSO:
  - domain check
  - enforceSSO
  - real IdP redirect/callback
  - session bridge
  - dashboard access
  - anti-lockout
- invoice PDFs:
  - consumer invoice PDF
  - org invoice PDF
  - dev/build/deploy-preview behavior
- Stream:
  - personal chat not in org dashboard
  - org chat appears in correct org
  - same user pair across multiple org contexts
  - video call org tag
  - recording org tag

## Path To 100

### Reach 90

- Fix runtime `Appointment.organizationId` stamping or change org activity pages to the correct source of truth.
- Replace normal-user "All activity" with `All mine` semantics.
- Verify invoice PDFs.
- Reconcile open implemented issues: `#718`, `#729`, `#728`, `#726`, `#710`, `#714`.
- Run typecheck and targeted enterprise/payment tests.

### Reach 95

- Complete `#670` SSO acceptance.
- Complete `#715` overage charging matrix for v1-supported permutations.
- Complete the v1 slice of `#716` for refunds, payout reversal/clawback, and pricing snapshots.
- Add compliance cron/exception dashboard for `#713`.
- Add staff/admin tenant filter UI and audit evidence on sensitive mutations.
- Finish personal dashboard org-scope retrofits listed in `#732`.

### Reach 100

- Close or explicitly defer every direct-path issue with docs:
  - `#732`
  - `#730`
  - `#716`
  - `#715`
  - `#713`
  - `#670`
  - `#674`
  - `#686`
  - `#707`
  - `#717`
  - `#725`
- Add full observability:
  - audit logs
  - webhook reconciliation
  - stuck job queues
  - compliance exception queues
  - payout/refund dashboards
  - data export audit
- Convert all WIP banners into gates, flags, or completed flows.
- Promote issue-comment specs into docs.
- Run a design-partner dry run using the production seed grid:
  - Wipro sponsor invoice/license
  - IIT hybrid wallet/credit pool
  - LearnPro host payout
  - solo host org
  - multi-org user
  - staff/admin support case

## Bottom Line

The enterprise subsystem is now a serious foundation, not just scaffolding. The architecture is good, the schema is largely right, and many high-risk paths have been thoughtfully implemented.

It is not yet 100% production-grade. The remaining gap is not "more pages"; it is correctness across scope, money, compliance, SSO, and operator evidence.

The highest-leverage next move is to close the P0 gates, then use `#732` + `#730` as the official production-readiness board until every WIP surface is either gated, flagged, or genuinely complete.
