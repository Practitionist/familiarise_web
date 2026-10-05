# 05 — High-Level Design (HLD)

> **Parent Legal Entity:** Practitionist (OPC) Private Limited (`CIN: U62012HR2026OPC146217`)  
> **Product:** Familiarise (`familiarise_web` + `familiarise_mobile`)  
> **Architecture Style:** Modular Monolith (Next.js 15 App Router + Mobile Dart Frog BFF) backed by PostgreSQL 16 (GiST + Deferrable Double-Entry Triggers), Upstash Redis (Distributed Locks & Rate Limiting), and Stream.io (WebRTC SFU + Chat)

---

## 1. System Context & C4 Container Architecture

Familiarise is architected as a **high-integrity transactional scheduling, live video collaboration, and double-entry financial platform** serving both B2C individual clients/consultants and B2B `SPONSOR × HOST` enterprise organizations.

```mermaid
flowchart TB
    subgraph Clients["Client Layer"]
        WEB["Next.js 15.5.27 Web App<br/>(App Router, React 18, Tailwind v3)"]
        MOB["Flutter 3.47.6 Mobile App<br/>(iOS & Android + WebHandoffDialog)"]
    end

    subgraph Edge["API & BFF Layer"]
        NEXT_API["familiarise_web Route Handlers & Server Actions<br/>(BetterAuth 1.7.7 + OIDC/SAML SSO)"]
        DART_BFF["familiarise_mobile Dart Frog 1.2 BFF<br/>(93/93 Synced Prisma Models)"]
    end

    subgraph CoreDomains["Familiarise Core Domain Engines (lib/)"]
        SCHED["Scheduling & 3-Layer Allocation Engine<br/>(lib/scheduling/ + lib/booking/)"]
        MEET["Live Video, Stage & Co-Viewing Engine<br/>(lib/meetings/ + lib/documents/)"]
        FIN["Multi-Leg Checkout & 13-Account Ledger Spine<br/>(lib/payments/ + scripts/reconcile/)"]
        ENT["2-Axis (SPONSOR × HOST) Enterprise Engine<br/>(RateCard, SeatGrant, SpendCap, CreditPool)"]
    end

    subgraph DataLayer["Persistence & Locking Layer"]
        PG[("PostgreSQL 16 (Supabase)<br/>155 Models, 140 Enums<br/>GiST Exclusion + Deferrable Triggers")]
        REDIS[("Upstash Redis<br/>Distributed Slot Locks + Rate Limiter")]
        S3[("Supabase Storage / S3<br/>AppointmentDocument PDFs + Cold Recordings")]
    end

    subgraph External["External Infrastructure & Ecosystem"]
        STREAM["Stream.io Video SFU (1,000-Seat WebRTC)<br/>& Booking-Gated Stream Chat"]
        PAY["Razorpay (India INR/UPI/Route)<br/>& Stripe (Global USD/Connect)"]
        RESEND["Resend + Novu<br/>(Transactional Email & In-App Alerts)"]
        ELLUMINAR["Elluminar (elluminar_web)<br/>Practitionist SSO & Cross-Sell Bridge"]
    end

    WEB --> NEXT_API
    MOB --> DART_BFF
    DART_BFF --> NEXT_API
    NEXT_API --> SCHED
    NEXT_API --> MEET
    NEXT_API --> FIN
    NEXT_API --> ENT

    SCHED --> REDIS
    SCHED --> PG
    MEET --> STREAM
    MEET --> S3
    MEET --> PG
    FIN --> PAY
    FIN --> PG
    ENT --> PG
    NEXT_API --> RESEND
    NEXT_API <-->|"OIDC SSO + Signed Webhooks"| ELLUMINAR
```

---

## 2. Core Subsystem 1: 3-Layer Zero-Collision Slot Allocation Topology

Scheduling live human experts across timezones, recurring weekly subscriptions (`SubscriptionCycle`), and multi-session cohorts (`Class`) without double-booking is one of the hardest concurrency problems in marketplace engineering. Familiarise enforces a **3-Layer Defense-in-Depth Architecture**:

```mermaid
sequenceDiagram
    autonumber
    participant Client as Buyer / Consultant UI
    participant API as AllocationService (lib/scheduling/allocationService.ts)
    participant Redis as Upstash Redis (utils/appointmentlock.ts)
    participant PG as PostgreSQL 16 (SERIALIZABLE + GiST)

    Client->>API: Request Slot Allocation (useRequestedSlots / manualAllocate / autoAllocate)
    API->>Redis: Layer 1: Acquire Redlock lockAutoAllocate(consultantProfileId, TTL=15s)
    alt Lock Contention
        Redis-->>API: Lock Busy -> Exponential Backoff Retry
    end
    Redis-->>API: Lock Acquired
    API->>PG: Layer 2: BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE
    API->>PG: Verify Entitlement (computeSubscriptionEntitlement) & Weekly Caps
    API->>PG: Score/Validate Candidate Windows (preferenceScoring.ts)
    API->>PG: INSERT / UPDATE AppointmentOccurrence (status = CONFIRMED)
    Note over PG: Layer 3: Postgres evaluates GiST Exclusion Constraint<br/>occurrence_no_confirmed_overlap<br/>(consultant_profile_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    alt GiST Overlap or Serialization Failure (P2034 / 23P01)
        PG-->>API: Reject Transaction (Zero Double-Booking Guaranteed)
        API->>PG: ROLLBACK & Retry (up to 3 attempts on P2034)
    else Clean Commit
        PG-->>API: COMMIT SUCCESS
    end
    API->>Redis: Release Lock
    API-->>Client: Return Confirmed AppointmentOccurrence(s)
```

### Key Architectural Properties:
1. **Layer 1 — Application Distributed Mutex (`utils/appointmentlock.ts`):** Serializes concurrent allocation requests per `consultantProfileId` at the edge using Upstash Redis before hitting PostgreSQL.
2. **Layer 2 — `SERIALIZABLE` Isolation with `P2034` Retry (`lib/scheduling/allocationService.ts`):** Prevents phantom reads when verifying `SubscriptionCycle` weekly call caps (`callsPerWeek`) and consultant availability windows.
3. **Layer 3 — Database Kernel GiST Exclusion Constraint (`prisma/sql/check-constraints.sql`):** Even if a bug or direct SQL script bypasses application code, PostgreSQL physically blocks any two `CONFIRMED` or `PAYMENT_IN_PROGRESS` `AppointmentOccurrence` rows for the same `consultant_profile_id` whose `[starts_at, ends_at)` `tstzrange` intervals overlap.

---

## 3. Core Subsystem 2: Anti-Leakage Consulting Workspace & Trial-to-Retainer Loop

To defeat the #1 failure mode of 1:1 consulting marketplaces (**1-Call Off-Platform Leakage to WhatsApp + Google Meet + UPI**), Familiarise embeds the entire consulting workflow inside a persistent, stateful workspace (`/meetings/[id]` + `/dashboard/consultee/`):

```mermaid
flowchart LR
    subgraph Funnel["1. Diagnostic Trial Entry"]
        T1["Paid/Discounted Trial Session<br/>(idx_trials_one_active_per_pair)"]
        T2["DMs Blocked Pre-Conversion<br/>(Anti-Leakage Guardrail)"]
    end

    subgraph Room["2. Live Consulting Room (/meetings/[id])"]
        R1["Stream.io WebRTC Video + Stage Controls<br/>(+30m Grace / +15m Free Host Extension)"]
        R2["Side-by-Side Document Co-Viewer<br/>(AppointmentDocument PDF + Pin Annotations)"]
        R3["Last-5-Min Retainer Proposal Drawer<br/>(1-Click Subscription Checkout in Call)"]
    end

    subgraph PostCall["3. Post-Call Retention & Conversion"]
        P1["1-Hr SessionOutcome Classifier<br/>(HELD / LEARNER_ABSENT / HOST_ABSENT)"]
        P2["48h 100% Trial Fee Credit Voucher<br/>(Auto-Applied via deriveCheckoutAmount)"]
        P3["AI Structured Call Brief &<br/>Shared Retainer Action-Item Tracker"]
    end

    T1 --> T2 --> R1
    R1 --> R2 --> R3
    R3 --> P1
    P1 --> P2
    P1 --> P3
    P2 -->|"Converts to Recurring SubscriptionPlan"| R1
    P3 -->|"Persists across SubscriptionCycle Occurrences"| R2
```

---

## 4. Core Subsystem 3: Multi-Leg Checkout & 13-Account Double-Entry Financial Spine

Familiarise never mutates balances via ad-hoc `UPDATE wallet SET balance = balance - X` queries. Every financial event flows through an immutable, trigger-verified **Double-Entry General Ledger**:

```mermaid
flowchart TB
    subgraph Checkout["1. Multi-Leg Checkout (lib/payments/operations/checkout.ts)"]
        CALC["deriveCheckoutAmount()<br/>(Pro-Rata Late Join + 48h Trial Credit + Promo + GST)"]
        LEGS["PaymentLeg Splitter<br/>(CARD | WALLET | INVOICE_ACCRUAL | OVERAGE_INVOICE_ACCRUAL | LICENSE | REFERRAL_CREDIT)"]
        TRIG1["Postgres Trigger: payment_legs_sum_to_amount<br/>(SUM(legs) == Payment.amountPaise)"]
    end

    subgraph Ledger["2. 13-Account Double-Entry Ledger (prisma/sql/ledger-triggers.sql)"]
        TXN["LedgerTransaction<br/>(Deferrable Trigger: ledger_txn_balanced)"]
        ACC1["GATEWAY_CLEARING / BUYER_WALLET / ORG_RECEIVABLE"]
        ACC2["PLATFORM_ESCROW (Held until SessionOutcome == HELD)"]
        ACC3["TAX_CGST_PAYABLE / TAX_SGST_PAYABLE / TAX_IGST_PAYABLE (18% GST)"]
        ACC4["TDS_194O_PAYABLE (0.1% PAN / 5% No-PAN)"]
        ACC5["PLATFORM_REVENUE (20% Marketplace | 10% Host RateCard | 0% OWN_LINK)"]
        ACC6["HOST_ORG_PAYABLE (10% Agency Royalty)"]
        ACC7["CREATOR_PAYABLE (80% - 100% Net + Collaborator Splits)"]
    end

    subgraph Settlement["3. Reconciliation & Payouts"]
        RECON["Nightly 26-Invariant Reconciler<br/>(scripts/reconcile/reconcile-ledgers.ts)"]
        BATCH["PayoutBatch Dispatcher<br/>(MSME 43B(h) Priority + Razorpay Route / Stripe Connect)"]
    end

    CALC --> LEGS --> TRIG1 --> TXN
    TXN --> ACC1 --> ACC2
    ACC2 -->|"SessionOutcome == HELD"| ACC3 & ACC4 & ACC5 & ACC6 & ACC7
    ACC7 --> RECON --> BATCH
```

### Commission & Split Routing Matrix (`lib/payments/core/splits.ts`)
| Booking Quadrant / Attribution | Platform Take Rate (`PLATFORM_REVENUE`) | Host Agency Royalty (`HOST_ORG_PAYABLE`) | Creator / Collaborator Pool (`CREATOR_PAYABLE`) |
|---|---|---|---|
| **Marketplace Discovery (`PLATFORM_DISCOVERY`)** | `20.0%` (`2000 bps`) | `0.0%` | `80.0%` (`8000 bps`, split across `Collaborator`s if applicable) |
| **Creator Direct Link (`OWN_LINK` / `ConsultantFeeWaiver`)** | `0.0%` (`0 bps`) | `0.0%` | `100.0%` (`10000 bps` minus gateway processing fee) |
| **Enterprise `SPONSOR × HOST` Agency (`RateCard`)** | `10.0%` (`1000 bps`) | `10.0%` (`1000 bps`) | `80.0%` (`8000 bps`) |

---

## 5. Core Subsystem 4: 2-Axis (`SPONSOR × HOST`) Enterprise Topology

Unlike single-sided B2B LMS portals, Familiarise models corporate organizations along **two orthogonal axes** (`familiarise_web_enterprise` PR `#1997`):
1. **Buyer Axis (`Organization` as `SPONSOR`):** Corporate HR/L&D teams or engineering leaders who fund employee coaching (`SeatGrant`), set departmental `SponsorSpendCap`s, manage `CreditPool`s, or sponsor `ProgramCohort` group classes via net-30 `INVOICE_ACCRUAL` billing.
2. **Supply Axis (`Organization` as `HOST`):** Boutique consulting firms, law/tax practices, or architecture advisories that roster multiple `ConsultantProfile`s (`HostMember`), negotiate custom `RateCard`s with `SPONSOR` organizations, and receive consolidated agency payouts (`HOST_ORG_PAYABLE`).

### 7-Axis Enterprise Checkout Resolution
When an enterprise employee books a session, the checkout engine resolves:
1. **Identity & SSO (`SsoConnection`)** -> 2. **Vendor Approval (`VendorApproval`)** -> 3. **Negotiated Rate Card (`RateCard`)** -> 4. **Seat/Cohort Entitlement (`SeatGrant` / `ProgramCohort`)** -> 5. **Spend Cap & Credit Pool (`SponsorSpendCap` / `CreditPool`)** -> 6. **Hybrid Overage Split (`INVOICE_ACCRUAL` + personal `CARD`/`WALLET`)** -> 7. **3-Way Settlement Split (`10% Platform / 10% Host Org / 80% Consultant`)**.

---

## 6. Deployment, Observability & Cross-Product Topology

- **Primary Web Runtime:** Next.js `^15.5.27` deployed on containerized Linux / Vercel-compatible edge infrastructure with strict security headers and patched image processing (`sharp >= 0.35.5`).
- **Database & Storage:** Supabase PostgreSQL 16 with PgBouncer connection pooling for transactional queries, direct connections for migrations/triggers, and Supabase Storage / S3 with signed URLs for `AppointmentDocument`s and transferred `Recording`s.
- **Background Cron & Event Workers (`app/api/cron/`, `jobs/`):**
  - `sla-breach-check`: Every 15 minutes (48h first-allocation SLA enforcement).
  - `session-outcome-classifier`: Hourly (`HELD` / `LEARNER_ABSENT` / `HOST_ABSENT` / `CUT_SHORT` evaluation + escrow release).
  - `recording-transfer`: Daily (transfers `STREAM_S3` recordings to `PLATFORM` storage before Stream's 14-day TTL).
  - `chat-lifecycle`: Daily (`+7d` freeze and `+90d` PII purge).
  - `reconcile-ledgers`: Nightly at 02:00 IST (26-invariant financial verification).
