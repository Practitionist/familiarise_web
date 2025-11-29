# Slot Types Feature

## Overview

The slot types feature helps distinguish between different types of availability slots in the system. This is particularly useful for consultants and consultees to understand the nature of their appointments.

## Slot Types

### 📅 Weekly Slots

- **Source**: Generated from weekly availability patterns
- **Description**: Recurring slots that follow a weekly schedule (e.g., every Monday at 2 PM)
- **Characteristics**:
  - Predictable and consistent
  - Part of a regular schedule
  - Automatically generated based on weekly availability settings

### 🎯 Custom Slots

- **Source**: Manually created for specific dates and times
- **Description**: One-time slots created for specific occasions
- **Characteristics**:
  - Unique and non-recurring
  - Manually scheduled by the consultant
  - Flexible timing outside regular schedule

## Where Slot Types Are Displayed

### 1. Dashboard - Appointments Tab

- Shows slot type badges next to appointment times
- Color-coded for easy identification
- Helps consultants understand their scheduling patterns

### 2. Public Expert Profile

- Displays slot types in the booking interface
- Helps consultees understand availability patterns
- Shows icons for quick visual identification

### 3. API Responses

- All slot-related API responses include the `type` field
- Enables consistent display across all interfaces

## Implementation Details

### Database Schema

- Added `SlotType` enum with values: `WEEKLY`, `CUSTOM`
- Added `type` field to `SlotOfAppointment` model
- Default value is `WEEKLY` for backward compatibility

### API Updates

- All appointment creation endpoints now include slot type
- Webhook handlers preserve slot type information
- Request-for-approval system includes slot type tracking

### UI Components

- Color-coded badges for visual distinction
- Icons for quick identification (📅 for weekly, 🎯 for custom)
- Consistent styling across all components

## Benefits

1. **Better Organization**: Consultants can easily see which appointments are part of their regular schedule vs. special arrangements
2. **Improved Planning**: Understanding slot types helps with scheduling decisions
3. **Enhanced User Experience**: Clear visual indicators improve the booking experience
4. **Data Insights**: Analytics can track patterns in weekly vs. custom bookings

## Migration

For existing appointments:

- Run the migration script: `npm run update-slot-types`
- All existing slots will be marked as `WEEKLY` by default
- Manual review may be needed for accurate classification
