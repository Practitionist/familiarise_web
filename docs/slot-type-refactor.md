# Slot Type Refactoring Documentation

## Overview

We've refactored the codebase to remove the redundant `type` field from `SlotOfAppointment` model and instead derive the slot type information from the appointment relations. This reduces database overhead and eliminates data duplication.

## Changes Made

### 1. Database Schema Changes

- **REMOVED**: `type` field from `SlotOfAppointment` model
- **BENEFIT**: Reduced storage overhead and eliminated duplicate data

### 2. Utility Functions Added

- **FILE**: `utils/appointmentUtils.ts`
- **FUNCTIONS**:
  - `getAppointmentTypeFromRelations()` - Determines appointment type from relations
  - `getSlotTypeFromAppointment()` - Provides backward compatibility for slot type
  - `getAppointmentTitleFromRelations()` - Gets title from appointment relations
  - `requiresSlotAvailability()` - Checks if appointment type needs slot availability
  - `isEventType()` - Checks if appointment is an event type (webinar/class)

### 3. UI Component Updates

- **REMOVED**: Slot type badges from booking interfaces
- **REASON**: Type is now derived from appointment context when needed
- **FILES UPDATED**:
  - `app/explore/experts/[consultantId]/components/PricingToggle.tsx`
  - `app/explore/experts/[consultantId]/components/ConsultantAvailability.tsx`
  - `app/dashboard/consultant/[consultantId]/(features)/shared/components/UnifiedCalendar.tsx`
  - `app/dashboard/consultee/[consulteeId]/(features)/appointments/EventCard.tsx`

### 4. API Updates

- **REMOVED**: Type field from slot creation in all API endpoints
- **FILES UPDATED**:
  - `app/api/slots/appointments/route.ts`
  - `app/api/slots/appointments/[appointmentId]/route.ts`
  - `app/api/webhooks/utils.ts`

### 5. Type Definitions

- **UPDATED**: `types/slots.ts` - Removed `type` field from `TSlotTiming`
- **UPDATED**: `utils/timeSlotsProcessing.ts` - Removed type field usage

## Migration Guide

### For Developers

1. **Instead of checking `slot.type`:**

   ```typescript
   // OLD WAY (DON'T USE)
   if (slot.type === "WEEKLY") {
     // handle weekly slot
   }

   // NEW WAY
   import { getSlotTypeFromAppointment } from "@/utils/appointmentUtils";
   const slotType = getSlotTypeFromAppointment(appointment);
   if (slotType === "WEEKLY") {
     // handle weekly slot
   }
   ```

2. **For appointment type checking:**

   ```typescript
   // OLD WAY (DON'T USE)
   const type = appointment.appointmentType;

   // NEW WAY (MORE RELIABLE)
   import { getAppointmentTypeFromRelations } from "@/utils/appointmentUtils";
   const type = getAppointmentTypeFromRelations(appointment);
   ```

### Database Migration Required

1. **Remove the `type` field from `SlotOfAppointment` model in Prisma schema**
2. **Run migration to drop the column from database**
3. **Update any direct database queries that reference the `type` field**

## Business Logic

### Slot Type Determination

The slot type is now determined based on appointment type:

- **CONSULTATION & SUBSCRIPTION**: Default to "WEEKLY" (uses availability slots)
- **WEBINAR & CLASS**: Default to "CUSTOM" (scheduled events)

### Benefits

1. **Reduced Database Overhead**: No redundant type field storage
2. **Single Source of Truth**: Appointment relations are the authoritative source
3. **Better Data Integrity**: No risk of type mismatch between slot and appointment
4. **Cleaner Schema**: More normalized database design
5. **Easier Maintenance**: One less field to manage and keep in sync

## Testing

Ensure to test:

1. **Appointment creation** - All types work without type field
2. **Slot display** - UI correctly shows appointment information
3. **API endpoints** - All appointment CRUD operations work
4. **Webhook handling** - Payment processing works correctly
5. **Calendar views** - Slots display correctly in all calendar components

## Rollback Plan

If issues arise, the rollback involves:

1. Re-adding the `type` field to Prisma schema
2. Running a migration to populate the field based on appointment relations
3. Reverting the code changes in this refactor

## Files Modified

### Core Logic

- `utils/appointmentUtils.ts` (NEW)
- `types/slots.ts`
- `utils/timeSlotsProcessing.ts`

### UI Components

- `app/explore/experts/[consultantId]/components/PricingToggle.tsx`
- `app/explore/experts/[consultantId]/components/ConsultantAvailability.tsx`
- `app/dashboard/consultant/[consultantId]/(features)/shared/components/UnifiedCalendar.tsx`
- `app/dashboard/consultee/[consulteeId]/(features)/appointments/EventCard.tsx`

### API Endpoints

- `app/api/slots/appointments/route.ts`
- `app/api/slots/appointments/[appointmentId]/route.ts`
- `app/api/webhooks/utils.ts`

### Schema

- `prisma/schema.prisma` (NEEDS UPDATE)
