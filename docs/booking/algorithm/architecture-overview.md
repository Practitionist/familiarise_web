# Booking System Architecture

**Version:** 2.0
**Last Updated:** January 2025
**Maintainers:** Engineering Team

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Backend Architecture](#backend-architecture)
3. [Frontend Architecture](#frontend-architecture)
4. [Business Logic Rules](#business-logic-rules)
5. [Data Flow](#data-flow)
6. [Database Schema](#database-schema)
7. [API Endpoints](#api-endpoints)
8. [Error Handling](#error-handling)
9. [Performance Considerations](#performance-considerations)

---

## 1. System Overview

### Purpose

The booking system allows consultants to schedule sessions with consultees across four event types: Consultations, Subscriptions, Webinars, and Classes. It handles slot allocation, conflict detection, weekly limits, and timezone conversions.

### Core Entities

| Entity           | Description                        | Duration Type                 | Allocation Pattern                          |
| ---------------- | ---------------------------------- | ----------------------------- | ------------------------------------------- |
| **Consultation** | One-time session                   | Total duration (e.g., 1 hour) | Single-day consecutive slots                |
| **Subscription** | Recurring calls over months        | Per-session duration          | Distributed across weeks with weekly limits |
| **Webinar**      | One-time presentation              | Total duration                | Consecutive slots (can span days)           |
| **Class**        | Recurring sessions with curriculum | Per-session duration          | Distributed with session grouping           |

### Key Features

- **3 Allocation Modes:**
  - **Auto Allocate**: System finds first available consecutive slots
  - **Manual Allocate**: User selects specific slots, system validates
  - **Requested Times**: Consultee requests slots, consultant approves

- **Validation Layers:**
  1. **Temporal**: Slots must be in the future
  2. **Schedule Match**: Slots must match consultant's availability
  3. **Conflict Detection**: No double-booking
  4. **Event-Specific**: Same-day for consultations, weekly limits for subscriptions

- **Timezone Handling:**
  - Database: All slots stored in UTC
  - Frontend: Converted to user's local timezone for display
  - Validation: Performed in UTC to avoid DST issues

---

## 2. Backend Architecture

### Service Layer Structure

The backend follows a clean service layer architecture where business logic is separated from HTTP handling.

```
utils/slotAllocation/
├── types.ts                          # Shared TypeScript types
├── SlotCalculationService.ts         # Slot math & week counting (SSOT)
├── SlotValidationService.ts          # Unified validation logic
├── SlotAllocationService.ts          # Allocation algorithms
└── SubscriptionValidationService.ts  # Subscription-specific rules

app/api/events/
├── consultations/
│   └── [consultationId]/
│       ├── allocate/route.ts         # ~80 lines (thin controller)
│       └── validate/route.ts         # ~60 lines (uses services)
├── subscriptions/
│   └── [subscriptionId]/
│       ├── allocate/route.ts
│       └── validate/route.ts
├── classes/
│   └── [classId]/
│       ├── allocate/route.ts
│       └── validate/route.ts
└── webinars/
    └── [webinarId]/
        ├── allocate/route.ts
        └── validate/route.ts
```

### Service Responsibilities

#### SlotCalculationService

**Purpose:** Single source of truth for all slot-related mathematics

**Key Methods:**

- `countWeeks(startDate, endDate)`: Sunday-to-Saturday week counting
- `calculateRequiredSlots(eventType, config)`: Determine total 30-min slots needed
- `getSlotsPerCall(sessionDurationInHours)`: Convert hours to 30-min increments
- `calculateProgress(selectedSlots, eventType, config)`: UI progress information
- `groupSlotsByDay(slots)`: Group slots for same-day validation
- `groupSlotsByWeek(slots)`: Group slots for weekly limit checks

**Week Counting Algorithm:**

```typescript
// Example: Jan 1 (Monday) to Feb 1 (Thursday)
// Week 1: Sunday Dec 29
// Week 2: Sunday Jan 5
// Week 3: Sunday Jan 12
// Week 4: Sunday Jan 19
// Week 5: Sunday Jan 26
// Total: 5 weeks (NOT 4.33)

const startSunday = startOfWeekSunday(startDate);
const endSunday = startOfWeekSunday(endDate);
let weeks = 1;
let cursor = new Date(startSunday);
while (cursor < endSunday) {
  cursor.setDate(cursor.getDate() + 7);
  weeks += 1;
}
return weeks;
```

#### SlotValidationService

**Purpose:** Unified validation for all event types

**Validation Flow:**

1. **Universal Validators** (apply to all events):
   - `validateSlotsInFuture()`: No past slots allowed
   - `validateNoConflicts()`: Check database for overlaps
   - `validateMatchesSchedule()`: Verify against consultant's availability
   - `validateConsecutiveSlots()`: 30-min gaps with 1-second tolerance
   - `validateSameDaySlots()`: All on same date

2. **Event-Specific Validators:**
   - `validateConsultation()`: Same-day + consecutive + slot count
   - `validateSubscription()`: Uses `SubscriptionValidationService` for weekly limits
   - `validateWebinar()`: Consecutive only (can span days)
   - `validateClass()`: Session grouping + weekly limits

**Key Features:**

- **1-second tolerance** for consecutive slot validation (handles timezone/precision issues)
- **Clear error messages** with specific dates/times
- **Conflict details** include appointment type and participant names

#### SlotAllocationService

**Purpose:** Allocation algorithms for all modes

**Main Entry Point:**

```typescript
SlotAllocationService.allocate(request: AllocationRequest)
  ├── autoAllocate()   // Find first available slots
  ├── manualAllocate() // Validate user selection
  └── useRequestedSlots() // Approve consultee's request
```

**Auto-Allocation Algorithm:**

```
For Consultations/Webinars:
1. Get consultant's availability slots
2. Sort by time of day (prefer earlier)
3. For each slot:
   a. Find next occurrence (if weekly pattern)
   b. Try to build consecutive block of required length
   c. Check each slot: not booked, not in past
   d. If full block found → validate → return

For Subscriptions/Classes:
1. Calculate: weeks × calls/week = total calls needed
2. For each week in period:
   a. Try to find `callsPerWeek` slots in this week
   b. For each day in week:
      - Find first available slot
      - Build consecutive block for one call
      - Add to selection, mark as booked
   c. If week filled → move to next week
3. Sort all selected slots chronologically
4. Validate → return
```

**Database Operations:**

```typescript
// Creates one Appointment per call/session
// Each Appointment has multiple SlotOfAppointment (30-min each)

For 1-hour consultation:
  Appointment (1)
  └── SlotOfAppointment (2 slots: 10:00-10:30, 10:30-11:00)

For 6-month subscription (3 calls/week):
  Appointment (1) for Week 1 Call 1
  └── SlotOfAppointment (2 slots)
  Appointment (2) for Week 1 Call 2
  └── SlotOfAppointment (2 slots)
  ... (78 appointments total for 26 weeks × 3 calls)
```

#### SubscriptionValidationService

**Purpose:** Subscription-specific weekly limit validation

**Key Features:**

- Validates slots against subscription period boundaries
- Enforces `callsPerWeek` limit per Sunday-Saturday week
- Provides weekly breakdown showing available slots per week
- Prevents over-scheduling in any single week

---

## 3. Frontend Architecture

### Component Hierarchy

```
EventTimingsCalendar.tsx (Manage Timings Dialog)
├── Extracts event details from appointment prop
├── Calls subscription/class validate APIs for debugging info
├── SafeUnifiedCalendar (Error boundary wrapper)
│   └── UnifiedCalendar (Main calendar component)
│       ├── useCalendarData (Custom hook)
│       │   ├── Fetches consultant availability
│       │   ├── Fetches existing appointments
│       │   └── Provides getSlotStatusForInterval()
│       ├── useEventSlotAllocation (Custom hook)
│       │   ├── Manages selected slots state
│       │   ├── Handles slot toggling
│       │   ├── Calls allocation APIs
│       │   └── Provides validation feedback
│       ├── Renders week/month view
│       ├── Footer: computeSubscriptionFooter() / computeClassFooter()
│       └── Allocation buttons: Auto / Manual

RequestedSlotsDialog.tsx (Use Requested Times Dialog)
├── Validates requested slots on open
├── Calls /api/events/{type}/{id}/validate
├── Shows conflicts / outside availability warnings
└── Confirm or override button
```

### State Management

**UnifiedCalendar State:**

```typescript
const [currentDate, setCurrentDate] = useState(new Date()); // Calendar view date
const [view, setView] = useState("week"); // Week or month
const [selectedSlots, setSelectedSlots] = useState([]); // User selections
const [isAllocating, setIsAllocating] = useState(false); // Loading state
const [error, setError] = useState(null); // Error message
```

**Data Fetching:**

- `useCalendarData()`: Fetches on mount and when `currentDate` or `view` changes
- `useEventSlotAllocation()`: Manages allocation API calls and slot limits
- Both use React Query / SWR for caching (if implemented)

### UI Color Coding

| State            | Color         | CSS Class                            |
| ---------------- | ------------- | ------------------------------------ |
| Available        | Green         | `bg-green-100 hover:bg-green-200`    |
| Booked           | Gray          | `bg-gray-300 cursor-not-allowed`     |
| Selected         | Blue          | `bg-primary text-primary-foreground` |
| Conflict         | Red           | `bg-red-100 border-red-400`          |
| Partially Booked | Yellow        | `bg-yellow-100`                      |
| Past             | Disabled Gray | `bg-gray-100 opacity-50`             |

---

## 4. Business Logic Rules

### Slot Duration Standard

- **All slots are 30 minutes**
- Stored in database as `slotStartTimeInUTC` (Date) and `slotEndTimeInUTC` (Date)
- Duration: `slotEndTimeInUTC = slotStartTimeInUTC + 30 minutes`

### Week Counting (Sunday-to-Saturday)

- **Week starts:** Sunday 00:00:00
- **Week ends:** Saturday 23:59:59
- Used for subscription/class weekly limits
- Example: Subscription from Jan 1 (Mon) to Mar 31 (Mon) = 13 weeks

### Consultation Rules

1. **Same Day Requirement:** All slots must be on the same calendar day
2. **Consecutive Requirement:** No gaps between slots (validated with 1-second tolerance)
3. **Slot Count:** Exactly `ceil(durationInHours / 0.5)` slots required
4. **Single Appointment:** Creates one `Appointment` with multiple `SlotOfAppointment`

**Example:**

- 1.5-hour consultation = 3 slots (9:00-9:30, 9:30-10:00, 10:00-10:30)
- Must all be on same day (e.g., Jan 15)
- Creates 1 Appointment with 3 SlotOfAppointment records

### Subscription Rules

1. **Weekly Limits:** Max `callsPerWeek` per Sunday-Saturday week
2. **Period Boundaries:** All slots must be within `[startDate, endDate]`
3. **Call Definition:** One call = `ceil(sessionDurationInHours / 0.5)` consecutive slots
4. **Total Calls:** `countWeeks(startDate, endDate) × callsPerWeek`
5. **Multiple Appointments:** Each call creates separate `Appointment`

**Example:**

- 6-month subscription, 3 calls/week, 1 hour/call
- Period: Jan 1 - Jun 30 = 26 weeks
- Total calls needed: 26 × 3 = 78 calls
- Each call: 2 consecutive 30-min slots
- Creates 78 Appointment records, each with 2 SlotOfAppointment

**Weekly Limit Validation:**

- Week 1 (Dec 29 - Jan 4): Max 3 calls
- Week 2 (Jan 5 - Jan 11): Max 3 calls
- If trying to schedule 4th call in Week 1 → Error: "Weekly call limit reached"

### Class Rules

1. **Session Grouping:** Slots grouped by day, each group = one session
2. **Consecutive Within Day:** Each session's slots must be consecutive
3. **Weekly Limits:** Max `callsPerWeek` sessions per week
4. **Session Duration:** Each session = `ceil(sessionDurationInHours / 0.5)` slots
5. **Plan Types:** Basic (2/week, 1 month), Extended (3/week, 2 months), Comprehensive (4/week, 4 months)

**Example:**

- Extended class plan: 3 sessions/week, 2 months, 1 hour/session
- Period: Jan 1 - Feb 28 = 9 weeks
- Total sessions: 9 × 3 = 27 sessions
- Each session: 2 consecutive slots on same day
- Total slots: 27 × 2 = 54 slots

### Webinar Rules

1. **Consecutive Slots:** Must be consecutive (no same-day requirement)
2. **Can Span Days:** 3-hour webinar can be 23:00-02:00 across midnight
3. **Single Appointment:** One `Appointment` with multiple slots

### Validation Order (Critical!)

1. **Slots in future** (earliest check to fail fast)
2. **Match consultant schedule** (day/time pattern)
3. **No conflicts** (database query)
4. **Event-specific rules** (same-day, consecutive, limits)

❌ **Wrong Order:**

```typescript
// Bad: Expensive DB query before cheap checks
await validateNoConflicts(); // Slow
validateSlotsInFuture(); // Fast - should be first!
```

✅ **Correct Order:**

```typescript
validateSlotsInFuture(); // Fast - fail early
validateMatchesSchedule(); // Fast - in-memory check
await validateNoConflicts(); // Slow - DB query
validateEventSpecific(); // Varies
```

---

## 5. Data Flow

### Auto Allocation Flow

```
User clicks "Auto Allocate"
  ↓
Frontend: AllocationAPIClient.allocate({ eventType, eventId, mode: 'auto' })
  ↓
Backend: POST /api/events/{type}/{id}/allocate { isAuto: true }
  ↓
SlotAllocationService.allocate(request)
  ├── fetchEventData() - Get consultant, config
  ├── findAvailableSlots()
  │   ├── Query consultant's availability (weekly or custom)
  │   ├── Query existing appointments (booked slots)
  │   ├── For consultations: Find first consecutive block
  │   └── For subscriptions/classes: Distribute across weeks
  ├── SlotValidationService.validate()
  │   ├── validateSlotsInFuture()
  │   ├── validateMatchesSchedule()
  │   ├── validateNoConflicts()
  │   └── validateEventSpecific()
  ├── createAppointments()
  │   └── Transaction: Create Appointment + SlotOfAppointment records
  └── updateEventStatus()
      └── Set requestStatus = APPROVED / status = SCHEDULED
  ↓
Frontend: Receives { success: true, appointments: [...] }
  ↓
UI: Show success toast, close dialog, refresh calendar
```

### Manual Allocation Flow

```
User selects slots on calendar
  ↓
Frontend: selectedSlots state updates (toggleSlot())
  ↓
User clicks "Allocate Manual Slots"
  ↓
Frontend: AllocationAPIClient.allocate({
  eventType,
  eventId,
  mode: 'manual',
  slots: selectedSlots.map(s => s.startTime.toISOString())
})
  ↓
Backend: POST /api/events/{type}/{id}/allocate { isAuto: false, slots: [...] }
  ↓
SlotAllocationService.allocate(request)
  ├── fetchEventData()
  ├── Convert slots to Date objects
  ├── SlotValidationService.validate()
  │   └── (same validation as auto)
  ├── createAppointments()
  └── updateEventStatus()
  ↓
Frontend: Success or error with specific message
```

### Requested Times Flow

```
Consultee requests specific slots
  ↓
System creates tentative Appointment with requested SlotOfAppointment
  ↓
Consultant opens "Requests" tab → sees pending request
  ↓
Consultant clicks "Use Requested Times"
  ↓
RequestedSlotsDialog opens
  ├── Calls /api/events/{type}/{id}/validate { slots: [...] }
  ├── Shows: Conflicts, Outside Availability, or "All Clear"
  └── If conflicts: Disable allocation
  └── If outside availability: Show "Override and Allocate" button
  ↓
Consultant confirms
  ↓
Frontend: AllocationAPIClient.allocate({ mode: 'requested', useRequestedSlots: true })
  ↓
Backend: Validates requested slots, updates status to APPROVED
  ↓
Consultee notified: "Your request has been approved!"
```

---

## 6. Database Schema

### Key Models (Prisma)

```prisma
model Appointment {
  id                   String             @id @default(cuid())
  appointmentType      AppointmentsType   // CONSULTATION | SUBSCRIPTION | WEBINAR | CLASS
  consultation         Consultation?      @relation(...)
  subscription         Subscription?      @relation(...)
  webinar              Webinar?           @relation(...)
  class                Class?             @relation(...)
  slotsOfAppointment   SlotOfAppointment[] // Multiple 30-min slots
  createdAt            DateTime           @default(now())
  updatedAt            DateTime           @updatedAt
}

model SlotOfAppointment {
  id                   String       @id @default(cuid())
  slotStartTimeInUTC   DateTime     // Start of 30-min slot (UTC)
  slotEndTimeInUTC     DateTime     // End of 30-min slot (UTC)
  isTentative          Boolean      @default(false) // For requested times
  appointment          Appointment  @relation(...)
  user                 User[]       // Consultant + Consultee

  @@index([slotStartTimeInUTC])  // Performance: Fast conflict queries
}

model ConsultantProfile {
  scheduleType                ScheduleType  // WEEKLY | CUSTOM
  slotsOfAvailabilityWeekly   SlotOfAvailabilityWeekly[]
  slotsOfAvailabilityCustom   SlotOfAvailabilityCustom[]
}

model SlotOfAvailabilityWeekly {
  dayOfWeekforStartTimeInUTC  DayOfWeek    // SUNDAY, MONDAY, ...
  slotStartTimeInUTC          DateTime     // Pattern time (e.g., 9:00 AM every Monday)
  slotEndTimeInUTC            DateTime
}

model Consultation {
  requestStatus        RequestStatus  // PENDING | APPROVED | REJECTED
  consultationPlan     ConsultationPlan
  appointment          Appointment?
}

model Subscription {
  requestStatus        RequestStatus
  startDate            DateTime       // Calculated from first allocated slot
  endDate              DateTime       // startDate + durationInMonths
  subscriptionPlan     SubscriptionPlan
  appointments         Appointment[]  // Multiple appointments (one per call)
}

model Class {
  status               String         // SCHEDULED | COMPLETED
  startDate            DateTime
  endDate              DateTime
  classPlan            ClassPlan
  appointments         Appointment[]
}
```

### Indexes for Performance

```prisma
// Critical indexes for fast queries
@@index([slotStartTimeInUTC])                      // SlotOfAppointment
@@index([consultantProfileId, slotStartTimeInUTC]) // Availability slots
@@index([requestStatus])                           // Consultations/Subscriptions
@@index([appointmentType])                         // Appointments
```

---

## 7. API Endpoints

### Allocation Endpoints

| Endpoint                                  | Method | Purpose                     | Request Body                             |
| ----------------------------------------- | ------ | --------------------------- | ---------------------------------------- |
| `/api/events/consultations/[id]/allocate` | PATCH  | Allocate consultation slots | `{ isAuto, slots?, useRequestedSlots? }` |
| `/api/events/subscriptions/[id]/allocate` | PATCH  | Allocate subscription slots | Same                                     |
| `/api/events/classes/[id]/allocate`       | PATCH  | Allocate class slots        | Same                                     |
| `/api/events/webinars/[id]/allocate`      | PATCH  | Allocate webinar slots      | Same                                     |

### Validation Endpoints

| Endpoint                                  | Method | Purpose                        | Request Body          |
| ----------------------------------------- | ------ | ------------------------------ | --------------------- |
| `/api/events/consultations/[id]/validate` | POST   | Validate slot selection        | `{ slots: string[] }` |
| `/api/events/subscriptions/[id]/validate` | POST   | Validate + subscription limits | Same                  |
| `/api/events/classes/[id]/validate`       | POST   | Validate + weekly limits       | Same                  |
| `/api/events/webinars/[id]/validate`      | POST   | Validate webinar slots         | Same                  |

### Response Format

**Success Response:**

```json
{
  "data": {
    "appointments": [...],
    "warnings": ["Week of Jan 15 is fully booked"]
  }
}
```

**Error Response:**

```json
{
  "error": "Slot 2025-01-15T10:00:00Z is already booked (conflicts with Subscription with John Doe)"
}
```

---

## 8. Error Handling

### Error Categories

| Category             | HTTP Status | Example               | User-Facing Message                                             |
| -------------------- | ----------- | --------------------- | --------------------------------------------------------------- |
| Validation Error     | 500         | Past slot selected    | "Cannot allocate slots in the past"                             |
| Conflict Error       | 500         | Double-booking        | "Slot 10:00 AM on Jan 15 conflicts with consultation with Jane" |
| Business Logic Error | 500         | Weekly limit exceeded | "Week of Jan 15 full: 3/3 calls already scheduled"              |
| Not Found Error      | 404         | Invalid event ID      | "Consultation not found"                                        |
| Bad Request Error    | 400         | Missing parameters    | "isAuto flag is required"                                       |

### Frontend Error Handling

```typescript
try {
  const result = await AllocationAPIClient.allocate(...);
  if (!result.success) {
    toast({ variant: 'destructive', title: 'Allocation Failed', description: result.error });
  }
} catch (error) {
  if (error instanceof AllocationError) {
    if (error.statusCode === 404) {
      // Navigate to error page
    } else {
      // Show error toast
    }
  } else {
    // Network error - show retry option
  }
}
```

---

## 9. Performance Considerations

### Backend Optimizations

1. **Database Indexes:**
   - `slotStartTimeInUTC` index for fast conflict queries
   - Composite indexes for consultant + time lookups

2. **Transaction Scoping:**
   - Keep transactions minimal (only writes, not reads)
   - Use read replicas for validation queries (if available)

3. **Query Optimization:**
   - Fetch only required fields (use Prisma `select`)
   - Batch appointment creation with `Promise.all`

### Frontend Optimizations

1. **Memoization:**

   ```typescript
   const weekDates = useMemo(() => calculateWeekDates(currentDate), [currentDate]);
   const slotStatus = useMemo(() => computeSlotStatus(...), [deps]);
   ```

2. **Debouncing:**
   - Validation API calls debounced by 500ms
   - Calendar re-renders throttled

3. **Lazy Loading:**
   - Only fetch appointments for visible week/month
   - Paginate large lists of appointments

4. **Caching:**
   - React Query / SWR for consultant availability
   - Cache slot status calculations per day

### Scalability Notes

- **Current:** Handles ~100 consultants, ~1000 appointments/month
- **Bottleneck:** Conflict queries for high-volume consultants
- **Solution:** Implement slot availability cache (Redis) updated on allocation
- **Future:** Sharding by consultant region for global scale

---

## Conclusion

This architecture provides a solid, maintainable foundation for the booking system. Key strengths:

✅ **Single Source of Truth:** `SlotCalculationService` for all slot math
✅ **Unified Validation:** Same rules applied consistently across all event types
✅ **Clean Separation:** Business logic in services, HTTP handling in routes
✅ **Extensibility:** Easy to add new event types or allocation modes
✅ **Performance:** Indexed queries, memoization, efficient algorithms

For implementation details, see [UI_GUIDE.md](./UI_GUIDE.md).
