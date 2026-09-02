# Dependency Graphs

Maps of how files in the booking system relate to each other, regenerated from the current imports.

---

## 1. System Layer Architecture

Each layer only calls the layer directly below it.

```mermaid
block-beta
  columns 1
  block:UI["FRONTEND COMPONENTS"]
    A["UnifiedCalendar.tsx / SlotPicker.tsx"]
    B["components/planner (event forms, EventCard)"]
  end
  block:HOOKS["FRONTEND HOOKS"]
    D["useSlotAllocation"]
    E["useCalendarData"]
  end
  block:UTILS["FRONTEND UTILITIES"]
    G["lib/scheduling (calendarUtils, allocationAlgorithms, allocationService, ...)"]
  end
  block:API["API ROUTES (Next.js)"]
    J["*/validate (POST)"]
    K["*/allocate (PATCH)"]
    L["appointments/* & slots/*"]
  end
  block:SERVICES["BACKEND SERVICES"]
    M["SlotCalculationService"]
    N["SlotValidationService"]
    O["SlotAllocationService"]
    P["lib/booking/transitions.ts (CAS)"]
    Q["utils/appointmentlock.ts (locking)"]
  end

  UI --> HOOKS
  HOOKS --> UTILS
  UTILS --> API
  API --> SERVICES
```

---

## 2. Backend Dependency Graph

Which backend file imports which, read bottom-up (leaf nodes first). `lib/booking/transitions.ts` is imported directly by API routes and by `SlotAllocationService`, not only by the service layer — every status write in the booking subsystem goes through it.

```mermaid
flowchart BT
  subgraph types ["Types & Schemas (read first)"]
    T["utils/slotAllocation/types.ts"]
    ZOD["schemas/slotAllocation/validationSchemas.ts"]
  end

  subgraph services ["Core Services"]
    CALC["SlotCalculationService.ts\npure math"]
    VAL["SlotValidationService.ts\nvalidate, isOccupiedByLiveAppointment"]
    ALLOC["SlotAllocationService.ts\nautoAllocate, manualAllocate, useRequestedSlots"]
    OCC["occupancyPolicy.ts\nbuildOccupiedAppointmentFilter, buildDeadHoldFilter"]
    COV["availabilityCoverage.ts\nloadPublishedCoverage, findUncoveredAtom"]
    MERGE["mergeAdjacentWeeklyRows.ts"]
  end

  subgraph guards ["Correctness Guards"]
    TRANS["lib/booking/transitions.ts\nCAS status transitions"]
    LOCK["utils/appointmentlock.ts\ndistributed locking via Redis"]
  end

  subgraph infra ["Infrastructure"]
    PRISMA["lib/prisma"]
    REDIS["lib/redis (Upstash Redis)"]
  end

  subgraph routes ["API Routes"]
    R_ALLOC["*/allocate/route.ts (PATCH)"]
    R_VAL["*/validate/route.ts (POST)"]
    R_CANCEL["appointments/[id]/cancel/route.ts"]
    R_RESCH["appointments/[id]/reschedule/route.ts"]
    R_CHECKOUT["lib/payments/operations/checkout.ts"]
  end

  T --> CALC
  T --> VAL
  T --> ALLOC
  CALC --> VAL
  CALC --> ALLOC
  VAL --> ALLOC
  VAL --> OCC
  PRISMA --> VAL
  PRISMA --> ALLOC
  REDIS --> LOCK

  ZOD --> R_ALLOC
  ZOD --> R_VAL
  ALLOC --> R_ALLOC
  VAL --> R_VAL
  ALLOC --> TRANS
  R_CANCEL --> TRANS
  R_CANCEL --> LOCK
  R_RESCH --> TRANS
  R_RESCH --> LOCK
  R_CHECKOUT --> COV
  R_CHECKOUT --> LOCK
  MERGE --> COV
```

---

## 3. Frontend Dependency Graph

```mermaid
flowchart BT
  subgraph shared_types ["Shared Types"]
    ST["@/types/slots"]
    BT2["@/utils/slotAllocation/types"]
  end

  subgraph utils ["lib/scheduling/"]
    CU["calendarUtils.ts"]
    AS["allocationService.ts\nAPI client"]
    AA["allocationAlgorithms.ts\nmanual/requested pre-validation + submit (no auto engine)"]
  end

  subgraph hooks ["hooks/scheduling/"]
    USA["useSlotAllocation\nmanual/requested submission"]
    UCD["useCalendarData\nfetch + polling + slot status"]
  end

  subgraph components ["components/scheduling/ + components/planner/"]
    UC["UnifiedCalendar.tsx"]
    SP["SlotPicker.tsx"]
    EC["EventCard.tsx (components/planner/components)"]
  end

  ST --> CU
  BT2 --> AS
  CU --> AS
  CU --> AA
  AS --> AA
  CU --> USA
  AA --> USA
  AS --> UCD
  UCD --> UC
  USA --> UC
  CU --> UC
  UC --> SP
```

**Reading order**: `calendarUtils` -> `allocationService` -> `allocationAlgorithms` -> `useCalendarData` + `useSlotAllocation` -> `UnifiedCalendar`. Server-side auto-allocation (`SlotAllocationService`) has no frontend counterpart in this chain — the client only pre-validates and submits.

---

## 4. Request Flow: Slot Allocation (The Main Path)

What happens when the consultant clicks "Allocate Slots":

```mermaid
sequenceDiagram
  participant UC as UnifiedCalendar
  participant USA as useSlotAllocation
  participant AA as allocationAlgorithms
  participant AS as allocationService
  participant API as allocate/route.ts
  participant ZOD as validationSchemas
  participant SAS as SlotAllocationService
  participant SVS as SlotValidationService
  participant SCS as SlotCalculationService
  participant TRANS as lib/booking/transitions.ts
  participant DB as Prisma + PostgreSQL
  participant LOCK as appointmentlock + Redis

  UC->>USA: User selects slots (manual/requested)
  USA->>UC: Update UI (selected slots, progress)

  Note over UC: User clicks "Allocate"

  UC->>AS: allocateSlots(type, id, mode, slots)
  AS->>API: PATCH /api/bookings/{type}/{id}/allocate

  API->>ZOD: Parse request body
  ZOD-->>API: Validated {isAuto, slots?, useRequestedSlots?}

  alt Auto Mode (server-picked)
    API->>SAS: autoAllocate(type, id)
    SAS->>SCS: calculateRequiredSlots(), getSlotsPerCall()
    SAS->>SAS: findAvailableSlots() (preferenceScoring.ts orders, never filters)
  else Manual Mode
    API->>SAS: manualAllocate(type, id, slots)
  else Requested Mode
    API->>SAS: useRequestedSlots(type, id)
  end

  SAS->>LOCK: lockSlotBooking / lockAutoAllocate
  LOCK-->>SAS: Lock acquired

  SAS->>SVS: validate(type, id, slots, consultant, config)
  SVS->>SCS: validateDuration()
  SVS->>DB: validateNoConflicts() - check existing appointments
  SVS-->>SAS: ValidationResult

  SAS->>DB: BEGIN TRANSACTION
  SAS->>DB: Clear stale tentative slots (payment-guarded; never a payment-bearing appointment)
  SAS->>DB: Create/reuse Appointment, create SlotOfAppointment rows
  SAS->>TRANS: transitionConsultationRequest / transitionSubscriptionRequest
  SAS->>DB: COMMIT

  SAS->>LOCK: Release lock
  SAS-->>API: AllocationResult
  API-->>AS: JSON response
  AS-->>UC: Success -> refresh calendar
```

---

## 5. Maintenance & Cleanup Flow

How the GitHub Actions crons keep the booking subsystem healthy. Every job listed here first calls `abortIfMaintenance()` (`lib/maintenance-cron.ts`), which refuses to run while the platform is in a declared maintenance freeze.

```mermaid
flowchart LR
  subgraph triggers ["GitHub Actions (Cron Triggers)"]
    GH1["cleanup-tentative-slots.yml\nevery 2 hours"]
    GH2["auto-complete-appointments.yml\nhourly"]
    GH3["cleanup-invalid-appointments.yml\ndaily"]
    GH4["reconcile-slot-availability.yml\ndaily"]
    GH5["expire-stale-requests.yml\ndaily"]
    GH6["cleanup-stale-pending-consultations.yml"]
    GH7["expire-reschedule-proposals.yml"]
    GH8["expire-unpaid-trials.yml"]
  end

  subgraph jobs ["jobs/appointments/*.ts (thin GH Actions wrappers)"]
    J1["cleanup-tentative-slots.ts"]
    J2["auto-complete-appointments.ts"]
    J3["cleanup-invalid-appointments.ts"]
    J4["reconcile-slot-availability.ts"]
    J5["expire-stale-requests.ts"]
  end

  subgraph scripts ["scripts/appointments/*.ts (the actual logic)"]
    S1["cleanup-tentative-slots.ts"]
    S2["auto-complete-appointments.ts"]
    S3["cleanup-invalid-appointments.ts"]
    S4["reconcile-slot-availability.ts"]
    S5["expire-stale-requests.ts"]
  end

  subgraph cleanup_actions ["What They Do"]
    A1["Delete stale isTentative slots with no SUCCEEDED payment;\nnever a confirmed or payment-bearing appointment"]
    A2["transitionSlotCompletion(COMPLETED) for past appointments"]
    A3["Remove orphaned records with missing FKs"]
    A4["Detect double-booking / sync slot availability with appointments"]
    A5["transitionConsultationRequest/transitionSubscriptionRequest(EXPIRED) for stale PENDING"]
  end

  GH1 --> J1 --> S1 --> A1
  GH2 --> J2 --> S2 --> A2
  GH3 --> J3 --> S3 --> A3
  GH4 --> J4 --> S4 --> A4
  GH5 --> J5 --> S5 --> A5
```

---

## 6. Data Model Relationships (Simplified)

```mermaid
erDiagram
  ConsultantProfile ||--o{ SlotOfAvailabilityWeekly : "sets availability"
  ConsultantProfile ||--o{ SlotOfAvailabilityCustom : "sets availability"

  ConsultationPlan ||--o{ Consultation : creates
  SubscriptionPlan ||--o{ Subscription : creates
  WebinarPlan ||--o{ Webinar : creates
  ClassPlan ||--o{ ClassEvent : creates

  Consultation ||--o| Appointment : "1 appointment"
  Subscription ||--o{ Appointment : "M appointments"
  Webinar ||--o| Appointment : "1 appointment"
  ClassEvent ||--o{ Appointment : "M appointments"

  Appointment ||--|{ SlotOfAppointment : "N slots per session"
  Appointment ||--o{ BookingStatusHistory : "one row per CAS transition"
  SlotOfAppointment ||--o| MeetingSession : "video call"
```

> Note: the diagram labels the Prisma `Class` model as `ClassEvent` because `class` is a reserved keyword in Mermaid.

---

## How to Read This

**Backend algorithm**: `types.ts` -> `SlotCalculationService` -> `SlotValidationService` -> `SlotAllocationService`, with every status write routed through `lib/booking/transitions.ts` and every slot-occupying write holding a lock from `utils/appointmentlock.ts`.

**Frontend**: `calendarUtils` -> `allocationService` -> `allocationAlgorithms` -> `useCalendarData` + `useSlotAllocation` -> `UnifiedCalendar`. Auto-allocation is server-only; the client never scores or picks slots itself.

**Tracing a full request**: `UnifiedCalendar` -> `useSlotAllocation` -> `allocationService` -> API route -> `SlotAllocationService` -> `SlotValidationService` -> `SlotCalculationService` -> Prisma -> PostgreSQL (see Diagram 4).
