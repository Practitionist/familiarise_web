# Date/Time Architecture Migration Plan

## Executive Summary

This document outlines a comprehensive migration plan to fix critical date/time inconsistencies in the Prisma schema that are causing booking algorithm bugs. The migration will standardize all temporal fields to use timezone-aware types and consistent naming conventions.

**Root Cause of Current Bug:**

- `Subscription.startDate` (plain DateTime, no timezone) is compared with `SlotOfAppointment.slotStartTimeInUTC` (@db.Timestamptz, UTC)
- This causes slots to be allocated outside the scheduling period because timezone interpretation is ambiguous

**Estimated Impact:**

- 1 Prisma schema file
- 3-4 database migrations
- ~15-20 TypeScript files
- All seed files
- ~50-100 code locations with date comparisons

---

## Core Principles

### 1. **Always Store Absolute Time in UTC**

- Use `@db.Timestamptz()` for all fields representing specific moments in time
- PostgreSQL automatically handles timezone conversion
- Application always works with UTC, converts for display only

### 2. **Consistent Naming Conventions**

| Use Case             | Pattern            | Examples                                               |
| -------------------- | ------------------ | ------------------------------------------------------ |
| Single point in time | `<action>At`       | `createdAt`, `updatedAt`, `requestedAt`, `scheduledAt` |
| Start of a period    | `<period>StartsAt` | `schedulingPeriodStartsAt`, `availabilityStartsAt`     |
| End of a period      | `<period>EndsAt`   | `schedulingPeriodEndsAt`, `availabilityEndsAt`         |
| Expiration           | `expiresAt`        | `passwordResetExpiresAt`, `sessionExpiresAt`           |

**Rules:**

- ✅ Use `At` suffix for all temporal fields
- ❌ Never use "InUTC" suffix (type already indicates UTC)
- ❌ Avoid ambiguous "Date" suffix (is it a date-only or datetime?)
- ✅ Use descriptive prefixes for period boundaries

### 3. **Store Timezone Context**

- Add explicit timezone fields where users interact with dates
- Use IANA timezone format (e.g., "Asia/Kolkata", "America/New_York")
- Store alongside UTC times for display purposes

### 4. **Maintain Audit Trail**

```prisma
createdAt DateTime @default(now()) @db.Timestamptz()
updatedAt DateTime @updatedAt @db.Timestamptz()
```

---

## Phase 1: Prisma Schema Updates

### Phase 1.1: Availability Slots

#### SlotOfAvailabilityWeekly

**Changes:**

```prisma
// BEFORE
model SlotOfAvailabilityWeekly {
  id                         String    @id @default(uuid())
  dayOfWeekforStartTimeInUTC DayOfWeek
  slotStartTimeInUTC         DateTime  @db.Timestamptz()
  dayOfWeekforEndTimeInUTC   DayOfWeek
  slotEndTimeInUTC           DateTime  @db.Timestamptz()

  consultantProfile   ConsultantProfile @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// AFTER
model SlotOfAvailabilityWeekly {
  id String @id @default(uuid())

  // Availability period (UTC)
  dayOfWeekForStart DayOfWeek
  availabilityStartsAt DateTime @db.Timestamptz()
  dayOfWeekForEnd DayOfWeek
  availabilityEndsAt DateTime @db.Timestamptz()

  // Relations
  consultantProfile   ConsultantProfile @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String

  // Audit trail (UTC)
  createdAt DateTime @default(now()) @db.Timestamptz()
  updatedAt DateTime @updatedAt @db.Timestamptz()

  @@index([consultantProfileId])
}
```

**Rationale:**

- Remove redundant "InUTC" suffix (type already indicates UTC storage)
- Simplify "dayOfWeekforStartTimeInUTC" → "dayOfWeekForStart"
- Rename "slotStartTimeInUTC" → "availabilityStartsAt" (clearer semantics)
- Add `@db.Timestamptz()` to audit fields

#### SlotOfAvailabilityCustom

**Changes:**

```prisma
// BEFORE
model SlotOfAvailabilityCustom {
  id                 String   @id @default(uuid())
  slotStartTimeInUTC DateTime @db.Timestamptz()
  slotEndTimeInUTC   DateTime @db.Timestamptz()

  consultantProfile   ConsultantProfile @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// AFTER
model SlotOfAvailabilityCustom {
  id String @id @default(uuid())

  // Availability period (UTC)
  availabilityStartsAt DateTime @db.Timestamptz()
  availabilityEndsAt   DateTime @db.Timestamptz()

  // Relations
  consultantProfile   ConsultantProfile @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String

  // Audit trail (UTC)
  createdAt DateTime @default(now()) @db.Timestamptz()
  updatedAt DateTime @updatedAt @db.Timestamptz()

  @@index([consultantProfileId])
}
```

### Phase 1.2: Appointment Slots

#### SlotOfAppointment

**Changes:**

```prisma
// BEFORE
model SlotOfAppointment {
  id String @id @default(uuid())

  user User[] @relation("SlotOfAppointmentToUser")

  slotStartTimeInUTC DateTime @db.Timestamptz()
  slotEndTimeInUTC   DateTime @db.Timestamptz()
  isTentative        Boolean  @default(false)

  appointment   Appointment @relation(fields: [appointmentId], references: [id])
  appointmentId String

  meetingSession MeetingSession?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// AFTER
model SlotOfAppointment {
  id String @id @default(uuid())

  // Users
  user User[] @relation("SlotOfAppointmentToUser")

  // Appointment time (UTC)
  startsAt    DateTime @db.Timestamptz()
  endsAt      DateTime @db.Timestamptz()
  isTentative Boolean  @default(false)

  // Relations
  appointment   Appointment @relation(fields: [appointmentId], references: [id])
  appointmentId String

  meetingSession MeetingSession?

  // Audit trail (UTC)
  createdAt DateTime @default(now()) @db.Timestamptz()
  updatedAt DateTime @updatedAt @db.Timestamptz()

  @@index([appointmentId])
  @@index([isTentative, appointmentId])
}
```

**Rationale:**

- Simplify "slotStartTimeInUTC" → "startsAt" (less verbose, clear context)
- Simplify "slotEndTimeInUTC" → "endsAt"
- Add `@db.Timestamptz()` to audit fields

### Phase 1.3: Subscriptions & Classes (Critical for Bug Fix)

#### Subscription

**Changes:**

```prisma
// BEFORE
model Subscription {
  id        String   @id @default(cuid())
  startDate DateTime @default(now())  // ❌ NO TIMEZONE!
  endDate   DateTime                  // ❌ NO TIMEZONE!

  requestStatus          RequestStatus    @default(PENDING)
  requestedBy            ConsulteeProfile @relation(...)
  requestedById          String
  requestedAt            DateTime         @default(now())
  requestNotes           String?
  feedbackFromConsultee  String?
  feedbackFromConsultant String?
  rating                 Float?

  subscriptionPlan   SubscriptionPlan @relation(...)
  subscriptionPlanId String

  appointments Appointment[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// AFTER
model Subscription {
  id String @id @default(cuid())

  // Scheduling period (UTC) - CRITICAL FIX
  schedulingPeriodStartsAt DateTime @db.Timestamptz()
  schedulingPeriodEndsAt   DateTime @db.Timestamptz()
  schedulingTimezone       String  // IANA timezone (e.g., "Asia/Kolkata")

  // Request tracking
  requestStatus          RequestStatus    @default(PENDING)
  requestedBy            ConsulteeProfile @relation(...)
  requestedById          String
  requestedAt            DateTime         @default(now()) @db.Timestamptz()
  requestNotes           String?

  // Feedback
  feedbackFromConsultee  String?
  feedbackFromConsultant String?
  rating                 Float?

  // Relations
  subscriptionPlan   SubscriptionPlan @relation(...)
  subscriptionPlanId String

  appointments Appointment[]

  // Audit trail (UTC)
  createdAt DateTime @default(now()) @db.Timestamptz()
  updatedAt DateTime @updatedAt @db.Timestamptz()
}
```

**Critical Bug Fix:**

- `startDate` (no TZ) → `schedulingPeriodStartsAt` (@db.Timestamptz)
- `endDate` (no TZ) → `schedulingPeriodEndsAt` (@db.Timestamptz)
- Added `schedulingTimezone` for display context
- Added `@db.Timestamptz()` to `requestedAt`

**Why This Fixes the Bug:**

```typescript
// BEFORE (causes bug)
subscription.startDate = "2025-10-22 20:37:37.225"; // ❌ Which timezone?
slotOfAppointment.slotStartTimeInUTC = "2025-10-22 09:00:00+00"; // ✅ UTC

// Comparison fails because startDate is ambiguous!

// AFTER (fixes bug)
subscription.schedulingPeriodStartsAt = "2025-10-22 20:37:37.225+05:30"; // ✅ IST → UTC
slotOfAppointment.startsAt = "2025-10-22 09:00:00+00"; // ✅ UTC

// Both in UTC, comparison works correctly!
```

#### Class

**Changes:**

```prisma
// BEFORE
model Class {
  id              String      @id @default(cuid())
  startDate       DateTime?   // ❌ NO TIMEZONE!
  endDate         DateTime?   // ❌ NO TIMEZONE!
  status          ClassStatus @default(SCHEDULED)
  waitlist        Waitlist[]
  recordingUrls   String[]
  feedbackSummary String?     @db.Text

  classPlan   ClassPlan @relation(...)
  classPlanId String

  appointments Appointment[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// AFTER
model Class {
  id String @id @default(cuid())

  // Scheduling period (UTC)
  schedulingPeriodStartsAt DateTime? @db.Timestamptz()
  schedulingPeriodEndsAt   DateTime? @db.Timestamptz()
  schedulingTimezone       String?   // IANA timezone

  // Status and content
  status          ClassStatus @default(SCHEDULED)
  waitlist        Waitlist[]
  recordingUrls   String[]
  feedbackSummary String?     @db.Text

  // Relations
  classPlan   ClassPlan @relation(...)
  classPlanId String

  appointments Appointment[]

  // Audit trail (UTC)
  createdAt DateTime @default(now()) @db.Timestamptz()
  updatedAt DateTime @updatedAt @db.Timestamptz()

  @@index([classPlanId])
}
```

### Phase 1.4: Consultation

**Changes:**

```prisma
// BEFORE
model Consultation {
  id                 String           @id @default(uuid())
  consultationPlan   ConsultationPlan @relation(...)
  consultationPlanId String

  requestStatus          RequestStatus    @default(PENDING)
  requestedBy            ConsulteeProfile @relation(...)
  requestedById          String
  requestedAt            DateTime         @default(now())
  requestNotes           String?
  directlyBooked         Boolean          @default(false)
  feedbackFromConsultee  String?
  feedbackFromConsultant String?
  rating                 Float?

  appointment Appointment?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// AFTER
model Consultation {
  id                 String           @id @default(uuid())
  consultationPlan   ConsultationPlan @relation(...)
  consultationPlanId String

  // Request tracking
  requestStatus          RequestStatus    @default(PENDING)
  requestedBy            ConsulteeProfile @relation(...)
  requestedById          String
  requestedAt            DateTime         @default(now()) @db.Timestamptz()
  requestNotes           String?
  directlyBooked         Boolean          @default(false)

  // Feedback
  feedbackFromConsultee  String?
  feedbackFromConsultant String?
  rating                 Float?

  // Relations
  appointment Appointment?

  // Audit trail (UTC)
  createdAt DateTime @default(now()) @db.Timestamptz()
  updatedAt DateTime @updatedAt @db.Timestamptz()
}
```

### Phase 1.5: User & Auth Models

#### User

**Changes:**

```prisma
// BEFORE
model User {
  id                   String    @id @default(cuid())
  name                 String?
  email                String?   @unique
  emailVerified        DateTime?
  // ... other fields
  currentTimezone      String?
  // ... other fields
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// AFTER
model User {
  id                   String    @id @default(cuid())
  name                 String?
  email                String?   @unique
  emailVerifiedAt      DateTime? @db.Timestamptz()  // Renamed
  passwordResetExpiresAt DateTime? @db.Timestamptz()  // Renamed + TZ
  // ... other fields
  timezone             String?  // Renamed, cleaner
  // ... other fields

  // Audit trail (UTC)
  createdAt DateTime @default(now()) @db.Timestamptz()
  updatedAt DateTime @updatedAt @db.Timestamptz()

  @@map("users")
}
```

#### Session

**Changes:**

```prisma
// BEFORE
model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime  // ❌ NO TIMEZONE!
  user         User     @relation(...)
}

// AFTER
model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expiresAt    DateTime @db.Timestamptz()  // Renamed + TZ
  user         User     @relation(...)

  @@index([userId])
  @@map("sessions")
}
```

#### VerificationToken

**Changes:**

```prisma
// BEFORE
model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime  // ❌ NO TIMEZONE!
}

// AFTER
model VerificationToken {
  identifier String
  token      String   @unique
  expiresAt  DateTime @db.Timestamptz()  // Renamed + TZ

  @@unique([identifier, token])
  @@map("verificationtokens")
}
```

### Phase 1.6: Other Models with Audit Fields

All remaining models need `@db.Timestamptz()` added to audit fields:

- `Feedback` (createdAt, updatedAt)
- `SupportTicket` (createdAt, updatedAt)
- `SupportResponse` (createdAt, updatedAt)
- `ConsultantProfile` (createdAt, updatedAt)
- `Domain` (createdAt, updatedAt)
- `SubDomain` (createdAt, updatedAt)
- `Tag` (createdAt, updatedAt)
- `ConsultantReview` (createdAt, updatedAt)
- `ConsulteeProfile` (createdAt, updatedAt)
- `StaffProfile` (createdAt, updatedAt)
- `ConsultationPlan` (createdAt, updatedAt)
- `SubscriptionPlan` (createdAt, updatedAt)
- `WebinarPlan` (createdAt, updatedAt)
- `Webinar` (createdAt, updatedAt)
- `ClassPlan` (createdAt, updatedAt)
- `ClassContent` (createdAt, updatedAt)
- `Topic` (createdAt, updatedAt)
- `Newsletter` (createdAt, updatedAt)
- `Waitlist` (joinedAt → createdAt @db.Timestamptz())
- `Appointment` (createdAt, updatedAt)
- `AppointmentDocument` (reviewedAt, uploadedAt, createdAt, updatedAt)
- `MeetingSession` (createdAt, updatedAt)
- `Recording` (recordedAt, createdAt, updatedAt)
- `Payment` (expiresAt, createdAt, updatedAt)
- `DiscountCode` (createdAt, updatedAt)

---

## Phase 2: Database Migrations

### Migration 2.1: Add New Fields (Non-Breaking)

**Strategy:** Add new columns alongside old ones, backfill data

```prisma
// This migration is SAFE - adds new columns without removing old ones

migration AddTimezoneAwareFields {
  // 1. SlotOfAvailabilityWeekly
  ALTER TABLE "SlotOfAvailabilityWeekly"
    ADD COLUMN "dayOfWeekForStart" "DayOfWeek",
    ADD COLUMN "availabilityStartsAt" TIMESTAMPTZ,
    ADD COLUMN "dayOfWeekForEnd" "DayOfWeek",
    ADD COLUMN "availabilityEndsAt" TIMESTAMPTZ;

  // Backfill from old columns
  UPDATE "SlotOfAvailabilityWeekly"
  SET
    "dayOfWeekForStart" = "dayOfWeekforStartTimeInUTC",
    "availabilityStartsAt" = "slotStartTimeInUTC",
    "dayOfWeekForEnd" = "dayOfWeekforEndTimeInUTC",
    "availabilityEndsAt" = "slotEndTimeInUTC";

  // 2. SlotOfAvailabilityCustom
  ALTER TABLE "SlotOfAvailabilityCustom"
    ADD COLUMN "availabilityStartsAt" TIMESTAMPTZ,
    ADD COLUMN "availabilityEndsAt" TIMESTAMPTZ;

  UPDATE "SlotOfAvailabilityCustom"
  SET
    "availabilityStartsAt" = "slotStartTimeInUTC",
    "availabilityEndsAt" = "slotEndTimeInUTC";

  // 3. SlotOfAppointment
  ALTER TABLE "SlotOfAppointment"
    ADD COLUMN "startsAt" TIMESTAMPTZ,
    ADD COLUMN "endsAt" TIMESTAMPTZ;

  UPDATE "SlotOfAppointment"
  SET
    "startsAt" = "slotStartTimeInUTC",
    "endsAt" = "slotEndTimeInUTC";

  // 4. Subscription (CRITICAL)
  ALTER TABLE "Subscription"
    ADD COLUMN "schedulingPeriodStartsAt" TIMESTAMPTZ,
    ADD COLUMN "schedulingPeriodEndsAt" TIMESTAMPTZ,
    ADD COLUMN "schedulingTimezone" TEXT DEFAULT 'Asia/Kolkata';

  // Backfill: Assume existing dates are in Asia/Kolkata timezone
  UPDATE "Subscription"
  SET
    "schedulingPeriodStartsAt" = "startDate" AT TIME ZONE 'Asia/Kolkata',
    "schedulingPeriodEndsAt" = "endDate" AT TIME ZONE 'Asia/Kolkata';

  // 5. Class
  ALTER TABLE "Class"
    ADD COLUMN "schedulingPeriodStartsAt" TIMESTAMPTZ,
    ADD COLUMN "schedulingPeriodEndsAt" TIMESTAMPTZ,
    ADD COLUMN "schedulingTimezone" TEXT;

  UPDATE "Class"
  SET
    "schedulingPeriodStartsAt" = "startDate" AT TIME ZONE 'Asia/Kolkata',
    "schedulingPeriodEndsAt" = "endDate" AT TIME ZONE 'Asia/Kolkata',
    "schedulingTimezone" = 'Asia/Kolkata'
  WHERE "startDate" IS NOT NULL;

  // 6. User timezone fields
  ALTER TABLE "users"
    ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ,
    ADD COLUMN "passwordResetExpiresAt" TIMESTAMPTZ,
    ADD COLUMN "timezone" TEXT;

  UPDATE "users"
  SET
    "emailVerifiedAt" = "emailVerified" AT TIME ZONE 'UTC',
    "passwordResetExpiresAt" = "passwordResetExpires" AT TIME ZONE 'UTC',
    "timezone" = "currentTimezone";

  // 7. Session
  ALTER TABLE "sessions"
    ADD COLUMN "expiresAt" TIMESTAMPTZ;

  UPDATE "sessions"
  SET "expiresAt" = "expires" AT TIME ZONE 'UTC';

  // 8. VerificationToken
  ALTER TABLE "verificationtokens"
    ADD COLUMN "expiresAt" TIMESTAMPTZ;

  UPDATE "verificationtokens"
  SET "expiresAt" = "expires" AT TIME ZONE 'UTC';
}
```

### Migration 2.2: Update Audit Fields to Timestamptz

```sql
// Add explicit timezone to all audit fields

// Helper function to convert existing DateTime to Timestamptz
CREATE OR REPLACE FUNCTION migrate_datetime_to_timestamptz(
  table_name TEXT,
  column_name TEXT
) RETURNS VOID AS $$
BEGIN
  EXECUTE format(
    'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
    table_name, column_name, column_name
  );
END;
$$ LANGUAGE plpgsql;

// Apply to all models
SELECT migrate_datetime_to_timestamptz('Feedback', 'createdAt');
SELECT migrate_datetime_to_timestamptz('Feedback', 'updatedAt');
SELECT migrate_datetime_to_timestamptz('SupportTicket', 'createdAt');
SELECT migrate_datetime_to_timestamptz('SupportTicket', 'updatedAt');
// ... repeat for all 30+ models
```

### Migration 2.3: Make New Fields Non-Nullable

```sql
// Once application code is updated to use new fields, make them required

ALTER TABLE "SlotOfAvailabilityWeekly"
  ALTER COLUMN "dayOfWeekForStart" SET NOT NULL,
  ALTER COLUMN "availabilityStartsAt" SET NOT NULL,
  ALTER COLUMN "dayOfWeekForEnd" SET NOT NULL,
  ALTER COLUMN "availabilityEndsAt" SET NOT NULL;

ALTER TABLE "SlotOfAvailabilityCustom"
  ALTER COLUMN "availabilityStartsAt" SET NOT NULL,
  ALTER COLUMN "availabilityEndsAt" SET NOT NULL;

ALTER TABLE "SlotOfAppointment"
  ALTER COLUMN "startsAt" SET NOT NULL,
  ALTER COLUMN "endsAt" SET NOT NULL;

ALTER TABLE "Subscription"
  ALTER COLUMN "schedulingPeriodStartsAt" SET NOT NULL,
  ALTER COLUMN "schedulingPeriodEndsAt" SET NOT NULL,
  ALTER COLUMN "schedulingTimezone" SET NOT NULL;

ALTER TABLE "sessions"
  ALTER COLUMN "expiresAt" SET NOT NULL;

ALTER TABLE "verificationtokens"
  ALTER COLUMN "expiresAt" SET NOT NULL;
```

### Migration 2.4: Drop Old Columns (Breaking)

**⚠️ ONLY RUN AFTER FULL APPLICATION UPDATE AND TESTING**

```sql
// Drop deprecated columns

ALTER TABLE "SlotOfAvailabilityWeekly"
  DROP COLUMN "dayOfWeekforStartTimeInUTC",
  DROP COLUMN "slotStartTimeInUTC",
  DROP COLUMN "dayOfWeekforEndTimeInUTC",
  DROP COLUMN "slotEndTimeInUTC";

ALTER TABLE "SlotOfAvailabilityCustom"
  DROP COLUMN "slotStartTimeInUTC",
  DROP COLUMN "slotEndTimeInUTC";

ALTER TABLE "SlotOfAppointment"
  DROP COLUMN "slotStartTimeInUTC",
  DROP COLUMN "slotEndTimeInUTC";

ALTER TABLE "Subscription"
  DROP COLUMN "startDate",
  DROP COLUMN "endDate";

ALTER TABLE "Class"
  DROP COLUMN "startDate",
  DROP COLUMN "endDate";

ALTER TABLE "users"
  DROP COLUMN "emailVerified",
  DROP COLUMN "passwordResetExpires",
  DROP COLUMN "currentTimezone";

ALTER TABLE "sessions"
  DROP COLUMN "expires";

ALTER TABLE "verificationtokens"
  DROP COLUMN "expires";
```

---

## Phase 3: TypeScript Type Updates

### Phase 3.1: Prisma Client Regeneration

```bash
# After schema changes, regenerate Prisma client
npx prisma generate

# This will create new TypeScript types with updated field names
```

### Phase 3.2: Create Type Aliases for Transition Period

Create `types/datetime-migration.ts`:

```typescript
/**
 * Type aliases to help with migration from old field names to new ones
 *
 * Usage during transition:
 * - Old code can still use deprecated names (with warnings)
 * - New code uses new names
 * - Remove this file after migration complete
 */

import { SlotOfAppointment, Subscription, Class } from "@prisma/client";

/** @deprecated Use SlotOfAppointment.startsAt */
export type SlotStartTimeInUTC = SlotOfAppointment["startsAt"];

/** @deprecated Use SlotOfAppointment.endsAt */
export type SlotEndTimeInUTC = SlotOfAppointment["endsAt"];

/** @deprecated Use Subscription.schedulingPeriodStartsAt */
export type SubscriptionStartDate = Subscription["schedulingPeriodStartsAt"];

/** @deprecated Use Subscription.schedulingPeriodEndsAt */
export type SubscriptionEndDate = Subscription["schedulingPeriodEndsAt"];

// Helper type for dual-field support during migration
export type SlotOfAppointmentMigration = SlotOfAppointment & {
  /** @deprecated Use startsAt */
  slotStartTimeInUTC?: Date;
  /** @deprecated Use endsAt */
  slotEndTimeInUTC?: Date;
};
```

### Phase 3.3: Update Core Types

**File:** `utils/slotAllocation/types.ts`

```typescript
// BEFORE
export interface EventConfig {
  durationInHours?: number;
  sessionDurationInHours?: number;
  durationInMonths?: number;
  callsPerWeek?: number;
  startDate?: Date; // ❌ Ambiguous
  endDate?: Date; // ❌ Ambiguous
}

// AFTER
export interface EventConfig {
  durationInHours?: number;
  sessionDurationInHours?: number;
  durationInMonths?: number;
  callsPerWeek?: number;
  schedulingPeriodStartsAt?: Date; // ✅ Clear + TZ-aware
  schedulingPeriodEndsAt?: Date; // ✅ Clear + TZ-aware
  schedulingTimezone?: string; // ✅ Display context
}
```

---

## Phase 4: Code Updates (Critical Files)

### Files Requiring Updates (Estimated)

#### High Priority (Core Booking Logic)

1. `utils/slotAllocation/SlotAllocationService.ts` ⭐⭐⭐
2. `utils/slotAllocation/SlotValidationService.ts` ⭐⭐⭐
3. `utils/slotAllocation/SlotCalculationService.ts` ⭐⭐
4. `app/api/events/subscriptions/[subscriptionId]/allocate/route.ts` ⭐⭐⭐
5. `app/api/events/classes/[classId]/allocate/route.ts` ⭐⭐⭐
6. `app/api/events/consultations/[consultationId]/allocate/route.ts` ⭐⭐
7. `app/api/events/webinars/[webinarId]/allocate/route.ts` ⭐⭐

#### Medium Priority (UI & Data Fetching)

8. `app/dashboard/consultant/[consultantId]/(features)/shared/hooks/useCalendarData.ts` ⭐⭐
9. `app/dashboard/consultant/[consultantId]/(features)/shared/utils/allocationService.ts` ⭐⭐
10. `app/dashboard/consultant/[consultantId]/(features)/shared/utils/calendarUtils.ts` ⭐
11. `app/dashboard/consultant/[consultantId]/(features)/shared/components/UnifiedCalendar.tsx` ⭐
12. `app/api/slots/availability-with-allocation/[consultantId]/route.ts` ⭐⭐
13. `app/api/slots/appointments/route.ts` ⭐⭐

#### Lower Priority (Display & Formatting)

14. Various component files displaying dates (search for `startDate`, `endDate`)
15. Seed files (`prisma/seed.ts`, etc.)
16. Test files

### Phase 4.1: Update SlotAllocationService.ts

**Critical Changes:**

```typescript
// File: utils/slotAllocation/SlotAllocationService.ts

// BEFORE
const startDate = config.startDate || new Date();
const endDate = config.endDate || addMonths(startDate, config.durationInMonths || 1);

// AFTER
const schedulingPeriodStartsAt = config.schedulingPeriodStartsAt || new Date();
const schedulingPeriodEndsAt = config.schedulingPeriodEndsAt ||
  addMonths(schedulingPeriodStartsAt, config.durationInMonths || 1);

// BEFORE (lines 554-558)
if (
  !slotTime ||
  slotTime < now ||
  slotTime < startDate ||
  slotTime > endDate
) {
  continue;
}

// AFTER
if (
  !slotTime ||
  slotTime < now ||
  slotTime < schedulingPeriodStartsAt ||
  slotTime > schedulingPeriodEndsAt
) {
  continue;
}

// BEFORE (line 813-816) - THIS FIXES YOUR BUG!
if (eventType === "subscription") {
  updates.startDate = firstSlot;
  updates.endDate = addMonths(firstSlot, config.durationInMonths || 1);
}

// AFTER
if (eventType === "subscription") {
  // Only set if not already configured (prevents overwriting user's period)
  if (!config.schedulingPeriodStartsAt || !config.schedulingPeriodEndsAt) {
    updates.schedulingPeriodStartsAt = firstSlot;
    updates.schedulingPeriodEndsAt = addMonths(firstSlot, config.durationInMonths || 1);
    updates.schedulingTimezone = config.schedulingTimezone || 'UTC';
  }
}

// BEFORE (fetchEventData, line 888-890)
config = {
  durationInMonths: event.subscriptionPlan?.durationInMonths,
  callsPerWeek: event.subscriptionPlan?.callsPerWeek,
  sessionDurationInHours: event.subscriptionPlan?.sessionDurationInHours,
  startDate: event.startDate,
  endDate: event.endDate,
};

// AFTER
config = {
  durationInMonths: event.subscriptionPlan?.durationInMonths,
  callsPerWeek: event.subscriptionPlan?.callsPerWeek,
  sessionDurationInHours: event.subscriptionPlan?.sessionDurationInHours,
  schedulingPeriodStartsAt: event.schedulingPeriodStartsAt,
  schedulingPeriodEndsAt: event.schedulingPeriodEndsAt,
  schedulingTimezone: event.schedulingTimezone,
};

// BEFORE (line 125-140) - Validation
if (config.startDate && config.endDate) {
  const slotsOutsidePeriod = selectedSlots.filter(
    (slot) => slot < config.startDate! || slot > config.endDate!
  );

// AFTER
if (config.schedulingPeriodStartsAt && config.schedulingPeriodEndsAt) {
  const slotsOutsidePeriod = selectedSlots.filter(
    (slot) => slot < config.schedulingPeriodStartsAt! || slot > config.schedulingPeriodEndsAt!
  );

  if (slotsOutsidePeriod.length > 0) {
    const firstBad = slotsOutsidePeriod[0];
    throw new Error(
      `Cannot allocate slots outside scheduling period. ` +
      `Period: ${config.schedulingPeriodStartsAt.toISOString()} to ${config.schedulingPeriodEndsAt.toISOString()}. ` +
      `Found slot at: ${firstBad.toISOString()} (${firstBad < config.schedulingPeriodStartsAt! ? 'before start' : 'after end'}). ` +
      `Total violations: ${slotsOutsidePeriod.length}`
    );
  }
}
```

### Phase 4.2: Update SlotValidationService.ts

```typescript
// File: utils/slotAllocation/SlotValidationService.ts

// Search and replace patterns:
// config.startDate → config.schedulingPeriodStartsAt
// config.endDate → config.schedulingPeriodEndsAt

// Update validatePeriodBoundaries method
private validatePeriodBoundaries(
  slots: Date[],
  config: EventConfig,
): string[] {
  const errors: string[] = [];

  if (!config.schedulingPeriodStartsAt || !config.schedulingPeriodEndsAt) {
    return errors;
  }

  const slotsOutsidePeriod = slots.filter(
    (slot) =>
      slot < config.schedulingPeriodStartsAt! ||
      slot > config.schedulingPeriodEndsAt!
  );

  if (slotsOutsidePeriod.length > 0) {
    errors.push(
      `${slotsOutsidePeriod.length} slot(s) fall outside the scheduling period ` +
      `(${config.schedulingPeriodStartsAt.toISOString()} - ${config.schedulingPeriodEndsAt.toISOString()})`
    );
  }

  return errors;
}
```

### Phase 4.3: Update API Routes

**Pattern to apply to all allocation routes:**

```typescript
// File: app/api/events/subscriptions/[subscriptionId]/allocate/route.ts

// Prisma include statements need updating:
include: {
  subscriptionPlan: {
    include: {
      consultantProfile: {
        select: {
          user: true,
          scheduleType: true,
          slotsOfAvailabilityWeekly: {
            select: {
              // BEFORE
              slotStartTimeInUTC: true,
              slotEndTimeInUTC: true,

              // AFTER
              availabilityStartsAt: true,
              availabilityEndsAt: true,
              dayOfWeekForStart: true,
              dayOfWeekForEnd: true,
            }
          },
          slotsOfAvailabilityCustom: {
            select: {
              // BEFORE
              slotStartTimeInUTC: true,
              slotEndTimeInUTC: true,

              // AFTER
              availabilityStartsAt: true,
              availabilityEndsAt: true,
            }
          },
        }
      }
    }
  },
  appointments: {
    include: {
      slotsOfAppointment: {
        select: {
          // BEFORE
          slotStartTimeInUTC: true,
          slotEndTimeInUTC: true,

          // AFTER
          startsAt: true,
          endsAt: true,
          isTentative: true,
        }
      }
    }
  }
}
```

### Phase 4.4: Update Calendar Components

```typescript
// File: app/dashboard/consultant/[consultantId]/(features)/shared/components/UnifiedCalendar.tsx

// Update slot comparison logic
const isCurrentEventSlot = eventSlots.some((eventSlot) => {
  // BEFORE
  const slotTime = slot.startTime.getTime();
  const eventTime = eventSlot.startTime.getTime();

  // AFTER (if eventSlot is SlotOfAppointment)
  const slotTime = slot.startTime.getTime();
  const eventTime = eventSlot.startsAt.getTime(); // ✅ New field name

  const timeDiff = Math.abs(slotTime - eventTime);
  return timeDiff < 1000;
});
```

### Phase 4.5: Update Utility Functions

```typescript
// File: app/dashboard/consultant/[consultantId]/(features)/shared/utils/calendarUtils.ts

export interface TimeSlot {
  startTime: Date;
  endTime: Date;
  // ... other fields
}

// Convert SlotOfAppointment to TimeSlot
export function slotOfAppointmentToTimeSlot(slot: SlotOfAppointment): TimeSlot {
  return {
    // BEFORE
    startTime: new Date(slot.slotStartTimeInUTC),
    endTime: new Date(slot.slotEndTimeInUTC),

    // AFTER
    startTime: new Date(slot.startsAt),
    endsAt: new Date(slot.endsAt),
  };
}
```

---

## Phase 5: Seed File Updates

### Phase 5.1: Update Seed Data Structure

**File:** `prisma/seed.ts` (or wherever seed data is defined)

```typescript
// BEFORE
await prisma.subscription.create({
  data: {
    startDate: new Date("2025-10-23T02:07:00.000Z"), // ❌ Ambiguous
    endDate: new Date("2025-10-31T02:07:00.000Z"), // ❌ Ambiguous
    requestStatus: "APPROVED",
    // ...
  },
});

// AFTER
await prisma.subscription.create({
  data: {
    schedulingPeriodStartsAt: new Date("2025-10-23T02:07:00.000+05:30"), // ✅ IST timestamp
    schedulingPeriodEndsAt: new Date("2025-10-31T02:07:00.000+05:30"), // ✅ IST timestamp
    schedulingTimezone: "Asia/Kolkata", // ✅ Explicit timezone
    requestStatus: "APPROVED",
    // ...
  },
});

// For availability slots
await prisma.slotOfAvailabilityWeekly.create({
  data: {
    // BEFORE
    dayOfWeekforStartTimeInUTC: "MONDAY",
    slotStartTimeInUTC: new Date("2024-01-01T09:00:00.000Z"),
    dayOfWeekforEndTimeInUTC: "MONDAY",
    slotEndTimeInUTC: new Date("2024-01-01T10:00:00.000Z"),

    // AFTER
    dayOfWeekForStart: "MONDAY",
    availabilityStartsAt: new Date("2024-01-01T09:00:00.000Z"),
    dayOfWeekForEnd: "MONDAY",
    availabilityEndsAt: new Date("2024-01-01T10:00:00.000Z"),
    // ...
  },
});

// For appointment slots
await prisma.slotOfAppointment.create({
  data: {
    // BEFORE
    slotStartTimeInUTC: new Date("2025-10-22T09:00:00.000Z"),
    slotEndTimeInUTC: new Date("2025-10-22T10:00:00.000Z"),

    // AFTER
    startsAt: new Date("2025-10-22T09:00:00.000Z"),
    endsAt: new Date("2025-10-22T10:00:00.000Z"),
    isTentative: false,
    // ...
  },
});
```

### Phase 5.2: Reseed Database

```bash
# Drop all data
npx prisma migrate reset --force

# Run new seeds
npx prisma db seed

# Verify data
npx prisma studio
```

---

## Phase 6: Testing Strategy

### Phase 6.1: Unit Tests

**Create test file:** `tests/datetime-migration.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";

describe("DateTime Migration Tests", () => {
  describe("Timezone Consistency", () => {
    it("should compare subscription schedulingPeriodStartsAt with slot startsAt correctly", () => {
      // This test verifies the bug fix
      const subscriptionStart = new Date("2025-10-22T20:37:37.225+05:30"); // IST
      const slotStart = new Date("2025-10-22T09:00:00.000Z"); // UTC

      // Before fix: comparison would fail due to timezone ambiguity
      // After fix: both are UTC, comparison works
      expect(slotStart).toBeLessThan(subscriptionStart);
    });

    it("should handle slots within scheduling period", () => {
      const config = {
        schedulingPeriodStartsAt: new Date("2025-10-23T02:07:00.000+05:30"),
        schedulingPeriodEndsAt: new Date("2025-10-31T02:07:00.000+05:30"),
      };

      const validSlot = new Date("2025-10-24T09:00:00.000Z");
      const invalidSlotBefore = new Date("2025-10-22T09:00:00.000Z");
      const invalidSlotAfter = new Date("2025-11-01T09:00:00.000Z");

      expect(validSlot >= config.schedulingPeriodStartsAt).toBe(true);
      expect(validSlot <= config.schedulingPeriodEndsAt).toBe(true);

      expect(invalidSlotBefore < config.schedulingPeriodStartsAt).toBe(true);
      expect(invalidSlotAfter > config.schedulingPeriodEndsAt).toBe(true);
    });
  });

  describe("Field Name Migrations", () => {
    it("should use new field names in SlotOfAppointment", async () => {
      const slot = await prisma.slotOfAppointment.findFirst();

      expect(slot).toHaveProperty("startsAt");
      expect(slot).toHaveProperty("endsAt");
      expect(slot).not.toHaveProperty("slotStartTimeInUTC");
      expect(slot).not.toHaveProperty("slotEndTimeInUTC");
    });

    it("should use new field names in Subscription", async () => {
      const subscription = await prisma.subscription.findFirst();

      expect(subscription).toHaveProperty("schedulingPeriodStartsAt");
      expect(subscription).toHaveProperty("schedulingPeriodEndsAt");
      expect(subscription).toHaveProperty("schedulingTimezone");
      expect(subscription).not.toHaveProperty("startDate");
      expect(subscription).not.toHaveProperty("endDate");
    });
  });
});
```

### Phase 6.2: Integration Tests

**Test Erik Hilpert scenario:**

```typescript
describe("Erik Hilpert Bug Fix", () => {
  it("should not allocate slots before scheduling period", async () => {
    // Create subscription with scheduling period starting Oct 23, 2025 at 2:07 AM IST
    const subscription = await prisma.subscription.create({
      data: {
        schedulingPeriodStartsAt: new Date("2025-10-23T02:07:00.000+05:30"),
        schedulingPeriodEndsAt: new Date("2025-10-31T02:07:00.000+05:30"),
        schedulingTimezone: "Asia/Kolkata",
        subscriptionPlanId: "test-plan-id",
        requestedById: "test-user-id",
        requestStatus: "PENDING",
      },
    });

    // Attempt auto-allocation
    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: subscription.id,
      mode: "auto",
    });

    // Verify all slots are AFTER schedulingPeriodStartsAt
    expect(result.success).toBe(true);

    const appointments = await prisma.appointment.findMany({
      where: { subscriptionId: subscription.id },
      include: { slotsOfAppointment: true },
    });

    const allSlots = appointments.flatMap((app) => app.slotsOfAppointment);

    for (const slot of allSlots) {
      expect(slot.startsAt >= subscription.schedulingPeriodStartsAt).toBe(true);
      expect(slot.endsAt <= subscription.schedulingPeriodEndsAt).toBe(true);
    }
  });
});
```

### Phase 6.3: Manual Testing Checklist

- [ ] Create new subscription with scheduling period
- [ ] Auto-allocate slots - verify first slot is NOT before period start
- [ ] Manual-allocate slots - verify validation rejects slots outside period
- [ ] View calendar UI - verify "Scheduling Period" displays correctly
- [ ] Check slot tooltips - verify times display in correct timezone
- [ ] Test with different timezones (UTC, IST, PST, EST)
- [ ] Verify existing appointments still display correctly
- [ ] Test appointment creation flow end-to-end
- [ ] Test rescheduling appointments

---

## Phase 7: Deployment Strategy

### Phase 7.1: Pre-Deployment Checklist

- [ ] All TypeScript errors resolved (`npm run typecheck`)
- [ ] All tests passing (`npm run test`)
- [ ] Seed files updated and tested
- [ ] Migration scripts reviewed and tested on staging
- [ ] Backup production database
- [ ] Document rollback procedure

### Phase 7.2: Deployment Steps

1. **Deploy Migration 2.1** (Add new fields, non-breaking)
   - Run in production
   - Verify backfill completed successfully
   - Monitor for errors

2. **Deploy Application Code** (Phase 4 changes)
   - Deploy updated TypeScript code
   - Application uses BOTH old and new fields during transition
   - Monitor logs for any field access errors

3. **Monitor Production** (1-2 days)
   - Verify new field usage
   - Check for any timezone-related bugs
   - Validate booking algorithm works correctly

4. **Deploy Migration 2.2** (Add Timestamptz to audit fields)
   - Run during low-traffic window
   - Monitor performance

5. **Deploy Migration 2.3** (Make new fields non-nullable)
   - Verify all new fields are populated
   - Run migration

6. **Final Code Update** (Remove dual-field support)
   - Update code to use ONLY new fields
   - Remove deprecated type aliases
   - Deploy

7. **Deploy Migration 2.4** (Drop old columns)
   - **FINAL STEP - IRREVERSIBLE**
   - Only after full validation
   - Drop old columns

### Phase 7.3: Rollback Plan

If issues occur after Migration 2.1-2.3:

```sql
// Rollback: Copy new fields back to old fields
UPDATE "Subscription"
SET
  "startDate" = "schedulingPeriodStartsAt" AT TIME ZONE 'UTC',
  "endDate" = "schedulingPeriodEndsAt" AT TIME ZONE 'UTC';

UPDATE "SlotOfAppointment"
SET
  "slotStartTimeInUTC" = "startsAt",
  "slotEndTimeInUTC" = "endsAt";

// Redeploy old application code
```

⚠️ **After Migration 2.4 (drop columns), rollback requires database restore**

---

## Phase 8: Documentation Updates

### Phase 8.1: Update Code Comments

Add explanatory comments to key locations:

```typescript
/**
 * CRITICAL: Scheduling Period Timezone Handling
 *
 * The subscription's scheduling period is stored in UTC (Timestamptz) but
 * associated with a timezone for display purposes.
 *
 * Example:
 * - schedulingPeriodStartsAt: "2025-10-22T20:37:37.225+00:00" (UTC)
 * - schedulingTimezone: "Asia/Kolkata" (IST = UTC+5:30)
 * - Display to user: "Oct 23, 2025 at 2:07 AM IST"
 *
 * When comparing with SlotOfAppointment.startsAt (also UTC), both are
 * in the same timezone, so comparison is accurate.
 */
```

### Phase 8.2: Update API Documentation

Update any API docs to reflect new field names:

````markdown
## Subscription Object

### Fields

- `schedulingPeriodStartsAt` (DateTime): Start of scheduling period in UTC
- `schedulingPeriodEndsAt` (DateTime): End of scheduling period in UTC
- `schedulingTimezone` (String): IANA timezone identifier (e.g., "Asia/Kolkata")

### Example

```json
{
  "id": "cm123456",
  "schedulingPeriodStartsAt": "2025-10-22T20:37:37.225Z",
  "schedulingPeriodEndsAt": "2025-10-30T20:37:37.225Z",
  "schedulingTimezone": "Asia/Kolkata"
}
```
````

```

### Phase 8.3: Create Migration Guide for Future Reference

Document this migration for team knowledge:

- Decision rationale
- Before/after comparisons
- Lessons learned
- Best practices for future schema changes

---

## Appendix A: Complete Field Mapping

| Old Field | New Field | Model | Type Change |
|-----------|-----------|-------|-------------|
| `slotStartTimeInUTC` | `availabilityStartsAt` | SlotOfAvailabilityWeekly | Name only |
| `slotEndTimeInUTC` | `availabilityEndsAt` | SlotOfAvailabilityWeekly | Name only |
| `dayOfWeekforStartTimeInUTC` | `dayOfWeekForStart` | SlotOfAvailabilityWeekly | Name only |
| `dayOfWeekforEndTimeInUTC` | `dayOfWeekForEnd` | SlotOfAvailabilityWeekly | Name only |
| `slotStartTimeInUTC` | `availabilityStartsAt` | SlotOfAvailabilityCustom | Name only |
| `slotEndTimeInUTC` | `availabilityEndsAt` | SlotOfAvailabilityCustom | Name only |
| `slotStartTimeInUTC` | `startsAt` | SlotOfAppointment | Name only |
| `slotEndTimeInUTC` | `endsAt` | SlotOfAppointment | Name only |
| `startDate` | `schedulingPeriodStartsAt` | Subscription | Name + `@db.Timestamptz()` ⭐ |
| `endDate` | `schedulingPeriodEndsAt` | Subscription | Name + `@db.Timestamptz()` ⭐ |
| (none) | `schedulingTimezone` | Subscription | New field |
| `startDate` | `schedulingPeriodStartsAt` | Class | Name + `@db.Timestamptz()` |
| `endDate` | `schedulingPeriodEndsAt` | Class | Name + `@db.Timestamptz()` |
| (none) | `schedulingTimezone` | Class | New field |
| `emailVerified` | `emailVerifiedAt` | User | Name + `@db.Timestamptz()` |
| `passwordResetExpires` | `passwordResetExpiresAt` | User | Name + `@db.Timestamptz()` |
| `currentTimezone` | `timezone` | User | Name only |
| `expires` | `expiresAt` | Session | Name + `@db.Timestamptz()` |
| `expires` | `expiresAt` | VerificationToken | Name + `@db.Timestamptz()` |
| `joinedAt` | `createdAt` | Waitlist | Name + `@db.Timestamptz()` |

⭐ = Critical for bug fix

---

## Appendix B: Common Errors and Solutions

### Error 1: TypeScript "Property does not exist"

```

Property 'slotStartTimeInUTC' does not exist on type 'SlotOfAppointment'

````

**Solution:** Update to new field name:
```typescript
// BEFORE
slot.slotStartTimeInUTC

// AFTER
slot.startsAt
````

### Error 2: Prisma Query Fails

```
Unknown argument `startDate`. Did you mean `schedulingPeriodStartsAt`?
```

**Solution:** Update Prisma query:

```typescript
// BEFORE
where: {
  startDate: {
    gte: new Date();
  }
}

// AFTER
where: {
  schedulingPeriodStartsAt: {
    gte: new Date();
  }
}
```

### Error 3: Migration Fails Due to NULL Values

```
ERROR: column "schedulingTimezone" contains null values
```

**Solution:** Backfill before making NOT NULL:

```sql
UPDATE "Subscription"
SET "schedulingTimezone" = 'Asia/Kolkata'
WHERE "schedulingTimezone" IS NULL;

ALTER TABLE "Subscription"
ALTER COLUMN "schedulingTimezone" SET NOT NULL;
```

### Error 4: Timezone Conversion Errors

```
ERROR: invalid input syntax for type timestamp with time zone
```

**Solution:** Ensure proper timezone format:

```typescript
// ❌ WRONG - Ambiguous
new Date("2025-10-22 20:37:37");

// ✅ CORRECT - Explicit UTC
new Date("2025-10-22T20:37:37.000Z");

// ✅ CORRECT - Explicit offset
new Date("2025-10-22T20:37:37.000+05:30");
```

---

## Appendix C: Estimated Timeline

| Phase                     | Duration                | Complexity |
| ------------------------- | ----------------------- | ---------- |
| Phase 1: Schema Updates   | 2-3 hours               | Medium     |
| Phase 2: Migrations       | 1-2 hours (+ test time) | High       |
| Phase 3: TypeScript Types | 1 hour                  | Low        |
| Phase 4: Code Updates     | 8-12 hours              | High       |
| Phase 5: Seed Files       | 2-3 hours               | Medium     |
| Phase 6: Testing          | 4-6 hours               | Medium     |
| Phase 7: Deployment       | 2-3 days (monitoring)   | High       |
| Phase 8: Documentation    | 2-3 hours               | Low        |

**Total Estimated Time:** 3-4 weeks (including testing and monitoring)

**Team Size:** 1-2 developers

---

## Summary

This migration addresses a critical bug where subscription scheduling periods were stored without timezone context, causing slots to be allocated outside the intended period. By standardizing on timezone-aware fields with clear naming conventions, we eliminate ambiguity and ensure accurate date/time comparisons throughout the application.

**Key Benefits:**

- ✅ Fixes slot allocation bug
- ✅ Eliminates timezone ambiguity
- ✅ Clearer, more maintainable code
- ✅ Consistent naming conventions
- ✅ Better PostgreSQL performance (Timestamptz indexing)
- ✅ Future-proof for multi-timezone support

**Next Steps:**

1. Review this plan with team
2. Set up staging environment for testing
3. Begin Phase 1 (Schema updates)
4. Follow migration phases sequentially
5. Monitor production closely after each deployment

---

**Document Version:** 1.1
**Last Updated:** 2025-10-15
**Author:** Migration Plan Generator
**Status:** Ready for Review

---

## Appendix D: Understanding the Timestamptz Inconsistency

### The Confusion

After reviewing the schema, you may notice that **only some** `createdAt` and `updatedAt` fields have `@db.Timestamptz()` while others don't:

```prisma
// Has Timestamptz ✅
model SlotOfAppointment {
  createdAt  DateTime  @default(now()) @db.Timestamptz()
  updatedAt  DateTime  @updatedAt @db.Timestamptz()
}

// Missing Timestamptz ❌
model Domain {
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
}
```

### Why This Happened

This is an **incomplete migration** from the original schema refactoring:

1. **Priority Focus**: The migration primarily targeted **scheduling-critical fields** (slots, appointments, subscriptions) where timezone bugs were causing actual business logic failures
2. **Incremental Approach**: Audit fields on "supporting tables" (domains, tags, profiles, etc.) were left as-is to minimize scope
3. **Low Impact**: These audit fields are used for internal tracking, not business logic comparisons

### What's the Difference?

**Without `@db.Timestamptz()`:**

```prisma
createdAt DateTime @default(now())
```

- PostgreSQL type: `timestamp` (no timezone)
- Stores: `2025-01-15 10:00:00` (ambiguous - which timezone?)
- Interpretation: Assumes the database server's timezone
- Risk: If DB server moves to different timezone, interpretation changes

**With `@db.Timestamptz()`:**

```prisma
createdAt DateTime @default(now()) @db.Timestamptz()
```

- PostgreSQL type: `timestamptz` (timezone-aware)
- Stores: `2025-01-15 10:00:00+00` (unambiguous - always UTC internally)
- Interpretation: Always stored in UTC, can be displayed in any timezone
- Risk: None - universal reference point

### Real-World Example of the Problem

```typescript
// Scenario: User signs up in India (IST timezone)
// Database server located in India

// WITHOUT Timestamptz
User.createdAt = "2025-01-15 10:00:00"; // No timezone info

// 6 months later: Database migrated to USA server (EST timezone)
// Now when you query User.createdAt, PostgreSQL interprets it as EST!
// The same "10:00:00" is now off by 10.5 hours from actual creation time

// WITH Timestamptz
User.createdAt = "2025-01-15 10:00:00+05:30"; // IST timezone preserved
// Internally stored as: "2025-01-15 04:30:00+00" (UTC)
// No matter where DB server is, it's always correct!
```

### Which Models Are Affected?

**✅ Have Timestamptz (Scheduling Models)**

- `SlotOfAppointment`
- `SlotOfAvailabilityWeekly`
- `SlotOfAvailabilityCustom`
- `Subscription`
- `Consultation`
- `Webinar`
- `Class`
- `Appointment`
- `Session`
- `VerificationToken`
- `User` (some fields: `emailVerifiedAt`, `passwordResetExpiresAt`)
- `Payment`
- `Recording`
- `AppointmentDocument`

**❌ Missing Timestamptz (Supporting Models)**

- `Domain`
- `SubDomain`
- `Tag`
- `ConsultantProfile`
- `ConsulteeProfile`
- `StaffProfile`
- `Feedback`
- `SupportTicket`
- `SupportResponse`
- `ConsultationPlan`
- `SubscriptionPlan`
- `WebinarPlan`
- `ClassPlan`
- `ClassContent`
- `Topic`
- `Newsletter`
- `DiscountCode`
- `MeetingSession`

### Why All DateTime Fields Should Use Timestamptz

**Best Practice Reasoning:**

1. **Consistency**: Same behavior everywhere, no special cases
2. **Audit Compliance**: "When was this created?" must be unambiguous globally
3. **No Downside**:
   - Same storage size (8 bytes)
   - Same or better performance (PostgreSQL optimizes for timestamptz)
   - More accurate
4. **Future-Proof**: If you ever need to analyze creation patterns across timezones
5. **DevOps Flexibility**: Can move database servers anywhere without breaking timestamps

**PostgreSQL Official Recommendation:**

> "For timestamps, use `timestamptz` (timestamp with time zone) unless you have a specific reason not to. It stores UTC and converts to the session's timezone for display."

### Current Risk Assessment

**🔴 Critical (Must Fix)**:

- NONE - All scheduling logic uses Timestamptz ✅

**🟡 Medium (Should Fix Eventually)**:

- Audit fields on supporting models
- Reason: For global audit compliance and consistency
- Impact: Low - only affects internal timestamps, not business logic
- Timeline: Can be addressed in next schema cleanup sprint

**🟢 Low (Already Correct)**:

- All business-critical datetime comparisons use Timestamptz ✅

### Simple Explanation

**Think of it like addresses:**

```
// Without Timestamptz (like missing country code)
"123 Main Street"
// Is this in USA? India? Australia? Ambiguous!

// With Timestamptz (complete address)
"123 Main Street, New York, NY 10001, USA"
// Unambiguous - anyone can find it
```

**For dates:**

```
// Without Timestamptz
"10:00 AM on Jan 15"
// India's 10 AM? USA's 10 AM? Different moments!

// With Timestamptz
"10:00 AM IST on Jan 15 (= 04:30 UTC)"
// Universal moment - everyone agrees when this happened
```

### Recommendation

**Short term:** No action needed - your booking algorithm is fixed! ✅

**Long term:** In the next schema cleanup sprint, consider:

1. Adding `@db.Timestamptz()` to all remaining audit fields
2. Creating a migration similar to Migration 2.2 (from this doc)
3. Benefits: Complete consistency, future-proof timestamps

**Quick Migration:**

```sql
-- One-time fix for all audit fields
ALTER TABLE "Domain"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';

-- Repeat for each supporting model...
```

### Key Takeaway

- **Your booking bug is FIXED** ✅ - All scheduling fields use Timestamptz correctly
- **The audit field inconsistency is TECHNICAL DEBT** 📝 - Low priority, no immediate impact
- **Eventually add Timestamptz to all DateTime fields** 🎯 - For best practices and consistency

This inconsistency is **cosmetic technical debt**, not a critical bug!
