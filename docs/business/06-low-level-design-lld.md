# 06 — Low-Level Design (LLD)

> **Parent Legal Entity:** Practitionist (OPC) Private Limited (`CIN: U62012HR2026OPC146217`)  
> **Product:** Familiarise (`familiarise_web` + `familiarise_mobile`)  
> **Schema Constraint:** 100% compatible with the Issue `#705` Schema Freeze (`prisma/schema.prisma` — 155 models, 140 enums) and raw PostgreSQL sidecar triggers (`prisma/sql/`).

---

## 1. Database Kernel Constraints & Trigger Specifications (`prisma/sql/`)

### 1.1 GiST Exclusion Constraint for Zero-Collision Slot Allocation
Defined in `prisma/sql/check-constraints.sql`, PostgreSQL's `btree_gist` extension guarantees at the storage engine level that no consultant can ever have two overlapping active occurrences:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "appointment_occurrences"
ADD CONSTRAINT "occurrence_no_confirmed_overlap"
EXCLUDE USING gist (
  "consultant_profile_id" WITH =,
  tstzrange("starts_at", "ends_at", '[)') WITH &&
)
WHERE ("status" IN ('CONFIRMED', 'PAYMENT_IN_PROGRESS'));
```

### 1.2 Multi-Slot Preference Scoring Algorithm (`lib/scheduling/preferenceScoring.ts`)
When `autoAllocate` runs for a multi-session `Subscription` or `Consultation`, candidate availability windows $w \in W_{\text{free}}$ are scored against the buyer's preferences $P$:

$$\text{Score}(w, P) = w_{\text{custom}} \cdot \mathbb{I}(w \in P_{\text{customWindows}}) + w_{\text{day}} \cdot \mathbb{I}(\text{day}(w) \in P_{\text{daysOfWeek}}) + w_{\text{bucket}} \cdot \mathbb{I}(\text{bucket}(w) \in P_{\text{timeBuckets}}) - w_{\text{dist}} \cdot \Delta_{\text{days}}(w)$$

Where:
- $w_{\text{custom}} = 50$ (exact match with buyer's requested custom window),
- $w_{\text{day}} = 25$ (matches preferred day of week `0..6`),
- $w_{\text{bucket}} = 15$ (matches time bucket `MORNING | AFTERNOON | EVENING | NIGHT`),
- $w_{\text{dist}} = 1$ per day from cycle start (tie-breaker favoring earlier scheduling within the `SubscriptionCycle` tranche).

### 1.3 Fill-Order Subscription Cycle Entitlement Math (`lib/booking/entitlement.ts`)
For a `SubscriptionPlan` with `durationInMonths` $M$ and `callsPerWeek` $K$:
- Total entitled occurrences: $N_{\text{total}} = M \times K \times 4$.
- Each `SubscriptionCycle` $c \in \{1, \dots, M\}$ holds an independent tranche of $4K$ credits (`entitledCalls = 4 * callsPerWeek`).
- `computeSubscriptionEntitlement(subscriptionId)` consumes credits in strict chronological **fill-order** across active cycles, enforcing both:
  1. **Cycle Cap:** `allocatedInCycle(c) <= c.entitledCalls + c.bonusCalls`
  2. **Weekly Cap:** `allocatedInIsoWeek(w) <= subscriptionPlan.callsPerWeek`

---

## 2. Double-Entry Ledger & Multi-Leg Payment Specifications

### 2.1 Multi-Leg Payment Conservation Trigger (`prisma/sql/payment-legs-triggers.sql`)
Every `Payment` record (amount $A_{\text{total}}$ in paise) decomposes into $1 \dots N$ `PaymentLeg` rows (`CARD`, `WALLET`, `INVOICE_ACCRUAL`, `OVERAGE_INVOICE_ACCRUAL`, `LICENSE`, `REFERRAL_CREDIT`). A `DEFERRABLE INITIALLY DEFERRED` constraint trigger verifies exact conservation at transaction commit:

```sql
CREATE OR REPLACE FUNCTION check_payment_legs_sum() RETURNS TRIGGER AS $$
DECLARE
  v_payment_id TEXT;
  v_expected_amount BIGINT;
  v_actual_sum BIGINT;
BEGIN
  v_payment_id := COALESCE(NEW.payment_id, OLD.payment_id);
  SELECT amount_paise INTO v_expected_amount FROM payments WHERE id = v_payment_id;
  SELECT COALESCE(SUM(amount_paise), 0) INTO v_actual_sum
    FROM payment_legs WHERE payment_id = v_payment_id;

  IF v_expected_amount IS NOT NULL AND v_actual_sum <> v_expected_amount THEN
    RAISE EXCEPTION 'payment_legs_sum_to_amount violated for payment %: expected %, got %',
      v_payment_id, v_expected_amount, v_actual_sum;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
```

### 2.2 Double-Entry Balance & Immutability Triggers (`prisma/sql/ledger-triggers.sql`)
1. **`ledger_txn_balanced` (`DEFERRABLE INITIALLY DEFERRED`):** Ensures that for every `ledger_transaction_id`, $\sum \text{DEBIT}_{\text{paise}} = \sum \text{CREDIT}_{\text{paise}}$ before `COMMIT`.
2. **`ledger_entry_immutable` (`BEFORE UPDATE OR DELETE`):** Blocks any mutation or deletion of posted `ledger_entries` rows; adjustments must be recorded via contra-entries (`REVERSAL` / `ADJUSTMENT`).

---

## 3. Low-Level Design for the 4 Phase-1 Consulting Wedge Upgrades (`#705`-Freeze Safe)

Because `prisma/schema.prisma` is frozen at 155 models under Issue `#705`, all 4 strategic Phase 1 upgrades confirmed for Familiarise are designed to **reuse existing tables and JSONB columns with zero destructive DDL migrations**.

### 3.1 Upgrade 1: In-Call Side-by-Side Document Co-Viewing & Pin Annotations
- **Existing Schema Model (`prisma/schema.prisma`):** `AppointmentDocument` (`id`, `appointmentId`, `occurrenceId`, `uploadedByUserId`, `fileName`, `fileUrl`, `mimeType`, `fileSizeBytes`, `reviewStatus`, `reviewNotes`, `reviewedByUserId`, `reviewedAt`, `version`, `parentDocumentId`).
- **Low-Level Implementation:**
  1. **In-Room Split-Pane Component (`app/meetings/[id]/components/DocumentCoViewerPane.tsx`):**
     - Renders alongside the Stream.io `<CallParticipantsList />` / `<SpeakerLayout />` inside `app/meetings/[id]/page.tsx`.
     - Streams PDF/image/code artifacts from `AppointmentDocument.fileUrl` via a short-lived signed URL (`GET /api/appointments/[appointmentId]/documents/[docId]/signed-url`).
  2. **Real-Time Page & Pin Synchronization via Stream Call Custom Events:**
     - Broadcasts ephemeral cursor/page sync events over the active Stream Video call channel (`call.sendCustomEvent({ type: 'doc.sync', docId, pageNumber, zoom, pin })`) with `<150ms` latency.
  3. **Persistent Pin Annotations (`reviewNotes` Structured JSON Envelope):**
     - Without altering `prisma/schema.prisma`, `AppointmentDocument.reviewNotes` stores a backwards-compatible JSON envelope (or falls back to plain markdown if legacy text is present):
     ```typescript
     export interface AppointmentDocumentReviewEnvelope {
       version: 1;
       summaryMarkdown: string;
       pins: Array<{
         id: string;
         pageNumber: number;
         xNorm: number; // 0.0 .. 1.0 normalized coordinate
         yNorm: number; // 0.0 .. 1.0 normalized coordinate
         authorUserId: string;
         authorRole: 'CONSULTANT' | 'CONSULTEE';
         comment: string;
         resolved: boolean;
         createdAtIso: string;
       }>;
     }
     ```
  4. **API Route (`PATCH /api/appointments/[appointmentId]/documents/[docId]`):**
     - Validates `reviewStatus` transitions (`PENDING -> IN_REVIEW -> APPROVED | REJECTED | NEEDS_REVISION`) via `lib/documents/document-review.ts` and persists new pin annotations atomically.

### 3.2 Upgrade 2: AI Call Summary + Shared Client Action-Item Tracker
- **Existing Schema Models:** `MeetingSession` (`id`, `occurrenceId`, `transcriptUrl`, `summary`, `metadata` JSONB) and `Subscription` (`id`, `requestNotes` / `MeetingSession.metadata`).
- **Low-Level Implementation:**
  1. **Post-Call Webhook Pipeline (`app/api/webhooks/stream/route.ts` -> `jobs/meetings/generate-call-brief.ts`):**
     - When Stream.io emits `call.transcription_ready` or `call.session_ended`, the worker fetches the VTT/JSON transcript and invokes the structured LLM extractor.
  2. **Structured Schema in `MeetingSession.metadata` (`CallBriefMetadata`):**
     ```typescript
     export interface CallBriefMetadata {
       briefVersion: 1;
       generatedAtIso: string;
       executiveSummary: string;
       keyDecisions: string[];
       identifiedRisks: string[];
       actionItems: Array<{
         id: string;
         title: string;
         assignee: 'CONSULTEE' | 'CONSULTANT';
         dueAtIso?: string;
         completed: boolean;
         completedAtIso?: string;
         occurrenceId: string;
       }>;
     }
     ```
  3. **Cross-Occurrence Retainer Continuity (`GET /api/subscriptions/[subscriptionId]/workspace`):**
     - Aggregates `MeetingSession.metadata.actionItems` and `AppointmentDocument` versions across all `AppointmentOccurrence` rows belonging to the `Subscription`, giving the client and consultant a continuous **Retainer Workspace** on `/dashboard/consultee/subscriptions/[id]` and inside the next live call room.

### 3.3 Upgrade 3: 48-Hour Trial-to-Subscription 100% Fee Credit & Last-5-Min Upsell Drawer
- **Existing Schema Models:** `Trial` (`id`, `consulteeProfileId`, `consultantProfileId`, `subscriptionPlanId`, `appointmentId`, `status`, `convertedToSubscriptionId`, `updatedAt`) and `Payment` / `deriveCheckoutAmount` (`lib/payments/operations/checkout.ts`).
- **Low-Level Implementation:**
  1. **Eligibility Rule (`lib/payments/operations/trial-credit.ts`):**
     - When a buyer initiates checkout for `SubscriptionPlan` $S$, `deriveCheckoutAmount` queries `prisma.trial.findFirst`:
       ```typescript
       const eligibleTrial = await prisma.trial.findFirst({
         where: {
           consulteeProfileId,
           consultantProfileId: plan.consultantProfileId,
           status: 'COMPLETED',
           convertedToSubscriptionId: null,
           updatedAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
         },
         include: { appointment: { include: { payments: { where: { status: 'SUCCEEDED' } } } } },
       });
       ```
     - If found within the **48-hour conversion window**, the paid trial fee $F_{\text{trial}} = \sum \text{payment.amountPaise}$ is deducted 100% from the first cycle's base price ($\text{netBasePaise} = \max(0, P_{\text{sub}} - F_{\text{trial}})$).
     - Upon payment success, `Trial.convertedToSubscriptionId` is atomically set to the new `Subscription.id` inside the checkout transaction so the credit can only be redeemed once.
  2. **In-Room Last-5-Minute Retainer Proposal Drawer (`app/meetings/[id]/components/RetainerUpsellDrawer.tsx`):**
     - Triggered automatically when `remainingSeconds <= 300` on any `Trial` or `Consultation` call, or manually via the Consultant's **"Propose Retainer Plan"** toolbar button.
     - Displays the consultant's `SubscriptionPlan` tiers, the live **48h 100% Trial Fee Credit badge** (`-₹X,XXX applied`), and a 1-click Razorpay/Stripe checkout modal.

### 3.4 Upgrade 4: Session Attendance Receipts (Strict Boundary vs. Elluminar Skill Credentials)
- **Existing Schema Fields:** `WebinarPlan.certificateProvided`, `ClassPlan.certificateProvided`, `AppointmentParticipant.attended`, `MeetingSession`, `TaxInvoice`.
- **Low-Level Implementation:**
  1. **UI & Copy Guardrail:** Rename all user-facing labels for `certificateProvided` on `WebinarPlan` and `ClassPlan` from *"Certificate of Completion"* to **"Verified Session Attendance Receipt (Corporate L&D Reimbursement Ready)"**.
  2. **Attendance Verification Gate (`GET /api/appointments/[appointmentId]/attendance-receipt`):**
     - Generates a downloadable PDF receipt only when `AppointmentParticipant.attended == true` and cumulative participant join duration across `MeetingSession` logs is $\ge 70\%$ of scheduled session duration.
     - Explicitly prints: *"This document certifies live session attendance on Familiarise (SAC 9983 / 999293). For rubric-graded, mentor-defended Skill Credentials and Proof-of-Work Portfolios, verify at elluminar.com/verify."*

---

## 4. Cross-Product Practitionist Bridge Specification (`Familiarise <-> Elluminar`)

### 4.1 Signed Webhook Contract (`POST /api/webhooks/practitionist-bridge`)
Both `familiarise_web` and `elluminar_web` exchange signed lifecycle events using a shared HMAC-SHA256 secret (`PRACTITIONIST_BRIDGE_SECRET`):

```typescript
export interface PractitionistBridgeEvent {
  eventId: string;
  occurredAtIso: string;
  sourceProduct: 'FAMILIARISE' | 'ELLUMINAR';
  targetProduct: 'FAMILIARISE' | 'ELLUMINAR';
  userEmail: string;
  practitionistSsoSub: string;
  eventType:
    | 'ELLUMINAR_CAPSTONE_PASSED'      // Unlocks "Elluminar Verified Practitioner" badge on ConsultantProfile
    | 'ELLUMINAR_DIAGNOSTIC_REFERRAL'  // Issues 10% cross-product credit for Familiarise 1:1 Consultation
    | 'FAMILIARISE_TRIAL_COMPLETED'    // Issues 10% cross-product credit for Elluminar Cohort/Project Track
    | 'ENTERPRISE_ORG_PROVISIONED';    // Syncs B2B Organization metadata across both products
  payload: Record<string, unknown>;
}
```
Every webhook handler verifies `X-Practitionist-Signature: sha256=<hmac>` and logs `eventId` in an idempotency key store (Upstash Redis `SET NX EX 604800`) to guarantee exactly-once processing.
