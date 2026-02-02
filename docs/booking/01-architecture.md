# Architecture

## Service Layer

### SlotCalculationService

**File**: `utils/slotAllocation/SlotCalculationService.ts`

Pure-function service with no database access. Single source of truth for all slot math.

| Method | Purpose |
|--------|---------|
| `countWeeks(start, end)` | Count Sunday-to-Saturday weeks overlapping a date range |
| `startOfWeekSunday(date)` | Get the Sunday 00:00 of the week containing a date |
| `validateDuration(duration, fieldName)` | Safety check: positive, finite, >= 0.5h, <= 24h |
| `calculateRequiredSlots(eventType, config)` | Total 30-min slots needed for an event |
| `getSlotsPerCall(sessionDurationInHours)` | Slots per session: `Math.ceil(duration / 0.5)` |
| `calculateProgress(selectedSlots, eventType, config)` | UI progress: scheduled vs required vs remaining |
| `countCompletedCalls(slots, slotsPerCall)` | Count complete consecutive-slot groups per day |
| `groupSlotsByDay(slots)` | Map\<dateString, slots[]\> |
| `groupSlotsByWeek(slots)` | Map\<sundayISO, slots[]\> |

### SlotValidationService

**File**: `utils/slotAllocation/SlotValidationService.ts`

Unified validation for all 4 event types. Takes a `PrismaClient` or transaction in the constructor.

**Entry point**: `validate(eventType, eventId, slots, consultant, config)` runs universal checks first, then routes to event-specific validation.

**Universal validators** (all event types):

| Validator | What it checks |
|-----------|---------------|
| `validateSlotsInFuture` | All slots > now + 5 seconds (buffer prevents race conditions) |
| `validateNoConflicts` | Range overlap detection: `slotStart < existingEnd AND existingStart < slotEnd`. Checks APPROVED subscriptions, PENDING/APPROVED/APPROVED_PENDING_PAYMENT consultations, SCHEDULED webinars/classes. Detects expired payments (orphaned payment fix). |
| `validateMatchesSchedule` | WEEKLY: day-of-week + time-of-day within availability ranges. CUSTOM: overlap detection with available slots. |
| `validateSchedulingPeriod` | All slots within [startDate, endDate] -- server-side enforcement |
| `validateConsecutiveSlots` | Sort + check 30-min diff with 1-second tolerance |
| `validateSameDaySlots` | All slots share the same `toDateString()` |

**Event-specific validators**:

| Validator | Rules |
|-----------|-------|
| `validateConsultation` | Same day + consecutive + exact slot count |
| `validateSubscription` | Delegates to `SubscriptionValidationService` |
| `validateWebinar` | Consecutive + exact slot count |
| `validateClass` | Complete sessions per day + consecutive within day + weekly limits |

```mermaid
sequenceDiagram
    participant API as API Route
    participant ZOD as Zod Schema
    participant VS as SlotValidationService
    participant DB as Database

    API->>ZOD: Parse request body
    ZOD-->>API: Validated data (or 400)
    API->>VS: validate(eventType, eventId, slots, consultant, config)
    VS->>VS: validateSlotsInFuture(slots)
    VS->>VS: validateMatchesSchedule(slots, consultant)
    VS->>DB: validateNoConflicts(slots, consultantId)
    DB-->>VS: Existing appointments
    VS->>VS: validateSchedulingPeriod(slots, start, end)
    VS->>VS: validateConsultation/Subscription/Webinar/Class
    VS-->>API: ValidationResult {isValid, errors, warnings}
```

### SlotAllocationService

**File**: `utils/slotAllocation/SlotAllocationService.ts`

Main allocation engine. All operations run inside a Prisma transaction with 60-second timeout.

```mermaid
flowchart TD
    A[allocate request] --> B{mode?}
    B -->|auto| C[autoAllocate]
    B -->|manual| D[manualAllocate]
    B -->|requested| E[useRequestedSlots]

    C --> F[fetchEventData]
    F --> G[Detect reschedule via isTentative]
    G --> H[findAvailableSlots]
    H --> I[validate + createAppointments]

    D --> J[fetchEventData]
    J --> K[Check duplicates + slot count]
    K --> L[validate + createAppointments]

    E --> M[fetchEventData]
    M --> N[Verify existing appointments exist]
    N --> O[validate + clear isTentative]
```

**Auto allocation** (`autoAllocate`):
1. Fetch event config and consultant availability
2. Detect reschedule (existing tentative slots? preserve total slot count)
3. Build lookup set of all available 30-min blocks (weekly: generate 8 weeks of occurrences; custom: break into 30-min blocks)
4. For consultations/webinars: find first available consecutive block
5. For subscriptions/classes: distribute across weeks (1 call/day, iterate days within weeks)
6. Validate selected slots, create appointments, update event status

**Manual allocation** (`manualAllocate`):
1. Convert ISO strings to Date objects
2. Reject duplicates
3. Verify slot count is exact multiple of slotsPerCall
4. Run full validation pipeline
5. Delete existing appointments, create new ones, update status

**Requested allocation** (`useRequestedSlots`):
1. Verify appointments actually exist (prevents approving empty requests)
2. Verify slot count matches
3. Run full validation
4. Clear `isTentative` flag on all slots
5. Update event status to APPROVED

**Appointment structure**:
```
1 Appointment record = 1 call/session
  N SlotOfAppointment records (N = slotsPerCall)
    Each: [startsAt, endsAt] = 30-min interval, isTentative flag
    Connected to: consultant user + consultee user
```

---

## Frontend Hooks

### useSlotAllocation

**File**: `shared/hooks/useSlotAllocation.ts` (~2170 lines)

Central React hook managing slot selection state for all event types.

**Key behaviors**:
- `toggleSlot()` -- event-specific interactive blocking: weekly limits (subscription), daily session limits (class), consecutive enforcement
- Auto-expansion -- when selecting a slot, auto-select consecutive adjacent slots to fill `slotsPerSession`
- `validateWeeklyDistribution()` -- counts **calls** not raw slots (divides by `slotsPerSession`)
- `isCompleteCall()` -- checks if a day's slots form a complete session
- Progress tracking -- scheduled/required/remaining calls

### useCalendarData

**File**: `shared/hooks/useCalendarData.ts` (~737 lines)

Unified calendar data synchronization. Fetches availability, appointments, and event slots in parallel.

**Key function**: `getSlotStatusForInterval()` returns:
- `isAvailable` / `isBookedForDisplay` (fully booked) / `isPartiallyBooked`
- `isDisabled` / `isInPast`
- `overlappingAppointments` for tooltips

Uses server-calculated `bookingStatus` (available / partially-booked / fully-booked) as source of truth.

### useSubscriptionValidation

**File**: `shared/hooks/useSubscriptionValidation.ts` (~261 lines)

Subscription-specific frontend validation: `validateSlots()`, `getAvailableWeeks()`, `canScheduleInWeek()`.

---

## Data Model

```mermaid
erDiagram
    ConsultantProfile ||--o{ SlotOfAvailabilityWeekly : has
    ConsultantProfile ||--o{ SlotOfAvailabilityCustom : has

    ConsultationPlan ||--o{ Consultation : creates
    SubscriptionPlan ||--o{ Subscription : creates
    WebinarPlan ||--o{ Webinar : creates
    ClassPlan ||--o{ Class : creates

    Consultation ||--o| Appointment : "has one"
    Subscription ||--o{ Appointment : "has many"
    Webinar ||--o| Appointment : "has one"
    Class ||--o{ Appointment : "has many"

    Appointment ||--|{ SlotOfAppointment : contains

    SlotOfAvailabilityWeekly {
        string id PK
        DayOfWeek dayOfWeekForStartsAt
        DateTime availabilityStartsAt
        DateTime availabilityEndsAt
    }

    Appointment {
        string id PK
        AppointmentsType appointmentType
        string consultationId FK
        string subscriptionId FK
        string webinarId FK
        string classId FK
    }

    SlotOfAppointment {
        string id PK
        DateTime startsAt
        DateTime endsAt
        boolean isTentative
        string appointmentId FK
    }
```

**Key relationships**:
- One-time events (consultation, webinar) have **1 appointment** with N slots
- Recurring events (subscription, class) have **M appointments** (one per call/session), each with N slots
- `slotsPerSession = Math.ceil(sessionDurationInHours / 0.5)`
- Weekly availability uses `dayOfWeekForStartsAt` enum (SUNDAY..SATURDAY) as the source of truth for which day-of-week a slot represents

---

## Data Flows

### Manual Allocation (Validate-then-Allocate)

```mermaid
sequenceDiagram
    participant UI as Frontend
    participant VA as POST /validate
    participant AL as PATCH /allocate
    participant SV as SlotValidationService
    participant SA as SlotAllocationService
    participant DB as Database

    UI->>VA: {slots: ["2025-01-15T10:00:00Z", ...]}
    VA->>SV: validate(eventType, eventId, slots, consultant, config)
    SV->>DB: Check conflicts, availability
    SV-->>VA: {conflicts: [], validSlots: [...]}
    VA-->>UI: Show validation results

    UI->>AL: {isAuto: false, slots: [...]}
    AL->>SA: manualAllocate(eventType, eventId, slots)
    SA->>SV: validate() again inside transaction
    SA->>DB: Delete old appointments
    SA->>DB: Create Appointment + SlotOfAppointment records
    SA->>DB: Update event status to APPROVED/SCHEDULED
    SA-->>AL: {success: true, appointments: [...]}
    AL-->>UI: Allocation result
```

### Auto Allocation

```mermaid
sequenceDiagram
    participant UI as Frontend
    participant AL as PATCH /allocate
    participant SA as SlotAllocationService
    participant SC as SlotCalculationService
    participant DB as Database

    UI->>AL: {isAuto: true}
    AL->>SA: autoAllocate(eventType, eventId)
    SA->>DB: Fetch event config + consultant availability
    SA->>DB: Fetch existing appointments (reschedule detection)
    SA->>SC: calculateRequiredSlots / getSlotsPerCall
    SA->>SA: Build available slots lookup set
    SA->>SA: findAvailableSlots (consecutive/distributed)
    SA->>SA: Validate selected slots
    SA->>DB: Delete existing + Create appointments
    SA-->>AL: {success: true, appointments: [...]}
    AL-->>UI: Result
```

---

## Tentative Appointment Lifecycle

Tentative appointments handle two scenarios: pending payment and rescheduling.

```mermaid
stateDiagram-v2
    [*] --> Tentative: Checkout creates appointment
    Tentative --> Confirmed: Payment succeeds
    Tentative --> CleanedUp: Abandoned (30 min)

    [*] --> Tentative2: Reschedule marks slots tentative
    Tentative2 --> Confirmed: Consultant approves new slots
    Tentative2 --> Confirmed: Auto-allocation replaces tentative

    state Tentative {
        direction LR
        Created --> PendingPayment
        PendingPayment --> Expired: No payment in 30 min
    }
```

**Retry protection**:
- User deduplication: 5-minute window blocks same-user duplicate attempts
- Rate limiting: max 3 pending attempts per slot per 30 minutes
- Cleanup job: runs every 15 minutes, removes appointments abandoned for 30+ minutes
- Expired payment detection: `APPROVED_PENDING_PAYMENT` consultations with expired payments are treated as available slots
