# Architecture Overview

This document provides a comprehensive overview of the booking algorithm system architecture, including service layers, database design, validation flow, and recent improvements.

## 📋 Table of Contents

1. [System Overview](#system-overview)
2. [Service Layer Architecture](#service-layer-architecture)
3. [Validation Architecture](#validation-architecture)
4. [Database Schema](#database-schema)
5. [API Routes](#api-routes)
6. [Key Services](#key-services)
7. [Recent Improvements](#recent-improvements)
8. [Design Patterns](#design-patterns)
9. [Data Flow](#data-flow)

## System Overview

The booking algorithm is a comprehensive time slot allocation system that manages scheduling for four event types: consultations, subscriptions, webinars, and classes. The system ensures conflict-free scheduling, validates business rules, and provides three allocation modes (auto, manual, requested).

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (Next.js)                     │
│   - Request validation dialogs                              │
│   - Slot selection calendars                                │
│   - Appointment management                                  │
└────────────────┬────────────────────────────────────────────┘
                 │ HTTP POST/PATCH
                 │
┌────────────────▼────────────────────────────────────────────┐
│                    API Routes (8 endpoints)                 │
│   /api/events/consultations/:id/allocate                    │
│   /api/events/consultations/:id/validate                    │
│   /api/events/subscriptions/:id/allocate                    │
│   /api/events/subscriptions/:id/validate                    │
│   /api/events/webinars/:id/allocate                         │
│   /api/events/webinars/:id/validate                         │
│   /api/events/classes/:id/allocate                          │
│   /api/events/classes/:id/validate                          │
└────────────────┬────────────────────────────────────────────┘
                 │
        ┌────────▼────────┐
        │ Zod Validation  │  Layer 1: Input Validation
        │   (Type-Safe)   │  - allocationRequestSchema
        └────────┬────────┘  - validationRequestSchema
                 │            - eventIdSchema
        ┌────────▼─────────────────────────────────────────────┐
        │         Service Layer (Business Logic)               │
        │  ┌──────────────────────────────────────────────┐   │
        │  │ SlotAllocationService                         │   │
        │  │  - allocate()                                 │   │
        │  │  - auto/manual/requested modes                │   │
        │  └──────────────────────────────────────────────┘   │
        │  ┌──────────────────────────────────────────────┐   │
        │  │ SlotValidationService                         │   │
        │  │  - validate()                                 │   │
        │  │  - checkConflicts()                           │   │
        │  │  - checkAvailability()                        │   │
        │  └──────────────────────────────────────────────┘   │
        │  ┌──────────────────────────────────────────────┐   │
        │  │ SubscriptionValidationService                 │   │
        │  │  - validateWeeklyLimits()                     │   │
        │  │  - validateTotalCalls()                       │   │
        │  └──────────────────────────────────────────────┘   │
        │  ┌──────────────────────────────────────────────┐   │
        │  │ SlotCalculationService                        │   │
        │  │  - calculateWeekNumber()                      │   │
        │  │  - areConsecutive()                           │   │
        │  └──────────────────────────────────────────────┘   │
        └────────┬─────────────────────────────────────────────┘
                 │
        ┌────────▼────────┐
        │ Prisma Client   │  Layer 3: Database Persistence
        │  (PostgreSQL)   │  - Transactions
        └─────────────────┘  - Relations
```

## Service Layer Architecture

### Core Services

#### 1. SlotAllocationService

**Location**: `utils/slotAllocation/SlotAllocationService.ts`

**Purpose**: Central service for allocating time slots across all event types

**Key Methods**:
- `allocate(params: AllocationParams)` - Main allocation method supporting three modes
- `allocateConsultation()` - Consultation-specific allocation
- `allocateSubscription()` - Subscription-specific allocation with weekly limits
- `allocateWebinar()` - Single-slot webinar allocation
- `allocateClass()` - Multi-session class allocation

**Allocation Modes**:
```typescript
type AllocationMode = 'auto' | 'manual' | 'requested';

// Auto Mode - System finds available slots
await SlotAllocationService.allocate({
  eventType: 'consultation',
  eventId: 'uuid',
  mode: 'auto',
});

// Manual Mode - User selects specific slots
await SlotAllocationService.allocate({
  eventType: 'consultation',
  eventId: 'uuid',
  mode: 'manual',
  slots: ['2025-01-15T10:00:00Z', '2025-01-15T10:30:00Z'],
});

// Requested Mode - Uses consultee's pre-selected slots
await SlotAllocationService.allocate({
  eventType: 'consultation',
  eventId: 'uuid',
  mode: 'requested',
});
```

**Key Features**:
- Transactional operations (all-or-nothing allocation)
- Automatic conflict detection
- Consultant availability validation
- Event status updates (PENDING → APPROVED/SCHEDULED)
- Warning system for edge cases

#### 2. SlotValidationService

**Location**: `utils/slotAllocation/SlotValidationService.ts`

**Purpose**: Validates time slots against business rules without creating appointments

**Key Methods**:
- `validate(eventType, eventId, slots, consultantProfile, options)` - Main validation
- `checkConflicts(slots, userId)` - Time range overlap detection
- `checkAvailability(slots, consultantProfile)` - Availability matching
- `validateConsecutive(slots)` - Ensures slots are adjacent
- `validateFutureSlots(slots)` - Ensures slots are not in the past

**Return Type**:
```typescript
interface ValidationResult {
  isValid: boolean;
  conflicts: Date[];           // Already booked slots
  outsideAvailability: Date[]; // Slots outside consultant's schedule
  validSlots: Date[];          // Available slots
}
```

**Usage Example**:
```typescript
const validationService = new SlotValidationService(prisma);
const result = await validationService.validate(
  'consultation',
  consultationId,
  [new Date('2025-01-15T10:00:00Z')],
  consultantProfile,
  { durationInHours: 1 }
);

if (!result.isValid) {
  console.log('Conflicts:', result.conflicts);
  console.log('Outside availability:', result.outsideAvailability);
}
```

#### 3. SubscriptionValidationService

**Location**: `utils/slotAllocation/SubscriptionValidationService.ts` (part of SlotAllocationService)

**Purpose**: Enforces subscription-specific business rules

**Key Validations**:
- **Weekly Call Limits**: Ensures `callsPerWeek` constraint is respected
- **Total Call Limits**: Ensures total appointments ≤ `totalCalls`
- **Week Distribution**: Validates slots are distributed across subscription period
- **Scheduling Period**: Validates slots fall within start/end dates

**Example Business Rules**:
```typescript
// Subscription with 2 calls/week, 8 total calls, over 4 weeks
const subscription = {
  callsPerWeek: 2,
  totalCalls: 8,
  durationInWeeks: 4,
  startDate: new Date('2025-01-01'),
  endDate: new Date('2025-01-29'),
};

// Valid allocation: 2 calls in week 1, 2 in week 2, etc.
const validSlots = [
  '2025-01-02T10:00:00Z', // Week 1, Call 1
  '2025-01-03T10:00:00Z', // Week 1, Call 2
  '2025-01-09T10:00:00Z', // Week 2, Call 1
  '2025-01-10T10:00:00Z', // Week 2, Call 2
  // ... total 8 calls
];

// Invalid: 3 calls in week 1 (exceeds callsPerWeek)
const invalidSlots = [
  '2025-01-02T10:00:00Z',
  '2025-01-03T10:00:00Z',
  '2025-01-04T10:00:00Z', // ❌ Third call in same week
];
```

#### 4. SlotCalculationService

**Location**: `utils/slotAllocation/SlotCalculationService.ts`

**Purpose**: Time slot mathematics and calculations

**Key Methods**:
- `calculateWeekNumber(date, subscriptionStart)` - Week index calculation
- `areConsecutive(slots)` - Checks if slots are adjacent 30-min blocks
- `getSlotDuration(startSlot, slotsPerSession)` - Calculates total duration
- `isWithinSchedulingPeriod(slot, start, end)` - Date range validation

**Week Calculation Algorithm**:
```typescript
// Formula: weekNumber = floor(daysSinceStart / 7) + 1
// Week 1: Days 0-6 from start
// Week 2: Days 7-13 from start
// etc.

function calculateWeekNumber(slotDate: Date, startDate: Date): number {
  const diffMs = slotDate.getTime() - startDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + 1;
}
```

## Validation Architecture

The system uses a **3-layer validation approach** to ensure data integrity and business rule compliance:

### Layer 1: Zod Schema Validation (Input Validation)

**Location**: `schemas/slotAllocation/validationSchemas.ts`

**Purpose**: Type-safe runtime validation with automatic TypeScript type inference

**Migration**: Originally used custom `InputValidator` (208 lines), migrated to Zod in December 2024, reducing code by ~75%

**Key Schemas**:

#### allocationRequestSchema
```typescript
export const allocationRequestSchema = z
  .object({
    isAuto: z.boolean({
      required_error: "'isAuto' is required",
      invalid_type_error: "'isAuto' must be a boolean (true/false)",
    }),
    useRequestedSlots: z.boolean({
      invalid_type_error: "'useRequestedSlots' must be a boolean",
    }).optional(),
    slots: z.array(
      z.string().datetime({
        message: "Each slot must be a valid ISO 8601 datetime string",
      }),
    ).optional(),
  })
  .refine(
    (data) => {
      // Manual mode requires slots
      if (!data.isAuto && !data.useRequestedSlots) {
        return data.slots && data.slots.length > 0;
      }
      return true;
    },
    {
      message: "Manual allocation requires 'slots' array",
      path: ["slots"],
    }
  );

// Automatic type inference
export type AllocationRequest = z.infer<typeof allocationRequestSchema>;
```

#### validationRequestSchema
```typescript
export const validationRequestSchema = z.object({
  slots: z.array(
    z.string().datetime({
      message: "Each slot must be a valid ISO 8601 datetime string",
    }),
  ).min(1, {
    message: "'slots' array must contain at least one time slot",
  }),
});
```

#### eventIdSchema
```typescript
export const eventIdSchema = z.string().uuid({
  message: "Event ID must be a valid UUID format",
});
```

**Benefits of Zod**:
- ✅ Automatic TypeScript type inference (`z.infer<typeof schema>`)
- ✅ Declarative schema definition (vs imperative validation logic)
- ✅ Industry-standard library (46M+ weekly downloads)
- ✅ Built-in error message formatting
- ✅ Composable and reusable schemas
- ✅ ~75% less code than custom validator

**Usage in API Routes**:
```typescript
export async function PATCH(request: NextRequest, { params }) {
  try {
    const { consultationId } = await params;

    // Validate event ID
    eventIdSchema.parse(consultationId);

    // Validate and parse request body (automatic type inference!)
    const body = allocationRequestSchema.parse(await request.json());
    // TypeScript now knows: body = { isAuto: boolean; slots?: string[]; ... }

    // Continue with allocation...
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("; ");
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }
    throw error;
  }
}
```

### Layer 2: Business Logic Validation

**Implemented by**: `SlotValidationService` and `SubscriptionValidationService`

**Validations**:

#### Universal Rules (All Event Types)
- ✅ Slots are in the future
- ✅ No time range overlaps with existing appointments
- ✅ Slots match consultant's availability (weekly or custom schedule)
- ✅ Slots are consecutive (for multi-slot sessions)

#### Event-Specific Rules

**Consultations**:
- Duration matches requested session length
- Single appointment with N consecutive slots

**Subscriptions**:
- Weekly call limits respected (`callsPerWeek`)
- Total call limits respected (`totalCalls`)
- Slots distributed across subscription period
- Slots within scheduling period (start/end dates)

**Webinars**:
- Exactly 1 slot required
- Slot must be in the future

**Classes**:
- Multiple appointments (one per session)
- Each appointment has correct number of slots
- Weekly distribution respected

### Layer 3: Database Validation

**Implemented by**: Prisma schema constraints and transactions

**Constraints**:
- Foreign key relationships
- NOT NULL constraints
- ENUM validations (AppointmentType, RequestStatus, etc.)
- Unique constraints where applicable

**Transaction Safety**:
```typescript
await prisma.$transaction(async (tx) => {
  // All operations succeed or all fail
  const appointment = await tx.appointment.create({ ... });
  await tx.consultation.update({ ... });
  await tx.slot.createMany({ ... });
});
```

## Database Schema

### Core Models

#### Consultation
```prisma
model Consultation {
  id                    String         @id @default(uuid())
  requestStatus         RequestStatus  @default(PENDING)
  consulteeProfile      ConsulteeProfile @relation(...)
  consultationPlan      ConsultationPlan @relation(...)
  appointment           Appointment?   @relation(...)
  // ... other fields
}
```

#### Subscription
```prisma
model Subscription {
  id                    String         @id @default(uuid())
  requestStatus         RequestStatus  @default(PENDING)
  durationInWeeks       Int
  callsPerWeek          Int
  totalCalls            Int            // callsPerWeek * durationInWeeks
  consulteeProfile      ConsulteeProfile @relation(...)
  subscriptionPlan      SubscriptionPlan @relation(...)
  appointments          Appointment[]  @relation(...)
  // ... other fields
}
```

#### Appointment
```prisma
model Appointment {
  id                    String            @id @default(uuid())
  appointmentType       AppointmentsType  // CONSULTATION | SUBSCRIPTION | WEBINAR | CLASS
  consultation          Consultation?     @relation(...)
  subscription          Subscription?     @relation(...)
  webinar               Webinar?          @relation(...)
  class                 Class?            @relation(...)
  slotsOfAppointment    Slot[]            @relation(...)
  createdAt             DateTime          @default(now())
  updatedAt             DateTime          @updatedAt
}
```

#### Slot
```prisma
model Slot {
  id                    String      @id @default(uuid())
  slotStartTimeInUTC    DateTime
  slotEndTimeInUTC      DateTime
  isTentative           Boolean     @default(false)
  user                  User[]      @relation(...)
  appointment           Appointment @relation(...)
  // ... other fields
}
```

### Key Relationships

```
Consultation (1) ──── (0..1) Appointment ──── (N) Slot
Subscription (1) ──── (0..N) Appointment ──── (N) Slot
Webinar (1)      ──── (0..1) Appointment ──── (1) Slot
Class (1)        ──── (0..N) Appointment ──── (N) Slot

ConsultantProfile (1) ──── (N) Slot (availability)
User (N) ──── (N) Slot (booked slots)
```

## API Routes

### Route Structure

All routes follow the same pattern:
```
/api/events/{eventType}/{eventId}/{action}
```

### 8 Endpoints

#### Allocate Endpoints (4)
- `PATCH /api/events/consultations/:id/allocate`
- `PATCH /api/events/subscriptions/:id/allocate`
- `PATCH /api/events/webinars/:id/allocate`
- `PATCH /api/events/classes/:id/allocate`

**Request Body**:
```typescript
{
  isAuto: boolean;
  useRequestedSlots?: boolean;
  slots?: string[]; // ISO 8601 datetime strings
}
```

**Response (Success)**:
```typescript
{
  data: Appointment[];
  warnings?: string[];
}
```

#### Validate Endpoints (4)
- `POST /api/events/consultations/:id/validate`
- `POST /api/events/subscriptions/:id/validate`
- `POST /api/events/webinars/:id/validate`
- `POST /api/events/classes/:id/validate`

**Request Body**:
```typescript
{
  slots: string[]; // ISO 8601 datetime strings
}
```

**Response**:
```typescript
{
  data: {
    conflicts: string[];           // Already booked slots
    outsideAvailability: string[]; // Slots outside schedule
    validSlots: string[];          // Available slots
  }
}
```

### Error Handling

**400 Bad Request** - Zod validation errors
```json
{
  "error": "slots: Each slot must be a valid ISO 8601 datetime string"
}
```

**404 Not Found** - Event not found
```json
{
  "error": "Consultation not found"
}
```

**500 Internal Server Error** - Business logic or database errors
```json
{
  "error": "Weekly call limit exceeded"
}
```

## Recent Improvements

### December 2024 - Major Refactor

#### 1. Zod Migration ✅

**Before**: Custom `InputValidator` class (208 lines)
```typescript
// Old approach - Imperative validation
class InputValidator {
  static validateAllocationRequest(body: unknown) {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Request body must be an object');
    }
    if (typeof body.isAuto !== 'boolean') {
      throw new Error('isAuto must be a boolean');
    }
    // ... 200+ more lines of imperative checks
  }
}

// Usage
try {
  InputValidator.validateAllocationRequest(body);
} catch (error) {
  return NextResponse.json({ error: error.message }, { status: 400 });
}
```

**After**: Zod schemas (50 lines)
```typescript
// New approach - Declarative validation
const allocationRequestSchema = z.object({
  isAuto: z.boolean({
    required_error: "'isAuto' is required",
  }),
  slots: z.array(z.string().datetime()).optional(),
}).refine(/* business logic */);

// Usage with automatic type inference
const body = allocationRequestSchema.parse(await request.json());
// TypeScript knows the exact type without manual interface!
```

**Benefits**:
- ✅ 75% code reduction (208 → 50 lines)
- ✅ Automatic TypeScript type inference
- ✅ Industry-standard library (Zod v3.25.67 already installed)
- ✅ Better error messages with path information
- ✅ Declarative and composable

#### 2. 10 Critical Bugs Fixed ✅

See [07_BUG_FIXES_CHANGELOG.md](./07_BUG_FIXES_CHANGELOG.md) for detailed list. Key fixes include:

1. **Double-booking prevention** - Fixed time range overlap detection
2. **Consecutive slot validation** - Proper 30-minute gap checking
3. **Weekly limit enforcement** - Server-side subscription validation
4. **Duration validation** - Centralized slot count checks
5. **Scheduling period enforcement** - Server-side date range validation
6. **Error message improvements** - Detailed validation paths
7. **Transaction safety** - Atomic updates for all allocations
8. **Timezone consistency** - Proper UTC handling throughout
9. **Request status updates** - Consistent PENDING → APPROVED flow
10. **Conflict detection** - Multi-event type conflict checking

#### 3. Documentation Overhaul ✅

**Created**:
- Comprehensive 10-document system (00-09 numbered files)
- ~175 KB of documentation
- Quick Start Guide for 15-minute onboarding
- Complete API reference with examples
- Troubleshooting guide with common solutions
- Testing guide with Jest examples

**Deleted**:
- Old `docs/algorithm/` folder (~1236 lines of .txt files)
- Scattered root-level docs (EVENT_TYPES_AND_SCHEDULING.md, etc.)

#### 4. Code Comments ✅

Added comprehensive inline comments across all services:
- Layer identification (Layer 1, Layer 2, Layer 3)
- Business rule explanations
- Algorithm descriptions
- Edge case handling
- Type safety notes

## Design Patterns

### 1. Service Layer Pattern

**Separation of Concerns**:
- **API Routes**: HTTP handling, request/response formatting
- **Services**: Business logic, validation, data manipulation
- **Prisma**: Data persistence, transactions

### 2. Strategy Pattern

**Allocation Modes**:
```typescript
interface AllocationStrategy {
  allocate(params: AllocationParams): Promise<Appointment[]>;
}

class AutoAllocationStrategy implements AllocationStrategy {
  async allocate(params) {
    // Find available slots automatically
  }
}

class ManualAllocationStrategy implements AllocationStrategy {
  async allocate(params) {
    // Use user-provided slots
  }
}

class RequestedAllocationStrategy implements AllocationStrategy {
  async allocate(params) {
    // Use consultee's pre-selected slots
  }
}
```

### 3. Repository Pattern

**Database Abstraction**:
```typescript
// Service doesn't know about Prisma specifics
class SlotAllocationService {
  async allocate(params) {
    return await prisma.$transaction(async (tx) => {
      // Business logic uses transaction
    });
  }
}
```

### 4. Builder Pattern

**Zod Schema Composition**:
```typescript
const baseSlotSchema = z.string().datetime();
const slotsArraySchema = z.array(baseSlotSchema);
const allocationRequestSchema = z.object({
  isAuto: z.boolean(),
  slots: slotsArraySchema.optional(),
}).refine(/* custom logic */);
```

## Data Flow

### Allocation Flow (Manual Mode)

```
1. Frontend: User selects slots in calendar
   │
2. Frontend: POST /api/events/consultations/:id/validate
   │           { slots: ["2025-01-15T10:00:00Z", ...] }
   │
3. API Route: Zod validation (Layer 1)
   │           ↓ Valid
4. SlotValidationService: Business rule validation (Layer 2)
   │           ↓ Check conflicts
   │           ↓ Check availability
   │           ↓ Check consecutive
   │
5. API Route: Return validation result
   │           { data: { validSlots, conflicts, outsideAvailability } }
   │
6. Frontend: Display green/red indicators
   │           User confirms selection
   │
7. Frontend: PATCH /api/events/consultations/:id/allocate
   │           { isAuto: false, slots: [...] }
   │
8. API Route: Zod validation (Layer 1)
   │           ↓ Valid
9. SlotAllocationService: Business logic (Layer 2)
   │           ↓ Validate again (prevent TOCTOU)
   │           ↓ Begin transaction
   │
10. Database: Create appointment + slots (Layer 3)
    │          Update consultation status
    │          Commit transaction
    │
11. API Route: Return created appointments
    │           { data: [{ id, appointmentType, slotsOfAppointment }] }
    │
12. Frontend: Show success, update UI
```

### Auto-Allocation Flow

```
1. Frontend: User clicks "Auto-allocate"
   │
2. Frontend: PATCH /api/events/consultations/:id/allocate
   │           { isAuto: true }
   │
3. API Route: Zod validation
   │           ↓ Valid
4. SlotAllocationService: Find available slots
   │           ↓ Get consultant availability
   │           ↓ Get existing appointments
   │           ↓ Find first N available consecutive slots
   │           ↓ Begin transaction
   │
5. Database: Create appointment + slots
    │          Update consultation status
    │          Commit transaction
    │
6. API Route: Return created appointments
   │
7. Frontend: Show allocated slots, update UI
```

## Performance Considerations

### Database Optimization

1. **Transactions**: All allocations use transactions to prevent partial updates
2. **Indexes**: Ensure indexes on:
   - `Slot.slotStartTimeInUTC`
   - `Slot.slotEndTimeInUTC`
   - `Appointment.appointmentType`
   - Foreign keys (automatic in PostgreSQL)

### Query Optimization

```typescript
// Good: Fetch related data in single query
const consultation = await prisma.consultation.findUnique({
  where: { id },
  include: {
    consultationPlan: {
      include: {
        consultantProfile: {
          select: {
            scheduleType: true,
            slotsOfAvailabilityWeekly: true,
            slotsOfAvailabilityCustom: true,
          },
        },
      },
    },
  },
});

// Bad: Multiple queries (N+1 problem)
const consultation = await prisma.consultation.findUnique({ where: { id } });
const plan = await prisma.consultationPlan.findUnique({ where: { id: consultation.planId } });
const consultant = await prisma.consultantProfile.findUnique({ where: { id: plan.consultantId } });
```

### Conflict Detection Optimization

```typescript
// Efficient: Single query for all conflicts
const conflicts = await prisma.appointment.findMany({
  where: {
    AND: [
      {
        OR: [
          { subscription: { requestStatus: 'APPROVED' } },
          { consultation: { requestStatus: 'APPROVED' } },
          { webinar: { status: 'SCHEDULED' } },
          { class: { status: 'SCHEDULED' } },
        ],
      },
      {
        slotsOfAppointment: {
          some: {
            slotStartTimeInUTC: { in: slotsToCheck },
          },
        },
      },
    ],
  },
  include: { slotsOfAppointment: true },
});
```

## Testing Strategy

See [09_TESTING_GUIDE.md](./09_TESTING_GUIDE.md) for comprehensive testing guide.

**Test Levels**:
1. **Unit Tests**: Individual service methods
2. **Integration Tests**: API routes with database
3. **E2E Tests**: Full user flows

**Key Test Cases**:
- ✅ Conflict detection (overlapping time ranges)
- ✅ Consecutive slot validation
- ✅ Weekly limit enforcement (subscriptions)
- ✅ Auto-allocation slot finding
- ✅ Timezone handling (UTC storage, local display)
- ✅ Transaction rollbacks on errors
- ✅ Error message formatting

## Future Enhancements

### Potential Improvements

1. **Caching**: Cache consultant availability for faster validation
2. **Rate Limiting**: Prevent abuse of allocation endpoints
3. **Webhooks**: Notify external systems of booking events
4. **Recurring Patterns**: Support complex recurrence rules
5. **Bulk Operations**: Allocate multiple events at once
6. **Analytics**: Track allocation success rates, peak times
7. **A/B Testing**: Test different auto-allocation algorithms

### Scalability Considerations

1. **Database Sharding**: Partition by consultant ID or date range
2. **Read Replicas**: Offload validation queries to read replicas
3. **Queue System**: Handle allocation requests asynchronously for high volume
4. **Microservices**: Split allocation service from other business logic

---

## Summary

The booking algorithm system is a robust, type-safe, and well-documented slot allocation platform. Key strengths:

- ✅ **3-Layer Validation**: Input (Zod) → Business Logic → Database
- ✅ **Type Safety**: Automatic TypeScript inference via Zod
- ✅ **Flexible Modes**: Auto, Manual, and Requested allocation
- ✅ **Conflict Prevention**: Time range overlap detection
- ✅ **Transaction Safety**: Atomic updates with Prisma
- ✅ **Comprehensive Docs**: 10-document system (~175 KB)
- ✅ **10 Critical Bugs Fixed**: See changelog for details

For implementation details, see:
- [Quick Start Guide](./01_QUICK_START.md)
- [API Reference](./06_API_REFERENCE.md)
- [Testing Guide](./09_TESTING_GUIDE.md)
