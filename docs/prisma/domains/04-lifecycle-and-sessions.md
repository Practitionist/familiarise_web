---
type: reference
title: Familiarise — Schema map, Lifecycle & Sessions
---

# Schema map — Lifecycle & Sessions

Ending a booking early, moving it, and running the session it becomes.

Part 4 of 10 of the domain map. The
[map index](../00-schema-map.md) holds the master diagram, the enforcer
inventory and the enum reference.

## 1. Cancellation Policy & Reschedule

The refund-shape side of a booking. `CancellationPolicy` is a published, versioned document owned by the consultant; `CancellationPolicyTier` is the percentage ladder inside it. `RescheduleRequest` is the ask, and `RescheduleProposedTime` holds the candidate windows the consultant offers back.

```mermaid
erDiagram
    CancellationPolicy {
        id string PK
        status cancellationpolicystatus
        organizationId string FK
        publishedByUserId string FK
        createdAt datetime
        version int
        consultantInitiatedBps int
        policyText string
    }
    CancellationPolicyTier {
        id string PK
        policyId string FK
        hoursBefore int
        refundBps int
    }
    RescheduleRequest {
        id string PK
        status reschedulerequeststatus
        appointmentId string FK
        initiatedById string FK
        resolvedById string FK
        organizationId string FK
        createdAt datetime
        initiatorRole rescheduleinitiatorrole
    }
    RescheduleProposedTime {
        id string PK
        rescheduleRequestId string FK
        proposedById string FK
        createdAt datetime
        startsAt datetime
        endsAt datetime
        round int
    }
    User {
        id string PK
    }
    ConsultantProfile {
        id string PK
    }
    Appointment {
        id string PK
    }
    Consultation {
        id string PK
    }
    Subscription {
        id string PK
    }
    Organization {
        id string PK
    }
    Domain {
        id string PK
    }
    Webinar {
        id string PK
    }
    ClassBatch {
        id string PK
    }
    ConsultationPlan {
        id string PK
    }
    ConsulteeProfile {
        id string PK
    }
    SubscriptionPlan {
        id string PK
    }
    CancellationPolicy }o--o| Organization : "organization"
    CancellationPolicy }o--o| User : "publishedBy"
    CancellationPolicyTier }o--|| CancellationPolicy : "policy"
    RescheduleRequest }o--|| Appointment : "appointment"
    RescheduleRequest }o--|| User : "initiatedBy"
    RescheduleRequest }o--o| User : "resolvedBy"
    RescheduleRequest }o--o| Organization : "organization"
    RescheduleProposedTime }o--|| RescheduleRequest : "rescheduleRequest"
    RescheduleProposedTime }o--|| User : "proposedBy"
    ConsultantProfile }o--|| Domain : "domain"
    ConsultantProfile }o--|| User : "user"
    Appointment }o--o| CancellationPolicy : "cancellationPolicy"
    Appointment }o--o| Consultation : "consultation"
    Appointment }o--o| Subscription : "subscription"
    Appointment }o--o| Webinar : "webinar"
    Appointment }o--o| ClassBatch : "class"
    Appointment }o--o| Organization : "organization"
    Consultation }o--|| ConsultationPlan : "consultationPlan"
    Consultation }o--|| ConsulteeProfile : "requestedBy"
    Consultation }o--o| User : "cancelledByUser"
    Subscription }o--|| ConsulteeProfile : "requestedBy"
    Subscription }o--o| User : "cancelledByUser"
    Subscription }o--|| SubscriptionPlan : "subscriptionPlan"
    Subscription }o--o| Subscription : "renewedFrom"
```

- **A booking snapshots the policy version it was sold under.** The policy is versioned rather than edited, so a policy change never retroactively re-dates an existing booking's refund tier.
- **`cancellation_policy_one_active_per_scope` is a partial unique.** Exactly one active policy may exist per scope, enforced by the database rather than by a read-then-write in application code.

## 2. Session Infrastructure, Attendance & Recordings

The Stream.io video layer and the recording store. `Meeting` is the live call for one occurrence. `MeetingAttendance` and `MeetingPresence` are two different attendance records — one is the settled record, one is the live signal. `Recording` is the media asset; `RecordingConsent` is the publish-time redistribution attestation; `RecordingPurchase` is a replay purchase.

```mermaid
erDiagram
    Meeting {
        id string PK
        appointmentOccurrenceId string FK
        organizationId string FK
        createdAt datetime
        streamCallId string UK
        platform platform
        passcode string
        hostKeys string
    }
    MeetingAttendance {
        id string PK
        meetingId string FK
        appointmentOccurrenceId string FK
        createdAt datetime
        userId string
        firstJoinedAt datetime
        lastLeftAt datetime
        joinCount int
    }
    MeetingPresence {
        id string PK
        meetingId string FK
        appointmentOccurrenceId string FK
        createdAt datetime
        userId string
        userSessionId string
        joinedAt datetime
        leftAt datetime
    }
    Recording {
        id string PK
        status recordingstatus
        listPricePaise bigint
        consentAttestedById string FK
        meetingId string FK
        organizationId string FK
        createdAt datetime
        title string
    }
    RecordingConsent {
        id string PK
        meetingId string FK
        createdAt datetime
        userId string
        decision recordingconsentdecision
        decidedAt datetime
        noticeVersion int
        updatedAt datetime
    }
    RecordingPurchase {
        id string PK
        status recordingpurchasestatus
        amountPaise bigint
        recordingId string FK
        buyerId string FK
        createdAt datetime
        gatewayOrderId string UK
        gatewayPaymentId string
    }
    AppointmentOccurrence {
        id string PK
    }
    Appointment {
        id string PK
    }
    Organization {
        id string PK
    }
    User {
        id string PK
    }
    CancellationPolicy {
        id string PK
    }
    Consultation {
        id string PK
    }
    Subscription {
        id string PK
    }
    Webinar {
        id string PK
    }
    ClassBatch {
        id string PK
    }
    BillingAccount {
        id string PK
    }
    Meeting }o--|| AppointmentOccurrence : "occurrence"
    Meeting }o--o| Organization : "organization"
    MeetingAttendance }o--|| Meeting : "meeting"
    MeetingAttendance }o--|| AppointmentOccurrence : "occurrence"
    MeetingPresence }o--|| Meeting : "meeting"
    MeetingPresence }o--|| AppointmentOccurrence : "occurrence"
    Recording }o--o| User : "consentAttestedBy"
    Recording }o--|| Meeting : "meeting"
    Recording }o--o| Organization : "organization"
    RecordingConsent }o--|| Meeting : "meeting"
    RecordingPurchase }o--|| Recording : "recording"
    RecordingPurchase }o--|| User : "buyer"
    AppointmentOccurrence }o--|| Appointment : "appointment"
    Appointment }o--o| CancellationPolicy : "cancellationPolicy"
    Appointment }o--o| Consultation : "consultation"
    Appointment }o--o| Subscription : "subscription"
    Appointment }o--o| Webinar : "webinar"
    Appointment }o--o| ClassBatch : "class"
    Appointment }o--o| Organization : "organization"
    Organization }o--o| BillingAccount : "billingAccount"
```

- **Dual storage.** `STREAM_S3` is temporary (the free tier's two-week window); `SUPABASE` is permanent on the premium path. The `RecordingStatus` lifecycle runs `RECORDING` → `PROCESSING` → `READY` → `TRANSFERRING` → `AVAILABLE`, and `Recording_storage_and_publish_check` refuses a row that claims a permanent path without having transferred to it.
- **Recording retention is bounded by the organisation.** `org_stream_recording_retention_days_range` on `organizations` keeps the per-organisation retention window inside the range the platform can honour.

## 3. Session Documents

Files exchanged inside a booking — briefs, follow-ups, receipts. `AppointmentDocument` is versioned within a thread: `rootDocumentId` anchors the thread and `responseToDocumentId` chains the replies.

```mermaid
erDiagram
    AppointmentDocument {
        id string PK
        reviewedById string FK
        responseToDocumentId string FK
        rootDocumentId string FK
        appointmentId string FK
        deletedById string FK
        fileName string
        originalName string
    }
    Appointment {
        id string PK
    }
    User {
        id string PK
    }
    CancellationPolicy {
        id string PK
    }
    Consultation {
        id string PK
    }
    Subscription {
        id string PK
    }
    Webinar {
        id string PK
    }
    ClassBatch {
        id string PK
    }
    Organization {
        id string PK
    }
    AppointmentDocument }o--o| User : "reviewedBy"
    AppointmentDocument }o--o| AppointmentDocument : "responseToDocument"
    AppointmentDocument }o--o| AppointmentDocument : "rootDocument"
    AppointmentDocument }o--|| Appointment : "appointment"
    AppointmentDocument }o--o| User : "deletedBy"
    Appointment }o--o| CancellationPolicy : "cancellationPolicy"
    Appointment }o--o| Consultation : "consultation"
    Appointment }o--o| Subscription : "subscription"
    Appointment }o--o| Webinar : "webinar"
    Appointment }o--o| ClassBatch : "class"
    Appointment }o--o| Organization : "organization"
```

- **Deletion is a soft-delete with a named deleter.** `deletedAt` plus `documentsDeleted` on `User` keep the audit trail; `appointment_doc_thread_version_unique` keeps a version number unique inside one thread.
