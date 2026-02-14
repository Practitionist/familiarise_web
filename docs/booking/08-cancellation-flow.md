# Cancellation Flow

This document is the definitive reference for how appointment cancellation works in the Familiarise booking system. It is written for developers who are new to the codebase and need to understand not just _what_ the code does, but _why_ it is structured the way it is. Every design decision documented here was made to solve a specific production problem, and this guide will walk you through each one.

**Source file**: `app/api/appointments/[appointmentId]/cancel/route.ts`

**Endpoint**: `POST /api/appointments/{appointmentId}/cancel`

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Who Can Cancel](#who-can-cancel)
3. [Request and Response Contract](#request-and-response-contract)
4. [The Pre-Transaction Pattern](#the-pre-transaction-pattern)
5. [Step-by-Step Walkthrough: A Concrete Example](#step-by-step-walkthrough-a-concrete-example)
6. [Cancellation by Event Type](#cancellation-by-event-type)
7. [What Happens to Each Record](#what-happens-to-each-record)
8. [The Transaction: Atomic Database Operations](#the-transaction-atomic-database-operations)
9. [Post-Cancellation Cascade](#post-cancellation-cascade)
10. [Error Handling](#error-handling)
11. [Cancellation vs Reschedule Comparison](#cancellation-vs-reschedule-comparison)
12. [Related Documents](#related-documents)

---

## High-Level Overview

Cancellation is one of the most architecturally nuanced flows in the booking system. On the surface it seems simple -- "delete the appointment" -- but in practice it must coordinate across five concerns: database integrity, notification delivery, waitlist management, payment/refund tracking, and audit trail preservation. The cancellation endpoint is designed around three strict principles:

1. **The cancellation itself must never fail because of a side effect.** If notifications fail, if the waitlist system is down, the user still gets a successful cancellation. This is the "fire-and-forget" philosophy.
2. **Data needed after deletion must be extracted before deletion.** Since the appointment record is destroyed inside the transaction, any information needed for notifications or logging must be captured beforehand.
3. **Refunds are never automatic.** The cancellation flow intentionally does not touch payment records. Refunds are a separate admin-initiated process with their own business rules.

Here is the complete decision tree for the cancellation endpoint, from the moment a request arrives to the final response:

```mermaid
flowchart TD
    A["POST /api/appointments/{id}/cancel"] --> B{Session exists?}
    B -->|No| C[401 Unauthorized]
    B -->|Yes| D[Extract appointmentId from URL params]
    D --> E{Request body present?}
    E -->|Yes| F[Parse JSON body]
    F --> G{CancelAppointmentSchema.safeParse}
    G -->|Fail| H[400 Validation Failed + Zod issues]
    G -->|Pass| I[Store validated reason and notes]
    E -->|No or parse error| I2[Continue without reason]
    I --> J[Fetch appointment with all relations]
    I2 --> J
    J --> K{Appointment found?}
    K -->|No| L[404 Appointment not found]
    K -->|Yes| M["Extract notification data\n(user IDs, names, plan title, dateTime)"]
    M --> N[Build cancellationData payload]
    N --> O["Begin $transaction\n(30s timeout, 10s maxWait)"]
    O --> P{Event type?}
    P -->|Consultation| Q["Update Consultation:\nrequestStatus, reason, notes,\ncancelledAt, cancelledBy"]
    P -->|Subscription| R["Update Subscription:\nrequestStatus, reason, notes,\ncancelledAt, cancelledBy"]
    P -->|Webinar| S["Update Webinar:\nstatus = CANCELLED"]
    P -->|Class| T["Update Class:\nstatus = CANCELLED"]
    Q --> U[deleteMany SlotOfAppointment]
    R --> U
    S --> U
    T --> U
    U --> V[delete Appointment]
    V --> W[Commit transaction]
    W --> X["void notifyAppointmentCancelled()\n(fire-and-forget)"]
    X --> Y{Webinar or Class?}
    Y -->|Yes| Z["handleSlotOpening()\n(try/catch wrapped)"]
    Y -->|No| AA[Return 200 success]
    Z --> AA

    style C fill:#f44336,color:#fff
    style H fill:#f44336,color:#fff
    style L fill:#f44336,color:#fff
    style AA fill:#4caf50,color:#fff
    style O fill:#2196f3,color:#fff
    style W fill:#2196f3,color:#fff
```

---

## Who Can Cancel

The current authorization model for cancellation is deliberately simple. Here is what is checked and what is not:

| Check | Performed? | Details |
|-------|-----------|---------|
| Is the user authenticated? | Yes | `getSession()` must return a valid session |
| Is the user the consultant? | No | Not checked |
| Is the user the consultee? | No | Not checked |
| Is the user an admin? | No | Not checked |
| Is the appointment in a cancellable state? | No | Any status can be cancelled |
| Has the event already started? | No | Not checked |

**What this means in practice**: Any authenticated user who knows an appointment ID can cancel it. The system currently relies on the frontend to enforce role-based access (only showing cancel buttons to the relevant parties). The `cancelledBy` field in the audit trail records who performed the cancellation, which can be used for post-hoc accountability.

**Design rationale**: This permissive model was chosen for initial development velocity. The endpoint prioritizes always allowing a cancellation to go through rather than risking a user being locked out of cancelling a booking they need to cancel. Business rules about who _should_ be able to cancel are enforced at the UI layer and can be tightened at the API layer later.

**Implications for developers**:

- Never assume the cancelling user is the consultee. Check `session.user.id` against the consultant and consultee IDs if you need to branch on role.
- The `cancelledBy` field on the event record stores the raw user ID. The notification system compares this against the consultant's user ID to determine whether to label the canceller as `"consultant"` or `"consultee"`.

---

## Request and Response Contract

### Request Body (Optional)

The request body is entirely optional. If omitted, empty, or unparseable as JSON, the cancellation proceeds without a reason. This design means a simple `POST` with no body is a valid cancellation request.

**Schema**: `CancelAppointmentSchema` (defined in `schemas/appointments.ts`)

```typescript
// schemas/appointments.ts
export const CancelAppointmentSchema = z.object({
  reason: CancellationReasonEnum.optional(),
  notes: z.string().optional(),
});
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | `CancellationReason` (enum) | No | Categorized reason for cancellation |
| `notes` | `string` | No | Free-text notes explaining the cancellation |

### CancellationReason Enum

The enum values are organized by who initiates the cancellation. This categorization is used in analytics and notification templates.

Defined in `schemas/enums.ts`:

| Category | Value | Typical Use Case |
|----------|-------|------------------|
| User-initiated | `SCHEDULE_CONFLICT` | The consultee has a conflicting commitment |
| User-initiated | `FOUND_ALTERNATIVE` | The consultee found another consultant |
| User-initiated | `FINANCIAL_REASONS` | The consultee can no longer afford the session |
| User-initiated | `PERSONAL_EMERGENCY` | Unforeseen personal circumstances |
| User-initiated | `NO_LONGER_NEEDED` | The consultee's problem was resolved |
| Consultant-initiated | `CONSULTANT_UNAVAILABLE` | The consultant cannot make the scheduled time |
| Consultant-initiated | `CONSULTANT_EMERGENCY` | The consultant has an emergency |
| System-initiated | `PAYMENT_FAILED` | An automated cancellation due to payment failure |
| System-initiated | `EXPIRED` | An automated cancellation due to expiration |
| Other | `OTHER` | None of the above; use `notes` for details |

### Body Parsing Logic

The body parsing has a subtle but important behavior. Here is how it works line by line:

```
1. Read request body as text
2. If text is empty  --> continue without reason (no error)
3. If text is present --> try JSON.parse
4.   If JSON parse fails --> continue without reason (caught by outer try/catch)
5.   If JSON parse succeeds --> run CancelAppointmentSchema.safeParse
6.     If Zod validation fails --> return 400 with Zod issues
7.     If Zod validation passes --> use validated data
```

The key insight: **only a valid JSON body that fails Zod validation returns an error**. An empty body, a non-JSON body, or a body that fails JSON.parse will all silently proceed without a reason. This is intentional -- it makes the endpoint maximally forgiving for clients that do not need to provide a reason.

### Success Response (200)

```json
{
  "success": true,
  "cancellationReason": "SCHEDULE_CONFLICT",
  "cancelledAt": "2025-06-15T10:30:00.000Z",
  "webinarId": null,
  "classId": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Always `true` on 200 |
| `cancellationReason` | `string \| undefined` | The reason if one was provided |
| `cancelledAt` | `string` (ISO 8601) | Timestamp of when the cancellation was processed |
| `webinarId` | `string \| null` | The webinar ID if this was a webinar cancellation |
| `classId` | `string \| null` | The class ID if this was a class cancellation |

The `webinarId` and `classId` fields are populated only for webinar and class cancellations. They are used internally by the waitlist cascade logic, but they are also included in the client response so the frontend can trigger any UI updates related to the specific event.

### Error Responses

| Status | Cause | Response Body | When It Happens |
|--------|-------|---------------|-----------------|
| 401 | No session / expired session | `{ "error": "Unauthorized" }` | `getSession()` returns null or no user |
| 400 | Zod validation fails on a valid JSON body | `{ "error": "Validation failed", "details": [<ZodIssue[]>] }` | Body is valid JSON but fails schema validation |
| 404 | Appointment not found in database | `{ "error": "Appointment not found" }` | ID does not match any appointment, or already deleted |
| 500 | Transaction failure or unexpected error | `{ "error": "Failed to cancel appointment" }` | Database error, connection timeout, or other |

---

## The Pre-Transaction Pattern

This is the single most important architectural pattern in the cancellation flow. If you understand this, you understand why the code is structured the way it is.

### The Problem

The cancellation endpoint needs to do three things that are in tension with each other:

1. **Fetch the appointment with deep relations** (consultation -> plan -> consultant profile -> user, and similarly for consultee). This is a heavy join across 5-6 tables.
2. **Delete the appointment and its slots atomically** within a database transaction.
3. **Send notifications** with data from the deleted records (user names, plan titles, scheduled time).

The naive approach would be to do all of this inside a single transaction:

```
BEGIN TRANSACTION
  1. Fetch appointment with all relations  <-- Heavy join
  2. Update event status
  3. Delete slots
  4. Delete appointment
  5. Send notification using fetched data
COMMIT
```

This approach fails in production because Prisma's interactive transactions have a default 5-second timeout. Even with the timeout increased to 30 seconds, putting a heavy multi-table join inside a transaction alongside write operations risks hitting the timeout under database contention. The transaction holds locks for the entire duration, increasing the chance of deadlocks with concurrent operations.

### The Solution: Three-Phase Architecture

The cancellation endpoint splits the work into three distinct phases:

```mermaid
flowchart LR
    subgraph Phase1["Phase 1: Pre-Transaction"]
        direction TB
        A["Fetch appointment\nwith ALL relations\n(heavy join, no locks)"] --> B["Extract notification data\n(user IDs, names, plan title,\nscheduled time)"]
    end

    subgraph Phase2["Phase 2: Transaction"]
        direction TB
        C["Update event status"] --> D["Delete slots"]
        D --> E["Delete appointment"]
    end

    subgraph Phase3["Phase 3: Post-Transaction"]
        direction TB
        F["Fire-and-forget:\nnotify both parties"] --> G["Best-effort:\nwaitlist cascade"]
    end

    Phase1 --> Phase2 --> Phase3

    style Phase1 fill:#e3f2fd,stroke:#1565c0
    style Phase2 fill:#fff3e0,stroke:#e65100
    style Phase3 fill:#e8f5e9,stroke:#2e7d32
```

**Phase 1 (Pre-Transaction)**: Run the heavy query with all nested includes _outside_ the transaction. This query does not hold any locks. Extract all the data needed for notifications into local variables, because these records will be deleted in Phase 2.

**Phase 2 (Transaction)**: The transaction contains only fast write operations -- three simple queries (update, deleteMany, delete) on indexed primary keys. No joins, no nested includes. This keeps the transaction fast and reduces lock contention.

**Phase 3 (Post-Transaction)**: Notifications and waitlist operations happen after the transaction has committed. They use the data extracted in Phase 1. Both are fault-tolerant: notifications use `void` (fire-and-forget), and the waitlist cascade is wrapped in try/catch.

### What Would Happen Without This Pattern

```mermaid
sequenceDiagram
    participant App as API Handler
    participant DB as Database
    participant Lock as DB Locks

    Note over App,Lock: WITHOUT Pre-Transaction Pattern
    App->>DB: BEGIN TRANSACTION
    activate Lock
    Note over Lock: Locks acquired on appointment row
    App->>DB: Heavy JOIN query (5+ tables)
    Note over DB: 2-5 seconds under load
    App->>DB: UPDATE event
    App->>DB: DELETE slots
    App->>DB: DELETE appointment
    App->>DB: COMMIT
    deactivate Lock
    Note over Lock: Locks held for entire 3-7 seconds

    Note over App,Lock: WITH Pre-Transaction Pattern
    App->>DB: Heavy JOIN query (no transaction)
    Note over DB: 2-5 seconds, NO locks
    App->>DB: BEGIN TRANSACTION
    activate Lock
    Note over Lock: Locks acquired
    App->>DB: UPDATE event (fast, indexed)
    App->>DB: DELETE slots (fast, indexed)
    App->>DB: DELETE appointment (fast, indexed)
    App->>DB: COMMIT
    deactivate Lock
    Note over Lock: Locks held for ~100ms
```

The difference is dramatic: locks are held for 3-7 seconds in the naive approach versus roughly 100 milliseconds with the pre-transaction pattern. Under concurrent load, this is the difference between a responsive system and cascading timeouts.

---

## Step-by-Step Walkthrough: A Concrete Example

Let us trace through a complete cancellation to see exactly what happens at each step. Consider this scenario:

> **Alice** (consultee) cancels her 2-hour consultation with **Bob** (consultant), which was scheduled for next Tuesday at 10:00 AM IST. The consultation uses Bob's "Career Strategy Session" plan. Alice cancels because of a schedule conflict.

### Database State Before Cancellation

```mermaid
erDiagram
    APPOINTMENT {
        string id "appt_abc123"
        string appointmentType "CONSULTATION"
        string consultationId "cons_xyz789"
        string subscriptionId "null"
        string webinarId "null"
        string classId "null"
    }

    CONSULTATION {
        string id "cons_xyz789"
        string requestStatus "APPROVED"
        string consultationPlanId "plan_456"
        string requestedById "profile_alice"
        string cancellationReason "null"
        string cancellationNotes "null"
        datetime cancelledAt "null"
        string cancelledBy "null"
    }

    CONSULTATION_PLAN {
        string id "plan_456"
        string title "Career Strategy Session"
        string consultantProfileId "profile_bob"
    }

    SLOT_OF_APPOINTMENT {
        string id "slot_001"
        string appointmentId "appt_abc123"
        datetime startsAt "2025-06-17T10:00:00Z"
        datetime endsAt "2025-06-17T12:00:00Z"
    }

    CONSULTEE_PROFILE {
        string id "profile_alice"
        string userId "user_alice"
    }

    CONSULTANT_PROFILE {
        string id "profile_bob"
        string userId "user_bob"
    }

    USER_ALICE {
        string id "user_alice"
        string name "Alice Johnson"
    }

    USER_BOB {
        string id "user_bob"
        string name "Bob Smith"
    }

    APPOINTMENT ||--|| CONSULTATION : "belongs to"
    APPOINTMENT ||--|{ SLOT_OF_APPOINTMENT : "has"
    CONSULTATION ||--|| CONSULTATION_PLAN : "uses"
    CONSULTATION ||--|| CONSULTEE_PROFILE : "requestedBy"
    CONSULTATION_PLAN ||--|| CONSULTANT_PROFILE : "offered by"
    CONSULTEE_PROFILE ||--|| USER_ALICE : "is"
    CONSULTANT_PROFILE ||--|| USER_BOB : "is"
```

### Step 1: Authentication (Lines 14-17)

Alice's browser sends:

```http
POST /api/appointments/appt_abc123/cancel
Content-Type: application/json
Cookie: session=...

{"reason": "SCHEDULE_CONFLICT", "notes": "Have a work meeting that day"}
```

The server calls `getSession()`, which validates Alice's session cookie and returns:

```json
{ "user": { "id": "user_alice", "name": "Alice Johnson" } }
```

Session is valid. Proceed.

### Step 2: Body Parsing and Validation (Lines 21-38)

1. `request.text()` returns `'{"reason": "SCHEDULE_CONFLICT", "notes": "Have a work meeting that day"}'`
2. `JSON.parse()` succeeds, producing a plain object.
3. `CancelAppointmentSchema.safeParse()` validates:
   - `reason`: `"SCHEDULE_CONFLICT"` -- valid enum value
   - `notes`: `"Have a work meeting that day"` -- valid string
4. `validatedData` is set to `{ reason: "SCHEDULE_CONFLICT", notes: "Have a work meeting that day" }`

### Step 3: Pre-Transaction Fetch (Lines 40-76)

The heavy query runs outside any transaction:

```sql
-- Conceptual SQL (Prisma generates this)
SELECT appointment.*,
       consultation.*,
       consultation_plan.*,
       consultant_profile.*,
       consultant_user.id, consultant_user.name,
       consultee_profile.*,
       consultee_user.id, consultee_user.name,
       slots.*
FROM "Appointment" appointment
LEFT JOIN "Consultation" consultation ON ...
LEFT JOIN "ConsultationPlan" consultation_plan ON ...
LEFT JOIN "ConsultantProfile" consultant_profile ON ...
LEFT JOIN "User" consultant_user ON ...
LEFT JOIN "ConsulteeProfile" consultee_profile ON ...
LEFT JOIN "User" consultee_user ON ...
LEFT JOIN "SlotOfAppointment" slots ON ... LIMIT 1
WHERE appointment.id = 'appt_abc123'
```

This query joins across 7 tables. It returns the full appointment tree.

### Step 4: Pre-Transaction Data Extraction (Lines 85-115)

Before the appointment is deleted, we extract everything needed for notifications:

| Variable | Extracted Value | Source Path |
|----------|----------------|-------------|
| `consultantUserId` | `"user_bob"` | `appointment.consultation.consultationPlan.consultantProfile.user.id` |
| `consulteeUserId` | `"user_alice"` | `appointment.consultation.requestedBy.user.id` |
| `consultantName` | `"Bob Smith"` | `appointment.consultation.consultationPlan.consultantProfile.user.name` |
| `consulteeName` | `"Alice Johnson"` | `appointment.consultation.requestedBy.user.name` |
| `planTitle` | `"Career Strategy Session"` | `appointment.consultation.consultationPlan.title` |
| `appointmentType` | `"CONSULTATION"` | `appointment.appointmentType` |
| `dateTime` | `"2025-06-17T10:00:00.000Z"` | `appointment.slotsOfAppointment[0].startsAt` |

**Why this matters**: After Step 5, the appointment record and its slots no longer exist. If we tried to read these values after the transaction, we would get `null` for everything.

### Step 5: Build Cancellation Payload (Lines 118-124)

```typescript
const cancellationData = {
  requestStatus: "CANCELLED",
  cancellationReason: "SCHEDULE_CONFLICT",  // from validatedData
  cancellationNotes: "Have a work meeting that day",  // from validatedData
  cancelledAt: new Date(),  // 2025-06-15T10:30:00.000Z
  cancelledBy: "user_alice",  // from session
};
```

### Step 6: Transaction (Lines 126-174)

Three operations execute atomically within a 30-second timeout:

**Operation 1** -- Update the consultation record:

```sql
UPDATE "Consultation"
SET "requestStatus" = 'CANCELLED',
    "cancellationReason" = 'SCHEDULE_CONFLICT',
    "cancellationNotes" = 'Have a work meeting that day',
    "cancelledAt" = '2025-06-15T10:30:00.000Z',
    "cancelledBy" = 'user_alice'
WHERE id = 'cons_xyz789'
```

**Operation 2** -- Delete all slot records for this appointment:

```sql
DELETE FROM "SlotOfAppointment"
WHERE "appointmentId" = 'appt_abc123'
```

**Operation 3** -- Delete the appointment record:

```sql
DELETE FROM "Appointment"
WHERE id = 'appt_abc123'
```

If any of these three operations fails, the entire transaction rolls back. The consultation stays `APPROVED`, the slots remain, and the appointment is untouched.

### Step 7: Fire-and-Forget Notification (Lines 176-207)

After the transaction commits, the notification fires using the data extracted in Step 4:

```typescript
void notifyAppointmentCancelled(
  ["user_bob", "user_alice"],  // Both parties receive notification
  {
    appointmentType: "CONSULTATION",
    consultantName: "Bob Smith",
    consulteeName: "Alice Johnson",
    planTitle: "Career Strategy Session",
    dateTime: "2025-06-17T10:00:00.000Z",
    dashboardUrl: "/dashboard",
    reason: "SCHEDULE_CONFLICT",
    cancelledBy: "consultee",  // Because user_alice !== user_bob (consultant)
  }
);
```

The `void` keyword is critical here. It means "call this function but do not await it." The API response is sent to Alice immediately without waiting for Novu to deliver the notification. If Novu is down or slow, Alice still gets her 200 OK.

### Step 8: Waitlist Check (Lines 209-234)

For this consultation, `result.webinarId` and `result.classId` are both `null`, so the waitlist cascade is skipped entirely. This logic only runs for webinar and class cancellations.

### Step 9: Response

Alice receives:

```json
{
  "success": true,
  "cancellationReason": "SCHEDULE_CONFLICT",
  "cancelledAt": "2025-06-15T10:30:00.000Z",
  "webinarId": null,
  "classId": null
}
```

### Database State After Cancellation

```mermaid
erDiagram
    CONSULTATION {
        string id "cons_xyz789"
        string requestStatus "CANCELLED"
        string consultationPlanId "plan_456"
        string requestedById "profile_alice"
        string cancellationReason "SCHEDULE_CONFLICT"
        string cancellationNotes "Have a work meeting..."
        datetime cancelledAt "2025-06-15T10:30:00Z"
        string cancelledBy "user_alice"
    }

    CONSULTATION_PLAN {
        string id "plan_456"
        string title "Career Strategy Session"
        string consultantProfileId "profile_bob"
    }

    CONSULTEE_PROFILE {
        string id "profile_alice"
        string userId "user_alice"
    }

    CONSULTANT_PROFILE {
        string id "profile_bob"
        string userId "user_bob"
    }

    CONSULTATION ||--|| CONSULTATION_PLAN : "uses"
    CONSULTATION ||--|| CONSULTEE_PROFILE : "requestedBy"
    CONSULTATION_PLAN ||--|| CONSULTANT_PROFILE : "offered by"
```

Notice what is gone:
- The `Appointment` record -- **deleted**
- The `SlotOfAppointment` record -- **deleted**

Notice what remains:
- The `Consultation` record -- **preserved** with `CANCELLED` status and full audit trail
- The `ConsultationPlan`, profiles, and users -- **untouched**
- Any `Payment` records -- **completely untouched** (refund is a separate process)

---

## Cancellation by Event Type

The system supports four event types, and they do not all behave the same way during cancellation. The differences are significant and worth understanding.

### Branching Logic Flowchart

```mermaid
flowchart TD
    A["Appointment fetched\nwith all relations"] --> B{Which relation is non-null?}

    B -->|"appointment.consultation"| C["CONSULTATION path"]
    B -->|"appointment.subscription"| D["SUBSCRIPTION path"]
    B -->|"appointment.webinar"| E["WEBINAR path"]
    B -->|"appointment.class"| F["CLASS path"]

    subgraph Consultation["Consultation / Subscription"]
        direction TB
        C --> C1["Update with full cancellationData:\n- requestStatus = CANCELLED\n- cancellationReason\n- cancellationNotes\n- cancelledAt\n- cancelledBy"]
        D --> D1["Update with full cancellationData:\n(same 5 fields as Consultation)"]
    end

    subgraph GroupEvent["Webinar / Class"]
        direction TB
        E --> E1["Update with only:\n- status = CANCELLED"]
        F --> F1["Update with only:\n- status = CANCELLED"]
    end

    C1 --> G["Delete slots + appointment"]
    D1 --> G
    E1 --> G
    F1 --> G

    G --> H{Post-transaction}
    H --> I["Notifications\n(all types)"]
    H --> J{Webinar or Class?}
    J -->|Yes| K["Waitlist cascade\nhandleSlotOpening()"]
    J -->|No| L["No waitlist action"]

    style Consultation fill:#e3f2fd,stroke:#1565c0
    style GroupEvent fill:#fff3e0,stroke:#e65100
```

### Comparison Table: All Four Event Types

| Aspect | Consultation | Subscription | Webinar | Class |
|--------|-------------|--------------|---------|-------|
| **Model updated** | `Consultation` | `Subscription` | `Webinar` | `Class` |
| **Status field** | `requestStatus` | `requestStatus` | `status` | `status` |
| **Audit fields stored** | Yes (5 fields) | Yes (5 fields) | No | No |
| **Cancellation reason on model** | Yes | Yes | No | No |
| **Cancelled-by tracking** | Yes | Yes | No | No |
| **Waitlist cascade** | No | No | Yes | Yes |
| **Notification sent** | Yes | Yes | Yes | Yes |
| **Slots deleted** | Yes | Yes | Yes | Yes |
| **Appointment deleted** | Yes | Yes | Yes | Yes |

### Consultation Cancellation (Detailed)

Consultations are one-to-one sessions between a consultant and a consultee. They have the richest cancellation data because they involve a direct relationship between two parties where accountability matters.

**What gets written to the database**:

```typescript
await tx.consultation.update({
  where: { id: appointment.consultation.id },
  data: {
    requestStatus: "CANCELLED",
    cancellationReason: validatedData.reason || null,   // e.g. "SCHEDULE_CONFLICT"
    cancellationNotes: validatedData.notes || null,      // e.g. "Have a work meeting"
    cancelledAt: new Date(),                             // Precise timestamp
    cancelledBy: session.user.id,                        // Who initiated
  },
});
```

**Why audit fields exist**: Consultations often involve payment disputes. When a consultee asks for a refund, the admin needs to know who cancelled, when they cancelled, and why. This audit trail is essential for the refund decision process.

**No waitlist cascade**: Consultations are 1:1. There is no concept of a "next person waiting" for a consultation slot.

### Subscription Cancellation (Detailed)

Subscriptions are recurring consultation sessions (e.g., "4 sessions per month with Bob"). They behave identically to consultations for cancellation purposes.

**What gets written to the database**: Exactly the same five fields as a consultation. The `Subscription` model has the same audit columns.

**Design note**: The fact that consultation and subscription cancellations are identical in structure is intentional. Both represent a committed agreement between two parties, so both require the same level of accountability and audit trail.

### Webinar Cancellation (Detailed)

Webinars are one-to-many events (one consultant, many attendees). Their cancellation is simpler because the business model is different.

**What gets written to the database**:

```typescript
await tx.webinar.update({
  where: { id: appointment.webinar.id },
  data: { status: "CANCELLED" },
});
```

**Why no audit fields**: Webinars are typically cancelled by the consultant (the host). Since webinars are group events, the system does not track individual cancellation reasons on the event model. The `status` change is sufficient for the event lifecycle. If audit data is needed, it can be reconstructed from the API logs and the `cancelledBy` information in the notification payload.

**Waitlist cascade triggers**: When a webinar is cancelled, `handleSlotOpening()` is called with `slotsAvailable: 1`. This notifies the first person in the waitlist queue that a spot has opened up.

### Class Cancellation (Detailed)

Classes are multi-session group events (e.g., "6-week Python bootcamp"). They behave identically to webinars for cancellation purposes.

**What gets written to the database**: Only `status: "CANCELLED"`, same as webinar.

**Waitlist cascade**: Same as webinar -- `handleSlotOpening()` is called.

### State Transition Diagram

```mermaid
stateDiagram-v2
    state "Consultation / Subscription" as CS {
        [*] --> PENDING: Created
        PENDING --> APPROVED: Approved
        APPROVED --> CANCELLED: Cancelled
        PENDING --> CANCELLED: Cancelled
        PENDING --> REJECTED: Rejected

        state CANCELLED {
            state "Audit Trail" as AT
            AT: requestStatus = CANCELLED
            AT: cancellationReason = enum value
            AT: cancellationNotes = text
            AT: cancelledAt = timestamp
            AT: cancelledBy = userId
        }
    }

    state "Webinar / Class" as WC {
        [*] --> DRAFT: Created
        DRAFT --> PUBLISHED: Published
        PUBLISHED --> CANCELLED_WC: Cancelled

        state CANCELLED_WC {
            state "Minimal State" as MS
            MS: status = CANCELLED
            MS: (no audit fields)
        }
    }
```

---

## What Happens to Each Record

This section provides a comprehensive before-and-after view of every database record affected by a cancellation.

### Data Cascade Diagram

```mermaid
flowchart TD
    subgraph BEFORE["BEFORE Cancellation"]
        direction TB
        A1["Appointment\n(appt_abc123)\nExists"] --- B1["SlotOfAppointment\n(1 or more slots)\nExists"]
        A1 --- C1["Event Record\n(Consultation/Subscription/\nWebinar/Class)\nActive status"]
        D1["Payment Records\nExists, various statuses"] --- A1
        E1["Waitlist Entries\n(Webinar/Class only)\nWAITING status"]
    end

    subgraph TRANSACTION["TRANSACTION"]
        direction TB
        T1["1. UPDATE Event Record\n   set status to CANCELLED\n   (+audit fields if applicable)"]
        T2["2. DELETE all SlotOfAppointment\n   for this appointmentId"]
        T3["3. DELETE Appointment record"]
        T1 --> T2 --> T3
    end

    subgraph AFTER["AFTER Cancellation"]
        direction TB
        A2["Appointment\nDELETED"] --- B2["SlotOfAppointment\nDELETED"]
        C2["Event Record\nstatus = CANCELLED\n(preserved for audit)"]
        D2["Payment Records\nUNTOUCHED\n(refund is separate)"]
        E2["Waitlist Entries\nNOTIFIED\n(next in queue promoted)"]
    end

    BEFORE --> TRANSACTION --> AFTER

    style A2 fill:#f44336,color:#fff
    style B2 fill:#f44336,color:#fff
    style C2 fill:#ff9800,color:#fff
    style D2 fill:#4caf50,color:#fff
    style E2 fill:#2196f3,color:#fff
    style TRANSACTION fill:#fff3e0,stroke:#e65100
```

### Record-by-Record Breakdown

| Record | Before | After | Why |
|--------|--------|-------|-----|
| `Appointment` | Exists with type and foreign keys | **Deleted** | The appointment no longer represents a scheduled event |
| `SlotOfAppointment` (all) | Exist with start/end times | **Deleted** | Time slots are meaningless without the appointment |
| `Consultation` (if applicable) | `requestStatus = "APPROVED"` | `requestStatus = "CANCELLED"` + audit fields | Preserved for refund decisions and analytics |
| `Subscription` (if applicable) | `requestStatus = "APPROVED"` | `requestStatus = "CANCELLED"` + audit fields | Same reasoning as consultation |
| `Webinar` (if applicable) | `status = "PUBLISHED"` | `status = "CANCELLED"` | Preserved but with minimal state change |
| `Class` (if applicable) | `status = "PUBLISHED"` | `status = "CANCELLED"` | Same reasoning as webinar |
| `Payment` / `PaymentOrder` | Various statuses | **Untouched** | Refund is a deliberate admin action, not automatic |
| `Earning` / `PayoutItem` | May exist if payment was captured | **Untouched** | Earnings reversal is handled by the refund flow |
| `Waitlist` entries | `WAITING` for others | Top entry moves to `NOTIFIED` | Only for webinar/class; the freed spot is offered to the next person |

### Why the Event Record is Preserved

A common question from new developers: "If we delete the appointment, why not delete the consultation/webinar too?"

The event record (consultation, subscription, webinar, or class) is intentionally preserved for several reasons:

1. **Refund processing**: An admin reviewing a refund request needs to see the cancelled event, when it was cancelled, by whom, and why. If the record were deleted, this information would be lost.
2. **Analytics**: Business intelligence queries count cancellation rates, reasons, and patterns. Deleted records cannot be counted.
3. **Dispute resolution**: If a consultee disputes a charge, the cancelled event record is evidence of what happened.
4. **Consultant dashboards**: Consultants may want to see their cancellation history.

The appointment record, on the other hand, is deleted because it represents a "scheduled event in time." Once cancelled, there is nothing scheduled, so the appointment has no ongoing purpose. The event record represents the "agreement to have a session," which retains value even after cancellation.

---

## The Transaction: Atomic Database Operations

### Transaction Configuration

```typescript
const result = await prisma.$transaction(
  async (tx) => { /* ... */ },
  {
    maxWait: 10000,  // 10 seconds: max time waiting for a DB connection from the pool
    timeout: 30000,  // 30 seconds: max duration of the transaction itself
  }
);
```

| Parameter | Value | Default | Why It Is Changed |
|-----------|-------|---------|-------------------|
| `maxWait` | 10,000 ms | 2,000 ms | Under high load, the connection pool can be saturated. 10 seconds gives more time to acquire a connection before failing. |
| `timeout` | 30,000 ms | 5,000 ms | Although the transaction only runs fast indexed writes, the increased timeout provides safety margin under extreme database contention. |

### Operation Order Within the Transaction

The three operations inside the transaction execute in a specific order that matters:

```mermaid
sequenceDiagram
    participant TX as Transaction
    participant EventTable as Event Table<br/>(Consultation/Subscription/Webinar/Class)
    participant SlotTable as SlotOfAppointment Table
    participant ApptTable as Appointment Table

    TX->>EventTable: 1. UPDATE status to CANCELLED<br/>(+ audit fields if applicable)
    Note over EventTable: Event record stays,<br/>just changes status

    TX->>SlotTable: 2. DELETE all slots<br/>WHERE appointmentId = ?
    Note over SlotTable: Explicit deletion,<br/>not relying on cascade

    TX->>ApptTable: 3. DELETE appointment<br/>WHERE id = ?
    Note over ApptTable: Parent record deleted<br/>after children
```

**Why slots are deleted before the appointment**: The `SlotOfAppointment` table has a foreign key to `Appointment`. If we deleted the appointment first and relied on Prisma's cascade configuration to clean up slots, we would be depending on cascade behavior that may vary across database providers and Prisma versions. By explicitly deleting slots first, we ensure deterministic ordering: children are removed before the parent, regardless of cascade configuration.

**Why the event is updated before anything is deleted**: The event record (consultation, subscription, etc.) has its own ID independent of the appointment. It does not need to be deleted, only updated. Updating it first ensures that even if the subsequent deletes fail (causing a rollback), the intended status change is part of the same atomic unit.

### Atomicity Guarantee

If any of the three operations fails:
- The event record reverts to its previous status
- The slot records are restored
- The appointment record is restored

The user receives a 500 error, and the system state is as if the cancellation never happened.

---

## Post-Cancellation Cascade

After the transaction commits successfully, two post-transaction effects may fire. Both are designed to be fault-tolerant: neither can cause the cancellation to "fail" from the user's perspective, because the transaction has already committed.

### Notification Delivery

```mermaid
sequenceDiagram
    participant API as Cancel API
    participant Novu as Novu Service
    participant Bob as Bob (Consultant)
    participant Alice as Alice (Consultee)

    Note over API: Transaction committed successfully

    API--)Novu: void notifyAppointmentCancelled()<br/>(fire-and-forget, not awaited)
    Note over API: API continues immediately<br/>to build response

    API-->>Alice: 200 OK (success: true)
    Note over API: Response sent BEFORE<br/>notification is delivered

    Novu->>Bob: Cancellation notification<br/>(email/in-app/push)
    Novu->>Alice: Cancellation notification<br/>(email/in-app/push)
```

**Mechanism**: Novu (`lib/novu.ts` -> `notifyAppointmentCancelled`)

**Who receives notifications**: Both the consultant and the consultee. The user IDs are collected into an array and filtered to remove any `undefined` values (which can happen if relations are broken or missing):

```typescript
const userIds = [
  notificationMeta.consultantUserId,
  notificationMeta.consulteeUserId,
].filter((id): id is string => !!id);
```

For webinars and classes where consultant/consultee relationships are not directly stored on the event model, the `userIds` array may be empty, in which case no notification is sent.

**Notification payload**:

| Field | Value | Source |
|-------|-------|--------|
| `appointmentType` | `"CONSULTATION"`, `"SUBSCRIPTION"`, `"WEBINAR"`, or `"CLASS"` | `appointment.appointmentType` |
| `consultantName` | e.g., `"Bob Smith"` or `"Consultant"` (fallback) | Extracted in Phase 1, with fallback |
| `consulteeName` | e.g., `"Alice Johnson"` or `"Consultee"` (fallback) | Extracted in Phase 1, with fallback |
| `planTitle` | e.g., `"Career Strategy Session"` or `"N/A"` (fallback) | From consultation/subscription plan |
| `dateTime` | ISO 8601 string or `undefined` | `slotsOfAppointment[0].startsAt` |
| `dashboardUrl` | `"/dashboard"` | Hardcoded |
| `reason` | e.g., `"SCHEDULE_CONFLICT"` or `undefined` | From validated body |
| `cancelledBy` | `"consultant"` or `"consultee"` | Derived by comparing `session.user.id` to `consultantUserId` |

**Why fire-and-forget**: The notification is a courtesy, not a critical operation. If Novu is down for 5 minutes, the cancellation should still succeed. The user can always check their dashboard. Making the notification blocking would mean a Novu outage causes cancellation failures, which would be unacceptable.

### Waitlist Cascade (Webinar and Class Only)

When a webinar or class appointment is cancelled, a spot opens up. The system automatically notifies the next person on the waitlist.

```mermaid
sequenceDiagram
    participant API as Cancel API
    participant SH as Slot Handler
    participant QM as Queue Manager<br/>(getNextInQueue)
    participant DB as Database
    participant Email as Email Service

    Note over API: Transaction committed,<br/>webinarId or classId is non-null

    API->>SH: handleSlotOpening with webinarId, slotsAvailable=1, reason=cancellation

    SH->>QM: getNextInQueue(webinarId)
    QM->>DB: Find first WAITING entry<br/>ordered by priority + joinedAt
    DB-->>QM: Waitlist entry (or null)

    alt No one waiting
        QM-->>SH: null
        Note over SH: Break loop,<br/>no one to notify
    else Someone is waiting
        QM-->>SH: (id, userId, user.email, ...)
        SH->>DB: UPDATE waitlist entry<br/>status = NOTIFIED<br/>notifiedAt = now<br/>expiresAt = now + 48h<br/>position = null
        SH->>Email: sendWaitlistSpotAvailableEmail(<br/>  email, name, eventTitle,<br/>  eventType, scheduledDate,<br/>  expiresAt, waitlistId<br/>)
        Email-->>SH: Sent
        SH->>DB: updatePositions()<br/>(recalculate remaining queue)
    end

    SH-->>API: notified: 1, errors: none
    Note over API: Log success,<br/>return 200 to client
```

**Key details about the waitlist cascade**:

1. **48-hour response window**: When notified, a user has 48 hours to accept the spot before it expires and is offered to the next person.
2. **Position clearing**: The notified user's `position` is set to `null` because they are no longer "in the queue" -- they are in a separate "offered" state.
3. **Queue reordering**: After notifying a user, `updatePositions()` recalculates position numbers for everyone still waiting.
4. **Best-effort guarantee**: The entire waitlist cascade is wrapped in try/catch:

```typescript
try {
  await handleSlotOpening({ ... });
  console.log(JSON.stringify({ event: "waitlist_notified_after_cancellation", ... }));
} catch (waitlistError) {
  console.error("Failed to notify waitlist after cancellation:", waitlistError);
}
```

If the waitlist system fails (database error, email service down, etc.), the error is logged but the cancellation response still returns 200 OK. The spot is still technically open; it just was not offered to anyone. An admin can manually trigger waitlist notifications later.

### Refund and Earnings

**Refunds are NOT automatic.** This is a critical design decision that new developers must understand.

When an appointment is cancelled:
- Payment records (`Payment`, `PaymentOrder`) are **not modified**.
- Earning records (`Earning`, `PayoutItem`) are **not modified**.
- No refund is initiated.
- No payout is reversed.

**Why refunds are decoupled from cancellation**:

1. **Business flexibility**: Different cancellation scenarios require different refund policies. A cancellation due to `CONSULTANT_EMERGENCY` might warrant a full refund. A last-minute `SCHEDULE_CONFLICT` might warrant a partial refund or no refund. These decisions require human judgment.
2. **Payment gateway complexity**: Refunds through Razorpay/Stripe are asynchronous operations with their own failure modes. Coupling them to the cancellation transaction would make the entire flow fragile.
3. **Accounting requirements**: Refunds must be tracked separately for tax compliance and financial reporting. They are not simply "undoing" a payment.

The refund flow is documented separately. After a cancellation, an admin reviews the case and initiates a refund if warranted.

**Cross-reference**: [Cancellation Payment Flow](../payments/cancellations-rescheduling/01-cancellation-payment-flow.md)

---

## Error Handling

The cancellation endpoint has five distinct failure points, each handled differently. Understanding these is essential for debugging production issues.

```mermaid
flowchart TD
    A[Request arrives] --> B{"getSession()"}
    B -->|null / no user| E1["401 Unauthorized\n\nSession cookie missing,\nexpired, or invalid"]
    B -->|valid session| C{"Body parsing"}

    C -->|Valid JSON + Zod fails| E2["400 Validation Failed\n+ Zod issues array\n\nBody was valid JSON but\nfailed schema validation"]
    C -->|Empty / invalid JSON / Zod passes| D[findUnique]

    D -->|null| E3["404 Appointment not found\n\nID does not match any\nappointment in database"]
    D -->|found| F["$transaction()"]

    F -->|throws| E4["500 Failed to cancel\n\nDatabase error, timeout,\ndeadlock, or connection\npool exhaustion"]
    F -->|commits| G[Post-transaction effects]

    G --> H["Notification failure?\nLogged, NOT blocking\nResponse already 200"]
    G --> I["Waitlist failure?\nLogged, NOT blocking\nResponse already 200"]

    F -->|commits| J["200 OK\n(success: true)"]

    style E1 fill:#f44336,color:#fff
    style E2 fill:#f44336,color:#fff
    style E3 fill:#f44336,color:#fff
    style E4 fill:#f44336,color:#fff
    style J fill:#4caf50,color:#fff
    style H fill:#ff9800,color:#000
    style I fill:#ff9800,color:#000
```

### Error Details

#### 401 Unauthorized

**When**: `getSession()` returns `null` or a session without a `user` property.

**Common causes**: Expired session cookie, missing auth header, server-side session store is down.

**Response**:
```json
{ "error": "Unauthorized" }
```

**Developer notes**: This is the very first check. No database queries run before this, so a 401 has minimal server impact.

#### 400 Validation Failed

**When**: The request body is valid JSON that fails `CancelAppointmentSchema.safeParse()`.

**Common causes**: Invalid enum value for `reason` (e.g., `"BORED"`), wrong field types.

**Response**:
```json
{
  "error": "Validation failed",
  "details": [
    {
      "code": "invalid_enum_value",
      "message": "Invalid enum value. Expected 'SCHEDULE_CONFLICT' | 'FOUND_ALTERNATIVE' | ...",
      "path": ["reason"]
    }
  ]
}
```

**Important subtlety**: An empty body or a non-JSON body does NOT trigger a 400. Only a valid JSON body that fails Zod validation returns 400. This is because the body is optional, and the try/catch around `JSON.parse()` silently catches parse failures.

#### 404 Appointment Not Found

**When**: `prisma.appointment.findUnique()` returns `null`.

**Common causes**: The appointment ID is wrong, the appointment was already cancelled (and thus already deleted), or there is a typo in the URL.

**Response**:
```json
{ "error": "Appointment not found" }
```

**Developer notes**: This also catches the case where a user tries to cancel the same appointment twice. Since the first cancellation deletes the appointment record, the second attempt gets a 404.

#### 500 Failed to Cancel Appointment

**When**: The `$transaction()` throws an error, or any other unexpected error occurs.

**Common causes**: Database connection timeout, deadlock with another concurrent operation, Prisma client error.

**Response**:
```json
{ "error": "Failed to cancel appointment" }
```

**Developer notes**: When this happens, the transaction has rolled back. The appointment and all its data are still intact. The user can safely retry.

#### Post-Transaction Failures (Non-Blocking)

**Notification failure**: If `notifyAppointmentCancelled` throws, the error is silently swallowed because of the `void` prefix. The function runs as an unhandled promise, but since it uses Novu's client (which has its own error handling), unhandled rejections are rare. The cancellation response has already been sent.

**Waitlist failure**: If `handleSlotOpening` throws, the error is caught and logged:
```
Failed to notify waitlist after cancellation: [error details]
```
The cancellation response still returns 200. The waitlist spot remains unclaimed until an admin intervenes or the next cancellation triggers another cascade.

---

## Cancellation vs Reschedule Comparison

Developers frequently ask: "What is the difference between cancelling and rescheduling?" The two flows share some code but differ in fundamental ways.

### Side-by-Side Comparison

| Aspect | Cancellation | Reschedule |
|--------|-------------|------------|
| **Intent** | End the booking entirely | Move the booking to a different time |
| **Appointment record** | Deleted | Preserved (slots are swapped) |
| **Event record** | Status set to `CANCELLED` | Status unchanged (remains `APPROVED`) |
| **Slot records** | Deleted | Old slots deleted, new slots created |
| **Payment** | Untouched (refund is separate) | Untouched (no additional charge) |
| **Refund triggered** | No (manual admin action) | No |
| **Notifications** | "Your appointment was cancelled" | "Your appointment was rescheduled" |
| **Waitlist cascade** | Yes (webinar/class) | No (slot count unchanged) |
| **Audit fields written** | Yes (consultation/subscription) | Different fields (rescheduled timestamp) |
| **Can happen after event start** | Not checked (no guard) | Typically blocked by validation |
| **Reversible** | No (must rebook from scratch) | Yes (can reschedule again) |

### Decision Guide: When to Cancel vs Reschedule

```mermaid
flowchart TD
    A["User wants to change\ntheir booking"] --> B{"Do they still want\nto have the session?"}
    B -->|"No, done entirely"| C["CANCEL"]
    B -->|"Yes, just different time"| D{"Is there a suitable\nalternative slot?"}
    D -->|Yes| E["RESCHEDULE"]
    D -->|"No available slots"| F{"Will slots open up\nin the future?"}
    F -->|"Maybe / Yes"| G["CANCEL + rebook later"]
    F -->|"No, consultant is\nfully booked"| H["CANCEL"]

    style C fill:#f44336,color:#fff
    style H fill:#f44336,color:#fff
    style G fill:#ff9800,color:#000
    style E fill:#4caf50,color:#fff
```

### What Happens to Slots in Each Case

```mermaid
flowchart LR
    subgraph Cancel["Cancellation"]
        direction TB
        CA["Slot: Tue 10:00-12:00"] -->|"Deleted"| CB["(nothing)\nSlot is gone"]
    end

    subgraph Reschedule["Reschedule"]
        direction TB
        RA["Slot: Tue 10:00-12:00"] -->|"Deleted"| RB["Slot: Thu 14:00-16:00"]
        RB -.->|"Created"| RC["New slot takes its place"]
    end

    style CB fill:#f44336,color:#fff
    style RB fill:#4caf50,color:#fff
```

---

## End-to-End Sequence Diagram

This diagram shows every actor and every interaction in a complete cancellation flow, including the post-transaction effects.

```mermaid
sequenceDiagram
    actor User as Cancelling User
    participant Client as Browser / App
    participant API as POST /cancel
    participant Auth as Auth Session
    participant Zod as Zod Validator
    participant DB as Prisma / PostgreSQL
    participant Novu as Novu Notifications
    participant WL as Waitlist System
    participant Email as Email Service

    User->>Client: Click "Cancel Appointment"
    Client->>API: POST /api/appointments/id/cancel with reason and notes

    rect rgb(240, 248, 255)
        Note over API,Auth: Phase 0: Authentication
        API->>Auth: getSession()
        Auth-->>API: (user: id, name)
    end

    rect rgb(240, 248, 255)
        Note over API,Zod: Phase 0: Validation
        API->>Zod: CancelAppointmentSchema.safeParse(body)
        Zod-->>API: success: true, data: (reason, notes)
    end

    rect rgb(227, 242, 253)
        Note over API,DB: Phase 1: Pre-Transaction Fetch
        API->>DB: findUnique(appointmentId) with all relations
        DB-->>API: Full appointment tree
        Note over API: Extract into local variables:<br/>consultantUserId, consulteeUserId,<br/>consultantName, consulteeName,<br/>planTitle, appointmentType, dateTime
    end

    rect rgb(255, 243, 224)
        Note over API,DB: Phase 2: Transaction (30s timeout)
        API->>DB: BEGIN TRANSACTION
        API->>DB: UPDATE consultation/subscription/webinar/class<br/>SET status = CANCELLED (+ audit fields)
        API->>DB: DELETE FROM SlotOfAppointment<br/>WHERE appointmentId = ?
        API->>DB: DELETE FROM Appointment<br/>WHERE id = ?
        DB-->>API: COMMIT<br/>(success, cancellationReason,<br/>cancelledAt, webinarId, classId)
    end

    rect rgb(232, 245, 233)
        Note over API,Email: Phase 3: Post-Transaction Effects
        API--)Novu: void notifyAppointmentCancelled to both parties
        Note over API: Not awaited (void prefix)
        Novu->>Email: Deliver to both parties
        Email-->>Novu: Delivered

        opt Webinar or Class cancellation
            API->>WL: handleSlotOpening with eventId, slotsAvailable=1
            WL->>DB: Find next WAITING entry
            WL->>DB: UPDATE status = NOTIFIED,<br/>expiresAt = now + 48h
            WL->>Email: sendWaitlistSpotAvailableEmail()
            WL->>DB: updatePositions()
            WL-->>API: notified: 1, errors: none
        end
    end

    API-->>Client: 200 OK (success: true, ...)
    Client-->>User: "Appointment cancelled successfully"
```

---

## Additional Technical Notes

### Structured Logging

The cancellation endpoint logs structured JSON for observability. When a waitlist cascade succeeds, the following is logged:

```json
{
  "event": "waitlist_notified_after_cancellation",
  "webinarId": "web_123",
  "classId": null,
  "timestamp": "2025-06-15T10:30:01.234Z"
}
```

The waitlist handler itself logs each individual notification:

```json
{
  "event": "waitlist_user_notified",
  "waitlistId": "wl_456",
  "userId": "user_789",
  "webinarId": "web_123",
  "classId": null,
  "reason": "cancellation",
  "expiresAt": "2025-06-17T10:30:01.234Z",
  "timestamp": "2025-06-15T10:30:01.234Z"
}
```

These structured logs can be queried in your logging infrastructure to track cancellation patterns and debug waitlist issues.

### Idempotency

The cancellation endpoint is **not idempotent** in the strict HTTP sense. If you call it twice with the same appointment ID:
- First call: 200 OK (appointment cancelled and deleted)
- Second call: 404 Not Found (appointment no longer exists)

This is acceptable because cancellation is a destructive operation. The 404 on the second call effectively communicates "this was already handled."

### Concurrency

If two users simultaneously try to cancel the same appointment:
- Both will pass the `findUnique` check (Phase 1)
- Both will enter the transaction (Phase 2)
- One transaction will succeed; the other will fail with a "Record not found" error because the first transaction already deleted the appointment
- The failing transaction returns a 500 or 404 depending on the error type

This race condition is acceptable because the end result is the same: the appointment is cancelled.

---

## Related Documents

- [Architecture](./01-architecture.md) -- Booking system overview and data model
- [Event Types and Validation](./02-event-types-and-validation.md) -- Differences between event models
- [API Reference](./04-api-reference.md) -- All booking endpoints including validate and allocate
- [Reschedule Implementation Plan](./06-reschedule-implementation-plan.md) -- How rescheduling works (contrast with this doc)
- [Waitlist System](./11-waitlist-system.md) -- Complete waitlist lifecycle and queue management
- [Cancellation Payment Flow](../payments/cancellations-rescheduling/01-cancellation-payment-flow.md) -- Refund processing and earnings reversal
- [Rescheduling Payment Flow](../payments/cancellations-rescheduling/02-rescheduling-payment-flow.md) -- How payment is handled during reschedule
