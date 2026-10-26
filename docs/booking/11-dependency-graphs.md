# Dependency Graphs

Maps of how files in the booking system relate to each other, regenerated from the current imports.

---

## 1. System Layer Architecture

Each layer only calls the layer directly below it.

```mermaid
block-beta
  columns 1
  block:UI["FRONTEND COMPONENTS"]
    A["UnifiedCalendar.tsx / TimePicker.tsx"]
    B["components/planner (event forms, EventCard)"]
  end
  block:HOOKS["FRONTEND HOOKS"]
    D["useScheduling"]
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
    M["ScheduleCalculationService"]
    N["ScheduleValidationService"]
    O["lib/booking/allocation (allocate)"]
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

Which backend file imports which, read bottom-up (leaf nodes first). `lib/booking/transitions.ts` is imported directly by API routes and by the allocator (`event-data.ts` and the mode files), not only by the service layer — every status write in the booking subsystem goes through it.

```mermaid
flowchart BT
  subgraph types ["Types & Schemas (read first)"]
    T["utils/scheduling-engine/types.ts"]
    ZOD["schemas/slotAllocation/validationSchemas.ts"]
  end

  subgraph services ["Core Services"]
    CALC["ScheduleCalculationService.ts\npure math"]
    VAL["ScheduleValidationService.ts\nvalidate, isOccupiedByLiveAppointment"]
    ALLOC["lib/booking/allocation/\nallocate, modes/auto, modes/manual, modes/use-requested"]
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
    R_CHECKOUT["lib/payments/checkout/\nhandleCheckout, commit/index.ts"]
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

### 2.1 The allocation and checkout modules

Two modules do the booking writes. The diagram shows who calls whom. Callers enter through one function each: `allocate` from `@/lib/booking/allocation` and `handleCheckout` from `@/lib/payments/checkout`.

```mermaid
flowchart TD
  subgraph callers ["Callers"]
    R_ALLOCATE["allocate routes\n(lib/scheduling/allocate-route.ts, org allocate route)"]
    RESCH["lib/booking/reschedule-respond.ts\nlib/booking/reschedule-auto-confirm.ts"]
    R_CO["app/api/checkout/route.ts"]
  end

  subgraph allocation ["lib/booking/allocation/"]
    AL["allocate.ts\nallocate, dispatch"]
    AUTO["modes/auto.ts"]
    MAN["modes/manual.ts"]
    REQ["modes/use-requested.ts"]
    SEARCH["search/\nfindAvailableSlots"]
    EVD["event-data.ts\nfetchEventData, updateEventStatus"]
    GRD["guards.ts, idempotency.ts"]
    COMMIT["commit/\nrelease-tentative, create-appointments,\nreconnect-enrolled, subscription-cap"]
  end

  subgraph checkout ["lib/payments/checkout/"]
    ORCH["orchestrate.ts\nhandleCheckout"]
    PRICE["pricing.ts, revalidate.ts,\nlocks.ts, order-reuse.ts"]
    CCOMMIT["commit/index.ts\ncommitCheckout (only withSerializableRetry)"]
    HAND["handlers/\nconsultation, subscription, webinar, class"]
    CSTEPS["commit/\npayment-row, org-utilization,\npayment-legs, ledger"]
  end

  R_ALLOCATE --> AL
  RESCH --> AL
  AL --> AUTO
  AL --> MAN
  AL --> REQ
  AUTO --> SEARCH
  AUTO --> EVD
  MAN --> EVD
  REQ --> EVD
  AUTO --> GRD
  MAN --> GRD
  REQ --> GRD
  AUTO --> COMMIT
  MAN --> COMMIT

  R_CO --> ORCH
  ORCH --> PRICE
  ORCH --> CCOMMIT
  CCOMMIT --> HAND
  CCOMMIT --> CSTEPS
```

The transaction boundaries are explicit. In allocation, each mode file opens its own write transaction after taking its locks (`lockAutoAllocate`, then `lockConsulteeBooking`). In checkout, `orchestrate.ts` takes the locks and `commit/index.ts` opens the one booking transaction, renewing the lock grant at the top of every retry.

---

## 3. Frontend Dependency Graph

```mermaid
flowchart BT
  subgraph shared_types ["Shared Types"]
    ST["@/types/slots"]
    BT2["@/utils/scheduling-engine/types"]
  end

  subgraph utils ["lib/scheduling/"]
    CU["calendarUtils.ts"]
    AS["allocationService.ts\nAPI client"]
    AA["allocationAlgorithms.ts\nmanual/requested pre-validation + submit (no auto engine)"]
  end

  subgraph hooks ["hooks/scheduling/"]
    USA["useScheduling\nmanual/requested submission"]
    UCD["useCalendarData\nfetch + polling + slot status"]
  end

  subgraph components ["components/scheduling/ + components/planner/"]
    UC["UnifiedCalendar.tsx"]
    SP["TimePicker.tsx"]
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

**Reading order**: `calendarUtils` -> `allocationService` -> `allocationAlgorithms` -> `useCalendarData` + `useScheduling` -> `UnifiedCalendar`. Server-side auto-allocation (`lib/booking/allocation`) has no frontend counterpart in this chain — the client only pre-validates and submits.

---

## 4. Request Flow: Slot Allocation (The Main Path)

What happens when the consultant clicks "Allocate Slots":

```mermaid
sequenceDiagram
  participant UC as UnifiedCalendar
  participant USA as useScheduling
  participant AA as allocationAlgorithms
  participant AS as allocationService
  participant API as allocate/route.ts
  participant ZOD as validationSchemas
  participant SAS as allocate (lib/booking/allocation)
  participant SVS as ScheduleValidationService
  participant SCS as ScheduleCalculationService
  participant TRANS as lib/booking/transitions.ts
  participant DB as Prisma + PostgreSQL
  participant LOCK as appointmentlock + Redis

  UC->>USA: User selects slots (manual/requested)
  USA->>UC: Update UI (selected slots, progress)

  Note over UC: User clicks "Allocate"

  UC->>USA: autoAllocate / manualAllocate / allocateRequestedSlots

  alt Auto Mode (client submits, server picks)
    USA->>AS: allocateSlots(type, id, [], {isAuto: true})
  else Manual or Requested Mode
    USA->>AA: AllocationAlgorithms.manualAllocate / allocateRequestedSlots
    AA->>AA: Pre-validate (required count, no past slots, webinar contiguity)
    AA->>AS: allocateSlots(type, id, slots, options)
  end

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

  SAS->>LOCK: lockAutoAllocate, then lockConsulteeBooking
  LOCK-->>SAS: Lock acquired

  SAS->>SVS: validate(type, id, slots, consultant, config)
  SVS->>SCS: validateDuration()
  SVS->>DB: validateNoConflicts() - check existing appointments
  SVS-->>SAS: ValidationResult

  SAS->>DB: BEGIN TRANSACTION
  SAS->>DB: Clear stale tentative slots (payment-guarded, never a payment-bearing appointment)
  SAS->>DB: Create/reuse Appointment, create AppointmentOccurrence rows
  SAS->>TRANS: transitionConsultationRequest / transitionSubscriptionRequest
  SAS->>DB: COMMIT

  SAS->>LOCK: Release lock
  SAS-->>API: AllocationResult
  API-->>AS: JSON response
  AS-->>USA: AllocationResponse (or AllocationAlgorithms result)
  USA-->>UC: Success -> refresh calendar
```

---

## 5. Maintenance & Cleanup Flow

The active platform ticker dispatches booking recovery through authenticated cleanup handlers and their canonical implementations. Maintenance admission runs at the cleanup boundary; financial classification determines DEGRADED holds, and OFFLINE holds non-exempt cleanup work. Job leases, domain CAS and vendor idempotency protect different failure boundaries.

```mermaid
flowchart LR
  T["Active platform ticker"] --> C["lib/cron/schedule.ts: due slots, limits and windows"]
  C --> R["Authenticated cleanup registry + maintenance admission"]
  R --> L["Canonical worker + Postgres job lease"]
  L --> O["Conditional domain transitions and durable obligations"]
  O --> V["Provider confirmation or retry"]
```

The catalog runs appointment completion and consultant no-show detection every 30 minutes; request expiry, tentative cleanup, reschedule expiry and unpaid-trial expiry have their own configured slots. Exact offsets and request bounds belong to the [generated job inventory](../maintenance/04-cron-jobs-reference.md), not a duplicate list of former Actions workflows. `reconcile-occurrence-availability` remains a configured non-money Actions job, currently budget-blocked; it is not a second ticker owner. Legacy cleanup functions are not automatically scheduled just because their files remain.

The completion worker shares the session-outcome verdict with no-show handling. Retention and expiry writers recheck current eligibility; a timeout does not establish process cancellation or completed business effects. Use the [SRE orientation](../start-here/10-infra-and-maintenance-sre-orientation.md) for cross-job races and recovery evidence.

---

## 6. Data Model Relationships (Simplified)

```mermaid
erDiagram
  ConsultantProfile ||--o{ AvailabilityWindowWeekly : "sets availability"
  ConsultantProfile ||--o{ AvailabilityWindowCustom : "sets availability"

  ConsultationPlan ||--o{ Consultation : creates
  SubscriptionPlan ||--o{ Subscription : creates
  WebinarPlan ||--o{ Webinar : creates
  ClassPlan ||--o{ ClassEvent : creates

  Consultation ||--o| Appointment : "1 appointment"
  Subscription ||--o{ Appointment : "M appointments"
  Webinar ||--o| Appointment : "1 appointment"
  ClassEvent ||--o{ Appointment : "M appointments"

  Appointment ||--|{ AppointmentOccurrence : "N slots per session"
  Appointment ||--o{ BookingStatusHistory : "one row per creation and CAS transition"
  AppointmentOccurrence ||--o| Meeting : "video call"
```

> Note: the diagram labels the Prisma `Class` model as `ClassEvent` because `class` is a reserved keyword in Mermaid.

---

## How to Read This

**Backend algorithm**: `types.ts` -> `ScheduleCalculationService` -> `ScheduleValidationService` -> `lib/booking/allocation`, with every status write routed through `lib/booking/transitions.ts` and every slot-occupying write holding a lock from `utils/appointmentlock.ts`.

**Frontend**: `calendarUtils` -> `allocationService` -> `allocationAlgorithms` -> `useCalendarData` + `useScheduling` -> `UnifiedCalendar`. Auto-allocation is server-only; the client never scores or picks slots itself.

**Tracing a full request**: `UnifiedCalendar` -> `useScheduling` -> `allocationAlgorithms` (manual and requested modes only; auto mode calls the service directly) -> `allocationService` -> API route -> `allocate` -> `ScheduleValidationService` -> `ScheduleCalculationService` -> Prisma -> PostgreSQL (see Diagram 4).
