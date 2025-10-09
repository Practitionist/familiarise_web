# Event Types Reference

This document provides comprehensive details about the four event types supported by the booking algorithm system.

## Overview

The booking algorithm system supports four distinct event types, each with unique characteristics, scheduling rules, and database fields:

1. **Consultations** - One-time sessions with variable duration
2. **Subscriptions** - Recurring sessions with weekly limits
3. **Webinars** - One-time group sessions
4. **Classes** - Recurring group sessions with weekly limits

---

## 1. Consultations

### Characteristics

- **Type**: One-time event
- **Participants**: One-on-one (consultant + consultee)
- **Duration**: Variable (configurable per consultation plan)
- **Scheduling**: Consultee selects preferred time slots
- **Allocation**: Single consecutive block of slots on the same day

### Database Schema

**Main Table**: `Consultation`

```typescript
{
  id: string (UUID)
  consultationPlanId: string
  requestedById: string
  requestStatus: RequestStatus (PENDING | APPROVED | REJECTED)
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Related Tables**:
- `ConsultationPlan` - Defines duration, price, consultant profile
- `Appointment` - Single appointment record for the consultation
- `SlotOfAppointment` - Multiple 30-minute slots for the appointment

### Allocation Rules

1. **Slot Count**: Exactly matches `durationInHours` from consultation plan
   - Example: 2-hour consultation = 4 slots (4 × 30 minutes)

2. **Same Day Requirement**: All slots must be on the same calendar day
   - Valid: `2025-01-15 10:00`, `2025-01-15 10:30`, `2025-01-15 11:00`, `2025-01-15 11:30`
   - Invalid: Slots spanning across midnight

3. **Consecutive Slots**: No gaps allowed between slots (1-second tolerance)
   - Valid: `10:00`, `10:30`, `11:00`, `11:30`
   - Invalid: `10:00`, `10:30`, `11:30` (missing `11:00`)

4. **Future Date**: All slots must be at least 5 seconds in the future

5. **Consultant Availability**: Slots must match consultant's schedule

### Example Scenarios

#### Example 1: 1.5-Hour Consultation

```typescript
// Consultation Plan
{
  durationInHours: 1.5,
  consultantProfile: { ... }
}

// Valid Slot Selection (3 slots × 30 min = 1.5 hours)
[
  "2025-02-15T14:00:00Z",  // 2:00 PM
  "2025-02-15T14:30:00Z",  // 2:30 PM
  "2025-02-15T15:00:00Z"   // 3:00 PM
]

// Creates 1 Appointment with 3 SlotOfAppointment records
```

#### Example 2: 3-Hour Consultation

```typescript
// Consultation Plan
{
  durationInHours: 3,
  consultantProfile: { ... }
}

// Valid Slot Selection (6 slots × 30 min = 3 hours)
[
  "2025-03-10T09:00:00Z",
  "2025-03-10T09:30:00Z",
  "2025-03-10T10:00:00Z",
  "2025-03-10T10:30:00Z",
  "2025-03-10T11:00:00Z",
  "2025-03-10T11:30:00Z"
]

// All on same day, consecutive, future date ✓
```

### Validation Code Location

- **Schema Validation**: `/schemas/slotAllocation/validationSchemas.ts`
- **Business Logic**: `/utils/slotAllocation/SlotValidationService.ts` (lines 377-433)
- **API Route**: `/app/api/events/consultations/[consultationId]/allocate/route.ts`

---

## 2. Subscriptions

### Characteristics

- **Type**: Recurring event
- **Participants**: One-on-one (consultant + consultee)
- **Duration**: Multiple months (configurable)
- **Session Duration**: Variable (configurable per subscription plan)
- **Scheduling**: Weekly limits enforced
- **Allocation**: Distributed slots across subscription period

### Database Schema

**Main Table**: `Subscription`

```typescript
{
  id: string (UUID)
  subscriptionPlanId: string
  requestedById: string
  requestStatus: RequestStatus (PENDING | APPROVED | REJECTED)
  startDate: DateTime
  endDate: DateTime
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Related Tables**:
- `SubscriptionPlan` - Defines duration, calls per week, session duration
- `Appointment` - Multiple appointment records (one per call)
- `SlotOfAppointment` - Multiple 30-minute slots per appointment

### Key Configuration Fields

```typescript
SubscriptionPlan {
  durationInMonths: number        // Total subscription length (e.g., 3 months)
  callsPerWeek: number           // Max calls per week (e.g., 2)
  sessionDurationInHours: number // Duration per call (e.g., 1.5 hours)
}
```

### Allocation Rules

1. **Weekly Limits**: Cannot exceed `callsPerWeek` in any Sunday-Saturday week
   - Example: 2 calls/week max → Cannot schedule 3 calls in same week

2. **Week Boundaries**: Weeks defined as Sunday 00:00 to Saturday 23:59
   - Uses `SlotCalculationService.countWeeks()` for accurate week counting

3. **Session Grouping**: Each call must be complete consecutive slots
   - 1.5-hour session = 3 consecutive slots on same day

4. **Scheduling Period**: All slots must fall within `[startDate, endDate]`

5. **Date Validation**: `startDate` must be before `endDate`

### Example Scenarios

#### Example 1: Basic Subscription (1 call/week, 1 month)

```typescript
// Subscription Plan
{
  durationInMonths: 1,
  callsPerWeek: 1,
  sessionDurationInHours: 1  // 2 slots per call
}

// Subscription Dates
startDate: 2025-01-06 (Monday)
endDate: 2025-02-02 (Sunday)

// Week Calculation
// Week 1: Sun Jan 5 - Sat Jan 11
// Week 2: Sun Jan 12 - Sat Jan 18
// Week 3: Sun Jan 19 - Sat Jan 25
// Week 4: Sun Jan 26 - Sat Feb 1
// Week 5: Sun Feb 2 - Sat Feb 8
// Total: 5 weeks × 1 call/week = 5 calls = 10 slots

// Valid Allocation Example
[
  // Week 1: Jan 8 (Wed) 10:00-11:00
  "2025-01-08T10:00:00Z", "2025-01-08T10:30:00Z",

  // Week 2: Jan 15 (Wed) 10:00-11:00
  "2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z",

  // Week 3: Jan 22 (Wed) 10:00-11:00
  "2025-01-22T10:00:00Z", "2025-01-22T10:30:00Z",

  // Week 4: Jan 29 (Wed) 10:00-11:00
  "2025-01-29T10:00:00Z", "2025-01-29T10:30:00Z",

  // Week 5: Feb 2 (Sun) 10:00-11:00
  "2025-02-02T10:00:00Z", "2025-02-02T10:30:00Z"
]

// Creates 5 Appointments, each with 2 SlotOfAppointment records
```

#### Example 2: Extended Subscription (2 calls/week, 2 months)

```typescript
// Subscription Plan
{
  durationInMonths: 2,
  callsPerWeek: 2,
  sessionDurationInHours: 1.5  // 3 slots per call
}

// Weekly Limit Enforcement
// Week of Jan 12: Can schedule max 2 calls (6 slots)
// Week of Jan 19: Can schedule max 2 calls (6 slots)
// etc.

// Invalid Example (Weekly Limit Violation)
[
  // Week of Jan 12: 3 calls scheduled (exceeds limit of 2)
  "2025-01-13T10:00:00Z", "2025-01-13T10:30:00Z", "2025-01-13T11:00:00Z",  // Call 1
  "2025-01-15T14:00:00Z", "2025-01-15T14:30:00Z", "2025-01-15T15:00:00Z",  // Call 2
  "2025-01-17T16:00:00Z", "2025-01-17T16:30:00Z", "2025-01-17T17:00:00Z"   // Call 3 ✗
]
// Error: "Week of 1/12/2025 exceeds call limit. Maximum 2 calls per week, but 3 calls are scheduled."
```

### Validation Code Location

- **Schema Validation**: `/schemas/slotAllocation/validationSchemas.ts`
- **Business Logic**: `/utils/slotAllocation/SlotValidationService.ts` (lines 439-458)
- **Subscription-Specific**: `/utils/subscriptionValidation.ts` (SubscriptionValidationService)
- **API Route**: `/app/api/events/subscriptions/[subscriptionId]/allocate/route.ts`

---

## 3. Webinars

### Characteristics

- **Type**: One-time event
- **Participants**: Group session (consultant + multiple attendees)
- **Duration**: Variable (configurable per webinar plan)
- **Scheduling**: Consultant selects single time slot
- **Allocation**: Single consecutive block of slots

### Database Schema

**Main Table**: `Webinar`

```typescript
{
  id: string (UUID)
  webinarPlanId: string
  status: string (DRAFT | SCHEDULED | COMPLETED | CANCELLED)
  startDate: DateTime (nullable)
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Related Tables**:
- `WebinarPlan` - Defines duration, price, max participants
- `Appointment` - Single appointment record for the webinar
- `SlotOfAppointment` - Multiple 30-minute slots for the appointment

### Allocation Rules

1. **Slot Count**: Exactly matches `durationInHours` from webinar plan
   - Example: 2-hour webinar = 4 slots

2. **Consecutive Slots**: All slots must be consecutive (1-second tolerance)
   - No same-day requirement (can span midnight if needed)

3. **Future Date**: All slots must be at least 5 seconds in the future

4. **Consultant Availability**: Slots must match consultant's schedule

### Example Scenarios

#### Example 1: 2-Hour Webinar

```typescript
// Webinar Plan
{
  durationInHours: 2,
  consultantProfile: { ... },
  maxParticipants: 50
}

// Valid Slot Selection (4 slots × 30 min = 2 hours)
[
  "2025-03-20T18:00:00Z",  // 6:00 PM
  "2025-03-20T18:30:00Z",  // 6:30 PM
  "2025-03-20T19:00:00Z",  // 7:00 PM
  "2025-03-20T19:30:00Z"   // 7:30 PM
]

// Creates 1 Appointment with 4 SlotOfAppointment records
// Status changes: DRAFT → SCHEDULED
```

#### Example 2: 1-Hour Webinar

```typescript
// Webinar Plan
{
  durationInHours: 1,
  maxParticipants: 100
}

// Valid Slot Selection (2 slots × 30 min = 1 hour)
[
  "2025-04-10T15:00:00Z",
  "2025-04-10T15:30:00Z"
]

// Consecutive check passes ✓
```

### Validation Code Location

- **Schema Validation**: `/schemas/slotAllocation/validationSchemas.ts`
- **Business Logic**: `/utils/slotAllocation/SlotValidationService.ts` (lines 460-509)
- **API Route**: `/app/api/events/webinars/[webinarId]/allocate/route.ts`

---

## 4. Classes

### Characteristics

- **Type**: Recurring event
- **Participants**: Group session (consultant + multiple students)
- **Duration**: Multiple months (configurable)
- **Session Duration**: Variable (configurable per class plan)
- **Scheduling**: Weekly limits enforced
- **Allocation**: Distributed sessions across class period

### Database Schema

**Main Table**: `Class`

```typescript
{
  id: string (UUID)
  classPlanId: string
  status: string (DRAFT | SCHEDULED | ONGOING | COMPLETED | CANCELLED)
  startDate: DateTime (nullable)
  endDate: DateTime (nullable)
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Related Tables**:
- `ClassPlan` - Defines duration, calls per week, session duration
- `ClassContent` - Individual topics/modules with hours allotted
- `Appointment` - Multiple appointment records (one per session)
- `SlotOfAppointment` - Multiple 30-minute slots per appointment

### Key Configuration Fields

```typescript
ClassPlan {
  durationInMonths: number        // Total class length (e.g., 6 months)
  callsPerWeek: number           // Max sessions per week (e.g., 3)
  sessionDurationInHours: number // Duration per session (e.g., 2 hours)
  maxStudents: number            // Max participants
  classContents: ClassContent[]  // Course modules
}
```

### Allocation Rules

1. **Weekly Limits**: Cannot exceed `callsPerWeek` in any Sunday-Saturday week
   - Example: 3 sessions/week max → Cannot schedule 4 sessions in same week

2. **Week Boundaries**: Weeks defined as Sunday 00:00 to Saturday 23:59

3. **Session Grouping**: Each session must be complete consecutive slots on same day
   - 2-hour session = 4 consecutive slots on same day

4. **Scheduling Period**: All slots must fall within `[startDate, endDate]`

5. **Date Validation**: `startDate` must be before `endDate`

### Example Scenarios

#### Example 1: Weekly Coding Class (3 sessions/week, 1 month)

```typescript
// Class Plan
{
  durationInMonths: 1,
  callsPerWeek: 3,
  sessionDurationInHours: 2,  // 4 slots per session
  maxStudents: 20,
  classContents: [
    { topic: "React Basics", hoursAllotted: 6 },
    { topic: "State Management", hoursAllotted: 6 },
    { topic: "API Integration", hoursAllotted: 6 }
  ]
}

// Class Dates
startDate: 2025-02-03 (Monday)
endDate: 2025-03-02 (Sunday)

// Week Calculation (5 weeks × 3 sessions = 15 sessions = 60 slots)
// Week 1: Sun Feb 2 - Sat Feb 8 (3 sessions max)
// Week 2: Sun Feb 9 - Sat Feb 15 (3 sessions max)
// Week 3: Sun Feb 16 - Sat Feb 22 (3 sessions max)
// Week 4: Sun Feb 23 - Sat Mar 1 (3 sessions max)
// Week 5: Sun Mar 2 - Sat Mar 8 (3 sessions max)

// Valid Allocation Example (Week 1)
[
  // Session 1: Monday Feb 3, 10:00-12:00
  "2025-02-03T10:00:00Z", "2025-02-03T10:30:00Z",
  "2025-02-03T11:00:00Z", "2025-02-03T11:30:00Z",

  // Session 2: Wednesday Feb 5, 10:00-12:00
  "2025-02-05T10:00:00Z", "2025-02-05T10:30:00Z",
  "2025-02-05T11:00:00Z", "2025-02-05T11:30:00Z",

  // Session 3: Friday Feb 7, 10:00-12:00
  "2025-02-07T10:00:00Z", "2025-02-07T10:30:00Z",
  "2025-02-07T11:00:00Z", "2025-02-07T11:30:00Z"
]

// Week 1: 3 sessions scheduled (within limit) ✓
```

#### Example 2: Invalid Session Grouping

```typescript
// Class Plan
{
  sessionDurationInHours: 2  // Requires 4 consecutive slots
}

// Invalid: Non-consecutive slots on same day
[
  "2025-02-03T10:00:00Z", "2025-02-03T10:30:00Z",
  "2025-02-03T11:00:00Z", "2025-02-03T12:00:00Z"  // Gap at 11:30
]
// Error: "Day Mon Feb 3 has non-consecutive slots"

// Invalid: Incomplete session
[
  "2025-02-03T10:00:00Z", "2025-02-03T10:30:00Z",
  "2025-02-03T11:00:00Z"  // Only 3 slots (needs 4)
]
// Error: "Day Mon Feb 3 has 3 slots but needs multiples of 4 (incomplete session)"
```

### Validation Code Location

- **Schema Validation**: `/schemas/slotAllocation/validationSchemas.ts`
- **Business Logic**: `/utils/slotAllocation/SlotValidationService.ts` (lines 511-606)
- **API Route**: `/app/api/events/classes/[classId]/allocate/route.ts`

---

## Event Type Comparison Table

| Feature | Consultations | Subscriptions | Webinars | Classes |
|---------|---------------|---------------|----------|---------|
| **Type** | One-time | Recurring | One-time | Recurring |
| **Participants** | 1-on-1 | 1-on-1 | Group | Group |
| **Weekly Limits** | No | Yes | No | Yes |
| **Same Day Requirement** | Yes | Per session | No | Per session |
| **Scheduling Period** | N/A | Yes | N/A | Yes |
| **Appointments Created** | 1 | Multiple | 1 | Multiple |
| **Status Field** | requestStatus | requestStatus | status | status |
| **Duration Source** | durationInHours | sessionDurationInHours | durationInHours | sessionDurationInHours |

---

## Common Validation Rules (All Event Types)

These validation rules apply to ALL event types:

1. **Future Slots**: All slots must be at least 5 seconds in the future
2. **No Conflicts**: Slots cannot overlap with existing approved appointments
3. **Consultant Availability**: Slots must match consultant's schedule (weekly or custom)
4. **Consecutive Tolerance**: 1-second tolerance for floating-point precision issues

---

## Event Type Determination in Code

```typescript
// API Route Pattern
/api/events/{eventType}/{eventId}/allocate
/api/events/{eventType}/{eventId}/validate

// Examples
/api/events/consultations/abc123/allocate
/api/events/subscriptions/def456/validate
/api/events/webinars/ghi789/allocate
/api/events/classes/jkl012/validate

// Service Usage
SlotAllocationService.allocate({
  eventType: "consultation" | "subscription" | "webinar" | "class",
  eventId: string,
  mode: "auto" | "manual" | "requested",
  slots?: string[]
})
```

---

## Next Steps

- **Validation Details**: See `04_VALIDATION_LAYERS.md` for validation architecture
- **Slot Mathematics**: See `05_SLOT_CALCULATIONS.md` for slot calculation formulas
- **API Usage**: See `06_API_REFERENCE.md` for complete API documentation
- **Bug Fixes**: See `07_BUG_FIXES_CHANGELOG.md` for recent improvements
