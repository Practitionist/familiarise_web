# Troubleshooting Guide

This guide helps diagnose and resolve common errors in the booking algorithm system.

## Overview

Errors in the booking system fall into three categories:

1. **Validation Errors** (400, 500) - Business rule violations
2. **Input Errors** (400) - Malformed requests
3. **System Errors** (500, 404) - Server issues

---

## Quick Error Reference

| Error Message Pattern | Category | Solution Reference |
|----------------------|----------|-------------------|
| "Slot already booked" | Conflict | [Overlap Detection](#1-slot-already-booked) |
| "Slots must be consecutive" | Validation | [Consecutive Gaps](#2-slots-must-be-consecutive) |
| "Invalid slot count" | Validation | [Slot Count](#3-invalid-slot-count) |
| "Weekly limit exceeded" | Subscription | [Weekly Limits](#4-weekly-limit-exceeded) |
| "Outside scheduling period" | Validation | [Scheduling Period](#5-outside-scheduling-period) |
| "Slots in the past" | Validation | [Future Slots](#6-slots-in-the-past) |
| "Each slot must be a valid ISO 8601" | Input | [Datetime Format](#7-invalid-datetime-format) |
| "Manual allocation requires 'slots' array" | Input | [Request Body](#8-missing-slots-array) |
| "Event not found" | System | [Event Lookup](#9-event-not-found) |
| "does not match consultant's schedule" | Validation | [Availability](#10-outside-availability) |

---

## Common Errors and Solutions

### 1. "Slot already booked"

**Full Error**:
```
"Validation failed: Slot already booked: 2/15/2025, 10:00:00 AM (conflicts with consultation for John Doe)"
```

**Cause**: Time slot overlaps with an existing approved appointment.

**Why This Happens**:
- The consultant is already booked at this time
- Another event (consultation, subscription, webinar, class) occupies this slot
- Uses range overlap detection (not just exact match)

**Example Conflict**:
```
Existing: 10:00-10:30 (consultation)
Proposed: 10:00-11:00 (2 slots)

Conflicts:
  - 10:00-10:30 ✗ (overlaps existing)
  - 10:30-11:00 ✗ (overlaps existing end time)
```

**Solutions**:

1. **Check Consultant Calendar**: View consultant's existing appointments
   ```typescript
   // Fetch consultant's booked slots
   GET /api/consultants/{id}/appointments?startDate=2025-02-15&endDate=2025-02-15
   ```

2. **Use Validation Endpoint First**: Check slots before allocation
   ```typescript
   // Validate before allocating
   const validation = await POST /api/events/consultations/{id}/validate

   if (validation.conflicts.length > 0) {
     // Show user which slots conflict
     validation.conflicts.forEach(conflict => {
       console.log(`${conflict.slot} conflicts with ${conflict.existingAppointment.type}`);
     });
   }
   ```

3. **Select Different Time**: Choose non-conflicting slots
   - Use `validSlots` array from validation response
   - Filter out slots in `conflicts` array

**Prevention**:
- Always call `/validate` before `/allocate`
- Show real-time availability calendar to users
- Highlight conflicting slots in UI

---

### 2. "Slots must be consecutive"

**Full Error**:
```
"Validation failed: Slots must be consecutive. Gap detected between 2/15/2025, 10:00:00 AM and 2/15/2025, 11:00:00 AM"
```

**Cause**: Selected slots have gaps (not exactly 30 minutes apart).

**Why This Happens**:
- User skipped a 30-minute slot
- Slots are not in sequential order
- Time difference > 1 second tolerance

**Example**:
```
Valid consecutive:
  ✓ 10:00, 10:30, 11:00, 11:30

Invalid (gap):
  ✗ 10:00, 10:30, 11:30 (missing 11:00)
  ✗ 10:00, 11:00 (missing 10:30)
  ✗ 10:00, 10:30, 14:00 (afternoon gap)
```

**Solutions**:

1. **Fill the Gap**: Add missing slots
   ```typescript
   // Before: [10:00, 11:00]
   // After:  [10:00, 10:30, 11:00]
   ```

2. **Auto-Generate Consecutive Slots**: Use helper function
   ```typescript
   function generateConsecutiveSlots(start: Date, count: number): Date[] {
     const slots = [start];
     for (let i = 1; i < count; i++) {
       const prevSlot = slots[i - 1];
       slots.push(new Date(prevSlot.getTime() + 30 * 60 * 1000));
     }
     return slots;
   }

   // Usage
   const slots = generateConsecutiveSlots(
     new Date("2025-02-15T10:00:00Z"),
     4 // 2-hour session
   );
   // Result: [10:00, 10:30, 11:00, 11:30]
   ```

3. **Sort Slots**: Ensure slots are in chronological order
   ```typescript
   const sortedSlots = slots.sort((a, b) =>
     new Date(a).getTime() - new Date(b).getTime()
   );
   ```

**Debug Checklist**:
- [ ] Are all 30-minute increments included?
- [ ] Are slots sorted chronologically?
- [ ] Is there a sub-second precision issue? (check milliseconds)

**Prevention**:
- Use datetime picker that enforces 30-minute increments
- Provide "fill consecutive" UI helper
- Validate on client-side before submission

---

### 3. "Invalid slot count"

**Full Error**:
```
"Invalid slot count: 7 slots provided, but 2-hour sessions require multiples of 4 slots (30 minutes each). Valid counts: 4, 8, 12, etc."
```

**Cause**: Number of slots doesn't match session duration requirements.

**Why This Happens**:
- User selected wrong number of slots
- Partial appointment created
- Session duration changed after slot selection

**Calculation**:
```
Session duration: 2 hours
Slots per session: 2 hours ÷ 0.5 hours = 4 slots
Required: Multiple of 4 (4, 8, 12, 16, ...)

Provided: 7 slots
7 ÷ 4 = 1.75 sessions (incomplete ✗)
```

**Solutions**:

1. **Calculate Required Slots**:
   ```typescript
   function calculateRequiredSlots(durationHours: number): number {
     return Math.ceil(durationHours / 0.5);
   }

   // Example
   const duration = 2.5; // hours
   const required = calculateRequiredSlots(2.5);
   // Result: 5 slots (5 × 30min = 2.5 hours)
   ```

2. **For One-Time Events** (Consultations, Webinars):
   - Select exactly the required number of slots
   ```typescript
   // 1.5-hour consultation → 3 slots
   slots = ["10:00", "10:30", "11:00"] ✓
   ```

3. **For Recurring Events** (Subscriptions, Classes):
   - Total slots must be multiple of slots per session
   ```typescript
   // 2-hour sessions (4 slots each)
   // Valid: 4, 8, 12, 16, 20, ... slots

   // Example: 3 sessions
   slots = 3 sessions × 4 slots = 12 slots ✓
   ```

4. **Auto-Allocation**: Let system calculate
   ```typescript
   POST /api/events/consultations/{id}/allocate
   { "isAuto": true }
   // System automatically selects correct number
   ```

**Debug Example**:
```
Session duration: 1.5 hours
Required slots per session: 3

User selected: 10 slots
10 ÷ 3 = 3.33 sessions (incomplete ✗)

Fix: Select 9 or 12 slots
  9 ÷ 3 = 3 sessions ✓
  12 ÷ 3 = 4 sessions ✓
```

**Prevention**:
- Display required slot count in UI
- Disable "submit" until correct number selected
- Show progress: "3 of 4 slots selected"

---

### 4. "Weekly limit exceeded"

**Full Error**:
```
"Week of 2/9/2025 exceeds call limit. Maximum 2 calls per week, but 3 calls are scheduled."
```

**Cause**: Subscription or class weekly limit exceeded.

**Why This Happens**:
- Week boundary (Sunday-Saturday) contains too many calls
- Existing appointments already consume weekly quota
- Proposed + existing > weekly limit

**Week Calculation**:
```
Subscription: 2 calls per week max
Week of Feb 9: Sun Feb 9 - Sat Feb 15

Existing calls:
  - Mon Feb 10, 10:00-11:00 (1 call)

Proposed calls:
  - Wed Feb 12, 14:00-15:00 (1 call)
  - Fri Feb 14, 16:00-17:00 (1 call)

Total: 1 + 2 = 3 calls
Limit: 2 calls
Result: EXCEEDED ✗
```

**Solutions**:

1. **Check Weekly Info**: Get current weekly schedule
   ```typescript
   POST /api/events/subscriptions/{id}/validate
   { "slots": [] }

   // Response includes weeklyInfo
   {
     "subscriptionValidation": {
       "weeklyInfo": [
         {
           "weekStart": "2025-02-09T00:00:00Z",
           "weekEnd": "2025-02-15T23:59:59Z",
           "existingCalls": 1,
           "maxCalls": 2,
           "canScheduleMore": true,
           "availableSlots": 1  // Can schedule 1 more
         }
       ]
     }
   }
   ```

2. **Spread Across Weeks**: Move slots to different weeks
   ```typescript
   // Before (3 calls in week of Feb 9)
   [
     "2025-02-10T10:00:00Z", // Week of Feb 9
     "2025-02-12T14:00:00Z", // Week of Feb 9
     "2025-02-14T16:00:00Z"  // Week of Feb 9
   ]

   // After (distributed)
   [
     "2025-02-10T10:00:00Z", // Week of Feb 9 (1 call)
     "2025-02-12T14:00:00Z", // Week of Feb 9 (2 calls total ✓)
     "2025-02-17T16:00:00Z"  // Week of Feb 16 (1 call ✓)
   ]
   ```

3. **Identify Week Boundaries**:
   ```typescript
   function getWeekBoundary(date: Date): { start: Date; end: Date } {
     const dayOfWeek = date.getDay(); // 0 = Sunday
     const sunday = new Date(date);
     sunday.setDate(date.getDate() - dayOfWeek);
     sunday.setHours(0, 0, 0, 0);

     const saturday = new Date(sunday);
     saturday.setDate(sunday.getDate() + 6);
     saturday.setHours(23, 59, 59, 999);

     return { start: sunday, end: saturday };
   }

   // Usage
   const week = getWeekBoundary(new Date("2025-02-12"));
   // { start: Sun Feb 9 00:00, end: Sat Feb 15 23:59 }
   ```

**Debug Checklist**:
- [ ] What is the weekly limit? (check subscription plan)
- [ ] How many calls already scheduled this week?
- [ ] Which week do proposed slots fall into? (use Sunday-Saturday)
- [ ] Can any slots be moved to a different week?

**Prevention**:
- Show weekly calendar with limits
- Highlight weeks at capacity
- Display "X of Y calls this week" in UI

---

### 5. "Outside scheduling period"

**Full Error**:
```
"Slot 4/15/2025, 10:00:00 AM is outside the scheduling period (1/1/2025 - 3/1/2025). All slots must be scheduled within this date range."
```

**Cause**: Slot date not within subscription/class start and end dates.

**Why This Happens**:
- User selected date outside allowed range
- Subscription expired or not yet started
- Server-side validation caught client bypass

**Example**:
```
Subscription period: Jan 1, 2025 - Mar 1, 2025

Valid slots:
  ✓ 2025-01-15T10:00:00Z (within period)
  ✓ 2025-02-20T14:00:00Z (within period)

Invalid slots:
  ✗ 2024-12-20T10:00:00Z (before start)
  ✗ 2025-03-15T10:00:00Z (after end)
```

**Solutions**:

1. **Check Scheduling Period**:
   ```typescript
   GET /api/events/subscriptions/{id}

   // Response includes dates
   {
     "startDate": "2025-01-01T00:00:00Z",
     "endDate": "2025-03-01T00:00:00Z"
   }
   ```

2. **Filter Slots by Date Range**:
   ```typescript
   function filterSlotsInPeriod(
     slots: string[],
     startDate: Date,
     endDate: Date
   ): string[] {
     return slots.filter(slot => {
       const slotDate = new Date(slot);
       return slotDate >= startDate && slotDate <= endDate;
     });
   }

   // Usage
   const validSlots = filterSlotsInPeriod(
     allSlots,
     new Date("2025-01-01"),
     new Date("2025-03-01")
   );
   ```

3. **Request Period Extension**: Contact admin to extend subscription

**Prevention**:
- Disable date picker dates outside period
- Show period boundaries clearly in UI
- Client-side validation before API call

---

### 6. "Slots in the past"

**Full Error**:
```
"Cannot allocate slots in the past or too soon: 2/15/2025, 10:00:00 AM (only 2.1s). Slots must be at least 5 seconds in the future to allow for processing time."
```

**Cause**: Slot time is in the past or too close to current time (< 5 seconds).

**Why This Happens**:
- User selected yesterday's date
- Clock drift between client and server
- Processing delay caused slot to become "now"
- Auto-allocation race condition

**5-Second Buffer Rationale**:
```
Current time: 10:00:00.000

Slot: 10:00:02.000 (2 seconds in future)
Buffer: 5 seconds
Cutoff: 10:00:05.000

Check: 10:00:02.000 < 10:00:05.000
Result: TOO SOON ✗

Slot: 10:00:10.000 (10 seconds in future)
Check: 10:00:10.000 < 10:00:05.000
Result: VALID ✓
```

**Solutions**:

1. **Select Future Date**:
   ```typescript
   // Ensure slot is at least 10 seconds in future
   const now = new Date();
   const minSlot = new Date(now.getTime() + 10000); // +10 seconds

   if (selectedSlot < minSlot) {
     alert("Please select a time at least 10 seconds in the future");
   }
   ```

2. **Handle Auto-Allocation Edge Case**:
   ```typescript
   // If auto-allocation fails with "too soon"
   // Wait a few seconds and retry
   try {
     await allocateSlots({ isAuto: true });
   } catch (error) {
     if (error.message.includes("too soon")) {
       await sleep(5000); // Wait 5 seconds
       await allocateSlots({ isAuto: true }); // Retry
     }
   }
   ```

3. **Check Server Time**:
   ```typescript
   // Get server time to check for clock drift
   GET /api/server-time

   const serverTime = await fetch('/api/server-time').then(r => r.json());
   const clientTime = new Date();
   const drift = Math.abs(serverTime.getTime() - clientTime.getTime());

   if (drift > 60000) { // >1 minute
     alert("Your computer clock is out of sync. Please synchronize your clock.");
   }
   ```

**Prevention**:
- Disable past dates in date picker
- Add minimum future time (e.g., 1 hour from now)
- Sync client clock with NTP server

---

### 7. "Invalid datetime format"

**Full Error**:
```
"slots.0: Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')"
```

**Cause**: Slot string is not in ISO 8601 format.

**Why This Happens**:
- Used local datetime format instead of UTC
- Missing timezone indicator
- Used date-only format
- Typo in datetime string

**Invalid Formats**:
```javascript
✗ "2025-01-15"                    // Date only, missing time
✗ "2025-01-15 10:00:00"           // Space instead of T
✗ "01/15/2025 10:00:00"           // US format
✗ "2025-01-15T10:00:00"           // Missing timezone
✗ "2025-01-15T10:00:00+05:30"     // Non-UTC timezone
✗ new Date("2025-01-15T10:00:00") // Date object (need string)
```

**Valid Format**:
```javascript
✓ "2025-01-15T10:00:00Z"          // ISO 8601 with UTC
✓ "2025-01-15T10:00:00.000Z"      // ISO 8601 with milliseconds
```

**Solutions**:

1. **Convert to ISO String**:
   ```typescript
   // From Date object
   const date = new Date("2025-01-15T10:00:00");
   const isoString = date.toISOString();
   // Result: "2025-01-15T10:00:00.000Z"

   // From local time
   const local = new Date(2025, 0, 15, 10, 0, 0); // Month is 0-indexed
   const isoString = local.toISOString();
   ```

2. **Validation Helper**:
   ```typescript
   function isValidISOString(dateString: string): boolean {
     // ISO 8601 regex
     const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
     if (!iso8601Regex.test(dateString)) return false;

     // Check if parseable
     const date = new Date(dateString);
     return !isNaN(date.getTime());
   }

   // Usage
   if (!isValidISOString("2025-01-15T10:00:00Z")) {
     alert("Invalid datetime format");
   }
   ```

3. **Format Examples**:
   ```typescript
   // Correct formatting
   const now = new Date();

   // UTC string
   const utc = now.toISOString();
   // "2025-01-15T10:00:00.000Z"

   // Specific UTC time
   const specific = new Date(Date.UTC(2025, 0, 15, 10, 0, 0));
   const specificISO = specific.toISOString();
   // "2025-01-15T10:00:00.000Z"
   ```

**Prevention**:
- Always use `toISOString()` method
- Validate format before API call
- Use date picker library that outputs ISO 8601

---

### 8. "Missing slots array"

**Full Error**:
```
"slots: Manual allocation requires 'slots' array with at least one time slot"
```

**Cause**: Manual allocation requested without providing slots.

**Why This Happens**:
- `isAuto: false` but no `slots` field
- Empty `slots` array
- `useRequestedSlots` flag not set

**Example**:
```typescript
// ✗ WRONG: Manual without slots
{ "isAuto": false }

// ✗ WRONG: Empty slots
{ "isAuto": false, "slots": [] }

// ✓ CORRECT: Manual with slots
{
  "isAuto": false,
  "slots": ["2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z"]
}

// ✓ CORRECT: Auto allocation
{ "isAuto": true }

// ✓ CORRECT: Use requested slots
{ "isAuto": false, "useRequestedSlots": true }
```

**Solutions**:

1. **Provide Slots Array**:
   ```typescript
   const request = {
     isAuto: false,
     slots: [
       "2025-02-15T10:00:00Z",
       "2025-02-15T10:30:00Z",
       "2025-02-15T11:00:00Z",
       "2025-02-15T11:30:00Z"
     ]
   };
   ```

2. **Use Auto Allocation**:
   ```typescript
   const request = { isAuto: true };
   // System finds slots automatically
   ```

3. **Use Requested Slots**:
   ```typescript
   const request = {
     isAuto: false,
     useRequestedSlots: true
   };
   // Uses pre-created appointments
   ```

**Prevention**:
- Validate request body before sending
- UI should enforce: if manual mode, require slot selection
- Show error in form if slots array empty

---

### 9. "Event not found"

**Full Error**:
```json
{ "error": "Consultation not found" }
```

**Status Code**: 404 Not Found

**Cause**: Event ID doesn't exist in database.

**Why This Happens**:
- Typo in event ID
- Event was deleted
- Using wrong event type URL
- UUID format invalid

**Solutions**:

1. **Verify Event ID**:
   ```typescript
   // Check if event exists
   GET /api/events/consultations/{id}

   // If 404, event doesn't exist
   ```

2. **Check Event Type**:
   ```typescript
   // ✗ WRONG: Using consultation endpoint for subscription
   POST /api/events/consultations/{subscriptionId}/validate

   // ✓ CORRECT: Match event type to endpoint
   POST /api/events/subscriptions/{subscriptionId}/validate
   ```

3. **Validate UUID Format**:
   ```typescript
   function isValidUUID(uuid: string): boolean {
     const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
     return uuidRegex.test(uuid);
   }

   // Usage
   if (!isValidUUID(eventId)) {
     alert("Invalid event ID format");
   }
   ```

**Debug Checklist**:
- [ ] Is the event ID a valid UUID?
- [ ] Does the event exist in the database?
- [ ] Are you using the correct event type endpoint?
- [ ] Was the event recently created? (check creation timestamp)

---

### 10. "Does not match consultant's schedule"

**Full Error**:
```
"Slot 2/15/2025, 3:00:00 PM does not match consultant's weekly schedule"
```

**Cause**: Selected slot not in consultant's availability.

**Why This Happens**:
- Consultant not available at that time
- Weekly schedule: day/time doesn't match pattern
- Custom schedule: exact datetime not in list
- Consultant changed availability after slot selection

**Weekly Schedule Example**:
```
Consultant availability (weekly):
  - Monday 10:00-12:00
  - Wednesday 14:00-16:00
  - Friday 10:00-12:00

Valid slots:
  ✓ Monday 2/17 at 10:00 (matches "Monday 10:00")
  ✓ Wednesday 2/19 at 14:30 (matches "Wednesday 14:00-16:00")

Invalid slots:
  ✗ Monday 2/17 at 15:00 (no Monday availability at 15:00)
  ✗ Tuesday 2/18 at 10:00 (no Tuesday availability)
```

**Solutions**:

1. **Fetch Consultant Availability**:
   ```typescript
   GET /api/consultants/{id}/availability?type=weekly

   // Response
   {
     "scheduleType": "WEEKLY",
     "slotsOfAvailabilityWeekly": [
       { "dayOfWeek": "MONDAY", "startTime": "10:00", "endTime": "12:00" },
       { "dayOfWeek": "WEDNESDAY", "startTime": "14:00", "endTime": "16:00" }
     ]
   }
   ```

2. **Filter Slots by Availability**:
   ```typescript
   function matchesWeeklySchedule(
     slot: Date,
     availability: WeeklySlot[]
   ): boolean {
     const dayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
     const slotDay = dayNames[slot.getDay()];
     const slotTime = `${slot.getHours().toString().padStart(2, '0')}:${slot.getMinutes().toString().padStart(2, '0')}`;

     return availability.some(avail => {
       return avail.dayOfWeek === slotDay &&
              slotTime >= avail.startTime &&
              slotTime < avail.endTime;
     });
   }
   ```

3. **Use Validation Response**:
   ```typescript
   POST /api/events/consultations/{id}/validate

   // Response shows which slots are outside availability
   {
     "outsideAvailability": [
       { "slot": "2025-02-15T15:00:00Z" }
     ],
     "validSlots": [
       "2025-02-15T10:00:00Z",
       "2025-02-15T10:30:00Z"
     ]
   }
   ```

**Prevention**:
- Show consultant availability calendar
- Disable unavailable time slots in picker
- Real-time validation as user selects slots

---

## Debugging Strategies

### 1. Use Validation Endpoint

Always validate before allocating:

```typescript
// Step 1: Validate
const validation = await fetch('/api/events/consultations/{id}/validate', {
  method: 'POST',
  body: JSON.stringify({ slots: proposedSlots })
});

const result = await validation.json();

// Step 2: Analyze errors
if (result.conflicts.length > 0) {
  console.log("Conflicts:", result.conflicts);
}
if (result.outsideAvailability.length > 0) {
  console.log("Outside availability:", result.outsideAvailability);
}

// Step 3: Only allocate if all valid
if (result.validSlots.length === proposedSlots.length) {
  await fetch('/api/events/consultations/{id}/allocate', {
    method: 'PATCH',
    body: JSON.stringify({ isAuto: false, slots: proposedSlots })
  });
}
```

### 2. Read Error Messages Carefully

Error messages contain specific details:

```
"Validation failed: Week of 2/9/2025 exceeds call limit. Maximum 2 calls per week, but 3 calls are scheduled."
                     ^^^^^^^^^^^^^^^^                        ^^                         ^^
                     Which week?                        Max limit                   Current count
```

### 3. Check Logs

Server logs contain full error stack:

```bash
# View recent errors
tail -f /var/log/app.log | grep "ERROR"

# Search for specific event
grep "consultationId: abc123" /var/log/app.log
```

### 4. Inspect Request/Response

Use browser DevTools Network tab:

1. Open DevTools (F12)
2. Go to Network tab
3. Filter by "Fetch/XHR"
4. Click failed request
5. Check:
   - Request Headers
   - Request Payload
   - Response
   - Status Code

### 5. Test with curl

Isolate API issues:

```bash
# Test validation
curl -X POST https://your-domain.com/api/events/consultations/{id}/validate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -d '{"slots": ["2025-02-15T10:00:00Z"]}'

# Check response
# - 200: Success
# - 400: Invalid input
# - 404: Not found
# - 500: Server error
```

---

## Common Patterns

### Pattern 1: Conflict Resolution

```typescript
async function resolveConflicts(eventId: string, slots: string[]) {
  let validSlots = [...slots];

  while (validSlots.length < slots.length) {
    // Validate current selection
    const validation = await validateSlots(eventId, validSlots);

    if (validation.conflicts.length === 0) {
      break; // All valid
    }

    // Remove conflicting slots
    validation.conflicts.forEach(conflict => {
      validSlots = validSlots.filter(s => s !== conflict.slot);
    });

    // Find replacement slots
    const replacements = await findAlternativeSlots(
      eventId,
      validation.conflicts.length
    );

    validSlots.push(...replacements);
  }

  return validSlots;
}
```

### Pattern 2: Retry with Backoff

```typescript
async function allocateWithRetry(
  eventId: string,
  slots: string[],
  maxRetries = 3
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await allocateSlots(eventId, slots);
      return result; // Success
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;

      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay);
    }
  }
}
```

### Pattern 3: Batch Validation

```typescript
async function validateBatch(
  events: Array<{ id: string; slots: string[] }>
) {
  const results = await Promise.all(
    events.map(event =>
      validateSlots(event.id, event.slots)
        .catch(error => ({ id: event.id, error }))
    )
  );

  const valid = results.filter(r => !r.error);
  const invalid = results.filter(r => r.error);

  return { valid, invalid };
}
```

---

## Next Steps

- **Event Types**: See `03_EVENT_TYPES.md` for event-specific validation rules
- **Validation Layers**: See `04_VALIDATION_LAYERS.md` for validation architecture
- **API Reference**: See `06_API_REFERENCE.md` for complete API documentation
- **Bug Fixes**: See `07_BUG_FIXES_CHANGELOG.md` for historical context on error handling
- **Testing**: See `09_TESTING_GUIDE.md` for testing error scenarios
