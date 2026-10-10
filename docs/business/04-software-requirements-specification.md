# 04 — Software Requirements Specification (SRS)

> **Parent Legal Entity:** Practitionist (OPC) Private Limited (`CIN: U62012HR2026OPC146217`)  
> **Product:** Familiarise (`familiarise_web` + `familiarise_mobile`)  
> **Document Standard:** IEEE 830 / ISO/IEC/IEEE 29148 Adapted for Modern Cloud-Native SaaS  
> **Schema Baseline:** `prisma/schema.prisma` (7,691 lines, 155 models, 140 enums — Frozen under Issue `#705`)

---

## 1. Introduction & System Scope

### 1.1 Purpose
This Software Requirements Specification (SRS) defines the complete functional (`FR-*`) and non-functional (`NFR-*`) requirements for **Familiarise**, the synchronous expert consulting, diagnostic trial, recurring consultation subscription (retainer), live broadcast webinar, live interactive group class, and B2B `SPONSOR × HOST` enterprise advisory platform under **Practitionist (OPC) Private Limited**.

### 1.2 Architectural & Product Boundaries
Per the locked **Practitionist Portfolio Architecture** ([`07-practitionist-ecosystem-familiarise-vs-elluminar.md`](./07-practitionist-ecosystem-familiarise-vs-elluminar.md)):
- **Familiarise (`familiarise_web` + `familiarise_mobile`)** owns all synchronous human-to-human advisory, recurring consultation retainers, diagnostic trials, live broadcast webinars, live cohort classes, persistent client-consultant document review (`AppointmentDocument`), and `SPONSOR × HOST` enterprise coaching/advisory marketplaces.
- **Explicit Anti-Goals (Zero LMS Bloat):** Familiarise shall **never** implement multi-module self-paced LMS hierarchies (`Course -> Module -> Lesson`), automated code/SQL/WASM execution sandboxes, interactive grading canvases, quizzes/assignments, or rubric-scored capstone defense workflows. All curriculum, sandbox, and verified credentialing workflows are routed to **Elluminar (`elluminar_web`)** via **Practitionist SSO (`@better-auth/sso`)** and signed cross-product webhooks.

---

## 2. User Classes & Role Taxonomy

| Actor / Role | Primary Models (`prisma/schema.prisma`) | Capabilities & Access Scope |
|---|---|---|
| **Consultee (Client / Attendee)** | `User`, `ConsulteeProfile` | Discover consultants, book 1:1 consultations, trials, subscriptions, webinars, and classes; upload `AppointmentDocument`s for joint review; track action items; claim **48h Trial-to-Subscription 100% Fee Credit**; download **Session Attendance Receipts** & GST invoices. |
| **Consultant (Expert / Host)** | `User`, `ConsultantProfile`, `AvailabilityWindowWeekly`, `AvailabilityWindowCustom`, `ConsultantFeeWaiver` | Publish `ConsultationPlan`, `SubscriptionPlan`, `WebinarPlan`, and `ClassPlan`; configure weekly/custom availability; accept/allocate slots; host Stream.io WebRTC rooms; co-review & annotate client documents; receive payouts via Stripe Connect / Razorpay Route; generate `0%` commission `OWN_LINK` share codes. |
| **Co-Host / Collaborator** | `WebinarCollaborator`, `ClassCollaborator`, `SubscriptionCollaborator` | Co-deliver webinars, classes, or multi-mentor retainers (`HOST`, `CO_HOST`, `MODERATOR`, `SOLO_INSTRUCTOR`, `TEACHING_ASSISTANT`) with automated pro-rata `PaymentSplit` earnings distribution (`lib/collaborators/earnings-split.ts`). |
| **Sponsor Organization (`SPONSOR`)** | `Organization`, `OrganizationMember`, `SeatGrant`, `SponsorSpendCap`, `ProgramCohort`, `CreditPool` | B2B buyer entity that funds employee coaching credits, departmental spend caps, post-paid net-30 `INVOICE_ACCRUAL` billing, and HR L&D utilization analytics (`/dashboard/organization/[orgId]`). |
| **Host Organization (`HOST`)** | `Organization`, `HostMember`, `RateCard`, `VendorApproval`, `PurchaseOrder` | Multi-consultant advisory firm or consulting agency that rosters experts under one corporate umbrella, negotiates custom `RateCard`s with `SPONSOR` orgs, and collects a `10%` `HOST_ORG_ROYALTY` (`lib/payments/core/splits.ts`). |
| **Platform Staff & Finance Admin** | `User` (`role: STAFF | ADMIN`), `StaffProfile`, `ModerationAction`, `ReconciliationRun` | Verify consultant KYC/credentials, adjudicate `Dispute` and `SessionOutcome` edge cases, manage `PayoutBatch` approvals, and monitor the 26-invariant nightly ledger reconciliation engine. |

---

## 3. Functional Requirements (`FR-*`)

### 3.1 Identity, Authentication, Onboarding & Cross-Product SSO (`FR-ID`)

| ID | Requirement Title | Priority | Implementation Status & Code Reference |
|---|---|---|---|
| **FR-ID-01** | **Multi-Provider Authentication & Session Management** | P0 | **Implemented** (`lib/auth.ts`): BetterAuth `1.7.7` with Email/Password, Google, GitHub, Facebook, Twitter/X, Resend transactional email verification, and server-validated database sessions. |
| **FR-ID-02** | **Enterprise OIDC / SAML Single Sign-On (`@better-auth/sso`)** | P0 | **Implemented** (`lib/auth.ts`, `SsoConnection`): Supports tenant-scoped OIDC and SAML 2.0 identity providers with automated domain verification and `SeatGrant` provisioning upon first login. |
| **FR-ID-03** | **Unified Onboarding & Role-Switched Dashboard Routing** | P0 | **Implemented** (`app/onboarding/`, `app/dashboard/`): Guided onboarding wizard creating `ConsultantProfile`, `ConsulteeProfile`, or `StaffProfile` with dynamic role context switching. |
| **FR-ID-04** | **Practitionist Federated Identity & Cross-Product Referral Bridge** | P1 | **Phase 2 Roadmap**: Shared OIDC identity provider claims across `familiarise.com` and `elluminar.com` plus HMAC-SHA256 signed webhook (`/api/webhooks/practitionist-bridge`) to honor `10%` cross-product bundle discounts and Verified Talent Badge imports. |

### 3.2 Marketplace Discovery, Plan Catalog & `OWN_LINK` Attribution (`FR-MKT`)

| ID | Requirement Title | Priority | Implementation Status & Code Reference |
|---|---|---|---|
| **FR-MKT-01** | **5-Primitive Service Plan Catalog** | P0 | **Implemented** (`prisma/schema.prisma`): Support creation, pricing (in integer paise / minor units), and lifecycle management of `ConsultationPlan`, `SubscriptionPlan`, `Trial` (nested under `SubscriptionPlan`), `WebinarPlan`, and `ClassPlan`. |
| **FR-MKT-02** | **Hybrid Search, Faceted Filtering & Consultant Profiles** | P0 | **Implemented** (`app/explore/`, `app/consultants/[slug]`): Filter experts by domain, subdomain, tags, language, hourly rate, availability window, rating, and verified enterprise vendor status. |
| **FR-MKT-03** | **Creator `OWN_LINK` (`0%` Take-Rate) Attribution** | P0 | **Implemented** (`ConsultantFeeWaiver`, `BookingSource.OWN_LINK`, `lib/payments/core/fee-waiver.ts`): Track share links (`?ref=<consultant_code>`) via signed HTTP-only cookies; apply `0%` platform commission (consultant keeps `100%` minus gateway fees) when `BookingSource == OWN_LINK`, vs. `20%` marketplace commission on `PLATFORM_DISCOVERY`. |
| **FR-MKT-04** | **Session Attendance Receipts (Replacing Skill Certificates)** | P0 | **Phase 1 Guardrail** (`WebinarPlan.certificateProvided`, `ClassPlan.certificateProvided`): Reposition all webinar/class completion documents strictly as **Session Attendance Receipts** (displaying `AppointmentParticipant.attended` duration, host name, and SAC tax code for corporate L&D reimbursement), reserving Verified Skill Credentials exclusively for Elluminar. |

### 3.3 Scheduling & 3-Layer Zero-Collision Slot Allocation Engine (`FR-SCHED`)

| ID | Requirement Title | Priority | Implementation Status & Code Reference |
|---|---|---|---|
| **FR-SCHED-01** | **Dual Availability Windows (Weekly Recurring & Custom Overrides)** | P0 | **Implemented** (`AvailabilityWindowWeekly`, `AvailabilityWindowCustom`): Store weekly recurring slots (`startTimeUtc`/`endTimeUtc` `0..1439` + IANA `timezone` and `localStartMinutes` for DST safety) alongside date-specific custom windows and blackout overrides. |
| **FR-SCHED-02** | **Three Slot Allocation Modes (`INSTANT`, `REQUEST`, `AUTO`)** | P0 | **Implemented** (`lib/scheduling/allocationService.ts`): Support (1) `useRequestedSlots` (`INSTANT` booking), (2) `manualAllocate` (`REQUEST` -> consultant approval -> `APPROVED_PENDING_PAYMENT` with 24h payment link expiry), and (3) `autoAllocate` (`lib/scheduling/preferenceScoring.ts` scoring `preferredDaysOfWeek`, `preferredTimeBuckets`, and `preferredCustomWindows`). |
| **FR-SCHED-03** | **3-Layer Zero-Collision Concurrency Guarantee** | P0 | **Implemented** (`utils/appointmentlock.ts`, `lib/scheduling/allocationService.ts`, `prisma/sql/check-constraints.sql`): Enforce zero double-booking via (1) Upstash Redis Redlock (`lockAutoAllocate(consultantProfileId)`), (2) PostgreSQL `SERIALIZABLE` transaction isolation with automatic `P2034` retry backoff, and (3) PostgreSQL GiST exclusion constraint `occurrence_no_confirmed_overlap` (`USING gist (consultant_profile_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)`). |
| **FR-SCHED-04** | **Fill-Order Subscription Cycle Tranches & Weekly Caps** | P0 | **Implemented** (`lib/booking/entitlement.ts`, `SubscriptionCycle`): Compute exact subscription entitlements (`computeSubscriptionEntitlement`) using fill-order cycle tranches (`totalSessions = durationInMonths * callsPerWeek * 4`), enforcing weekly `callsPerWeek` caps and `SubscriptionCycle` credit exhaustion. |
| **FR-SCHED-05** | **48-Hour First-Allocation SLA & Auto-Refund Watchdog** | P0 | **Implemented** (`jobs/appointments/sla-breach-check.ts`): Monitor newly paid `Consultation` and `Subscription` bookings; if the first session is not allocated within 48 hours of payment, trigger an automated SLA breach alert and full buyer refund. |
| **FR-SCHED-06** | **Per-Occurrence Rescheduling & Backup Waitlist Queue** | P0 | **Implemented** (`AppointmentOccurrence`, `WindowBackupInterest`): Allow partial rescheduling of individual occurrences (`STATUS_PARTIALLY_RESCHEDULED`, capped at `rescheduleCount <= 2` per occurrence) without invalidating sibling sessions in a multi-session subscription or class, and notify waitlisted buyers via `WindowBackupInterest`. |

### 3.4 Diagnostic Trials & Trial-to-Subscription Conversion Loop (`FR-TRIAL`)

| ID | Requirement Title | Priority | Implementation Status & Code Reference |
|---|---|---|---|
| **FR-TRIAL-01** | **Anti-Gaming Trial Uniqueness & Pre-Conversion DM Guard** | P0 | **Implemented** (`Trial`, `prisma/sql/check-constraints.sql`): Enforce `idx_trials_one_active_per_pair` (`consultee_profile_id`, `consultant_profile_id`, `subscription_plan_id`) to prevent repeat free/discounted trial abuse, and restrict direct messaging prior to subscription conversion. |
| **FR-TRIAL-02** | **48-Hour Trial-to-Subscription 100% Fee Credit (`TrialCreditVoucher`)** | P0 | **Phase 1 Core Wedge**: When a paid `Trial` occurrence reaches `SessionOutcome.HELD`, automatically issue a 48-hour credit token (`Trial.convertedToSubscriptionId` / `TrialCreditVoucher`) that deducts **100% of the paid trial fee** from the first month's `SubscriptionPlan` checkout via `deriveCheckoutAmount` (`lib/payments/operations/checkout.ts`). |
| **FR-TRIAL-03** | **In-Room Last-5-Minute Retainer Proposal & 1-Click Checkout Drawer** | P0 | **Phase 1 Core Wedge** (`app/meetings/[id]/`): During the final 5 minutes of a live `Trial` or `Consultation` call, render a real-time **Retainer Proposal Drawer** allowing the consultant to propose a `SubscriptionPlan` with pre-selected weekly slots and the client to complete 1-click checkout without leaving the video room. |

### 3.5 Live Events (`Webinar` & `Class`), Co-Hosts & Recording Marketplace (`FR-EVT`)

| ID | Requirement Title | Priority | Implementation Status & Code Reference |
|---|---|---|---|
| **FR-EVT-01** | **1-to-Many Shared Appointment Pivot Architecture** | P0 | **Implemented** (`Webinar`, `Class`, `Appointment`, `AppointmentOccurrence`, `AppointmentParticipant`): Map each `Webinar` or `Class` cohort to a shared `Appointment` with $M$ `AppointmentOccurrence` sessions and $N$ `AppointmentParticipant` seats, preventing per-attendee room duplication. |
| **FR-EVT-02** | **Pro-Rata Late Join, Make-Up Window & Class Exit Right** | P0 | **Implemented** (`ClassPlan`, `lib/payments/operations/checkout.ts`): Support pro-rata discounted enrollment up to session $K$ (`lateJoinUntilSession: 1..3`), a 14-day post-cohort host make-up window (`isMakeupSession = true`), and an automatic **Class Exit Right** pro-rata refund if a learner misses $\ge 3$ sessions or $\ge 25\%$ of the cohort. |
| **FR-EVT-03** | **Multi-Collaborator Revenue Splits** | P0 | **Implemented** (`WebinarCollaborator`, `ClassCollaborator`, `SubscriptionCollaborator`, `lib/collaborators/earnings-split.ts`): Enforce `SUM(collaborator.shareBps) <= 10000` (100%) and automatically split the creator's net payout across `HOST`, `CO_HOST`, `MODERATOR`, and `TEACHING_ASSISTANT` ledger accounts upon settlement release. |
| **FR-EVT-04** | **Evergreen Recording Marketplace & 14-Day Cold Storage Transfer** | P1 | **Implemented** (`Recording`, `RecordingPurchase`, `app/explore/recordings/`): Automatically transfer Stream.io recordings (`STREAM_S3`) to platform-owned Supabase/S3 storage (`PLATFORM`) within 14 days and enable standalone `RecordingPurchase` monetization for past webinars and classes. |

### 3.6 Stream.io Live Video Room & Persistent Consulting Workspace (`FR-WORK`)

| ID | Requirement Title | Priority | Implementation Status & Code Reference |
|---|---|---|---|
| **FR-WORK-01** | **Server-Provisioned WebRTC Rooms, Stage Moderation & Elastic Overruns** | P0 | **Implemented** (`lib/meetings/`, `StageControls.tsx`, `OverrunBanner.tsx`): Provision Stream.io Video rooms exclusively on the server (`provisionAppointmentMeeting`), supporting up to 1,000 webinar viewers with backstage/stage hand-raise promotion (`request_to_speak` -> `promote_to_stage`) and elastic duration caps (`+30m` hard grace cap + one `+15m` free host extension). |
| **FR-WORK-02** | **Automated 1-Hour Post-Call `SessionOutcome` Classifier** | P0 | **Implemented** (`SessionOutcome`, `MeetingSession`, `ParticipantAllocationLog`): Evaluate join/leave telemetry 1 hour after scheduled `endsAt` to classify every occurrence as `HELD`, `LEARNER_ABSENT`, `HOST_ABSENT`, or `CUT_SHORT`, automatically triggering escrow release or buyer refund rules. |
| **FR-WORK-03** | **In-Call Side-by-Side Document Co-Viewing & Pin Annotation (`AppointmentDocument`)** | P0 | **Phase 1 Core Wedge** (`AppointmentDocument`, `lib/documents/document-review.ts`, `app/meetings/[id]/`): Upgrade `AppointmentDocument` from an asynchronous dashboard upload table into an **In-Call Split-Screen PDF/Doc Co-Viewer** inside `/meetings/[id]` with synchronized page scrolling, pin annotations (`annotationsJson` JSONB), and versioned `PENDING -> IN_REVIEW -> APPROVED / REJECTED / NEEDS_REVISION` state transitions. |
| **FR-WORK-04** | **AI Structured Call Summary & Shared Client Action-Item Tracker** | P0 | **Phase 1 Core Wedge** (`MeetingSession`, `Subscription`): Post-call transcription and LLM structuring pipeline that generates a **Structured Consultation Brief** (Key Decisions, Risks Identified, Next Steps, and Interactive Client Checklist items) persisted across all occurrences of a `Subscription` retainer. |
| **FR-WORK-05** | **Booking-Gated Stream Chat Lifecycle (`+7d` Freeze, `+90d` Purge)** | P0 | **Implemented** (`lib/stream/`): Restrict Stream Chat channel creation to confirmed bookings; automatically freeze channels to read-only `+7 days` after the final occurrence ends and purge chat payloads at `+90 days` for DPDP Act 2023 data minimization. |

### 3.7 Financial Spine, Double-Entry Ledger & Indian Tax/Payout Engine (`FR-FIN`)

| ID | Requirement Title | Priority | Implementation Status & Code Reference |
|---|---|---|---|
| **FR-FIN-01** | **Multi-Leg Checkout Composition (`PaymentLeg`)** | P0 | **Implemented** (`lib/payments/operations/checkout.ts`, `PaymentLeg`, `prisma/sql/payment-legs-triggers.sql`): Support atomic multi-tender checkouts combining `CARD` (Razorpay/Stripe), `WALLET`, `INVOICE_ACCRUAL`, `OVERAGE_INVOICE_ACCRUAL`, `LICENSE` (`SeatGrant`), and `REFERRAL_CREDIT`, enforced by PostgreSQL trigger `payment_legs_sum_to_amount`. |
| **FR-FIN-02** | **13-Account Double-Entry Ledger with `DEFERRABLE` Balance Triggers** | P0 | **Implemented** (`LedgerTransaction`, `LedgerEntry`, `LedgerAccountKind`, `prisma/sql/ledger-triggers.sql`): Record every monetary movement across 13 distinct `LedgerAccountKind` buckets (`GATEWAY_CLEARING`, `BUYER_WALLET`, `PLATFORM_ESCROW`, `PLATFORM_REVENUE`, `CREATOR_PAYABLE`, `HOST_ORG_PAYABLE`, `TAX_CGST_PAYABLE`, `TAX_SGST_PAYABLE`, `TAX_IGST_PAYABLE`, `TDS_194O_PAYABLE`, etc.) guarded by `DEFERRABLE INITIALLY DEFERRED` trigger `ledger_txn_balanced` (`SUM(debit) == SUM(credit)`) and immutability trigger `ledger_entry_immutable`. |
| **FR-FIN-03** | **Automated GST (SAC `9983` / `999293`), Sec 194-O TDS & MSME 43B(h) Compliance** | P0 | **Implemented** (`TaxInvoice`, `CreditNote`, `TdsCertificateQuarter`, `MsmeVendorDeclaration`): Compute 18% GST (`CGST 9% + SGST 9%` intra-state or `IGST 18%` inter-state, `0%` LUT export), withhold Section 194-O TDS (`0.1%` with AES-256-GCM encrypted PAN or `5%` without PAN above ₹5,00,000 annual threshold), and prioritize MSME-registered vendors within the statutory 15/45-day Section 43B(h) settlement window. |
| **FR-FIN-04** | **Nightly 26-Invariant Ledger Reconciler** | P0 | **Implemented** (`scripts/reconcile/reconcile-ledgers.ts`, `ReconciliationRun`): Execute 26 automated SQL/financial invariants nightly, halting automated `PayoutBatch` dispatch if any account drift (`discrepancyPaise != 0`) is detected. |

### 3.8 2-Axis (`SPONSOR × HOST`) Enterprise Subsystem (`FR-ENT`)

| ID | Requirement Title | Priority | Implementation Status & Code Reference |
|---|---|---|---|
| **FR-ENT-01** | **2-Axis Organization Topology (`SPONSOR` Buyers × `HOST` Consulting Agencies)** | P0 | **Implemented** (`familiarise_web_enterprise` PR `#1997`, `Organization`, `RateCard`, `HostMember`): Support 4 booking quadrants (`B2C Marketplace`, `Sponsor -> Solo Consultant`, `Individual -> Host Agency`, `Sponsor -> Host Agency`) with custom `RateCard` pricing and automated `10% Platform / 10% Host Org Royalty / 80% Consultant` split routing. |
| **FR-ENT-02** | **7-Axis Enterprise Entitlement, Spend Cap & Hybrid Overage Engine** | P0 | **Implemented** (`SeatGrant`, `SponsorSpendCap`, `CreditPool`, `ProgramCohort`): Evaluate seat entitlements, departmental spend caps, and hybrid checkout splits (`INVOICE_ACCRUAL` up to cap + personal `CARD`/`WALLET` for overage). |

### 3.9 Mobile Companion (`familiarise_mobile` — Flutter + Dart Frog) (`FR-MOB`)

| ID | Requirement Title | Priority | Implementation Status & Code Reference |
|---|---|---|---|
| **FR-MOB-01** | **93-Model Schema Parity & Mobile Video/Scheduling Companion** | P1 | **Implemented** (`familiarise_mobile`): Flutter `3.47.6` client + Dart Frog `1.2.x` BFF with 93/93 Prisma models synced (`prisma_flutter_connector` `v1.0.0`), supporting push notifications, calendar management, Stream.io mobile video calls, and `WebHandoffDialog` external checkout handoff for Apple App Store Guideline `3.1.3(b)/(d)` (1:1 live services) and `3.1.3(a)` (reader/enterprise seat) compliance. |

---

## 4. Non-Functional Requirements (`NFR-*`)

| ID | Category | Specification & Target SLA | Verification Mechanism |
|---|---|---|---|
| **NFR-01** | **Zero Double-Booking Integrity** | `0` overlapping confirmed `AppointmentOccurrence` rows per `consultantProfileId` under 500 concurrent checkout/allocation requests. | PostgreSQL GiST exclusion constraint (`occurrence_no_confirmed_overlap`) + k6 concurrency stress suite. |
| **NFR-02** | **Financial & Ledger Conservation** | `0 paise` unbalance across all `LedgerTransaction`s; 100% of currency values stored as integer minor units (`BigInt` in PostgreSQL, safely serialized via `lib/prisma.ts`). | PostgreSQL `ledger_txn_balanced` trigger + nightly 26-invariant `reconcile-ledgers.ts` job. |
| **NFR-03** | **Schema Freeze Discipline (`#705`)** | Zero destructive migrations or unapproved table additions to `prisma/schema.prisma` during Phase 1 launch hardening; new metadata persisted in typed JSONB columns or existing relations. | CI schema drift check against `prisma/sql/known-drift.json` and `check-constraints.sql`. |
| **NFR-04** | **WebRTC Video & Co-Viewer Latency** | `< 150ms` median audio/video latency via Stream.io edge SFUs; `< 200ms` document page-sync & pin-annotation broadcast latency inside `/meetings/[id]`. | Stream.io webhook QoS telemetry (`MeetingSession`) + real-time custom event benchmarks. |
| **NFR-05** | **Security, PII Encryption & DPDP Act 2023** | AES-256-GCM encryption at rest for tax identifiers (`panEncrypted` in `ConsultantProfile`), HMAC-SHA256 webhook signature verification (Razorpay, Stripe, Stream.io, Practitionist Bridge), and automated `+90d` chat PII purge. | Automated security test suite + `ModerationAction` / audit log immutability checks. |
| **NFR-06** | **API & Checkout Responsiveness** | `p95 < 350ms` for marketplace search and slot availability queries; `p95 < 800ms` for multi-leg `deriveCheckoutAmount` and order creation. | OpenTelemetry / Sentry performance tracing across Next.js 15 App Router API routes. |
