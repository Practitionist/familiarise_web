# Slot Calculations and Mathematics

This document explains the mathematical foundations and calculation logic used throughout the booking algorithm system.

## Overview

All slot calculations follow a consistent set of rules:

1. **Slot Standard**: 30-minute increments (0.5 hours)
2. **Week Boundaries**: Sunday 00:00 to Saturday 23:59
3. **Duration Validation**: Minimum 0.5 hours, maximum 24 hours
4. **Consecutive Tolerance**: 1-second precision tolerance
5. **Date Precision**: Normalized to midnight for consistency

**Location**: `/utils/slotAllocation/SlotCalculationService.ts`

---

## 1. The 30-Minute Slot Standard

### Fundamental Unit

The entire booking system is built on **30-minute slots** as the fundamental unit of time.

```typescript
const SLOT_DURATION_MINUTES = 30;
const SLOT_DURATION_HOURS = 0.5;
const SLOT_DURATION_MS = 30 * 60 * 1000; // 1,800,000 milliseconds
```

### Why 30 Minutes?

1. **Industry Standard**: Most consultation/session platforms use 15, 30, or 60-minute slots
2. **Flexibility**: 30 minutes provides good balance between granularity and simplicity
3. **User Experience**: Easy for users to understand (half-hour increments)
4. **Database Efficiency**: Reduces slot record count compared to 15-minute slots

### Slot Representation

Each slot is represented as a pair of timestamps:

```typescript
interface SlotOfAppointment {
  slotStartTimeInUTC: DateTime  // e.g., 2025-01-15 10:00:00
  slotEndTimeInUTC: DateTime    // e.g., 2025-01-15 10:30:00
}

// Invariant: endTime = startTime + 30 minutes
```

**Example**:
```typescript
// A 2-hour appointment consists of 4 slots:
[
  { start: "2025-01-15T10:00:00Z", end: "2025-01-15T10:30:00Z" }, // Slot 1
  { start: "2025-01-15T10:30:00Z", end: "2025-01-15T11:00:00Z" }, // Slot 2
  { start: "2025-01-15T11:00:00Z", end: "2025-01-15T11:30:00Z" }, // Slot 3
  { start: "2025-01-15T11:30:00Z", end: "2025-01-15T12:00:00Z" }  // Slot 4
]
```

---

## 2. Slots Per Call Calculation

### Formula

```typescript
function getSlotsPerCall(sessionDurationInHours: number): number {
  return Math.ceil(sessionDurationInHours / 0.5);
}
```

### Calculation Table

| Duration (hours) | Calculation | Slots Needed | Total Time |
|------------------|-------------|--------------|------------|
| 0.5 | Math.ceil(0.5 / 0.5) | 1 | 30 min |
| 1.0 | Math.ceil(1.0 / 0.5) | 2 | 1 hour |
| 1.5 | Math.ceil(1.5 / 0.5) | 3 | 1.5 hours |
| 2.0 | Math.ceil(2.0 / 0.5) | 4 | 2 hours |
| 2.5 | Math.ceil(2.5 / 0.5) | 5 | 2.5 hours |
| 3.0 | Math.ceil(3.0 / 0.5) | 6 | 3 hours |

### Why Math.ceil()?

The `Math.ceil()` function rounds up to handle edge cases:

```typescript
// Example: 1.25-hour session
getSlotsPerCall(1.25)
= Math.ceil(1.25 / 0.5)
= Math.ceil(2.5)
= 3 slots
= 1.5 hours actual duration

// The system allocates 1.5 hours (3 slots) to accommodate the 1.25-hour request
```

**Rationale**: Better to over-allocate slightly than under-allocate and cause conflicts.

### Edge Cases

```typescript
// Minimum duration: 0.5 hours
getSlotsPerCall(0.5) → 1 slot ✓

// Very short duration (less than 30 min)
getSlotsPerCall(0.25) → Math.ceil(0.5) → 1 slot
// Still allocates 30 min minimum

// Zero or negative (caught by validation)
getSlotsPerCall(0) → Error: "must be positive"
getSlotsPerCall(-1) → Error: "must be positive"

// Very long duration
getSlotsPerCall(24) → 48 slots → Warning logged
```

---

## 3. Week Counting (Sunday-Saturday Boundaries)

### Week Definition

Weeks are defined as **Sunday 00:00:00 to Saturday 23:59:59**.

This is critical for subscription and class scheduling.

### Finding Week Start

```typescript
function startOfWeekSunday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const diff = day; // days since Sunday
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - diff);
  sunday.setHours(0, 0, 0, 0); // Normalize to midnight
  return sunday;
}
```

**Example**:
```typescript
// Input: Wednesday, January 15, 2025, 14:30:00
const date = new Date("2025-01-15T14:30:00Z");

// Step 1: Get day of week
date.getDay() → 3 (Wednesday)

// Step 2: Calculate days since Sunday
diff = 3 days

// Step 3: Subtract to find Sunday
date - 3 days = Sunday, January 12, 2025

// Step 4: Normalize to midnight
result = Sunday, January 12, 2025, 00:00:00
```

### Counting Weeks Between Dates

```typescript
function countWeeks(startDate: Date, endDate: Date): number {
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (end < start) return 0;

  // Normalize to midnight
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  // Find Sunday of week containing start and end
  const startSunday = startOfWeekSunday(start);
  const endSunday = startOfWeekSunday(end);

  // Count Sundays from startSunday to endSunday inclusive
  let weeks = 1;
  let cursor = new Date(startSunday);
  while (cursor < endSunday) {
    cursor.setDate(cursor.getDate() + 7);
    weeks += 1;
  }
  return weeks;
}
```

### Week Counting Examples

#### Example 1: Basic Week Count

```
Input:
  startDate: Monday, January 6, 2025
  endDate: Sunday, February 2, 2025

Step 1: Find week boundaries
  Week containing Jan 6 (Mon): Sun Jan 5 - Sat Jan 11
  Week containing Feb 2 (Sun): Sun Feb 2 - Sat Feb 8

Step 2: Count Sundays from Jan 5 to Feb 2
  Week 1: Sunday, Jan 5
  Week 2: Sunday, Jan 12
  Week 3: Sunday, Jan 19
  Week 4: Sunday, Jan 26
  Week 5: Sunday, Feb 2

Result: 5 weeks
```

#### Example 2: Same Week

```
Input:
  startDate: Monday, January 6, 2025
  endDate: Friday, January 10, 2025

Step 1: Find week boundaries
  Both dates in week: Sun Jan 5 - Sat Jan 11
  startSunday = endSunday = Jan 5

Step 2: Count Sundays
  Only 1 Sunday (Jan 5)

Result: 1 week
```

#### Example 3: Month Boundary

```
Input:
  startDate: Wednesday, January 29, 2025
  endDate: Tuesday, February 4, 2025

Step 1: Find week boundaries
  Week containing Jan 29: Sun Jan 26 - Sat Feb 1
  Week containing Feb 4: Sun Feb 2 - Sat Feb 8

Step 2: Count Sundays
  Week 1: Sunday, Jan 26
  Week 2: Sunday, Feb 2

Result: 2 weeks
```

### Common Pitfall: Month-Based Calculation

**Wrong Approach** (don't do this):
```typescript
// ❌ WRONG: Assumes 4.33 weeks per month
const weeks = durationInMonths * 4.33;

// Example: 1 month from Jan 6 to Feb 2
const weeks = 1 * 4.33 = 4.33 → 4 weeks
// But actual: 5 weeks (as shown above)
```

**Correct Approach**:
```typescript
// ✓ CORRECT: Count actual Sunday boundaries
const weeks = countWeeks(startDate, endDate);

// Example: 1 month from Jan 6 to Feb 2
const weeks = countWeeks(jan6, feb2) = 5 weeks ✓
```

---

## 4. Total Slots Required Calculation

### Consultation / Webinar (One-Time Events)

```typescript
function calculateRequiredSlots_OneTime(durationInHours: number): number {
  return Math.ceil(durationInHours / 0.5);
}
```

**Example**:
```typescript
// 2-hour consultation
calculateRequiredSlots_OneTime(2) → 4 slots

// 1.5-hour webinar
calculateRequiredSlots_OneTime(1.5) → 3 slots
```

### Subscription / Class (Recurring Events)

```typescript
function calculateRequiredSlots_Recurring(
  startDate: Date,
  endDate: Date,
  callsPerWeek: number,
  sessionDurationInHours: number
): number {
  const totalWeeks = countWeeks(startDate, endDate);
  const totalCalls = totalWeeks * callsPerWeek;
  const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);
  return totalCalls * slotsPerCall;
}
```

**Example**:
```typescript
// 2-month subscription
// - Start: Jan 6, 2025 (Mon)
// - End: Mar 2, 2025 (Sun)
// - 2 calls per week
// - 1.5 hours per call

Step 1: Count weeks
  countWeeks(Jan 6, Mar 2) = 9 weeks

Step 2: Calculate total calls
  9 weeks × 2 calls/week = 18 calls

Step 3: Calculate slots per call
  Math.ceil(1.5 / 0.5) = 3 slots

Step 4: Calculate total slots
  18 calls × 3 slots/call = 54 slots

Result: 54 slots needed
```

### Fallback Calculation (When Dates Unavailable)

```typescript
function calculateRequiredSlots_Fallback(
  durationInMonths: number,
  callsPerWeek: number,
  sessionDurationInHours: number
): number {
  const weeksPerMonth = 4.33;
  const totalWeeks = Math.ceil(durationInMonths * weeksPerMonth);
  const totalCalls = totalWeeks * callsPerWeek;
  const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);
  return totalCalls * slotsPerCall;
}
```

**Note**: This is less accurate and only used when `startDate` and `endDate` are not available.

---

## 5. Consecutive Slot Validation

### The Consecutive Check

Consecutive slots means each slot's end time equals the next slot's start time.

```typescript
function validateConsecutiveSlots(slots: Date[]): boolean {
  if (slots.length <= 1) return true;

  const sortedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());
  const TOLERANCE_MS = 1000; // 1 second tolerance

  for (let i = 1; i < sortedSlots.length; i++) {
    const prevSlot = sortedSlots[i - 1];
    const currentSlot = sortedSlots[i];

    // Expected: prevSlot + 30 minutes = currentSlot
    const expectedNextTime = prevSlot.getTime() + 30 * 60 * 1000;
    const timeDiff = Math.abs(currentSlot.getTime() - expectedNextTime);

    if (timeDiff > TOLERANCE_MS) {
      return false; // Gap detected
    }
  }

  return true; // All consecutive
}
```

### Why 1-Second Tolerance?

**Problem**: Floating-point arithmetic and timezone conversions can introduce sub-second precision errors.

**Example Scenario**:
```typescript
// Client sends:
const slot1 = new Date("2025-01-15T10:00:00.000Z");
const slot2 = new Date("2025-01-15T10:30:00.000Z");

// After timezone conversion and database roundtrip:
const slot1_db = new Date("2025-01-15T10:00:00.000Z");
const slot2_db = new Date("2025-01-15T10:30:00.001Z"); // +1ms precision error

// Without tolerance:
slot1_db + 30 min = 10:30:00.000
slot2_db = 10:30:00.001
timeDiff = 1ms → REJECTED ❌ (false positive)

// With 1-second tolerance:
timeDiff = 1ms < 1000ms → ACCEPTED ✓
```

### Consecutive Examples

#### Valid Consecutive Slots

```typescript
// Perfect consecutive (no gaps)
[
  "2025-01-15T10:00:00Z",
  "2025-01-15T10:30:00Z",
  "2025-01-15T11:00:00Z"
]
// ✓ Each slot exactly 30 minutes apart

// Consecutive with sub-second precision
[
  "2025-01-15T10:00:00.000Z",
  "2025-01-15T10:30:00.001Z",  // +1ms (within tolerance)
  "2025-01-15T11:00:00.000Z"
]
// ✓ Differences < 1 second

// Out of order (sorted before validation)
[
  "2025-01-15T11:00:00Z",
  "2025-01-15T10:00:00Z",
  "2025-01-15T10:30:00Z"
]
// ✓ Sorted to [10:00, 10:30, 11:00] → consecutive
```

#### Invalid Consecutive Slots

```typescript
// Missing slot (gap)
[
  "2025-01-15T10:00:00Z",
  "2025-01-15T11:00:00Z"  // Missing 10:30
]
// ❌ Gap: 10:00 + 30min = 10:30 ≠ 11:00
// timeDiff = 30 minutes > 1 second

// Non-contiguous slots
[
  "2025-01-15T10:00:00Z",
  "2025-01-15T10:30:00Z",
  "2025-01-15T14:00:00Z"  // Afternoon slot
]
// ❌ Gap: 10:30 + 30min = 11:00 ≠ 14:00
// timeDiff = 3.5 hours > 1 second

// Overlapping slots
[
  "2025-01-15T10:00:00Z",
  "2025-01-15T10:15:00Z"  // Starts 15min after previous
]
// ❌ Not 30-minute increment
// timeDiff = 15 minutes > 1 second
```

---

## 6. Duration Validation

### Validation Function

```typescript
function validateDuration(duration: number | undefined, fieldName: string): void {
  // Check existence
  if (duration === undefined || duration === null) {
    throw new Error(`${fieldName} is required but was not provided`);
  }

  // Check type
  if (typeof duration !== 'number') {
    throw new Error(
      `${fieldName} must be a number, but received type: ${typeof duration}`
    );
  }

  // Check positivity
  if (duration <= 0) {
    throw new Error(
      `${fieldName} must be positive, but received: ${duration}`
    );
  }

  // Check finiteness
  if (!Number.isFinite(duration)) {
    throw new Error(
      `${fieldName} must be a finite number, but received: ${duration}`
    );
  }

  // Check minimum (30 minutes)
  if (duration < 0.5) {
    throw new Error(
      `${fieldName} must be at least 0.5 hours (30 minutes), but received: ${duration}`
    );
  }

  // Warn if unusually large
  if (duration > 24) {
    console.warn(
      `⚠️ ${fieldName} is unusually large (${duration} hours). Maximum expected is 24 hours.`
    );
  }
}
```

### Why Centralized Validation?

**Problem**: Duration is used in division throughout the app. Invalid values cause:
- Division by zero errors
- Infinite loops in slot allocation
- Negative slot counts
- Database corruption

**Solution**: Single validation function used by all services ensures consistency.

### Duration Validation Examples

```typescript
// Valid durations
validateDuration(0.5, "sessionDuration") → ✓ Pass
validateDuration(1, "sessionDuration") → ✓ Pass
validateDuration(2.5, "sessionDuration") → ✓ Pass
validateDuration(24, "sessionDuration") → ✓ Pass (with warning)

// Invalid durations
validateDuration(undefined, "sessionDuration")
// → Error: "sessionDuration is required but was not provided"

validateDuration(0, "sessionDuration")
// → Error: "sessionDuration must be positive, but received: 0"

validateDuration(-1, "sessionDuration")
// → Error: "sessionDuration must be positive, but received: -1"

validateDuration(0.25, "sessionDuration")
// → Error: "sessionDuration must be at least 0.5 hours (30 minutes), but received: 0.25"

validateDuration(Infinity, "sessionDuration")
// → Error: "sessionDuration must be a finite number, but received: Infinity"

validateDuration("2", "sessionDuration")
// → Error: "sessionDuration must be a number, but received type: string"
```

---

## 7. Grouping Slots

### Group by Day

```typescript
function groupSlotsByDay(slots: TimeSlot[]): Map<string, TimeSlot[]> {
  const slotsByDay = new Map<string, TimeSlot[]>();

  for (const slot of slots) {
    const dayKey = slot.startTime.toDateString();
    // Example: "Wed Jan 15 2025"

    if (!slotsByDay.has(dayKey)) {
      slotsByDay.set(dayKey, []);
    }
    slotsByDay.get(dayKey)!.push(slot);
  }

  return slotsByDay;
}
```

**Usage**: Validate complete sessions per day for classes.

**Example**:
```typescript
const slots = [
  { startTime: new Date("2025-01-15T10:00:00Z"), ... }, // Wed
  { startTime: new Date("2025-01-15T10:30:00Z"), ... }, // Wed
  { startTime: new Date("2025-01-17T14:00:00Z"), ... }, // Fri
  { startTime: new Date("2025-01-17T14:30:00Z"), ... }, // Fri
];

groupSlotsByDay(slots)
// Map {
//   "Wed Jan 15 2025" => [10:00 slot, 10:30 slot],
//   "Fri Jan 17 2025" => [14:00 slot, 14:30 slot]
// }
```

### Group by Week

```typescript
function groupSlotsByWeek(slots: TimeSlot[]): Map<string, TimeSlot[]> {
  const slotsByWeek = new Map<string, TimeSlot[]>();

  for (const slot of slots) {
    const weekStart = startOfWeekSunday(slot.startTime);
    const weekKey = weekStart.toISOString();
    // Example: "2025-01-12T00:00:00.000Z" (Sunday)

    if (!slotsByWeek.has(weekKey)) {
      slotsByWeek.set(weekKey, []);
    }
    slotsByWeek.get(weekKey)!.push(slot);
  }

  return slotsByWeek;
}
```

**Usage**: Validate weekly limits for subscriptions and classes.

**Example**:
```typescript
const slots = [
  { startTime: new Date("2025-01-13T10:00:00Z"), ... }, // Mon, Week of Jan 12
  { startTime: new Date("2025-01-15T10:00:00Z"), ... }, // Wed, Week of Jan 12
  { startTime: new Date("2025-01-20T10:00:00Z"), ... }, // Mon, Week of Jan 19
];

groupSlotsByWeek(slots)
// Map {
//   "2025-01-12T00:00:00.000Z" => [Jan 13 slot, Jan 15 slot],  // 2 slots
//   "2025-01-19T00:00:00.000Z" => [Jan 20 slot]                // 1 slot
// }
```

---

## 8. Progress Calculation

### Progress Info Structure

```typescript
interface ProgressInfo {
  scheduled: number;      // Calls/sessions scheduled so far
  required: number;       // Total calls/sessions needed
  remaining: number;      // Calls/sessions still needed
  sessionDuration: number; // Duration per call in hours
  displayText: string;    // User-friendly progress message
}
```

### Calculation Logic

```typescript
function calculateProgress(
  selectedSlots: TimeSlot[],
  eventType: EventType,
  config: EventConfig,
): ProgressInfo {
  const sessionDuration = config.sessionDurationInHours || config.durationInHours || 1;
  const slotsPerCall = getSlotsPerCall(sessionDuration);

  let scheduled = 0;
  let required = 0;

  switch (eventType) {
    case "consultation":
    case "webinar":
      // Single event - just check if enough consecutive slots selected
      scheduled = selectedSlots.length >= slotsPerCall ? 1 : 0;
      required = 1;
      break;

    case "subscription":
    case "class":
      // Count complete calls/sessions (full consecutive slot groups)
      scheduled = countCompletedCalls(selectedSlots, slotsPerCall);

      // Calculate total required calls/sessions
      if (config.startDate && config.endDate && config.callsPerWeek) {
        const weeks = countWeeks(config.startDate, config.endDate);
        required = weeks * config.callsPerWeek;
      } else if (config.durationInMonths && config.callsPerWeek) {
        const weeks = Math.ceil(config.durationInMonths * 4.33);
        required = weeks * config.callsPerWeek;
      }
      break;
  }

  const remaining = Math.max(0, required - scheduled);
  const displayText = formatProgressText(
    eventType,
    scheduled,
    required,
    remaining,
    sessionDuration,
    config.callsPerWeek,
  );

  return { scheduled, required, remaining, sessionDuration, displayText };
}
```

### Counting Completed Calls

```typescript
function countCompletedCalls(
  selectedSlots: TimeSlot[],
  slotsPerCall: number,
): number {
  if (!selectedSlots?.length) return 0;

  // Group slots by day
  const slotsByDay = groupSlotsByDay(selectedSlots);

  let completed = 0;
  slotsByDay.forEach((daySlots) => {
    const sorted = [...daySlots].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    // Check if this day has enough consecutive slots for a complete call
    if (sorted.length >= slotsPerCall) {
      let consecutiveCount = 1;
      for (let i = 1; i < sorted.length; i++) {
        if (
          sorted[i].startTime.getTime() === sorted[i - 1].endTime.getTime()
        ) {
          consecutiveCount++;
          if (consecutiveCount === slotsPerCall) {
            completed++;
            consecutiveCount = 0; // Reset for next potential call
          }
        } else {
          consecutiveCount = 1; // Reset on gap
        }
      }
    }
  });

  return completed;
}
```

**Example**:
```typescript
// Subscription: 2 calls per week, 1.5 hours per call (3 slots)
const selectedSlots = [
  // Week 1, Day 1: Complete call (3 consecutive slots)
  { startTime: new Date("2025-01-13T10:00:00Z"), endTime: new Date("2025-01-13T10:30:00Z") },
  { startTime: new Date("2025-01-13T10:30:00Z"), endTime: new Date("2025-01-13T11:00:00Z") },
  { startTime: new Date("2025-01-13T11:00:00Z"), endTime: new Date("2025-01-13T11:30:00Z") },

  // Week 1, Day 2: Incomplete call (only 2 slots)
  { startTime: new Date("2025-01-15T14:00:00Z"), endTime: new Date("2025-01-15T14:30:00Z") },
  { startTime: new Date("2025-01-15T14:30:00Z"), endTime: new Date("2025-01-15T15:00:00Z") },
];

countCompletedCalls(selectedSlots, 3)
// → 1 (only Day 1 has complete call)

// Progress
scheduled: 1 call
required: 10 calls (5 weeks × 2 calls/week)
remaining: 9 calls
displayText: "✅ 1 scheduled | ⏳ 9 remaining (1.5 hours each) | 2/week"
```

---

## 9. Edge Cases and Special Scenarios

### Scenario 1: Daylight Saving Time Transitions

**Problem**: Clocks "spring forward" or "fall back", affecting slot calculations.

**Solution**: Always use UTC for calculations, convert to local time only for display.

```typescript
// ✓ CORRECT: Store and calculate in UTC
const slot = new Date("2025-03-09T10:00:00Z"); // UTC

// ❌ WRONG: Calculate in local time
const slot = new Date("2025-03-09T10:00:00"); // Ambiguous timezone
```

### Scenario 2: Leap Year February

**Problem**: February has 28 or 29 days, affecting month calculations.

**Solution**: Use exact date arithmetic, not month-based estimates.

```typescript
// ✓ CORRECT: Count actual weeks
const weeks = countWeeks(
  new Date("2024-02-01"),
  new Date("2024-02-29") // Leap year
);
// → 5 weeks (Feb 1 is Thu, Feb 29 is Thu, spans 5 Sundays)

// ❌ WRONG: Estimate weeks
const weeks = 1 * 4.33; // → 4.33 weeks (inaccurate)
```

### Scenario 3: Timezone Boundaries

**Problem**: Consultant and consultee in different timezones.

**Example**:
```
Consultant (UTC+0): Sets availability for 10:00 AM UTC
Consultee (UTC-5): Sees slot as 5:00 AM local time
```

**Solution**: All slots stored in UTC, UI shows local time with timezone label.

```typescript
// Database: UTC
slotStartTimeInUTC: "2025-01-15T10:00:00Z"

// UI Display (for UTC-5 user)
"Jan 15, 2025 at 5:00 AM EST (10:00 AM consultant time)"
```

### Scenario 4: Very Long Duration

**Problem**: User creates 12-hour session.

```typescript
// Session: 12 hours
const slotsNeeded = getSlotsPerCall(12);
// → 24 slots (24 × 30 minutes)

// Validation warning logged:
// "⚠️ sessionDuration is unusually large (12 hours). Maximum expected is 24 hours."
```

**Handled**: System allows but logs warning for review.

### Scenario 5: Sub-Minimum Duration

**Problem**: User tries to create 15-minute session.

```typescript
validateDuration(0.25, "sessionDuration");
// → Error: "sessionDuration must be at least 0.5 hours (30 minutes), but received: 0.25"
```

**Handled**: Rejected at validation layer.

---

## 10. Performance Considerations

### Optimization: Set-Based Lookups

```typescript
// ❌ SLOW: O(n²) - nested loops
for (const slot of proposedSlots) {
  for (const existing of existingSlots) {
    if (slot.equals(existing)) {
      // conflict
    }
  }
}

// ✓ FAST: O(n) - set lookup
const existingSet = new Set(existingSlots.map(s => s.toISOString()));
for (const slot of proposedSlots) {
  if (existingSet.has(slot.toISOString())) {
    // conflict
  }
}
```

### Optimization: Early Exit

```typescript
// ✓ Stop validation on first error
for (const slot of slots) {
  const result = validateSlot(slot);
  if (!result.isValid) {
    return result; // Early exit, don't check remaining slots
  }
}
```

### Optimization: Batch Database Queries

```typescript
// ❌ SLOW: N queries for N slots
for (const slot of slots) {
  const conflict = await db.appointment.findFirst({ where: { slot } });
}

// ✓ FAST: 1 query for all slots
const conflicts = await db.appointment.findMany({
  where: {
    slot: { in: slots }
  }
});
```

---

## 11. Testing Slot Calculations

### Unit Test Examples

```typescript
describe('SlotCalculationService', () => {
  describe('getSlotsPerCall', () => {
    it('should calculate correct slots for standard durations', () => {
      expect(getSlotsPerCall(0.5)).toBe(1);
      expect(getSlotsPerCall(1)).toBe(2);
      expect(getSlotsPerCall(1.5)).toBe(3);
      expect(getSlotsPerCall(2)).toBe(4);
    });

    it('should round up fractional slots', () => {
      expect(getSlotsPerCall(1.25)).toBe(3); // Rounds 2.5 → 3
    });
  });

  describe('countWeeks', () => {
    it('should count weeks correctly across month boundaries', () => {
      const start = new Date('2025-01-06'); // Monday
      const end = new Date('2025-02-02'); // Sunday
      expect(countWeeks(start, end)).toBe(5);
    });

    it('should return 1 for dates in same week', () => {
      const start = new Date('2025-01-06'); // Monday
      const end = new Date('2025-01-10'); // Friday
      expect(countWeeks(start, end)).toBe(1);
    });

    it('should return 0 if end is before start', () => {
      const start = new Date('2025-02-01');
      const end = new Date('2025-01-01');
      expect(countWeeks(start, end)).toBe(0);
    });
  });

  describe('validateConsecutiveSlots', () => {
    it('should accept perfectly consecutive slots', () => {
      const slots = [
        new Date('2025-01-15T10:00:00Z'),
        new Date('2025-01-15T10:30:00Z'),
        new Date('2025-01-15T11:00:00Z'),
      ];
      expect(validateConsecutiveSlots(slots).isValid).toBe(true);
    });

    it('should reject slots with gaps', () => {
      const slots = [
        new Date('2025-01-15T10:00:00Z'),
        new Date('2025-01-15T11:00:00Z'), // Missing 10:30
      ];
      expect(validateConsecutiveSlots(slots).isValid).toBe(false);
    });

    it('should tolerate sub-second precision errors', () => {
      const slots = [
        new Date('2025-01-15T10:00:00.000Z'),
        new Date('2025-01-15T10:30:00.001Z'), // 1ms difference
      ];
      expect(validateConsecutiveSlots(slots).isValid).toBe(true);
    });
  });
});
```

---

## Summary Formulas

| Calculation | Formula | Example |
|-------------|---------|---------|
| **Slots per call** | `Math.ceil(duration / 0.5)` | 1.5 hours → 3 slots |
| **Week start** | `date - date.getDay() days, 00:00:00` | Jan 15 (Wed) → Jan 12 (Sun) |
| **Week count** | Count Sundays from start to end | Jan 6 to Feb 2 → 5 weeks |
| **Total slots (one-time)** | `slots_per_call` | 2 hours → 4 slots |
| **Total slots (recurring)** | `weeks × calls/week × slots/call` | 5 wk × 2 call/wk × 3 slot → 30 slots |
| **Consecutive check** | `slot[i].start == slot[i-1].end ± 1s` | 10:30:00.001 vs 10:30:00.000 → OK |

---

## Next Steps

- **Event Types**: See `03_EVENT_TYPES.md` for event-specific calculation examples
- **Validation**: See `04_VALIDATION_LAYERS.md` for how calculations are validated
- **API Reference**: See `06_API_REFERENCE.md` for using calculations in API calls
- **Troubleshooting**: See `08_TROUBLESHOOTING.md` for calculation-related errors
