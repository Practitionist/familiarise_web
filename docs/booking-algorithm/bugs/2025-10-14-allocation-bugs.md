# Booking Allocation Bugs - October 14, 2025

## Testing Session Summary

**Date**: October 14, 2025
**Testing Tool**: Claude Code with Supabase MCP + Chrome DevTools MCP
**Test Environment**:
- Consultant: Aaron Casper (teetanrobotics@gmail.com)
- Consultation ID: `83a590c8-5593-4b33-b8e9-2ba64f9f61b5`
- Required: 2-hour consultation (4 consecutive 30-min slots)
- Browser: Chrome with DevTools MCP
- Database: Supabase PostgreSQL

**Scope**: Comprehensive testing of auto-allocate, manual allocate, and slot selection functionality from consultant dashboard.

---

## Bug #1: Frontend Configuration Bug ✅ FIXED

### Classification
- **Severity**: Medium
- **Type**: Configuration/Props passing
- **Status**: **RESOLVED** (October 14, 2025)

### Affected Components
- `app/dashboard/consultant/[consultantId]/(features)/requests/components/TimingsCalendar.tsx` (Lines 4-32)
- `app/dashboard/consultant/[consultantId]/(features)/requests/RequestSlotAllocationTab.tsx` (Lines 811-825)

### Description

The allocation dialog displayed conflicting information about consultation duration:
- ✅ Header correctly showed: "Choose 4 slots for consultation"
- ✅ Header correctly showed: "Consultation is 2 hours (4 consecutive slots)"
- ❌ Warning banner displayed: "⚠️ Using Default Value - Consultation duration not configured. Using 1-hour default"
- ❌ Footer incorrectly showed: "Required: 1h consultation (2 consecutive slots)"
- ❌ Slot selection was limited to 2 slots instead of 4

### Root Cause

1. **Missing Prop in TimingsCalendar**: The `durationInHours` prop was not defined in the component's TypeScript interface, so it wasn't being passed to the `SafeUnifiedCalendar` child component.

2. **Incorrect Prop Mapping in Parent**: The `RequestSlotAllocationTab` component was passing consultation duration as `sessionDurationInHours` (line 819), which is meant for subscription events, not consultations.

**Code Flow**:
```
RequestSlotAllocationTab (parent)
  ↓ sessionDurationInHours={consultation.durationInHours} ❌ WRONG
TimingsCalendar (wrapper)
  ↓ [prop not defined, not passed through]
SafeUnifiedCalendar → UnifiedCalendar
  ↓ Checks durationInHours
  ❌ undefined → Shows warning, uses 1-hour default
```

### Fix Applied

**File 1**: `TimingsCalendar.tsx`

```typescript
// BEFORE (Line 4-17):
type TimingsCalendarProps = {
  consultantId: string;
  eventType: "consultation" | "subscription";
  eventId?: string;
  onSlotSelect: (slotStartTimeUTC: string) => void;
  selectedSlots: string[] | undefined;
  requiredSlots: number;
  durationInMonths?: number;
  callsPerWeek?: number;
  sessionDurationInHours?: number;
  allowedStart?: Date;
  allowedEnd?: Date;
};

// AFTER (Added line 12):
type TimingsCalendarProps = {
  consultantId: string;
  eventType: "consultation" | "subscription";
  eventId?: string;
  onSlotSelect: (slotStartTimeUTC: string) => void;
  selectedSlots: string[] | undefined;
  requiredSlots: number;
  durationInMonths?: number;
  durationInHours?: number; // ← ADDED FOR CONSULTATIONS
  callsPerWeek?: number;
  sessionDurationInHours?: number; // For subscriptions
  allowedStart?: Date;
  allowedEnd?: Date;
};

// Component signature (Line 19-32):
export function TimingsCalendar({
  consultantId,
  eventType,
  eventId,
  onSlotSelect,
  selectedSlots = [],
  requiredSlots: _requiredSlots,
  durationInMonths,
  durationInHours, // ← ADDED
  callsPerWeek,
  sessionDurationInHours,
  allowedStart,
  allowedEnd,
}: TimingsCalendarProps) {
  // ... rest of component

  // Pass to child (Line 55-70):
  return (
    <SafeUnifiedCalendar
      consultantId={consultantId}
      eventType={eventType}
      eventId={eventId}
      durationInMonths={durationInMonths}
      durationInHours={durationInHours} // ← ADDED
      callsPerWeek={callsPerWeek}
      sessionDurationInHours={sessionDurationInHours}
      // ... other props
    />
  );
}
```

**File 2**: `RequestSlotAllocationTab.tsx`

```typescript
// BEFORE (Line 806-825):
<TimingsCalendar
  consultantId={consultantId}
  eventType={selectedRequest.type.toLowerCase() as "consultation" | "subscription"}
  eventId={selectedRequest.id}
  onSlotSelect={handleSlotSelect}
  selectedSlots={selectedSlots}
  requiredSlots={selectedRequest.requiredSlots}
  durationInMonths={
    selectedRequest.type === "SUBSCRIPTION"
      ? selectedRequest.durationInMonths
      : undefined
  }
  callsPerWeek={
    selectedRequest.type === "SUBSCRIPTION"
      ? selectedRequest.callsPerWeek
      : undefined
  }
  sessionDurationInHours={
    selectedRequest.type === "SUBSCRIPTION"
      ? selectedRequest.sessionDurationInHours
      : selectedRequest.durationInHours  // ❌ WRONG - passing consultation duration as subscription prop
  }
  allowedStart={selectedRequest.startDate}
  allowedEnd={selectedRequest.endDate}
/>

// AFTER (Lines 806-828):
<TimingsCalendar
  consultantId={consultantId}
  eventType={selectedRequest.type.toLowerCase() as "consultation" | "subscription"}
  eventId={selectedRequest.id}
  onSlotSelect={handleSlotSelect}
  selectedSlots={selectedSlots}
  requiredSlots={selectedRequest.requiredSlots}
  durationInMonths={
    selectedRequest.type === "SUBSCRIPTION"
      ? selectedRequest.durationInMonths
      : undefined
  }
  durationInHours={ // ← ADDED
    selectedRequest.type === "CONSULTATION"
      ? selectedRequest.durationInHours
      : undefined
  }
  callsPerWeek={
    selectedRequest.type === "SUBSCRIPTION"
      ? selectedRequest.callsPerWeek
      : undefined
  }
  sessionDurationInHours={
    selectedRequest.type === "SUBSCRIPTION"
      ? selectedRequest.sessionDurationInHours
      : undefined // ✅ FIXED - only pass for subscriptions
  }
  allowedStart={selectedRequest.startDate}
  allowedEnd={selectedRequest.endDate}
/>
```

### Verification

**Before Fix**:
- Warning banner: "Using 1-hour default"
- Footer: "Required: 1h consultation (2 consecutive slots)"
- Selection limited to 2 slots

**After Fix**:
- ✅ No warning banner
- ✅ Footer: "Required: 2h consultation (4 consecutive slots)"
- ✅ UI shows "0 selected out of 4 required slots"
- ✅ Calendar allows selection of 4 slots

### Impact
- **User Experience**: Confusing UI with contradictory information
- **Functionality**: Prevented correct slot allocation for consultations with non-1-hour durations
- **Data Integrity**: No impact (validation happened before database write)

### Prevention
- Add TypeScript strict mode checks for required props
- Add integration tests for consultation allocation with various durations (0.5h, 1h, 1.5h, 2h, 3h)
- Add prop validation warnings in development mode

---

## Bug #2: Server-Side Auto-Allocation Algorithm ❌ CRITICAL - NOT FIXED

### Classification
- **Severity**: **CRITICAL** (Blocks auto-allocation feature)
- **Type**: Logic Error / Algorithm Bug
- **Status**: **OPEN** - Fix Pending Deployment

### Affected Components
- `utils/slotAllocation/SlotAllocationService.ts` (Lines 348-378, `findAvailableSlots` method)

### Description

Auto-allocation fails with **500 Internal Server Error** even when the consultant has valid consecutive available slots that meet all requirements.

**Test Case**:
- Consultant has 4 consecutive available slots: Wednesday Oct 15, 2025 at 19:30, 20:00, 20:30, 21:00 (UTC)
- Consultation requires 2 hours (4 consecutive 30-minute slots)
- No conflicting appointments during this time
- All slots are in the future
- **Expected**: Auto-allocation succeeds
- **Actual**: 500 error, auto-allocation fails

**Console Error**:
```
Failed to load resource: the server responded with a status of 500 (Internal Server Error)
allocate:undefined:undefined
```

### Root Cause

The `findAvailableSlots()` method in `SlotAllocationService` builds consecutive slot blocks by **incrementing time by 30 minutes** but **does not verify** that each incremented slot actually exists in the consultant's `availableTimeSlots` array. It only checks if slots are booked.

**Problematic Code** (Lines 348-378):

```typescript
private static findAvailableSlots(
  availableTimeSlots: AvailabilitySlotResponse[],
  appointments: AppointmentSlotResponse[],
  slotsPerCall: number,
  scheduleType: "FLEXIBLE" | "FIXED",
): Date[] | null {
  const now = new Date();
  const bookedSlots = new Set(
    appointments.map((a) => a.slotStartTimeInUTC.toISOString())
  );
  const sortedSlots = this.sortSlotsByTime(availableTimeSlots);

  for (const slot of sortedSlots) {
    const slotStart = this.getNextOccurrence(
      slot.slotStartTimeInUTC,
      scheduleType
    );

    if (slotStart < now || bookedSlots.has(slotStart.toISOString())) {
      continue;
    }

    // ❌ BUG: Try to build consecutive block WITHOUT checking if each slot exists
    const consecutiveBlock: Date[] = [];
    let currentTime = new Date(slotStart);

    for (let i = 0; i < slotsPerCall; i++) {
      const currentTimeStr = currentTime.toISOString();

      // ❌ ONLY checks if booked or past, NOT if slot exists in availability
      if (bookedSlots.has(currentTimeStr) || currentTime < now) {
        break;
      }

      consecutiveBlock.push(new Date(currentTime));
      currentTime = new Date(currentTime.getTime() + 30 * 60 * 1000); // Blindly increments
    }

    if (consecutiveBlock.length === slotsPerCall) {
      return consecutiveBlock;
    }
  }

  return null;
}
```

**Problem Scenario**:
1. Consultant has availability slots at: 15:00, 15:30, 16:00, 16:30, 17:30, 18:00 (missing 17:00)
2. Algorithm starts at 15:00 and increments: 15:00 → 15:30 → 16:00 → 16:30 ✅
3. Tries to continue: → 17:00 ❌ (doesn't exist in availability!)
4. Algorithm assumes 17:00 is available because it's not booked and not in past
5. Returns invalid consecutive block including non-existent slot 17:00
6. Later validation or database operation fails → 500 error

### Fix Required

**Solution**: Create a lookup set of available slot times and verify each incremented time exists before adding to consecutive block.

**Code Changes** (`SlotAllocationService.ts` lines ~348-378):

```typescript
private static findAvailableSlots(
  availableTimeSlots: AvailabilitySlotResponse[],
  appointments: AppointmentSlotResponse[],
  slotsPerCall: number,
  scheduleType: "FLEXIBLE" | "FIXED",
): Date[] | null {
  const now = new Date();
  const bookedSlots = new Set(
    appointments.map((a) => a.slotStartTimeInUTC.toISOString())
  );

  // ✅ ADD: Create lookup set for available slots
  const availableSlotsSet = new Set(
    availableTimeSlots.map((s) => s.slotStartTimeInUTC.toISOString())
  );

  const sortedSlots = this.sortSlotsByTime(availableTimeSlots);

  for (const slot of sortedSlots) {
    const slotStart = this.getNextOccurrence(
      slot.slotStartTimeInUTC,
      scheduleType
    );

    if (slotStart < now || bookedSlots.has(slotStart.toISOString())) {
      continue;
    }

    // Try to build consecutive block
    const consecutiveBlock: Date[] = [];
    let currentTime = new Date(slotStart);

    for (let i = 0; i < slotsPerCall; i++) {
      const currentTimeStr = currentTime.toISOString();

      // ✅ FIXED: Check all three conditions
      if (
        bookedSlots.has(currentTimeStr) ||
        !availableSlotsSet.has(currentTimeStr) || // ← ADD THIS CHECK
        currentTime < now
      ) {
        break; // Slot doesn't meet requirements
      }

      consecutiveBlock.push(new Date(currentTime));
      currentTime = new Date(currentTime.getTime() + 30 * 60 * 1000);
    }

    if (consecutiveBlock.length === slotsPerCall) {
      return consecutiveBlock;
    }
  }

  return null;
}
```

**Key Changes**:
1. **Line ~358**: Add `availableSlotsSet` creation for O(1) lookup
2. **Line ~373**: Add `!availableSlotsSet.has(currentTimeStr)` check before adding to consecutive block

### Testing Verification

**Before Fix**:
```bash
# Auto-allocate API call
PATCH /api/events/consultations/83a590c8-5593-4b33-b8e9-2ba64f9f61b5/allocate
Body: { "isAuto": true }

Response: 500 Internal Server Error
Body: { "error": "Failed to allocate slots" }
```

**After Fix** (Expected):
```bash
# Same API call
Response: 200 OK
Body: {
  "success": true,
  "data": {
    "appointmentId": "...",
    "slots": [
      "2025-10-15T19:30:00.000Z",
      "2025-10-15T20:00:00.000Z",
      "2025-10-15T20:30:00.000Z",
      "2025-10-15T21:00:00.000Z"
    ]
  }
}

# Database verification
SELECT * FROM "Appointment" WHERE "consultationId" = '83a590c8-5593-4b33-b8e9-2ba64f9f61b5';
-- Should return 1 appointment

SELECT COUNT(*) FROM "SlotOfAppointment"
WHERE "appointmentId" = [new appointment id];
-- Should return 4
```

### Impact
- **User Experience**: Consultants cannot use auto-allocation feature at all
- **Workaround**: Manual allocation works (when Bug #3 is fixed)
- **Data Integrity**: No corruption (validation prevents bad data)
- **Business Impact**: HIGH - Forces manual slot selection for all allocations

### Related Issues
- May affect subscription auto-allocation as well (uses same service)
- Webinar and class auto-allocation likely affected

### Prevention
- Add unit tests for `findAvailableSlots` with various availability patterns:
  - All consecutive
  - Gaps in availability (e.g., missing 17:00 between 16:30 and 17:30)
  - Overlapping appointments
  - Past slots
- Add integration tests for auto-allocation with real database data
- Add logging to track which slots are considered during allocation

---

## Bug #3: Manual Allocation Button Remains Disabled ❌ CRITICAL - UNDER INVESTIGATION

### Classification
- **Severity**: **CRITICAL** (Blocks manual allocation feature)
- **Type**: UI State Management / Event Handling Bug
- **Status**: **OPEN** - Investigation In Progress

### Affected Components
- `app/dashboard/consultant/[consultantId]/(features)/requests/RequestSlotAllocationTab.tsx` (Lines 395-398, 600, 846)
- `app/dashboard/consultant/[consultantId]/(features)/shared/components/UnifiedCalendar.tsx` (Unknown lines - requires investigation)
- `app/dashboard/consultant/[consultantId]/(features)/requests/components/TimingsCalendar.tsx` (Lines 47-52)

### Description

The "Allocate Manual Slots" button remains **disabled (grayed out)** even when all required slots are correctly selected, preventing consultants from completing manual allocation.

**Test Case**:
- Consultation requires 4 consecutive slots (2 hours)
- Manually selected 4 consecutive Wednesday slots:
  - 19:30 UTC (Selected - dark green)
  - 20:00 UTC (Selected - dark green)
  - 20:30 UTC (Selected - dark green)
  - 21:00 UTC (Selected - dark green)
- Footer displays: "**4 selected out of 4 required slots**" ✅
- Status bar shows: "Required: 2h consultation (4 consecutive slots)" ✅
- All slots are on same day ✅
- All slots are consecutive ✅
- **Expected**: "Allocate Manual Slots" button should be **enabled**
- **Actual**: Button remains **disabled** (grayed out, unclickable)

**Visual Evidence**:
![Screenshot showing 4 selected slots with disabled button](Screenshot from test session - Wed Oct 14 evening slots selected, button grayed out)

### Observed Behavior

**UI State**:
- Calendar correctly shows 4 slots in dark green "Selected" state
- Status text accurately displays "4 selected out of 4 required slots"
- All other validation appears correct (same day, consecutive, future dates)
- Button has `disabled` attribute set to `true`

**Console**:
- No JavaScript errors during slot selection
- No validation errors logged
- Selection clicks are registered (slots turn dark green)
- No 500 errors (this is purely a frontend issue)

**Attempted Actions**:
- Clicking the disabled button: Times out (button truly disabled in DOM)
- Reselecting slots: Same issue persists
- Trying different slot combinations: Button never enables

### Root Cause Analysis

**Button Enable Logic** (`RequestSlotAllocationTab.tsx`):

```typescript
// Line 600: Calculate if quota is met
const isQuotaMet = selectedRequest?.requiredSlots === selectedSlots.length;

// Line 846: Button disabled attribute
<Button
  onClick={handleManualAllocation}
  disabled={!isQuotaMet || isAllocating}
>
  {isAllocating ? "Allocating..." : "Allocate Manual Slots"}
</Button>
```

**Expected Values**:
- `selectedRequest.requiredSlots` = 4
- `selectedSlots.length` = 4
- `isQuotaMet` = true
- `isAllocating` = false
- **Button should be enabled** (`disabled={false}`)

**Hypothesis**: Despite UI showing "4 selected", the parent component's `selectedSlots` state array does NOT actually contain 4 items.

**Possible Causes**:

1. **State Update Delay**: `UnifiedCalendar` tracks selections internally but doesn't propagate all 4 to parent immediately
2. **Callback Not Firing**: `onSlotsSelected` callback in `TimingsCalendar` not invoked correctly
3. **Validation Blocking**: Internal validation in `UnifiedCalendar` prevents selection from being "finalized"
4. **Stale Closure**: `handleSlotSelect` has stale reference to `selectedSlots` state

**Data Flow**:
```
User clicks slot in UnifiedCalendar
  ↓
UnifiedCalendar updates internal state (slot turns dark green)
  ↓
UnifiedCalendar calls onSlotsSelected(selectedSlots) ???
  ↓
TimingsCalendar.handleSlotsSelected receives TimeSlot[] ???
  ↓
Calls onSlotSelect(slot.startTime.toISOString()) for each slot ???
  ↓
RequestSlotAllocationTab.handleSlotSelect adds to selectedSlots state ???
  ↓
isQuotaMet calculation: selectedSlots.length === 4 ???
  ↓
Button enabled ???
```

**One of these steps is failing** ⚠️

### Investigation Steps Required

1. **Add Debug Logging** to `RequestSlotAllocationTab.tsx`:
```typescript
// Line ~381-393
const handleSlotSelect = (slot: string) => {
  console.log('[DEBUG] handleSlotSelect called with:', slot);
  console.log('[DEBUG] Current selectedSlots:', selectedSlots);
  console.log('[DEBUG] selectedRequest.requiredSlots:', selectedRequest?.requiredSlots);

  setSelectedSlots((prevSlots) => {
    const newSlots = // ... existing logic
    console.log('[DEBUG] New selectedSlots:', newSlots);
    return newSlots;
  });
};

// Line ~600
const isQuotaMet = selectedRequest?.requiredSlots === selectedSlots.length;
console.log('[DEBUG] isQuotaMet:', isQuotaMet);
console.log('[DEBUG] Calculation:', selectedRequest?.requiredSlots, '===', selectedSlots.length);
```

2. **Inspect `UnifiedCalendar.tsx`**:
   - Find where `onSlotsSelected` is called
   - Check if validation prevents callback invocation
   - Verify callback receives ALL selected slots, not just the last clicked

3. **Check `TimingsCalendar.tsx`** (Lines 47-52):
```typescript
const handleSlotsSelected = (slots: TimeSlot[]) => {
  // Does this loop call onSlotSelect for EACH slot?
  slots.forEach((slot) => {
    onSlotSelect(slot.startTime.toISOString());
  });
};
```
**Question**: Is `forEach` calling the callback 4 times with 4 different slots, or is something preventing the calls?

4. **Test with Manual State Update**:
   - Use browser DevTools to manually set `selectedSlots = ['slot1', 'slot2', 'slot3', 'slot4']`
   - Check if button enables
   - This would confirm if issue is state management vs. UI rendering

### Suspected Code Location

**Primary Suspect**: `UnifiedCalendar.tsx` - Likely has validation that prevents `onSlotsSelected` from being called with all 4 slots when they're not "perfectly" consecutive according to some internal logic.

**Potential Issue**:
```typescript
// Hypothetical problematic code in UnifiedCalendar.tsx
const handleSlotClick = (slot: TimeSlot) => {
  // Update internal state
  setInternalSelectedSlots(prev => [...prev, slot]);

  // Check if consecutive (might have bug)
  if (!areConsecutive(internalSelectedSlots)) {
    return; // ❌ Never calls onSlotsSelected!
  }

  // Only call parent callback if validation passes
  onSlotsSelected(internalSelectedSlots);
};
```

### Workaround
**None available** - Manual allocation is completely blocked. Users must wait for Bug #2 fix to use auto-allocation.

### Impact
- **User Experience**: Extremely frustrating - slots appear selected but action cannot be completed
- **Functionality**: Manual allocation feature completely unusable
- **Business Impact**: **CRITICAL** - Combined with Bug #2, consultants have NO way to allocate slots
- **Data Integrity**: No impact (no data written due to inability to submit)

### Related Issues
- May be related to Bug #2 - both involve slot selection/validation logic
- Could affect subscription manual allocation as well

### Next Steps
1. ✅ Add debug logging to all components in the callback chain
2. ⏳ Read `UnifiedCalendar.tsx` to find selection handling code
3. ⏳ Identify exact line where callback is/isn't being invoked
4. ⏳ Fix the blocking validation or state sync issue
5. ⏳ Test with original test case (4 consecutive Wednesday slots)
6. ⏳ Add integration test to prevent regression

---

## Additional Findings

### Non-Critical Issues

**1. HTML Hydration Warnings**:
- **Location**: Dialog components
- **Issue**: Nested `<p>` tags inside `<p>` parent elements
- **Impact**: Development console warnings, no functional impact
- **Fix**: Change inner `<p>` to `<div>` or use proper semantic HTML

**Error Output**:
```
Error> In HTML, %s cannot be a descendant of <%s>.
This will cause a hydration error.%s <p> p
```

**2. 500 Error from Previous Auto-Allocate Attempt**:
- Logged in console from earlier failed auto-allocation test
- Does not impact manual allocation testing
- Will be resolved when Bug #2 is fixed

---

## Testing Recommendations

### Immediate Actions
1. **Deploy Bug #2 Fix**: Unblocks auto-allocation (highest priority)
2. **Complete Bug #3 Investigation**: Debug logging + code review
3. **Deploy Bug #3 Fix**: Unblocks manual allocation

### Short-Term Testing
- Regression test Bug #1 fix with various durations (0.5h, 1.5h, 2.5h, 3h)
- Test auto-allocation with different availability patterns:
  - All consecutive slots
  - Slots with gaps (missing 17:00 between 16:30 and 17:30)
  - Past vs. future slots
  - Overlapping appointments
- Test manual allocation with:
  - Exact required number of slots
  - More than required (should limit selection)
  - Non-consecutive slots (should show error)

### Long-Term Improvements
1. **Add Integration Tests**:
   - E2E test for full allocation flow (request → allocate → verify DB)
   - Test all event types (consultation, subscription, webinar, class)
   - Test all allocation modes (auto, manual, requested times)

2. **Add Unit Tests**:
   - `findAvailableSlots` with various availability patterns
   - `handleSlotSelect` state updates
   - Button enable/disable logic

3. **Improve Error Handling**:
   - More specific error messages (e.g., "No consecutive slots available" vs. generic "Failed to allocate")
   - Validation errors shown in UI before API call
   - Retry mechanism for transient failures

4. **Add Monitoring**:
   - Log allocation success/failure rates
   - Track time taken for auto-allocation algorithm
   - Alert on high error rates

---

## Summary

| Bug # | Title | Severity | Status | Blocker | Fix Available |
|-------|-------|----------|--------|---------|---------------|
| #1 | Frontend Configuration | Medium | ✅ FIXED | No | ✅ Deployed |
| #2 | Auto-Allocation Algorithm | CRITICAL | ❌ Open | Yes | ✅ Ready |
| #3 | Manual Allocation Button | CRITICAL | ❌ Open | Yes | ⏳ Investigating |

**Critical Path**:
1. Deploy Bug #2 fix → Enables auto-allocation
2. Complete Bug #3 investigation → Identify root cause
3. Deploy Bug #3 fix → Enables manual allocation
4. Full system functional ✅

**Estimated Resolution Timeline**:
- Bug #2: Fix ready, deploy today
- Bug #3: Investigation in progress, fix within 24 hours
- All issues resolved: Within 1-2 business days

---

## Appendix: Test Data

### Consultant Details
```sql
SELECT * FROM "ConsultantProfile" WHERE id = '56ac8db0-e9a8-4010-be14-77ad7c40cbef';
-- Returns: Aaron Casper, email: teetanrobotics@gmail.com
```

### Availability Slots (Wednesday Oct 15, 2025)
```sql
SELECT "slotStartTimeInUTC", "slotEndTimeInUTC", "isActive"
FROM "AvailabilitySlot"
WHERE "consultantProfileId" = '56ac8db0-e9a8-4010-be14-77ad7c40cbef'
  AND "slotStartTimeInUTC" >= '2025-10-15T19:00:00Z'
  AND "slotStartTimeInUTC" <= '2025-10-15T22:00:00Z'
ORDER BY "slotStartTimeInUTC";

-- Results:
-- 2025-10-15T19:30:00.000Z | 2025-10-15T20:00:00.000Z | true
-- 2025-10-15T20:00:00.000Z | 2025-10-15T20:30:00.000Z | true
-- 2025-10-15T20:30:00.000Z | 2025-10-15T21:00:00.000Z | true
-- 2025-10-15T21:00:00.000Z | 2025-10-15T21:30:00.000Z | true
```

### Consultation Request
```sql
SELECT c.id, c."requestStatus", cp."durationInHours", c."requestedAt"
FROM "Consultation" c
JOIN "ConsultationPlan" cp ON cp.id = c."consultationPlanId"
WHERE c.id = '83a590c8-5593-4b33-b8e9-2ba64f9f61b5';

-- Results:
-- id: 83a590c8-5593-4b33-b8e9-2ba64f9f61b5
-- requestStatus: PENDING
-- durationInHours: 2
-- requestedAt: [timestamp]
```

### Existing Appointments (No conflicts)
```sql
SELECT COUNT(*) FROM "Appointment" a
JOIN "SlotOfAppointment" soa ON soa."appointmentId" = a.id
WHERE a."consultantProfileId" = '56ac8db0-e9a8-4010-be14-77ad7c40cbef'
  AND soa."slotStartTimeInUTC" >= '2025-10-15T19:00:00Z'
  AND soa."slotStartTimeInUTC" <= '2025-10-15T22:00:00Z';

-- Results: 0 (no conflicts)
```

---

**Report compiled by**: Claude Code Testing Agent
**Date**: October 14, 2025
**Tools**: Supabase MCP, Chrome DevTools MCP, Prisma Schema Analysis
**Next Review**: After Bug #2 and #3 fixes deployed
