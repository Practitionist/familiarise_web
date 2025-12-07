# Comprehensive Booking Algorithm Testing Prompt

## Context for Fresh LLM

You are testing a **booking allocation system** for a consultation/subscription platform called Familiarise (formerly ConsultX). This system manages appointments between consultants and consultees for various event types.

---

## System Architecture Overview

### Database Schema (Prisma)

**Key Models**:

1. **User** - Platform users (consultants and consultees)
2. **ConsultantProfile** - Consultant-specific data, links to User
3. **ConsulteeProfile** - Consultee-specific data, links to User

4. **AvailabilitySlot** - Consultant's available time slots
   - `type`: WEEKLY (recurring) or CUSTOM (one-time)
   - `slotStartTimeInUTC`, `slotEndTimeInUTC` (30-minute intervals)
   - `dayOfWeek`: For WEEKLY slots
   - `isActive`: Boolean

5. **Appointment** - Scheduled meetings
   - `appointmentType`: CONSULTATION, SUBSCRIPTION, WEBINAR, CLASS
   - Links to specific event via `consultationId`, `subscriptionId`, etc.
   - `slotsOfAppointment`: Array of SlotOfAppointment

6. **SlotOfAppointment** - Individual 30-minute time slots for an appointment
   - `slotStartTimeInUTC`, `slotEndTimeInUTC`
   - Links to Appointment

7. **Event Types**:
   - **Consultation**: One-time consultation with specific duration (e.g., 1h, 2h)
     - Fields: `consultationPlanId`, `durationInHours`, `requestStatus`, `requestedAt`
   - **Subscription**: Recurring sessions over months
     - Fields: `subscriptionPlanId`, `durationInMonths`, `callsPerWeek`, `sessionDurationInHours`, `startDate`, `endDate`
   - **Webinar**: Group webinar events
   - **Class**: Scheduled course/class

8. **Plans**:
   - **ConsultationPlan**: Template for consultations (`title`, `durationInHours`)
   - **SubscriptionPlan**: Template for subscriptions (`title`, `durationInMonths`, `callsPerWeek`, `sessionDurationInHours`)
   - **WebinarPlan**, **ClassPlan**

---

## UI Structure

### Consultant Dashboard Routes

**Base**: `/dashboard/consultant/[consultantId]`

**Key Pages**:

- `/requests` - View and allocate slots for pending requests
  - Tab: "All", "Consultation", "Subscription"
  - Shows table of pending requests with:
    - Type, Title, Requested By, Requested At, Requested Times, Required Slots, Status
    - Actions: "Use Requested Times", "Allocate Slots"

**Allocation Dialog Components**:

- `RequestSlotAllocationTab.tsx` - Main tab component
- `TimingsCalendar.tsx` - Wrapper for calendar component
- `UnifiedCalendar.tsx` - Core calendar UI with slot selection
- `SafeUnifiedCalendar.tsx` - Error boundary wrapper

**Allocation Modes**:

1. **Auto Allocate**: System finds first available consecutive slots
2. **Manual Allocate**: Consultant selects specific slots
3. **Use Requested Times**: Approve consultee's requested times (with optional override)

---

## API Routes

### Consultation Endpoints

- `GET /api/events/consultations?consultantProfileId=X&status=PENDING`
- `PATCH /api/events/consultations/[id]/allocate` - Allocate slots
  - Body: `{ isAuto: boolean, slots?: string[], useRequestedSlots?: boolean, override?: boolean }`
- `POST /api/events/consultations/[id]/validate` - Validate slots
  - Body: `{ slots: string[] }`

### Subscription Endpoints

- `GET /api/events/subscriptions?consultantProfileId=X&status=PENDING`
- `PATCH /api/events/subscriptions/[id]/allocate`
- `POST /api/events/subscriptions/[id]/validate`

### Webinar & Class Endpoints

- Similar pattern: `/api/events/webinars/[id]/allocate`, `/api/events/classes/[id]/allocate`

### Availability & Appointments

- `GET /api/slots/availability/weekly?consultantProfileId=X`
- `GET /api/slots/availability/custom?consultantProfileId=X`
- `GET /api/slots/appointments?consultantProfileId=X&consultationStatus=APPROVED&subscriptionStatus=APPROVED`

---

## Testing Scenarios

### Prerequisites

```bash
# Supabase MCP Tools
- mcp__supabase__list_projects
- mcp__supabase__execute_sql
- mcp__supabase__get_project
- mcp__supabase__list_tables

# Chrome DevTools MCP Tools
- mcp__chrome-devtools__list_pages
- mcp__chrome-devtools__navigate_page
- mcp__chrome-devtools__take_snapshot
- mcp__chrome-devtools__click
- mcp__chrome-devtools__fill
- mcp__chrome-devtools__take_screenshot
- mcp__chrome-devtools__list_console_messages
```

### Test Setup

1. **Query Database Baseline**:

```sql
-- Get test consultant
SELECT id, "userId" FROM "ConsultantProfile" LIMIT 1;

-- Get their availability (should have multiple consecutive slots)
SELECT "slotStartTimeInUTC", "slotEndTimeInUTC", "type", "dayOfWeek", "isActive"
FROM "AvailabilitySlot"
WHERE "consultantProfileId" = 'CONSULTANT_ID'
  AND "isActive" = true
ORDER BY "slotStartTimeInUTC";

-- Get pending requests
SELECT id, "consultationPlanId", "requestStatus", "requestedAt"
FROM "Consultation"
WHERE "consultantProfileId" = 'CONSULTANT_ID'
  AND "requestStatus" = 'PENDING';

SELECT id, "subscriptionPlanId", "requestStatus", "startDate", "endDate"
FROM "Subscription"
WHERE "consultantProfileId" = 'CONSULTANT_ID'
  AND "requestStatus" = 'PENDING';

-- Get existing appointments (to check for overlaps)
SELECT a.id, a."appointmentType", s."slotStartTimeInUTC", s."slotEndTimeInUTC"
FROM "Appointment" a
JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
WHERE a."consultantProfileId" = 'CONSULTANT_ID'
ORDER BY s."slotStartTimeInUTC";
```

2. **Navigate to Consultant Dashboard**:

```
URL: http://localhost:3000/dashboard/consultant/[consultantId]/requests
- Login as consultant
- Navigate to Requests tab
```

---

### Scenario 1: Auto-Allocation for 2-Hour Consultation

**Setup**:

- Consultant has consecutive availability: Wed 19:30, 20:00, 20:30, 21:00
- Pending consultation requires 2 hours (4 consecutive 30-min slots)

**Steps**:

1. Take snapshot of requests table
2. Click "Allocate Slots" button for the consultation
3. In dialog, verify:
   - Header shows "Choose 4 slots for consultation"
   - Description shows "Consultation is 2 hours (4 consecutive slots)"
   - No configuration warning banner
4. Click "Auto Allocate" button
5. Monitor console for errors
6. Verify success toast appears
7. Query database to confirm:

   ```sql
   SELECT * FROM "Appointment"
   WHERE "consultationId" = 'CONSULTATION_ID';

   SELECT "slotStartTimeInUTC", "slotEndTimeInUTC"
   FROM "SlotOfAppointment"
   WHERE "appointmentId" = 'NEW_APPOINTMENT_ID'
   ORDER BY "slotStartTimeInUTC";

   SELECT "requestStatus" FROM "Consultation"
   WHERE id = 'CONSULTATION_ID';
   ```

8. Expected: Status changed to APPROVED, 4 consecutive slots allocated

**Edge Cases**:

- Insufficient consecutive availability
- Consultant has slots but not consecutive
- All slots booked

---

### Scenario 2: Manual Allocation for 1-Hour Consultation

**Setup**:

- Consultant has various non-consecutive available slots
- Pending consultation requires 1 hour (2 consecutive slots)

**Steps**:

1. Click "Allocate Slots"
2. Manually select 2 consecutive available slots (e.g., Thu 14:00, 14:30)
3. Verify:
   - Status shows "2 selected out of 2 required slots"
   - Selected slots turn dark green
   - "Allocate Manual Slots" button becomes enabled
4. Click "Allocate Manual Slots"
5. Verify success and database update

**Edge Cases**:

- Select non-consecutive slots (should show error)
- Select past slots (should prevent selection)
- Select booked slots (should be disabled)

---

### Scenario 3: Subscription Allocation (Multi-Month Recurring)

**Setup**:

- Subscription plan: 3 months, 2 calls/week, 1-hour sessions
- Required slots: 3 months × 4 weeks × 2 calls × 2 slots = 48 slots
- Date range: startDate to endDate (3 months span)

**Steps**:

1. Click "Allocate Slots" for subscription
2. Verify dialog shows:
   - "Each call is 1 hour (2 consecutive slots per call)"
   - "Scheduling period: [startDate] - [endDate]"
   - Calendar restricted to date range
3. Attempt auto-allocation
4. If successful, verify database:

   ```sql
   SELECT COUNT(*) FROM "Appointment"
   WHERE "subscriptionId" = 'SUBSCRIPTION_ID';
   -- Should be 24 appointments (2 per week × 4 weeks × 3 months)

   SELECT COUNT(*) FROM "SlotOfAppointment" soa
   JOIN "Appointment" a ON a.id = soa."appointmentId"
   WHERE a."subscriptionId" = 'SUBSCRIPTION_ID';
   -- Should be 48 slots
   ```

---

### Scenario 4: Use Requested Times with Conflicts

**Setup**:

- Consultee requested specific times
- Some requested times conflict with consultant's existing appointments

**Steps**:

1. Click "Use Requested Times" button
2. Dialog shows:
   - Requested slots listed
   - Conflicts highlighted in red with details
   - "Accept" button (if no conflicts) or "Override" checkbox
3. Test approval with conflicts:
   - If conflicts exist, enable override checkbox
   - Click "Allocate with Override"
4. Verify database: Requested slots allocated despite conflicts

---

### Scenario 5: Webinar Allocation (Group Event)

**Setup**:

- Webinar requires single time slot (e.g., 1.5 hours)
- No individual consultee, multiple attendees

**Steps**:

1. Navigate to webinar requests
2. Allocate single slot for webinar start time
3. Verify appointment created with correct duration

---

### Scenario 6: Class Allocation (Recurring Course)

**Setup**:

- Class plan: Weekly class for 8 weeks
- Same day/time each week (e.g., Monday 10:00-11:00)

**Steps**:

1. Allocate slots for class
2. Verify 8 appointments created (one per week)
3. Check appointments don't conflict with other bookings

---

### Scenario 7: Edge Cases & Error Handling

**Test Cases**:

1. **Past Slot Selection**:
   - Attempt to select slots in the past
   - Expected: Slots disabled with "Cannot select past slot" error

2. **Overlapping Appointments**:
   - Consultant has existing appointment 14:00-15:00
   - Attempt to manually select slots overlapping this time
   - Expected: Slots shown as "Booked"

3. **Insufficient Availability**:
   - Consultation requires 4 consecutive slots
   - Consultant only has 3 consecutive slots available
   - Expected: Auto-allocate disabled, manual selection possible but validation fails

4. **Non-Consecutive Manual Selection**:
   - Select slots: 14:00, 14:30, 15:30, 16:00 (gap at 15:00)
   - Expected: Error "Consultation requires consecutive slots on same day"

5. **Cross-Day Selection**:
   - Select Friday 23:30 and Saturday 00:00
   - Expected: Error "All slots must be on the same day"

6. **Duration Mismatch**:
   - Frontend configured for 1-hour consultation
   - Backend plan says 2-hour consultation
   - Expected: Warning banner about configuration mismatch

---

## Verification Checklist

After each test scenario:

**UI Verification**:

- [ ] Calendar displays correctly (available=green, booked=gray, selected=dark green)
- [ ] Slot count accurate ("X selected out of Y required")
- [ ] Buttons enable/disable appropriately
- [ ] Success/error toasts appear
- [ ] Dialog closes on success
- [ ] Request removed from table after allocation

**Console Verification**:

- [ ] No JavaScript errors
- [ ] No 500 server errors
- [ ] Allocation API calls successful (200 OK)
- [ ] Validation API calls working

**Database Verification**:

```sql
-- Verify appointment created
SELECT * FROM "Appointment" WHERE id = 'APPOINTMENT_ID';

-- Verify correct number of slots
SELECT COUNT(*) FROM "SlotOfAppointment"
WHERE "appointmentId" = 'APPOINTMENT_ID';

-- Verify slot times are consecutive
SELECT "slotStartTimeInUTC", "slotEndTimeInUTC"
FROM "SlotOfAppointment"
WHERE "appointmentId" = 'APPOINTMENT_ID'
ORDER BY "slotStartTimeInUTC";

-- Verify request status updated
SELECT "requestStatus" FROM "Consultation" WHERE id = 'CONSULTATION_ID';
-- Should be 'APPROVED'

-- Verify no duplicate slots
SELECT "slotStartTimeInUTC", COUNT(*)
FROM "SlotOfAppointment" soa
JOIN "Appointment" a ON a.id = soa."appointmentId"
WHERE a."consultantProfileId" = 'CONSULTANT_ID'
GROUP BY "slotStartTimeInUTC"
HAVING COUNT(*) > 1;
-- Should return 0 rows
```

---

## Known Issues to Test

### Bug #1: Configuration Warning (FIXED)

- ✅ Frontend now correctly passes `durationInHours` prop

### Bug #2: Auto-Allocation Algorithm

- ❌ Auto-allocate may fail even with valid consecutive slots
- Test: Consultant has Wed 19:30-21:00 available (4 consecutive slots)
- Expected: Auto-allocate should succeed
- Current: May fail with 500 error
- Root Cause: Algorithm doesn't verify each incremented slot exists in availability

### Bug #3: Manual Allocation Button Disabled

- ❌ Button remains disabled even when all required slots selected
- Test: Manually select all 4 required consecutive slots
- Expected: "Allocate Manual Slots" button enabled
- Current: Button stays grayed out
- Investigation Needed: Check slot selection callback chain

---

## Testing Output Format

For each scenario, provide:

```markdown
## Test: [Scenario Name]

**Date**: [YYYY-MM-DD]
**Tester**: [Name/Tool]

### Setup

- Consultant ID: [ID]
- Event ID: [ID]
- Event Type: [TYPE]
- Required Slots: [N]

### Execution Steps

1. [Step with screenshot]
2. [Step with console output]
3. [Step with database query result]

### Results

- ✅ Success / ❌ Failure
- Console Errors: [None / List errors]
- Database State: [Query results]
- Screenshots: [Links/attachments]

### Issues Found

- [Issue #1 description]
- [Issue #2 description]

### Notes

[Any additional observations]
```

---

## Advanced Testing: Load & Concurrency

### Multiple Simultaneous Allocations

- Open 3 browser tabs
- Attempt to allocate same consultant's slots simultaneously
- Verify only one succeeds, others get conflict errors

### Large Subscription Allocation

- Test subscription with 6 months, 5 calls/week, 2-hour sessions
- Required: 240 slots
- Verify performance and database consistency

### Timezone Handling

- Consultant in UTC+5:30 (Asia/Calcutta)
- Consultee in UTC-5:00 (US EST)
- Verify slot times correctly converted and displayed

---

## Debugging Tools

### Enable Verbose Logging

Add to components:

```typescript
console.log("[DEBUG] Component State:", {
  selectedSlots,
  requiredSlots,
  isQuotaMet,
});
```

### Network Monitoring

- Use Chrome DevTools → Network tab
- Filter: `/api/events/`
- Check request/response payloads

### Database Queries

```sql
-- Recent appointments
SELECT * FROM "Appointment"
WHERE "createdAt" > NOW() - INTERVAL '1 hour'
ORDER BY "createdAt" DESC;

-- Slot allocation summary
SELECT
  a."appointmentType",
  COUNT(DISTINCT a.id) as "appointmentCount",
  COUNT(s.id) as "slotCount"
FROM "Appointment" a
LEFT JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
WHERE a."consultantProfileId" = 'CONSULTANT_ID'
GROUP BY a."appointmentType";
```

---

## Success Criteria

A fully functional booking system should:

1. ✅ Auto-allocate slots successfully when consecutive availability exists
2. ✅ Manual allocation works with correct slot selection
3. ✅ Requested times can be approved/overridden
4. ✅ No double-booking (overlapping appointments prevented)
5. ✅ Calendar UI accurately reflects availability and bookings
6. ✅ Database consistency maintained (no orphaned slots)
7. ✅ All API endpoints return correct status codes
8. ✅ Error messages clear and actionable
9. ✅ Performance acceptable for large allocations (<5s)
10. ✅ Timezone conversions accurate

---

## Contact & Resources

- **Architecture Docs**: `/docs/booking-algorithm/02_ARCHITECTURE.md`
- **API Reference**: `/docs/booking-algorithm/06_API_REFERENCE.md`
- **Bug Reports**: `/docs/booking-algorithm/bugs/`
- **Prisma Schema**: `/prisma/schema.prisma`
- **Component Tree**: `/app/dashboard/consultant/[consultantId]/(features)/`

Happy Testing! 🚀
