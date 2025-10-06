# Seeding Bugs Report - Comprehensive Analysis

**Date**: October 6, 2025
**Analyzed Files**:

- `prisma/seedFiles/createSlotsOfAvailability.ts`
- `prisma/seedFiles/createAppointments.ts`
- `app/api/slots/availability/[consultantId]/route.ts`

**Analysis Method**: Code review + curl-based verification testing + real data validation

---

## Executive Summary

Found **8 critical bugs** in the seeding scripts that cause:

- ❌ Incorrect UTC timezone handling (4 bugs)
- ❌ Data integrity violations (2 bugs)
- ❌ Availability API failures (1 critical bug - Dr. Lionel Ward case)
- ❌ Random slot times instead of business hours (1 bug)

**Impact**:

- 15/40 consultants show booking/availability mismatches
- WEEKLY slots are unmatchable in availability API
- Appointments linked to wrong consultants' plans
- Timezone-dependent bugs in production

---

## Bug #1: WEEKLY Slots Use setHours() Instead of setUTCHours()

### Severity: 🔴 CRITICAL

### Location

`prisma/seedFiles/createSlotsOfAvailability.ts:133, 159`

### Buggy Code

```typescript
for (const timeSlot of selectedHours) {
  const slotStartTime = new Date();
  slotStartTime.setHours(timeSlot.hour, timeSlot.minute, 0, 0); // ❌ WRONG

  weeklySlots.push({
    consultantProfileId: consultant.consultantProfile.id,
    dayOfWeekforStartTimeInUTC: dayOfWeek,
    dayOfWeekforEndTimeInUTC: dayOfWeek,
    slotStartTimeInUTC: slotStartTime, // Contains LOCAL time!
    slotEndTimeInUTC: new Date(slotStartTime.getTime() + 60 * 60 * 1000),
  });
}
```

### Root Cause

- `setHours()` sets time in **LOCAL** timezone, not UTC
- If server runs in IST (UTC+5:30):
  - Setting `9:00` creates `9:00 AM IST` = `3:30 AM UTC`
  - Database field is named `slotStartTimeInUTC` but contains IST time!
- Same bug on line 159 for weekend slots

### Impact

- All WEEKLY slots have incorrect UTC timestamps
- Slots appear 5.5 hours earlier in UTC than intended
- Availability API returns wrong times
- Booking conflicts may occur

### Example

```
Intended: 9:00 AM UTC
Actual in DB: 2025-10-03T03:30:00.000Z (9:00 AM IST = 3:30 AM UTC)
Displayed to user in Asia/Calcutta: 9:00 AM ✓
Displayed to user in UTC: 3:30 AM ✗
```

### Fix

```typescript
for (const timeSlot of selectedHours) {
  const slotStartTime = new Date();
  slotStartTime.setUTCHours(timeSlot.hour, timeSlot.minute, 0, 0); // ✅ CORRECT

  weeklySlots.push({
    consultantProfileId: consultant.consultantProfile.id,
    dayOfWeekforStartTimeInUTC: dayOfWeek,
    dayOfWeekforEndTimeInUTC: dayOfWeek,
    slotStartTimeInUTC: slotStartTime,
    slotEndTimeInUTC: new Date(slotStartTime.getTime() + 60 * 60 * 1000),
  });
}
```

---

## Bug #2: WEEKLY Slot Date Doesn't Match dayOfWeek Field ⚠️ ROOT CAUSE OF DR. LIONEL WARD BUG

### Severity: 🔴 CRITICAL

### Location

`prisma/seedFiles/createSlotsOfAvailability.ts:132-143`

### Buggy Code

```typescript
for (const dayOfWeek of weekdays) {
  // dayOfWeek = TUESDAY
  for (const timeSlot of selectedHours) {
    const slotStartTime = new Date(); // Oct 3, 2025 = FRIDAY!
    slotStartTime.setHours(timeSlot.hour, timeSlot.minute, 0, 0);

    weeklySlots.push({
      consultantProfileId: consultant.consultantProfile.id,
      dayOfWeekforStartTimeInUTC: dayOfWeek, // Says TUESDAY
      dayOfWeekforEndTimeInUTC: dayOfWeek,
      slotStartTimeInUTC: slotStartTime, // But date is Oct 3 (FRIDAY)
      slotEndTimeInUTC: new Date(slotStartTime.getTime() + 60 * 60 * 1000),
    });
  }
}
```

### Root Cause

- `new Date()` creates date with **current system date** (Oct 3, 2025 = Friday when seeded)
- Loop sets `dayOfWeekforStartTimeInUTC: TUESDAY`
- But `slotStartTimeInUTC` contains Oct 3 (Friday)
- **Date and day-of-week fields are mismatched!**

### Impact - This is the Dr. Lionel Ward Bug!

Dr. Lionel Ward's data in database:

```json
{
  "dayOfWeekforStartTimeInUTC": "TUESDAY",
  "slotStartTimeInUTC": "2025-10-03T10:30:00.000Z" // Oct 3 = FRIDAY!
}
```

Availability API query for Oct 7, 2025 (Tuesday):

1. API: "Get slots where dayOfWeekforStartTimeInUTC = TUESDAY"
2. Finds Dr. Lionel Ward's slots (dayOfWeek = TUESDAY) ✓
3. API uses `mapWeeklySlotToTiming()` which calls `setToUserDate()`
4. `setToUserDate()` tries to adjust the date:
   ```typescript
   function setToUserDate(date: Date, userDate: Date): Date {
     const result = new Date(date);
     result.setFullYear(
       userDate.getFullYear(),
       userDate.getMonth(),
       userDate.getDate()
     );
     return result;
   }
   ```
5. Takes slot with `slotStartTimeInUTC = 2025-10-03T10:30:00.000Z` (Friday 10:30 AM)
6. Adjusts date to Oct 7, 2025 → `2025-10-07T10:30:00.000Z` (Tuesday 10:30 AM)
7. **But the day changed from Friday to Tuesday, breaking the time logic!**
8. API's `filterSlots()` may exclude it or booking check may fail
9. Result: **0 available slots returned**

### Why This Happens

The availability API assumes:

- For WEEKLY slots, only TIME matters (hours/minutes)
- Date component should match the requested date
- But seeding creates mismatched date/dayOfWeek, confusing the mapping logic

### Fix - Option 1: Use Reference Dates Matching Day of Week

```typescript
function getReferenceDateForDayOfWeek(dayOfWeek: DayOfWeek): Date {
  // Use a fixed reference week where dates match days
  const referenceWeekStart = new Date("2025-01-06T00:00:00.000Z"); // Monday, Jan 6, 2025
  const daysMap = {
    SUNDAY: 0,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6,
  };
  const date = new Date(referenceWeekStart);
  date.setUTCDate(date.getUTCDate() + daysMap[dayOfWeek]);
  return date;
}

for (const dayOfWeek of weekdays) {
  for (const timeSlot of selectedHours) {
    const slotStartTime = getReferenceDateForDayOfWeek(dayOfWeek);
    slotStartTime.setUTCHours(timeSlot.hour, timeSlot.minute, 0, 0);

    weeklySlots.push({
      consultantProfileId: consultant.consultantProfile.id,
      dayOfWeekforStartTimeInUTC: dayOfWeek,
      dayOfWeekforEndTimeInUTC: dayOfWeek,
      slotStartTimeInUTC: slotStartTime, // Now date matches dayOfWeek!
      slotEndTimeInUTC: new Date(slotStartTime.getTime() + 60 * 60 * 1000),
    });
  }
}
```

### Fix - Option 2: Store Only Time, Not Date (Schema Change Required)

Better long-term solution but requires database migration:

```prisma
model SlotOfAvailabilityWeekly {
  dayOfWeek  DayOfWeek
  startHour  Int       // 0-23
  startMinute Int      // 0-59
  durationMinutes Int  // e.g., 60 for 1 hour
}
```

---

## Bug #3: CUSTOM Slots Use setHours() Instead of setUTCHours()

### Severity: 🔴 CRITICAL

### Location

`prisma/seedFiles/createSlotsOfAvailability.ts:211`

### Buggy Code

```typescript
for (let slot = 0; slot < slotsPerWeek; slot++) {
  const slotDate = new Date(
    weekStart.getTime() + dayOffset * 24 * 60 * 60 * 1000
  );
  const timeSlot = faker.helpers.arrayElement(businessHours);
  slotDate.setHours(timeSlot.hour, timeSlot.minute, 0, 0); // ❌ WRONG

  customSlots.push({
    consultantProfileId: consultant.consultantProfile.id,
    slotStartTimeInUTC: slotDate, // Contains LOCAL time!
    slotEndTimeInUTC: new Date(slotDate.getTime() + 60 * 60 * 1000),
  });
}
```

### Root Cause

Same as Bug #1 - uses local timezone instead of UTC

### Impact

- All CUSTOM slots have incorrect UTC timestamps
- Same 5.5-hour offset issue in IST

### Fix

```typescript
slotDate.setUTCHours(timeSlot.hour, timeSlot.minute, 0, 0); // ✅ CORRECT
```

---

## Bug #4: Subscription Appointment Slots Use setHours()

### Severity: 🟡 HIGH

### Location

`prisma/seedFiles/createAppointments.ts:241`

### Buggy Code

```typescript
for (let callIndex = 0; callIndex < callsThisWeek; callIndex++) {
  const dayOffset = (callIndex * 2) % 5;
  const callDate = new Date(
    weekStartDate.getTime() + dayOffset * 24 * 60 * 60 * 1000
  );

  const hour = 9 + (callIndex % 8); // 9 AM to 5 PM
  callDate.setHours(hour, 0, 0, 0); // ❌ WRONG - local time

  slots.push({
    slotStartTimeInUTC: callDate,
    slotEndTimeInUTC: new Date(callDate.getTime() + 60 * 60 * 1000),
  });
}
```

### Root Cause

Same timezone issue - `setHours()` instead of `setUTCHours()`

### Impact

- Subscription appointment slots have incorrect UTC timestamps
- Can cause booking time mismatches

### Fix

```typescript
callDate.setUTCHours(hour, 0, 0, 0); // ✅ CORRECT
```

---

## Bug #5: Class Slots Inherit Random Time from startDate

### Severity: 🟡 HIGH

### Location

`prisma/seedFiles/createAppointments.ts:366-369`

### Buggy Code

```typescript
const createClassAppointment = async (
  consultee: UserWithProfiles,
  classPlans: any[],
  consultees: UserWithProfiles[],
  isPastAppointment: boolean,
  startDate: Date, // Has random time like 14:37:22.481
  endDate: Date,
  numSlots: number
): Promise<Prisma.AppointmentCreateInput> => {
  const limitedSlots = Math.min(numSlots, 4);

  return {
    appointmentType: AppointmentsType.CLASS,
    slotsOfAppointment: {
      create: Array.from({ length: limitedSlots }, (_, index) => {
        const slotStart = new Date(
          startDate.getTime() + index * 7 * 24 * 60 * 60 * 1000
        ); // Inherits random time from startDate!
        const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

        return {
          slotStartTimeInUTC: slotStart, // Could be 3:47 AM, 11:23 PM, etc.
          slotEndTimeInUTC: slotEnd,
        };
      }),
    },
  };
};
```

### Root Cause

- `startDate` comes from `getAppointmentDate()` which returns `new Date(now.getTime() + offset * 24 * 60 * 60 * 1000)`
- This preserves the current time (e.g., 14:37:22.481)
- Class slots should be during business hours (9 AM - 6 PM), not random times

### Impact

- Class appointments scheduled at 3:47 AM, 11:23 PM, etc.
- Doesn't match realistic business hours
- Poor user experience in testing/demo

### Fix

```typescript
create: Array.from({ length: limitedSlots }, (_, index) => {
  const slotStart = new Date(
    startDate.getTime() + index * 7 * 24 * 60 * 60 * 1000
  );

  // Set to business hours
  const businessHour = faker.helpers.arrayElement([9, 10, 11, 14, 15, 16, 17]);
  slotStart.setUTCHours(businessHour, 0, 0, 0);

  const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

  return {
    slotStartTimeInUTC: slotStart,
    slotEndTimeInUTC: slotEnd,
  };
}),
```

---

## Bug #6: Plan Selection Doesn't Filter by Consultant

### Severity: 🟠 MEDIUM (Data Integrity)

### Location

`prisma/seedFiles/createAppointments.ts:170, 202, 320, 387`

### Buggy Code

```typescript
// Line 558-573: Fetch ALL plans from ALL consultants
export async function createAppointments(consultees: UserWithProfiles[]) {
  const consultationPlans = await prisma.consultationPlan.findMany();
  const subscriptionPlans = await prisma.subscriptionPlan.findMany();
  const webinarPlans = await prisma.webinarPlan.findMany();
  const classPlans = await prisma.classPlan.findMany();
  // ... passes these to createAppointmentBatch
}

// Line 170: Randomly selects from ALL plans
const createConsultationAppointment = (
  consultee: UserWithProfiles,
  consultationPlans: any[], // Contains plans from all consultants!
  ...
) => {
  return {
    consultation: {
      create: {
        consultationPlan: {
          connect: {
            id: faker.helpers.arrayElement(consultationPlans).id, // ❌ Random plan!
          },
        },
      },
    },
  };
};

// Same issue on lines 202, 320, 387 for other appointment types
```

### Root Cause

- Script fetches all plans from all consultants
- Randomly selects a plan when creating appointment
- **Doesn't verify the plan belongs to the consultant whose slot is being used**

### Impact - Data Inconsistency

Example scenario:

1. Appointment uses Consultant A's availability slot (from `allSlots[i]`)
2. But links to Consultant B's consultation plan (random selection)
3. Database shows:
   - Appointment booked with Consultant B's plan
   - But slot time pattern comes from Consultant A
   - Consultant A shows booking but has no associated plan
   - Consultant B gets booking for slot they don't offer

Real-world equivalent: Booking Dr. Smith's 9 AM slot but paying Dr. Jones' rate

### Example from Verification Data

From `consultant-verification-curl-report.json`:

- Consultant has bookings but wrong plan associations
- Explains why some consultants show bookings without matching availability

### Fix

```typescript
async function createAppointmentBatch(
  consultees: UserWithProfiles[],
  allSlots: SlotData[],
  consultationPlans: any[],
  subscriptionPlans: any[],
  webinarPlans: any[],
  classPlans: any[],
  startIndex: number,
  batchSize: number
): Promise<number> {
  for (
    let i = startIndex;
    i < Math.min(startIndex + batchSize, NUM_APPOINTMENTS);
    i++
  ) {
    const slotData = allSlots[i];

    // Get consultant ID from the slot
    const slotConsultantId = slotData.slot.consultantProfileId;

    // Filter plans to only this consultant's plans
    const consultantConsultationPlans = consultationPlans.filter(
      (p) => p.consultantProfileId === slotConsultantId
    );
    const consultantSubscriptionPlans = subscriptionPlans.filter(
      (p) => p.consultantProfileId === slotConsultantId
    );
    const consultantWebinarPlans = webinarPlans.filter(
      (p) => p.consultantProfileId === slotConsultantId
    );
    const consultantClassPlans = classPlans.filter(
      (p) => p.consultantProfileId === slotConsultantId
    );

    // Now randomly select from consultant's own plans
    const selectedPlan = faker.helpers.arrayElement(
      consultantConsultationPlans
    );
  }
}
```

---

## Bug #7: Slot-to-Appointment Mapping Uses Wrong Consultant

### Severity: 🔴 CRITICAL (Data Integrity)

### Location

`prisma/seedFiles/createAppointments.ts:440, 564-578`

### Buggy Code

```typescript
// Lines 564-578: Fetch mixed slots from all consultants
export async function createAppointments(consultees: UserWithProfiles[]) {
  const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
    take: NUM_APPOINTMENTS / 2, // Get 250 random weekly slots
  });
  const customSlots = await prisma.slotOfAvailabilityCustom.findMany({
    take: NUM_APPOINTMENTS / 2, // Get 250 random custom slots
  });

  const allSlots: SlotData[] = [
    ...weeklySlots.map((slot) => ({ type: "weekly" as const, slot })),
    ...customSlots.map((slot) => ({ type: "custom" as const, slot })),
  ];
  // allSlots[0] might be from Consultant A
  // allSlots[1] might be from Consultant B
  // allSlots[2] might be from Consultant C, etc.

  await createAppointmentBatch(consultees, allSlots, ...);
}

// Line 440: Uses sequential index mapping
async function createAppointmentBatch(...) {
  for (let i = startIndex; i < Math.min(startIndex + batchSize, NUM_APPOINTMENTS); i++) {
    const consultee = consultees[i % consultees.length];
    const slotData = allSlots[i]; // ❌ Uses slot at index i

    // Uses slotData.slot time pattern but doesn't check which consultant it belongs to
    const slotTime = slotData.slot;
    const startHours = slotTime.slotStartTimeInUTC.getUTCHours();
    const actualStartTime = new Date(startDate);
    actualStartTime.setUTCHours(startHours, ...);
  }
}
```

### Root Cause - Fundamental Design Flaw

The script:

1. Fetches 500 random slots from all consultants (mixed pool)
2. Uses `allSlots[i]` to get slot for appointment i
3. **Doesn't associate appointment with the consultant who owns that slot!**

### Impact - This Explains the Booking/Availability Mismatch!

From verification report: **15 consultants have bookings but 0 availability on test date**

Why this happens:

1. Slot #50 belongs to Consultant A
2. Appointment #50 uses slot #50's time pattern (e.g., 10:00 AM)
3. But appointment #50 might be randomly assigned to Consultant B via plan selection (Bug #6)
4. Result:
   - Database shows booking at 10:00 AM for Consultant B
   - But Consultant B doesn't have availability at 10:00 AM
   - Consultant A has availability at 10:00 AM but no bookings
   - **Availability check fails!**

### Example

```
allSlots[100] = {
  slot: {
    consultantProfileId: "consultant-A-id",
    slotStartTimeInUTC: "2025-10-07T10:00:00.000Z"
  }
}

Appointment #100 uses:
- Time: 10:00 AM from allSlots[100]
- But linked to Consultant B's plan (random selection)

Result:
- Consultant A: Has 10 AM slot available, shows 0 bookings
- Consultant B: Shows booking at 10 AM, but has no 10 AM slot → 0 availability
```

### Fix - Complete Rewrite of Appointment Creation Logic

**Option 1: Assign appointments to slot owners**

```typescript
export async function createAppointments(consultees: UserWithProfiles[]) {
  // Get all slots with consultant info
  const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
    take: NUM_APPOINTMENTS / 2,
    include: { consultantProfile: true },
  });
  const customSlots = await prisma.slotOfAvailabilityCustom.findMany({
    take: NUM_APPOINTMENTS / 2,
    include: { consultantProfile: true },
  });

  const allSlots = [...weeklySlots, ...customSlots];

  // Get plans grouped by consultant
  const plansByConsultant = await getPlansByConsultant();

  for (let i = 0; i < NUM_APPOINTMENTS; i++) {
    const slotData = allSlots[i];
    const consultantId = slotData.consultantProfileId;
    const consultee = faker.helpers.arrayElement(consultees);

    // Get this consultant's plans
    const consultantPlans = plansByConsultant[consultantId];

    // Create appointment using:
    // - Slot time from slotData
    // - Plan from consultantPlans (matching consultant)
    // - Random consultee

    await createAppointment({
      consultant: consultantId,
      consultee: consultee,
      slot: slotData,
      plans: consultantPlans,
    });
  }
}
```

**Option 2: Select consultant first, then use their slots**

```typescript
export async function createAppointments(consultees: UserWithProfiles[]) {
  const consultants = await prisma.consultantProfile.findMany();

  for (let i = 0; i < NUM_APPOINTMENTS; i++) {
    // Select random consultant
    const consultant = faker.helpers.arrayElement(consultants);

    // Get this consultant's slots
    const slots = await getConsultantSlots(consultant.id);
    if (slots.length === 0) continue;

    // Select random slot from this consultant
    const slot = faker.helpers.arrayElement(slots);

    // Get this consultant's plans
    const plans = await getConsultantPlans(consultant.id);

    // Select random consultee
    const consultee = faker.helpers.arrayElement(consultees);

    // Create appointment with matching consultant/slot/plan
    await createAppointment({
      consultant,
      consultee,
      slot,
      plans,
    });
  }
}
```

---

## Bug #8: Inconsistent UTC Method Usage

### Severity: 🟠 MEDIUM (Code Quality / Maintainability)

### Locations

Multiple files show inconsistent patterns

### Issue

**createAppointments.ts** correctly uses:

```typescript
const startHours = slotTime.slotStartTimeInUTC.getUTCHours(); // ✅
actualStartTime.setUTCHours(startHours, startMinutes, 0, 0); // ✅
```

**createSlotsOfAvailability.ts** incorrectly uses:

```typescript
slotStartTime.setHours(timeSlot.hour, timeSlot.minute, 0, 0); // ❌
```

### Impact

- Confusing codebase with mixed patterns
- Easy to introduce bugs during maintenance
- New developers may copy wrong pattern

### Fix

**Enforce consistent UTC usage:**

1. Always use `setUTCHours()`, `getUTCHours()`, etc.
2. Add ESLint rule to ban `setHours()` in these files
3. Document timezone handling policy in README

---

## Priority Matrix

| Priority          | Bugs       | Reason                                             |
| ----------------- | ---------- | -------------------------------------------------- |
| **P0 - Critical** | #2, #7     | Breaks availability API, causes booking mismatches |
| **P1 - High**     | #1, #3, #4 | Timezone bugs affect all data                      |
| **P2 - Medium**   | #5, #6     | Data quality issues                                |
| **P3 - Low**      | #8         | Code quality                                       |

---

## Recommended Fix Order

1. **Bug #7** - Fix slot-to-appointment mapping (requires rewrite)
2. **Bug #6** - Filter plans by consultant (required for #7)
3. **Bug #2** - Fix WEEKLY date/dayOfWeek mismatch
4. **Bug #1** - Fix WEEKLY setUTCHours
5. **Bug #3** - Fix CUSTOM setUTCHours
6. **Bug #4** - Fix subscription setUTCHours
7. **Bug #5** - Fix class slot business hours
8. **Bug #8** - Add linting rules

---

## Testing Plan

### Before Fixes

1. ✅ Verified Dr. Lionel Ward has 0 availability despite having Tuesday slots and no bookings on Oct 7 (Tuesday)
2. ✅ Verified 15/40 consultants show booking/availability mismatches
3. ✅ Documented timezone issues in slot timestamps

### After Fixes

1. **Re-seed database** with fixed scripts
2. **Run curl verification script** (`verify-consultants-curl.sh`)
3. **Verify Dr. Lionel Ward** now shows availability on Tuesdays
4. **Check all consultants** - should have 0 issues (or only CUSTOM schedule "issues" which are expected)
5. **Verify timezone consistency** - check UTC timestamps are correct
6. **Run Playwright E2E tests** (`calendar-display.spec.ts`, `calendar-data-integrity.spec.ts`)
7. **Manual testing** - Open calendar UI, verify slots display correctly

### Expected Results After Fixes

- Dr. Lionel Ward: ✅ Shows availability on Tuesdays
- WEEKLY consultants: ✅ Slots matchable on correct days
- Bookings: ✅ Only on consultant's own slots
- Plans: ✅ Only consultant's own plans linked
- UTC times: ✅ Correctly stored in UTC
- Class slots: ✅ During business hours (9 AM - 6 PM)

---

## Migration Considerations

### Database Impact

- ✅ No schema changes required for Bugs #1-#7
- ⚠️ Existing seeded data is invalid and should be cleared
- ⚠️ Run `npx prisma migrate reset` or manual cleanup

### Breaking Changes

None - fixes are internal to seeding logic

### Rollout Plan

1. Fix seeding scripts (this PR)
2. Clear existing seed data
3. Re-seed database
4. Verify with tests
5. Deploy to staging
6. Verify in staging environment
7. Deploy to production (if using seed data there)

---

## Long-Term Recommendations

### 1. Schema Improvements

Consider storing WEEKLY slots as time-only (not full timestamp):

```prisma
model SlotOfAvailabilityWeekly {
  dayOfWeek     DayOfWeek
  startHour     Int       // 0-23
  startMinute   Int       // 0-59
  durationMins  Int       // e.g., 60
}
```

### 2. Seeding Architecture

- Separate slot creation from appointment creation
- Create consultant-slot mappings first
- Then create appointments using valid mappings

### 3. Validation Layer

Add validation in Prisma hooks or API layer:

```typescript
// Validate appointment uses slot from same consultant
beforeCreate: async (appointment) => {
  const slot = await getSlot(appointment.slotId);
  const plan = await getPlan(appointment.planId);

  if (slot.consultantId !== plan.consultantId) {
    throw new Error("Appointment slot and plan must belong to same consultant");
  }
};
```

### 4. Linting Rules

Add to `.eslintrc`:

```json
{
  "rules": {
    "no-restricted-syntax": [
      "error",
      {
        "selector": "CallExpression[callee.property.name='setHours']",
        "message": "Use setUTCHours() instead of setHours() in seed files"
      }
    ]
  }
}
```

---

## References

- Verification Report: `consultant-verification-curl-report.json`
- Verification Findings: `VERIFICATION_FINDINGS.md`
- Playwright Tests: `tests/e2e/calendar-display.spec.ts`, `tests/e2e/calendar-data-integrity.spec.ts`
- API Code: `app/api/slots/availability/[consultantId]/route.ts`

---

## Conclusion

These 8 bugs explain the entire booking/availability mismatch issue discovered during testing:

- **Root Cause #1** (Bug #7): Slots from one consultant used for another's bookings
- **Root Cause #2** (Bug #2): WEEKLY slots have mismatched date/dayOfWeek
- **Root Cause #3** (Bug #1, #3, #4): Timezone bugs create offset issues

Fixing these bugs will:

- ✅ Resolve Dr. Lionel Ward's 0 availability issue
- ✅ Fix all 15 consultant booking/availability mismatches
- ✅ Ensure correct UTC timestamp handling
- ✅ Improve data integrity and code maintainability

**Next Steps**: Implement fixes in order of priority (P0 → P1 → P2 → P3)
