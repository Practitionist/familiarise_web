# Validation Layers Architecture

This document explains the three-layer validation system used throughout the booking algorithm.

## Overview

The booking algorithm uses a defense-in-depth approach with three distinct validation layers:

```
Request → Layer 1: Zod Schemas → Layer 2: Business Rules → Layer 3: Subscription-Specific → Database
                 (Type Safety)      (Universal + Event)     (Weekly Limits)
```

Each layer serves a specific purpose and catches different types of errors.

---

## Layer 1: Zod Schema Validation

**Location**: `/schemas/slotAllocation/validationSchemas.ts`

**Purpose**: Type-safe input validation with automatic TypeScript type inference

**When It Runs**: Immediately upon receiving API request, before any business logic

### Why Zod?

Zod provides several advantages over manual validation:

1. **Type Inference**: Automatic TypeScript types derived from schemas
2. **Declarative**: Define validation rules once, use everywhere
3. **Rich Errors**: Detailed validation messages out of the box
4. **Industry Standard**: Used by Vercel, tRPC, Remix, etc.
5. **Composable**: Schemas can be combined and reused

### Schemas Defined

#### 1. Allocation Request Schema

Validates requests to allocate slots:

```typescript
export const allocationRequestSchema = z
  .object({
    isAuto: z.boolean({
      required_error: "'isAuto' is required",
      invalid_type_error: "'isAuto' must be a boolean (true/false)",
    }),

    useRequestedSlots: z
      .boolean({
        invalid_type_error: "'useRequestedSlots' must be a boolean",
      })
      .optional(),

    slots: z
      .array(
        z.string().datetime({
          message:
            "Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')",
        }),
      )
      .optional(),
  })
  .refine(
    (data) => {
      // Auto allocation: no slots needed
      if (data.isAuto) return true;

      // Using requested slots: no manual slots needed
      if (data.useRequestedSlots) return true;

      // Manual allocation: slots array is required
      return data.slots && data.slots.length > 0;
    },
    {
      message:
        "Manual allocation requires 'slots' array with at least one time slot",
      path: ["slots"],
    },
  );
```

**What It Validates**:

- `isAuto` is a boolean (required)
- `useRequestedSlots` is a boolean (optional)
- `slots` is an array of ISO 8601 datetime strings (optional)
- **Business Rule**: Manual allocation requires slots unless using requested slots

**Example Valid Inputs**:

```typescript
// Auto allocation
{ isAuto: true }

// Manual allocation
{ isAuto: false, slots: ["2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z"] }

// Using requested slots
{ isAuto: false, useRequestedSlots: true }
```

**Example Invalid Inputs**:

```typescript
// Missing isAuto
{ slots: ["2025-01-15T10:00:00Z"] }
// Error: "'isAuto' is required"

// Manual allocation without slots
{ isAuto: false }
// Error: "Manual allocation requires 'slots' array with at least one time slot"

// Invalid datetime format
{ isAuto: false, slots: ["2025-01-15"] }
// Error: "Each slot must be a valid ISO 8601 datetime string"

// Wrong type for isAuto
{ isAuto: "true" }
// Error: "'isAuto' must be a boolean (true/false)"
```

#### 2. Validation Request Schema

Validates requests to validate slots:

```typescript
export const validationRequestSchema = z.object({
  slots: z
    .array(
      z.string().datetime({
        message:
          "Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')",
      }),
    )
    .min(1, {
      message: "'slots' array must contain at least one time slot to validate",
    }),
});
```

**What It Validates**:

- `slots` is an array of ISO 8601 datetime strings (required)
- Array must contain at least one slot

#### 3. Event ID Schema

Validates event IDs in URL parameters:

```typescript
export const eventIdSchema = z.string().uuid({
  message: "Event ID must be a valid UUID format",
});
```

**What It Validates**:

- ID is a valid UUID v4 format
- Example: `"123e4567-e89b-12d3-a456-426614174000"`

### Error Formatting

Zod errors are formatted into user-friendly messages:

```typescript
export function formatZodError(error: z.ZodError): string {
  return error.errors
    .map((err) => {
      const path = err.path.join(".");
      return path ? `${path}: ${err.message}` : err.message;
    })
    .join("; ");
}
```

**Example Error Output**:

```typescript
// Input: { isAuto: "yes", slots: ["invalid-date"] }
// Output: "isAuto: Expected boolean, received string; slots.0: Invalid datetime"
```

### Usage in API Routes

```typescript
// app/api/events/consultations/[consultationId]/allocate/route.ts

export async function PATCH(request: NextRequest, { params }) {
  try {
    const { consultationId } = await params;

    // LAYER 1: Zod Schema Validation
    try {
      // Validate consultation ID from URL params
      eventIdSchema.parse(consultationId);

      // Validate request body and get typed data
      const body = allocationRequestSchema.parse(await request.json());

      // TypeScript now knows exact type of 'body'
      // body.isAuto is boolean
      // body.slots is string[] | undefined
      // body.useRequestedSlots is boolean | undefined

      // ... proceed to Layer 2 ...
    } catch (validationError) {
      // Zod validation errors - return 400 Bad Request
      if (validationError instanceof ZodError) {
        const errorMessage = formatZodError(validationError);
        return NextResponse.json({ error: errorMessage }, { status: 400 });
      }
      throw validationError;
    }
  } catch (error) {
    // ... handle other errors ...
  }
}
```

---

## Layer 2: Business Rules Validation

**Location**: `/utils/slotAllocation/SlotValidationService.ts`

**Purpose**: Validate business logic rules (conflicts, availability, consecutive slots, etc.)

**When It Runs**: After Zod validation passes, before database operations

### Architecture

The `SlotValidationService` class provides a unified validation entry point:

```typescript
export class SlotValidationService {
  async validate(
    eventType: EventType,
    eventId: string,
    slots: Date[],
    consultant: ConsultantAllocationData,
    config: EventConfig,
  ): Promise<ValidationResult> {
    // Universal validations (apply to all event types)
    const futureCheck = this.validateSlotsInFuture(slots);
    if (!futureCheck.isValid) return futureCheck;

    const scheduleCheck = this.validateMatchesSchedule(slots, consultant);
    if (!scheduleCheck.isValid) return scheduleCheck;

    const conflictCheck = await this.validateNoConflicts(
      slots,
      consultant.userId,
    );
    if (!conflictCheck.isValid) return conflictCheck;

    const periodCheck = this.validateSchedulingPeriod(
      slots,
      config.startDate,
      config.endDate,
    );
    if (!periodCheck.isValid) return periodCheck;

    // Event-specific validations
    switch (eventType) {
      case "consultation":
        return this.validateConsultation(slots, config);
      case "subscription":
        return this.validateSubscription(eventId, slots, config);
      case "webinar":
        return this.validateWebinar(slots, config);
      case "class":
        return this.validateClass(slots, config);
    }
  }
}
```

### Universal Validators

These validators apply to ALL event types:

#### 1. Future Slots Validator

```typescript
private validateSlotsInFuture(slots: Date[]): ValidationResult {
  const now = new Date();
  const BUFFER_MS = 5000; // 5-second processing time buffer
  const cutoff = new Date(now.getTime() + BUFFER_MS);
  const errors: string[] = [];

  for (const slot of slots) {
    if (slot < cutoff) {
      const secondsUntilSlot = (slot.getTime() - now.getTime()) / 1000;
      errors.push(
        `Cannot allocate slots in the past or too soon: ${slot.toLocaleString()} ` +
          `(${secondsUntilSlot >= 0 ? `only ${secondsUntilSlot.toFixed(1)}s` : `${Math.abs(secondsUntilSlot).toFixed(1)}s ago`}). ` +
          `Slots must be at least 5 seconds in the future to allow for processing time.`,
      );
    }
  }

  return { isValid: errors.length === 0, errors, warnings: [] };
}
```

**What It Validates**:

- All slots are at least 5 seconds in the future
- 5-second buffer prevents race conditions during processing

**Example Error**:

```
"Cannot allocate slots in the past or too soon: 1/15/2025, 10:00:00 AM (only 2.1s).
Slots must be at least 5 seconds in the future to allow for processing time."
```

#### 2. Conflict Validator

```typescript
private async validateNoConflicts(
  slots: Date[],
  consultantUserId: string,
): Promise<ValidationResult> {
  const errors: string[] = [];

  for (const slot of slots) {
    // Calculate the end time of the proposed slot (30-minute slots)
    const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000);

    const existingAppointment = await this.prismaClient.appointment.findFirst({
      where: {
        AND: [
          {
            OR: [
              { subscription: { requestStatus: RequestStatus.APPROVED } },
              { consultation: { requestStatus: RequestStatus.APPROVED } },
              { webinar: { status: "SCHEDULED" } },
              { class: { status: "SCHEDULED" } },
            ],
          },
          {
            slotsOfAppointment: {
              some: {
                // CRITICAL: Check for range overlap, not exact match
                AND: [
                  { slotStartTimeInUTC: { lt: slotEnd } },     // Existing starts before proposed ends
                  { slotEndTimeInUTC: { gt: slot } },          // Existing ends after proposed starts
                ],
                user: {
                  some: { id: consultantUserId },
                },
              },
            },
          },
        ],
      },
      include: {
        consultation: { include: { consultationPlan: true, requestedBy: { include: { user: true } } } },
        subscription: { include: { subscriptionPlan: true, requestedBy: { include: { user: true } } } },
      },
    });

    if (existingAppointment) {
      let conflictDetails = `${slot.toLocaleString()}`;
      if (existingAppointment.consultation) {
        conflictDetails += ` (conflicts with consultation for ${existingAppointment.consultation.requestedBy?.user?.name || "unknown"})`;
      } else if (existingAppointment.subscription) {
        conflictDetails += ` (conflicts with subscription for ${existingAppointment.subscription.requestedBy?.user?.name || "unknown"})`;
      }
      errors.push(`Slot already booked: ${conflictDetails}`);
    }
  }

  return { isValid: errors.length === 0, errors, warnings: [] };
}
```

**What It Validates**:

- Slots don't overlap with existing approved appointments
- Uses range overlap detection (not just exact match)
- Checks all appointment types (consultations, subscriptions, webinars, classes)

**Range Overlap Logic**:

```
Slot A: [10:00, 10:30]
Slot B: [10:15, 10:45]

Overlap if: A.start < B.end AND B.start < A.end
           10:00 < 10:45 AND 10:15 < 10:30
           true AND true = OVERLAP DETECTED
```

**Example Error**:

```
"Slot already booked: 1/15/2025, 10:00:00 AM (conflicts with consultation for John Doe)"
```

#### 3. Schedule Matcher Validator

```typescript
private validateMatchesSchedule(
  slots: Date[],
  consultant: ConsultantAllocationData,
): ValidationResult {
  const errors: string[] = [];

  if (consultant.scheduleType === ScheduleType.WEEKLY) {
    // Create a set of valid day+time patterns
    const validPatterns = new Set<string>();
    for (const slot of consultant.slotsOfAvailabilityWeekly) {
      const slotDay = new Date(slot.slotStartTimeInUTC).getDay();
      const slotHours = new Date(slot.slotStartTimeInUTC).getHours();
      const slotMinutes = new Date(slot.slotStartTimeInUTC).getMinutes();
      validPatterns.add(`${slotDay}-${slotHours}-${slotMinutes}`);
    }

    for (const slot of slots) {
      const pattern = `${slot.getDay()}-${slot.getHours()}-${slot.getMinutes()}`;
      if (!validPatterns.has(pattern)) {
        errors.push(
          `Slot ${slot.toLocaleString()} does not match consultant's weekly schedule`,
        );
      }
    }
  } else {
    // Custom schedule - validate exact datetime match
    const validTimes = new Set(
      consultant.slotsOfAvailabilityCustom.map((s) =>
        new Date(s.slotStartTimeInUTC).toISOString(),
      ),
    );

    for (const slot of slots) {
      if (!validTimes.has(slot.toISOString())) {
        errors.push(
          `Slot ${slot.toLocaleString()} is not in consultant's custom schedule`,
        );
      }
    }
  }

  return { isValid: errors.length === 0, errors, warnings: [] };
}
```

**What It Validates**:

- **Weekly Schedule**: Slots match day-of-week + time-of-day patterns
- **Custom Schedule**: Slots match exact datetime entries

**Example Error**:

```
"Slot 1/15/2025, 3:00:00 PM does not match consultant's weekly schedule"
```

#### 4. Scheduling Period Validator

```typescript
private validateSchedulingPeriod(
  slots: Date[],
  startDate: Date,
  endDate: Date,
): ValidationResult {
  const errors: string[] = [];

  for (const slot of slots) {
    if (slot < startDate || slot > endDate) {
      errors.push(
        `Slot ${slot.toLocaleString()} is outside the scheduling period ` +
          `(${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}). ` +
          `All slots must be scheduled within this date range.`,
      );
    }
  }

  return { isValid: errors.length === 0, errors, warnings: [] };
}
```

**What It Validates**:

- All slots fall within `[startDate, endDate]` for subscriptions and classes
- This was previously only enforced client-side (security fix)

**Example Error**:

```
"Slot 3/15/2025, 10:00:00 AM is outside the scheduling period (1/1/2025 - 3/1/2025).
All slots must be scheduled within this date range."
```

#### 5. Consecutive Slots Validator

```typescript
private validateConsecutiveSlots(slots: Date[]): ValidationResult {
  if (slots.length <= 1) {
    return { isValid: true, errors: [], warnings: [] };
  }

  const sortedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());
  const toleranceMs = 1000; // 1 second tolerance
  const errors: string[] = [];

  for (let i = 1; i < sortedSlots.length; i++) {
    const prevSlot = sortedSlots[i - 1];
    const currentSlot = sortedSlots[i];

    // Expected: previous slot + 30 minutes = current slot
    const expectedNextTime = prevSlot.getTime() + 30 * 60 * 1000;
    const timeDiff = Math.abs(currentSlot.getTime() - expectedNextTime);

    if (timeDiff > toleranceMs) {
      errors.push(
        `Slots must be consecutive. Gap detected between ${prevSlot.toLocaleString()} and ${currentSlot.toLocaleString()}`,
      );
    }
  }

  return { isValid: errors.length === 0, errors, warnings: [] };
}
```

**What It Validates**:

- Slots are exactly 30 minutes apart
- 1-second tolerance for floating-point precision issues

**Example Error**:

```
"Slots must be consecutive. Gap detected between 1/15/2025, 10:00:00 AM and 1/15/2025, 11:00:00 AM"
```

### Event-Specific Validators

#### Consultation Validator

```typescript
private validateConsultation(
  slots: Date[],
  config: EventConfig,
): ValidationResult {
  const errors: string[] = [];
  const duration = config.durationInHours || config.sessionDurationInHours;

  // Validate duration before use
  try {
    SlotCalculationService.validateDuration(duration, "Consultation duration");
  } catch (error) {
    return {
      isValid: false,
      errors: [error instanceof Error ? error.message : "Invalid consultation duration"],
      warnings: [],
    };
  }

  const requiredSlots = SlotCalculationService.getSlotsPerCall(duration!);

  // Check slot count
  if (slots.length !== requiredSlots) {
    errors.push(
      `Consultation requires exactly ${requiredSlots} slot${requiredSlots !== 1 ? "s" : ""} (${duration!} hour${duration! > 1 ? "s" : ""}) but ${slots.length} provided`,
    );
  }

  // Check same day
  const sameDayCheck = this.validateSameDaySlots(slots);
  if (!sameDayCheck.isValid) {
    errors.push(
      "Consultation is a one-day event - all slots must be on the same day",
    );
    return { isValid: false, errors, warnings: [] };
  }

  // Check consecutive
  const consecutiveCheck = this.validateConsecutiveSlots(slots);
  if (!consecutiveCheck.isValid) {
    errors.push("Consultation slots must be consecutive (no gaps allowed)");
  }

  return { isValid: errors.length === 0, errors, warnings: [] };
}
```

**What It Validates**:

- Correct number of slots for duration
- All slots on same day
- All slots consecutive

#### Subscription Validator

Delegates to Layer 3 (SubscriptionValidationService) for weekly limit validation.

#### Webinar Validator

```typescript
private validateWebinar(
  slots: Date[],
  config: EventConfig,
): ValidationResult {
  const errors: string[] = [];
  const duration = config.durationInHours || config.sessionDurationInHours;

  try {
    SlotCalculationService.validateDuration(duration, "Webinar duration");
  } catch (error) {
    return {
      isValid: false,
      errors: [error instanceof Error ? error.message : "Invalid webinar duration"],
      warnings: [],
    };
  }

  const requiredSlots = SlotCalculationService.getSlotsPerCall(duration!);

  if (slots.length !== requiredSlots) {
    errors.push(
      `Webinar (${duration!} hour${duration! > 1 ? "s" : ""}) requires exactly ${requiredSlots} consecutive slot${requiredSlots > 1 ? "s" : ""}, but ${slots.length} provided`,
    );
  }

  if (requiredSlots > 1) {
    const consecutiveCheck = this.validateConsecutiveSlots(slots);
    if (!consecutiveCheck.isValid) {
      errors.push("Webinar slots must be consecutive");
    }
  }

  return { isValid: errors.length === 0, errors, warnings: [] };
}
```

**What It Validates**:

- Correct number of slots for duration
- All slots consecutive (no same-day requirement)

#### Class Validator

```typescript
private validateClass(slots: Date[], config: EventConfig): ValidationResult {
  const errors: string[] = [];

  if (!config.callsPerWeek) {
    return {
      isValid: false,
      errors: ["Classes per week is required for class validation"],
      warnings: [],
    };
  }

  if (!config.sessionDurationInHours) {
    return {
      isValid: false,
      errors: ["Session duration is required for class validation"],
      warnings: [],
    };
  }

  try {
    SlotCalculationService.validateDuration(config.sessionDurationInHours, "Session duration");
  } catch (error) {
    return {
      isValid: false,
      errors: [error instanceof Error ? error.message : "Invalid session duration"],
      warnings: [],
    };
  }

  const slotsPerSession = SlotCalculationService.getSlotsPerCall(
    config.sessionDurationInHours,
  );

  // Group slots by day and validate each day has complete sessions
  const slotsByDay = SlotCalculationService.groupSlotsByDay(
    slots.map((s) => ({
      startTime: s,
      endTime: new Date(s.getTime() + 30 * 60 * 1000),
      isAvailable: true,
      isBooked: false,
    })),
  );

  slotsByDay.forEach((daySlots, dayKey) => {
    const sorted = [...daySlots].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    // Check if day has incomplete sessions
    if (sorted.length % slotsPerSession !== 0) {
      errors.push(
        `Day ${dayKey} has ${sorted.length} slots but needs multiples of ${slotsPerSession} (incomplete session)`,
      );
    }

    // Check consecutiveness within day
    const consecutiveCheck = this.validateConsecutiveSlots(
      sorted.map((s) => s.startTime),
    );
    if (!consecutiveCheck.isValid) {
      errors.push(`Day ${dayKey} has non-consecutive slots`);
    }
  });

  // Validate weekly limits
  const slotsByWeek = SlotCalculationService.groupSlotsByWeek(
    slots.map((s) => ({
      startTime: s,
      endTime: new Date(s.getTime() + 30 * 60 * 1000),
      isAvailable: true,
      isBooked: false,
    })),
  );

  slotsByWeek.forEach((weekSlots, weekKey) => {
    const sessionsThisWeek = Math.floor(weekSlots.length / slotsPerSession);
    if (sessionsThisWeek > config.callsPerWeek!) {
      errors.push(
        `Week of ${new Date(weekKey).toLocaleDateString()} has ${sessionsThisWeek} sessions but max is ${config.callsPerWeek}`,
      );
    }
  });

  return { isValid: errors.length === 0, errors, warnings: [] };
}
```

**What It Validates**:

- Complete sessions per day (no partial sessions)
- Consecutive slots within each day
- Weekly session limits

---

## Layer 3: Subscription-Specific Validation

**Location**: `/utils/subscriptionValidation.ts`

**Purpose**: Enforce weekly call limits and subscription period constraints

**When It Runs**: Called by Layer 2 for subscription event types

### SubscriptionValidationService

```typescript
export class SubscriptionValidationService {
  async validateSubscriptionSlots(
    subscriptionId: string,
    proposedSlots: string[],
    excludeAppointmentIds: string[] = [],
  ): Promise<SubscriptionValidationResult> {
    // Get subscription details
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: true,
        requestedBy: { include: { user: true } },
      },
    });

    // Calculate exact weeks using Sunday-Saturday boundaries
    const exactWeeks = countSundayWeeksInclusive(
      subscription.startDate,
      subscription.endDate,
    );

    // Get existing appointments
    const existingAppointments = await this.getExistingSubscriptionAppointments(
      subscriptionId,
      excludeAppointmentIds,
    );

    // Group existing and proposed calls by week
    const existingCallsByWeek =
      this.groupAppointmentsByWeek(existingAppointments);
    const proposedCallsByWeek = this.groupSlotsByWeek(
      proposedSlotDates,
      subscriptionPlan.sessionDurationInHours,
    );

    // Generate weekly info for entire subscription period
    const weeklyInfo = this.generateWeeklyInfo(
      subscription.startDate,
      subscription.endDate,
      subscriptionPlan.callsPerWeek,
      existingCallsByWeek,
      proposedCallsByWeek,
    );

    // Validate weekly limits
    const weeklyValidation = this.validateWeeklyLimits(weeklyInfo);

    return {
      isValid: weeklyValidation.isValid,
      errors: weeklyValidation.errors,
      warnings: weeklyValidation.warnings,
      weeklyInfo,
      totalCallsScheduled: weeklyInfo.reduce(
        (sum, w) => sum + w.existingCalls,
        0,
      ),
      maxTotalCalls: subscriptionPlan.callsPerWeek * exactWeeks,
      subscriptionPeriod: {
        start: subscription.startDate,
        end: subscription.endDate,
      },
    };
  }
}
```

### Key Features

#### 1. Sunday-Saturday Week Boundaries

```typescript
// Week counting uses Sunday as start of week
const exactWeeks = countSundayWeeksInclusive(startDate, endDate);

// Example: Jan 6 (Mon) to Feb 2 (Sun)
// Week 1: Sun Jan 5 - Sat Jan 11
// Week 2: Sun Jan 12 - Sat Jan 18
// Week 3: Sun Jan 19 - Sat Jan 25
// Week 4: Sun Jan 26 - Sat Feb 1
// Week 5: Sun Feb 2 - Sat Feb 8
// Total: 5 weeks
```

#### 2. Consecutive Slot Validation with Tolerance

```typescript
// FIX: Use 1-second tolerance for floating-point precision issues
const TOLERANCE_MS = 1000; // 1 second tolerance

for (let i = 1; i < sortedSlots.length; i++) {
  const prevEnd = new Date(sortedSlots[i - 1].getTime() + 30 * 60 * 1000);
  const currentStart = sortedSlots[i];
  const timeDiff = Math.abs(currentStart.getTime() - prevEnd.getTime());

  if (timeDiff > TOLERANCE_MS) {
    return false; // Not consecutive
  }
}
```

**Why Tolerance Matters**:

- Date arithmetic can introduce sub-second precision errors
- Timezone conversions may cause rounding
- Database timestamps may have microsecond precision
- 1-second tolerance catches genuine gaps while allowing precision issues

#### 3. Iteration Limits (Safety Check)

```typescript
private generateWeeklyInfo(...): WeeklyCallInfo[] {
  const MAX_WEEKS = 520; // 10 years - reasonable upper bound
  let weekCount = 0;

  while (currentWeek <= subscriptionEnd) {
    weekCount++;

    // Safety check: prevent infinite loops from malformed dates
    if (weekCount > MAX_WEEKS) {
      throw new Error(
        `Subscription period exceeds maximum duration (${MAX_WEEKS} weeks / 10 years). ` +
          `Start: ${subscriptionStart.toISOString()}, End: ${subscriptionEnd.toISOString()}. ` +
          `Please verify the subscription dates are correct.`,
      );
    }

    // ... process week ...
    currentWeek = addWeeks(currentWeek, 1);
  }

  return weeklyInfo;
}
```

**Why This Matters**:

- Protects against infinite loops from bad data
- Example malformed dates: startDate="3000-01-01", endDate="2020-01-01"
- Prevents server hang/crash from date calculation bugs

---

## Validation Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    API Request Received                      │
│           POST /api/events/{type}/{id}/validate             │
│          PATCH /api/events/{type}/{id}/allocate             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              LAYER 1: Zod Schema Validation                  │
│                                                              │
│  ✓ Event ID is valid UUID                                   │
│  ✓ Request body has correct structure                       │
│  ✓ Slots are ISO 8601 datetime strings                      │
│  ✓ isAuto is boolean                                        │
│  ✓ Manual allocation has slots array                        │
│                                                              │
│  ❌ Return 400 Bad Request if validation fails              │
└────────────────────────┬────────────────────────────────────┘
                         │ ✓ Valid
                         ▼
┌─────────────────────────────────────────────────────────────┐
│         LAYER 2: Business Rules Validation                   │
│            (SlotValidationService)                           │
│                                                              │
│  Universal Validators (all event types):                     │
│  ✓ Slots in future (5-second buffer)                        │
│  ✓ No conflicts with existing appointments                  │
│  ✓ Matches consultant's schedule                            │
│  ✓ Within scheduling period (if applicable)                 │
│                                                              │
│  Event-Specific Validators:                                  │
│  ✓ Consultations: same day, consecutive, correct count      │
│  ✓ Webinars: consecutive, correct count                     │
│  ✓ Subscriptions: → Go to Layer 3                           │
│  ✓ Classes: session grouping, weekly limits                 │
│                                                              │
│  ❌ Return validation errors if any check fails             │
└────────────────────────┬────────────────────────────────────┘
                         │ ✓ Valid (if subscription)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│      LAYER 3: Subscription-Specific Validation               │
│         (SubscriptionValidationService)                      │
│                                                              │
│  ✓ Weekly call limits not exceeded                          │
│  ✓ Complete calls (consecutive slots)                       │
│  ✓ Slots within subscription period                         │
│  ✓ No duplicate weeks over-scheduled                        │
│                                                              │
│  Generates:                                                  │
│  • weeklyInfo: breakdown of calls per week                  │
│  • totalCallsScheduled vs maxTotalCalls                     │
│  • warnings for fully booked weeks                          │
│                                                              │
│  ❌ Return validation errors if any check fails             │
└────────────────────────┬────────────────────────────────────┘
                         │ ✓ All layers passed
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Database Transaction Begins                     │
│                                                              │
│  1. Create/update appointments                              │
│  2. Create slot records                                     │
│  3. Update event status                                     │
│  4. Commit transaction                                      │
│                                                              │
│  ✓ Return 200 OK with appointment data                      │
│  ❌ Return 500 Internal Server Error if DB operation fails  │
└─────────────────────────────────────────────────────────────┘
```

---

## Error Message Examples

### Layer 1 Errors (400 Bad Request)

```json
{
  "error": "isAuto: Expected boolean, received string"
}
```

```json
{
  "error": "slots.0: Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')"
}
```

```json
{
  "error": "slots: Manual allocation requires 'slots' array with at least one time slot"
}
```

### Layer 2 Errors (Validation Result)

```json
{
  "data": {
    "conflicts": [
      {
        "slot": "2025-01-15T10:00:00Z",
        "existingAppointment": {
          "type": "Consultation",
          "with": "John Doe",
          "time": "1/15/2025, 10:00:00 AM"
        }
      }
    ],
    "outsideAvailability": [
      {
        "slot": "2025-01-15T15:00:00Z"
      }
    ],
    "validSlots": ["2025-01-15T11:00:00Z", "2025-01-15T11:30:00Z"]
  }
}
```

### Layer 3 Errors (Subscription Validation)

```json
{
  "error": "Validation failed: Week of 1/12/2025 exceeds call limit. Maximum 2 calls per week, but 3 calls are scheduled."
}
```

---

## Testing Validation Layers

### Testing Layer 1 (Zod)

```typescript
import { allocationRequestSchema } from "@/schemas/slotAllocation/validationSchemas";

// Test valid input
const validInput = {
  isAuto: false,
  slots: ["2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z"],
};
const result = allocationRequestSchema.safeParse(validInput);
expect(result.success).toBe(true);

// Test invalid input
const invalidInput = {
  isAuto: "yes", // Should be boolean
  slots: ["invalid-date"],
};
const result2 = allocationRequestSchema.safeParse(invalidInput);
expect(result2.success).toBe(false);
```

### Testing Layer 2 (Business Rules)

```typescript
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";

const validator = new SlotValidationService(prisma);

// Test future slots validation
const pastSlot = new Date("2020-01-01T10:00:00Z");
const result = await validator.validate(
  "consultation",
  consultationId,
  [pastSlot],
  consultant,
  config,
);
expect(result.isValid).toBe(false);
expect(result.errors[0]).toContain("Cannot allocate slots in the past");
```

### Testing Layer 3 (Subscription Limits)

```typescript
import { SubscriptionValidationService } from "@/utils/subscriptionValidation";

const validator = new SubscriptionValidationService(prisma);

// Test weekly limit violation
const proposedSlots = [
  // 3 calls in week of Jan 12 (exceeds limit of 2)
  "2025-01-13T10:00:00Z",
  "2025-01-13T10:30:00Z",
  "2025-01-15T10:00:00Z",
  "2025-01-15T10:30:00Z",
  "2025-01-17T10:00:00Z",
  "2025-01-17T10:30:00Z",
];
const result = await validator.validateSubscriptionSlots(
  subscriptionId,
  proposedSlots,
);
expect(result.isValid).toBe(false);
expect(result.errors[0]).toContain("exceeds call limit");
```

---

## Next Steps

- **Event Types**: See `03_EVENT_TYPES.md` for event-specific rules
- **Slot Calculations**: See `05_SLOT_CALCULATIONS.md` for slot mathematics
- **API Reference**: See `06_API_REFERENCE.md` for complete API documentation
- **Troubleshooting**: See `08_TROUBLESHOOTING.md` for common validation errors
