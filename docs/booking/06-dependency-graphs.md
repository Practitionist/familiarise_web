# Dependency Graphs

Visual maps of how files in the booking system relate to each other.

---

## 1. System Layer Architecture

How the 5 layers stack. Each layer only calls the layer directly below it.

```mermaid
block-beta
  columns 1
  block:UI["FRONTEND COMPONENTS"]
    A["UnifiedCalendar.tsx (1222)"]
    B["EventPlannerFor*.tsx"]
    C["EventCard.tsx (1031)"]
  end
  block:HOOKS["FRONTEND HOOKS"]
    D["useSlotAllocation (2171)"]
    E["useCalendarData (737)"]
    F["useSubscriptionValidation (260)"]
  end
  block:UTILS["FRONTEND UTILITIES"]
    G["calendarUtils (786)"]
    H["allocationAlgorithms (850)"]
    I["allocationService (612)"]
  end
  block:API["API ROUTES (Next.js)"]
    J["*/validate (POST)"]
    K["*/allocate (PATCH)"]
    L["slots/* & appointments/*"]
  end
  block:SERVICES["BACKEND SERVICES"]
    M["SlotCalculationService (416)"]
    N["SlotValidationService (808)"]
    O["SlotAllocationService (1140)"]
    P["appointmentlock (698)"]
  end

  UI --> HOOKS
  HOOKS --> UTILS
  UTILS --> API
  API --> SERVICES
```

---

## 2. Backend Dependency Graph

Which backend file imports which. Read bottom-up (leaf nodes first).

```mermaid
flowchart BT
  subgraph types ["Types & Schemas (read first)"]
    T["types.ts (143)\nEventType, EventConfig,\nTimeSlot, ProgressInfo"]
    ZOD["validationSchemas.ts (215)\nZod: allocationRequestSchema,\nvalidationRequestSchema"]
  end

  subgraph services ["Core Services"]
    CALC["SlotCalculationService.ts (416)\nPure math, no DB\ncountWeeks, getSlotsPerCall,\ncalculateRequiredSlots"]
    VAL["SlotValidationService.ts (808)\nvalidate(), validateNoConflicts,\nvalidateMatchesSchedule,\nvalidateConsecutiveSlots"]
    ALLOC["SlotAllocationService.ts (1140)\nautoAllocate, manualAllocate,\nuseRequestedSlots"]
  end

  subgraph infra ["Infrastructure"]
    PRISMA["lib/prisma\n(Prisma client)"]
    REDIS["lib/redis\n(Upstash Redis)"]
    LOCK["appointmentlock.ts (698)\nDistributed locking\nvia Redis"]
  end

  subgraph routes ["API Routes"]
    R_ALLOC["*/allocate/route.ts\nPATCH handler"]
    R_VAL["*/validate/route.ts\nPOST handler"]
    R_RESCH["*/reschedule/route.ts\nPOST handler"]
    R_SLOTS["slots/*/route.ts\nCRUD handlers"]
  end

  T --> CALC
  T --> VAL
  T --> ALLOC
  CALC --> VAL
  CALC --> ALLOC
  VAL --> ALLOC
  PRISMA --> VAL
  PRISMA --> ALLOC
  REDIS --> LOCK

  ZOD --> R_ALLOC
  ZOD --> R_VAL
  ALLOC --> R_ALLOC
  VAL --> R_VAL
  PRISMA --> R_RESCH
  PRISMA --> R_SLOTS
```

**Reading order**: `types.ts` -> `SlotCalculationService` -> `SlotValidationService` -> `SlotAllocationService` -> API routes

---

## 3. Frontend Dependency Graph

Which frontend file imports which. Read bottom-up.

```mermaid
flowchart BT
  subgraph shared_types ["Shared Types"]
    ST["@/types/slots\nTCustomSlot, TWeeklySlot"]
    BT2["@/utils/slotAllocation/types\nSlotConflictResult"]
  end

  subgraph utils ["Frontend Utilities"]
    CU["calendarUtils.ts (786)\nTimeSlot, mapWeeklySlots,\nmapCustomSlots,\ncalculateRequiredSlots"]
    AS["allocationService.ts (612)\nAPI client: validateSlots,\nallocateSlots, fetchAvailability"]
    AA["allocationAlgorithms.ts (850)\nPreference-based auto allocation\nwith time/day scoring"]
  end

  subgraph hooks ["Frontend Hooks"]
    USA["useSlotAllocation (2171)\ntoggleSlot, validateWeekly,\nprogress tracking"]
    UCD["useCalendarData (737)\ngetSlotStatusForInterval,\nfetch availability + appointments"]
    USV["useSubscriptionValidation (260)\nvalidateSlots, getAvailableWeeks"]
  end

  subgraph components ["Components"]
    UC["UnifiedCalendar.tsx (1222)\nMain calendar rendering"]
    EP["EventPlannerFor*.tsx\nConsultation/Subscription/\nWebinar/Class planners"]
    AT["AppointmentsTab.tsx (855)\nConsultant appointment list"]
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
```

**Reading order**: `types/slots` -> `calendarUtils` -> `allocationService` -> `allocationAlgorithms` -> `useCalendarData` -> `useSlotAllocation` -> `UnifiedCalendar`

---

## 4. Consultee Side (Separate Dependency Chain)

The consultee dashboard has its own simpler chain.

```mermaid
flowchart BT
  subgraph consultee_utils ["Consultee Utilities"]
    SH["scheduleHelpers.ts\ngetActualSlots"]
    SC["statusConfig.ts\nSTATUS_CONFIG"]
    GM["getMetadata.ts\ngetStatusColor"]
  end

  subgraph consultee_components ["Consultee Components"]
    EC["EventCard.tsx (1031)\nBooking card with\nreschedule/cancel/join"]
    DU["DocumentUpload.tsx (809)"]
    CAL["Calendar.tsx (323)"]
    RID["ReportIssueDialog.tsx"]
    CCD["CancelConfirmationDialog.tsx"]
  end

  SC --> EC
  DU --> EC
  RID --> EC
  CCD --> EC
  SH --> CAL
  GM --> CAL
```

---

## 5. Request Flow: Slot Allocation (The Main Path)

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
  participant DB as Prisma + PostgreSQL
  participant LOCK as appointmentlock + Redis

  UC->>USA: User selects slots via toggleSlot()
  USA->>AA: Auto-expand consecutive slots
  USA->>UC: Update UI (selected slots, progress)

  Note over UC: User clicks "Allocate"

  UC->>AS: allocateSlots(type, id, mode, slots)
  AS->>API: PATCH /api/events/{type}/{id}/allocate

  API->>ZOD: Parse request body
  ZOD-->>API: Validated {isAuto, slots?, useRequestedSlots?}

  alt Auto Mode
    API->>SAS: autoAllocate(type, id)
    SAS->>DB: Fetch event config + availability
    SAS->>SCS: calculateRequiredSlots()
    SAS->>SCS: getSlotsPerCall()
    SAS->>SAS: Build available slots lookup set
    SAS->>SAS: findAvailableSlots()
  else Manual Mode
    API->>SAS: manualAllocate(type, id, slots)
  else Requested Mode
    API->>SAS: useRequestedSlots(type, id)
  end

  SAS->>LOCK: Acquire distributed lock (Redis)
  LOCK-->>SAS: Lock acquired

  SAS->>SVS: validate(type, id, slots, consultant, config)
  SVS->>SCS: validateDuration()
  SVS->>DB: validateNoConflicts() - check existing appointments
  SVS->>SVS: validateMatchesSchedule()
  SVS->>SVS: validateConsecutiveSlots()
  SVS-->>SAS: ValidationResult

  SAS->>DB: BEGIN TRANSACTION (60s timeout)
  SAS->>DB: Delete old appointments (if any)
  SAS->>DB: Create Appointment records
  SAS->>DB: Create SlotOfAppointment records
  SAS->>DB: Update event status
  SAS->>DB: COMMIT

  SAS->>LOCK: Release lock
  SAS-->>API: AllocationResult
  API-->>AS: JSON response
  AS-->>UC: Success -> refresh calendar
```

---

## 6. Request Flow: Slot Validation (Pre-flight Check)

What happens when the frontend validates slots before allocation:

```mermaid
sequenceDiagram
  participant UC as UnifiedCalendar
  participant AS as allocationService
  participant API as validate/route.ts
  participant ZOD as validationSchemas
  participant SVS as SlotValidationService
  participant DB as Prisma + PostgreSQL

  UC->>AS: validateSlots(type, id, slots)
  AS->>API: POST /api/events/{type}/{id}/validate

  API->>ZOD: Parse {slots: ["ISO...", ...]}
  API->>DB: Fetch event + consultant + availability

  API->>SVS: validate(type, id, slots, consultant, config)
  SVS->>SVS: validateSlotsInFuture (now + 5s buffer)
  SVS->>DB: validateNoConflicts (range overlap query)
  SVS->>SVS: validateMatchesSchedule (weekly/custom)
  SVS->>SVS: validateSchedulingPeriod
  SVS->>SVS: Event-specific validation

  SVS-->>API: {conflicts, outsideAvailability, validSlots}
  API-->>AS: JSON response
  AS-->>UC: Show warnings/errors in UI
```

---

## 7. Maintenance & Cleanup Flow

How cron jobs keep the system healthy:

```mermaid
flowchart LR
  subgraph triggers ["GitHub Actions (Cron Triggers)"]
    GH1["cleanup-tentative-slots.yml\nevery 15 min"]
    GH2["auto-complete-appointments.yml\nevery hour"]
    GH3["cleanup-invalid-appointments.yml\ndaily"]
    GH4["reconcile-slot-availability.yml\ndaily"]
    GH5["expire-stale-requests.yml\nevery 30 min"]
  end

  subgraph jobs ["Job Files (Lightweight)"]
    J1["cleanup-tentative-slots.ts"]
    J2["auto-complete-appointments.ts"]
    J3["cleanup-invalid-appointments.ts"]
    J4["reconcile-slot-availability.ts"]
    J5["expire-stale-requests.ts"]
  end

  subgraph scripts ["Script Files (Verbose, for manual runs)"]
    S1["scripts/appointments/\ncleanup-tentative-slots.ts"]
    S2["scripts/appointments/\nauto-complete-appointments.ts"]
  end

  subgraph cleanup_actions ["What They Do"]
    A1["Remove tentative appointments\nolder than 30 minutes"]
    A2["Mark past appointments\nas COMPLETED"]
    A3["Remove orphaned records\nwith missing FKs"]
    A4["Sync slot availability\nstate with appointments"]
    A5["Expire PENDING requests\nolder than threshold"]
  end

  GH1 --> J1 --> A1
  GH2 --> J2 --> A2
  GH3 --> J3 --> A3
  GH4 --> J4 --> A4
  GH5 --> J5 --> A5
  J1 -.->|same logic, verbose| S1
  J2 -.->|same logic, verbose| S2
```

---

## 8. Data Model Relationships (Simplified)

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
  SlotOfAppointment ||--o| MeetingSession : "video call"
```

---

## 9. File Dependency Summary Table

Quick reference: what imports what.

### Backend

| File | Imports From |
|------|-------------|
| `types.ts` | _(leaf node - no local deps)_ |
| `validationSchemas.ts` | _(leaf node - only zod)_ |
| `SlotCalculationService.ts` | `types.ts` |
| `SlotValidationService.ts` | `types.ts`, `SlotCalculationService`, `lib/prisma` |
| `SlotAllocationService.ts` | `types.ts`, `SlotCalculationService`, `SlotValidationService`, `lib/prisma` |
| `appointmentlock.ts` | `lib/redis`, `errors/SlotLockError` |
| `*/allocate/route.ts` | `SlotAllocationService`, `types`, `validationSchemas` |
| `*/validate/route.ts` | `SlotValidationService`, `types`, `validationSchemas`, `lib/prisma` |
| `*/reschedule/route.ts` | `lib/prisma`, `lib/auth-server` |

### Frontend

| File | Imports From |
|------|-------------|
| `calendarUtils.ts` | `@/types/slots` |
| `allocationService.ts` | `calendarUtils`, `@/utils/slotAllocation/types` |
| `allocationAlgorithms.ts` | `calendarUtils`, `allocationService` |
| `useCalendarData.ts` | `allocationService` |
| `useSlotAllocation.ts` | `calendarUtils`, `allocationAlgorithms` |
| `useSubscriptionValidation.ts` | _(independent - no local deps)_ |
| `UnifiedCalendar.tsx` | `calendarUtils`, `useCalendarData`, `useSlotAllocation` |
| `EventPlannerFor*.tsx` | `types/event`, `services/planner`, form components |
| `EventCard.tsx` (consultee) | `DocumentUpload`, `ReportIssueDialog`, `CancelConfirmationDialog`, `statusConfig` |

---

## How to Read This

**If you want to understand the backend algorithm:**
```
types.ts -> SlotCalculationService -> SlotValidationService -> SlotAllocationService
   (4 files, read left to right, ~2500 LOC total)
```

**If you want to understand the frontend:**
```
calendarUtils -> allocationService -> allocationAlgorithms -> useCalendarData + useSlotAllocation -> UnifiedCalendar
   (6 files, read left to right, ~5400 LOC total)
```

**If you want to trace a full request:**
```
UnifiedCalendar -> useSlotAllocation -> allocationService -> API route -> SlotAllocationService -> SlotValidationService -> SlotCalculationService -> Prisma -> PostgreSQL
   (follow Diagram 5 above)
```
