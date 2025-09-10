# Reschedule Functionality Fixes

## Core Issue Identified

The reschedule functionality was **only calculating slots for one call** instead of calculating all the **remaining slots** for the entire subscription/class. This caused the system to fail when trying to reschedule events that had multiple calls or sessions.

## Problem Details

### 1. Missing Reschedule Endpoints

- **Subscription reschedule endpoint** didn't exist at all
- **Class reschedule endpoint** didn't exist
- Only webinar reschedule existed, but had flawed conflict detection

### 2. Incorrect Slot Calculation

- **Webinar reschedule**: Only calculated slots for one webinar session (correct behavior)
- **Subscription reschedule**: Missing entirely - should calculate all remaining calls
- **Class reschedule**: Missing entirely - should calculate all remaining sessions

### 3. Flawed Conflict Detection

- **Webinar reschedule**: Only checked for exact start time matches
- **Missing**: Proper overlapping time range detection

## Solutions Implemented

### 1. Created Missing Reschedule Endpoints

#### Subscription Reschedule (`/api/events/subscriptions/[subscriptionId]/reschedule`)

```typescript
// Key features:
- Calculates total required calls for entire subscription
- Counts existing completed calls (excluding the one being rescheduled)
- Calculates remaining calls needed
- Validates newSlots contains correct number of slots for all remaining calls
- Validates availability and conflicts
- Creates slots for ALL remaining calls, not just one
```

#### Class Reschedule (`/api/events/classes/[classId]/reschedule`)

```typescript
// Key features:
- Calculates total required sessions for entire class
- Counts existing completed sessions (excluding the one being rescheduled)
- Calculates remaining sessions needed
- Validates newSlots contains correct number of slots for all remaining sessions
- Validates availability and conflicts
- Creates slots for ALL remaining sessions, not just one
```

### 2. Fixed Conflict Detection

#### Webinar Reschedule Conflict Detection

**Before:**

```typescript
// Only checked exact start time matches
slotStartTimeInUTC: { in: newChainStarts }
```

**After:**

```typescript
// Check for overlapping time ranges AND exact start times
OR: [
  // Overlapping time ranges
  {
    AND: [
      { slotStartTimeInUTC: { lt: newEndTime } },
      { slotEndTimeInUTC: { gt: newStartTime } },
    ],
  },
  // Exact start time matches (backward compatibility)
  { slotStartTimeInUTC: { in: newChainStarts } },
];
```

### 3. Updated Allocation Service

Added new methods to `AllocationService`:

- `rescheduleClassAppointment()` - for class rescheduling
- Enhanced existing `rescheduleSubscriptionAppointment()` - now works with proper endpoint

## Event Type Behavior

### Webinars (One-time Events)

- ✅ **Correct behavior**: Only calculate slots for one webinar session
- ✅ **Fixed**: Conflict detection now checks overlapping time ranges

### Subscriptions (Multiple Calls)

- ✅ **Fixed**: Now calculates all remaining calls for the entire subscription
- ✅ **New**: Proper endpoint that validates total call count

### Classes (Multiple Sessions)

- ✅ **Fixed**: Now calculates all remaining sessions for the entire class
- ✅ **New**: Proper endpoint that validates total session count

## Validation Logic

### Subscription Reschedule Validation

```typescript
// Calculate total required calls
const totalWeeks = countSundayWeeksInclusive(startDate, endDate);
const totalRequiredCalls = totalWeeks * callsPerWeek;

// Count existing completed calls (excluding rescheduled one)
const existingCompletedCalls = appointments
  .filter((appt) => appt.id !== appointmentId)
  .filter((appt) => appt.slotsOfAppointment.length === slotsPerCall).length;

// Calculate remaining calls
const remainingCalls = totalRequiredCalls - existingCompletedCalls;

// Validate newSlots contains correct number of slots
const expectedSlots = remainingCalls * slotsPerCall;
if (newSlots.length !== expectedSlots) {
  throw new Error(
    `Expected ${expectedSlots} slots for ${remainingCalls} remaining calls`
  );
}
```

### Class Reschedule Validation

```typescript
// Calculate total required sessions
const totalWeeks = countSundayWeeksInclusive(startDate, endDate);
const totalRequiredSessions = totalWeeks * callsPerWeek;

// Count existing completed sessions (excluding rescheduled one)
const existingCompletedSessions = appointments
  .filter((appt) => appt.id !== appointmentId)
  .filter((appt) => appt.slotsOfAppointment.length === slotsPerSession).length;

// Calculate remaining sessions
const remainingSessions = totalRequiredSessions - existingCompletedSessions;

// Validate newSlots contains correct number of slots
const expectedSlots = remainingSessions * slotsPerSession;
if (newSlots.length !== expectedSlots) {
  throw new Error(
    `Expected ${expectedSlots} slots for ${remainingSessions} remaining sessions`
  );
}
```

## Testing Scenarios

### Subscription Reschedule Test Cases

1. **6-month subscription, 3 calls/week, 1-hour sessions**
   - Total calls: 26 weeks × 3 calls = 78 calls
   - If 10 calls already completed, reschedule should require 68 calls × 2 slots = 136 slots

2. **3-month subscription, 2 calls/week, 1.5-hour sessions**
   - Total calls: 13 weeks × 2 calls = 26 calls
   - If 5 calls already completed, reschedule should require 21 calls × 3 slots = 63 slots

### Class Reschedule Test Cases

1. **3-month class, 2 sessions/week, 2-hour sessions**
   - Total sessions: 13 weeks × 2 sessions = 26 sessions
   - If 8 sessions already completed, reschedule should require 18 sessions × 4 slots = 72 slots

## Error Handling

### Common Error Messages

- `"Expected X slots for Y remaining calls, but received Z"` - Slot count mismatch
- `"Cannot reschedule to a past time"` - Time validation
- `"Selected time does not match consultant's weekly availability"` - Availability validation
- `"Consultant has overlapping events within the new slot times"` - Conflict detection

## Future Improvements

1. **Add reschedule validation to frontend** - Show expected slot count before submission
2. **Add progress indicators** - Show how many calls/sessions are being rescheduled
3. **Add bulk reschedule** - Allow rescheduling multiple appointments at once
4. **Add reschedule history** - Track reschedule changes for audit purposes
5. **Add reschedule notifications** - Notify participants of schedule changes

## Files Modified

### New Files Created

- `app/api/events/subscriptions/[subscriptionId]/reschedule/route.ts`
- `app/api/events/classes/[classId]/reschedule/route.ts`
- `docs/reschedule-fixes.md`

### Files Modified

- `app/api/events/webinars/[webinarId]/reschedule/route.ts` - Fixed conflict detection
- `app/dashboard/consultant/[consultantId]/(features)/shared/utils/allocationService.ts` - Added class reschedule method

## Summary

The core issue was that the reschedule functionality was treating all events as single-session events, when subscriptions and classes actually have multiple calls/sessions that need to be calculated together. The fixes ensure that:

1. **All remaining calls/sessions are calculated** for the entire event duration
2. **Proper validation** ensures the correct number of slots are provided
3. **Conflict detection** works correctly for overlapping time ranges
4. **Event-specific logic** handles the different requirements of webinars vs subscriptions vs classes

This resolves the issue where users couldn't reschedule events because the system was only expecting slots for one call instead of all remaining calls.



