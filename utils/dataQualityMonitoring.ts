/**
 * Data Quality Monitoring Utilities
 *
 * Provides validation and monitoring functions to detect corrupt or invalid data
 * in appointment slots, availability slots, and subscriptions.
 *
 * These utilities help maintain data integrity in production by:
 * - Validating data structures and required fields
 * - Detecting anomalies (dates far in past/future, invalid durations)
 * - Logging warnings for investigation
 * - Providing safe fallbacks when data is corrupt
 */

import { DayOfWeek } from "@prisma/client";

// ============================================================================
// VALIDATABLE INTERFACES
// ============================================================================

interface ValidatableSlot {
  id?: string;
  slotStartTimeInUTC?: string | Date;
  slotEndTimeInUTC?: string | Date;
  dayOfWeekforStartTimeInUTC?: string;
}

interface ValidatableAppointment {
  id?: string;
  appointmentType?: string;
  slotsOfAppointment?: ValidatableSlot[];
}

interface ValidatableSubscription {
  id?: string;
  startDate?: string | Date;
  endDate?: string | Date;
}

// ============================================================================
// VALIDATION THRESHOLDS
// ============================================================================

export const QUALITY_THRESHOLDS = {
  MAX_SLOT_DURATION_HOURS: 24,
  MIN_SLOT_DURATION_MINUTES: 1,
  MAX_YEARS_IN_PAST: 10,
  MAX_YEARS_IN_FUTURE: 10,
} as const;

// ============================================================================
// VALIDATION RESULT TYPES
// ============================================================================

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface SlotValidationResult extends ValidationResult {
  slotId?: string;
}

// ============================================================================
// SLOT VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validates a single slot's basic structure and date fields
 */
export function validateSlot(
  slot: ValidatableSlot | null | undefined,
  slotType: "weekly" | "custom" | "appointment",
): SlotValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required fields
  if (!slot) {
    errors.push("Slot is null or undefined");
    return { isValid: false, errors, warnings };
  }

  if (!slot.id && slotType !== "appointment") {
    errors.push("Slot missing required field: id");
  }

  if (!slot.slotStartTimeInUTC) {
    errors.push("Slot missing required field: slotStartTimeInUTC");
  }

  if (!slot.slotEndTimeInUTC) {
    errors.push("Slot missing required field: slotEndTimeInUTC");
  }

  // If basic structure is invalid, return early
  if (errors.length > 0) {
    return { isValid: false, errors, warnings, slotId: slot.id };
  }

  // Validate dates are valid — fields guaranteed non-null by the errors.length early return above
  const startDate = new Date(slot.slotStartTimeInUTC!);
  const endDate = new Date(slot.slotEndTimeInUTC!);

  if (isNaN(startDate.getTime())) {
    errors.push("slotStartTimeInUTC is not a valid date");
  }

  if (isNaN(endDate.getTime())) {
    errors.push("slotEndTimeInUTC is not a valid date");
  }

  if (errors.length > 0) {
    return { isValid: false, errors, warnings, slotId: slot.id };
  }

  // Check slot duration
  const durationMs = endDate.getTime() - startDate.getTime();
  const durationHours = durationMs / (1000 * 60 * 60);
  const durationMinutes = durationMs / (1000 * 60);

  // Allow overnight slots, but flag if duration > 24 hours
  if (durationHours > QUALITY_THRESHOLDS.MAX_SLOT_DURATION_HOURS) {
    errors.push(
      `Slot duration exceeds ${QUALITY_THRESHOLDS.MAX_SLOT_DURATION_HOURS} hours (${durationHours.toFixed(1)}h)`,
    );
  }

  if (durationMinutes < QUALITY_THRESHOLDS.MIN_SLOT_DURATION_MINUTES) {
    errors.push(
      `Slot duration is less than ${QUALITY_THRESHOLDS.MIN_SLOT_DURATION_MINUTES} minute(s)`,
    );
  }

  // Check if slot is unreasonably far in the past
  const now = new Date();
  const yearsAgo = new Date();
  yearsAgo.setFullYear(
    now.getFullYear() - QUALITY_THRESHOLDS.MAX_YEARS_IN_PAST,
  );

  if (endDate < yearsAgo) {
    warnings.push(
      `Slot end date is more than ${QUALITY_THRESHOLDS.MAX_YEARS_IN_PAST} years in the past (${endDate.toISOString()})`,
    );
  }

  // Check if slot is unreasonably far in the future
  const yearsFromNow = new Date();
  yearsFromNow.setFullYear(
    now.getFullYear() + QUALITY_THRESHOLDS.MAX_YEARS_IN_FUTURE,
  );

  if (startDate > yearsFromNow) {
    warnings.push(
      `Slot start date is more than ${QUALITY_THRESHOLDS.MAX_YEARS_IN_FUTURE} years in the future (${startDate.toISOString()})`,
    );
  }

  // Weekly slot specific validation
  if (slotType === "weekly") {
    if (!slot.dayOfWeekforStartTimeInUTC) {
      errors.push(
        "Weekly slot missing required field: dayOfWeekforStartTimeInUTC",
      );
    }
  }

  const isValid = errors.length === 0;
  return { isValid, errors, warnings, slotId: slot.id };
}

/**
 * Validates an appointment and its slots
 */
export function validateAppointment(appointment: ValidatableAppointment | null | undefined): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!appointment) {
    errors.push("Appointment is null or undefined");
    return { isValid: false, errors, warnings };
  }

  if (!appointment.id) {
    errors.push("Appointment missing required field: id");
  }

  if (!appointment.appointmentType) {
    errors.push("Appointment missing required field: appointmentType");
  }

  // Validate slots if they exist
  if (appointment.slotsOfAppointment) {
    if (!Array.isArray(appointment.slotsOfAppointment)) {
      errors.push("slotsOfAppointment is not an array");
    } else {
      appointment.slotsOfAppointment.forEach((slot: ValidatableSlot, index: number) => {
        const slotValidation = validateSlot(slot, "appointment");
        if (!slotValidation.isValid) {
          errors.push(
            `Slot ${index} in appointment ${appointment.id}: ${slotValidation.errors.join(", ")}`,
          );
        }
        if (slotValidation.warnings.length > 0) {
          warnings.push(
            `Slot ${index} in appointment ${appointment.id}: ${slotValidation.warnings.join(", ")}`,
          );
        }
      });
    }
  }

  const isValid = errors.length === 0;
  return { isValid, errors, warnings };
}

/**
 * Validates a subscription and its date boundaries
 */
export function validateSubscription(subscription: ValidatableSubscription | null | undefined): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!subscription) {
    errors.push("Subscription is null or undefined");
    return { isValid: false, errors, warnings };
  }

  if (!subscription.id) {
    errors.push("Subscription missing required field: id");
  }

  if (!subscription.startDate) {
    errors.push("Subscription missing required field: startDate");
  }

  if (!subscription.endDate) {
    errors.push("Subscription missing required field: endDate");
  }

  if (errors.length > 0) {
    return { isValid: false, errors, warnings };
  }

  // Validate dates — fields guaranteed non-null by the errors.length early return above
  const startDate = new Date(subscription.startDate!);
  const endDate = new Date(subscription.endDate!);

  if (isNaN(startDate.getTime())) {
    errors.push("startDate is not a valid date");
  }

  if (isNaN(endDate.getTime())) {
    errors.push("endDate is not a valid date");
  }

  if (errors.length > 0) {
    return { isValid: false, errors, warnings };
  }

  // Check date order
  if (endDate <= startDate) {
    errors.push("endDate must be after startDate");
  }

  // Check duration is reasonable
  const durationMs = endDate.getTime() - startDate.getTime();
  const durationDays = durationMs / (1000 * 60 * 60 * 24);

  if (durationDays < 1) {
    errors.push("Subscription duration is less than 1 day");
  }

  if (durationDays > 365 * 5) {
    warnings.push(
      `Subscription duration exceeds 5 years (${Math.floor(durationDays)} days)`,
    );
  }

  const isValid = errors.length === 0;
  return { isValid, errors, warnings };
}

/**
 * Validates consultant availability matches with appointment slots
 * Detects if appointments are scheduled on days consultant doesn't work
 */
export function validateAppointmentAgainstAvailability(
  appointment: ValidatableAppointment | null | undefined,
  consultantWeeklySlots: Array<{ dayOfWeekforStartTimeInUTC: DayOfWeek }>,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!appointment || !appointment.slotsOfAppointment) {
    return { isValid: true, errors, warnings };
  }

  // Get consultant's available days
  const availableDays = new Set(
    consultantWeeklySlots.map((s) => s.dayOfWeekforStartTimeInUTC),
  );

  if (availableDays.size === 0) {
    warnings.push(
      "Consultant has no weekly availability slots, cannot validate appointment days",
    );
    return { isValid: true, errors, warnings };
  }

  const dayMap: Record<number, DayOfWeek> = {
    0: DayOfWeek.SUNDAY,
    1: DayOfWeek.MONDAY,
    2: DayOfWeek.TUESDAY,
    3: DayOfWeek.WEDNESDAY,
    4: DayOfWeek.THURSDAY,
    5: DayOfWeek.FRIDAY,
    6: DayOfWeek.SATURDAY,
  };

  // Check each appointment slot
  appointment.slotsOfAppointment.forEach((slot: ValidatableSlot) => {
    if (!slot.slotStartTimeInUTC) return;
    const slotDate = new Date(slot.slotStartTimeInUTC);
    const dayOfWeek = dayMap[slotDate.getUTCDay()];

    if (!availableDays.has(dayOfWeek)) {
      errors.push(
        `Appointment slot on ${dayOfWeek} (${slotDate.toISOString()}) - consultant not available on this day`,
      );
    }
  });

  const isValid = errors.length === 0;
  return { isValid, errors, warnings };
}

/**
 * Validates appointment slots are within subscription boundaries
 */
export function validateAppointmentWithinSubscription(
  appointment: ValidatableAppointment | null | undefined,
  subscription: ValidatableSubscription | null | undefined,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!appointment || !subscription) {
    return { isValid: true, errors, warnings };
  }

  if (!appointment.slotsOfAppointment) {
    return { isValid: true, errors, warnings };
  }

  if (!subscription.startDate || !subscription.endDate) {
    return { isValid: true, errors, warnings };
  }

  const subStart = new Date(subscription.startDate);
  const subEnd = new Date(subscription.endDate);

  appointment.slotsOfAppointment.forEach((slot: ValidatableSlot, index: number) => {
    if (!slot.slotStartTimeInUTC || !slot.slotEndTimeInUTC) return;
    const slotStart = new Date(slot.slotStartTimeInUTC);
    const slotEnd = new Date(slot.slotEndTimeInUTC);

    if (slotStart < subStart || slotEnd > subEnd) {
      errors.push(
        `Slot ${index} (${slotStart.toISOString()}) is outside subscription period (${subStart.toISOString()} to ${subEnd.toISOString()})`,
      );
    }
  });

  const isValid = errors.length === 0;
  return { isValid, errors, warnings };
}

// ============================================================================
// BATCH VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validates multiple slots and returns summary
 */
export function validateSlots(
  slots: Array<ValidatableSlot | null | undefined>,
  slotType: "weekly" | "custom" | "appointment",
): {
  valid: number;
  invalid: number;
  warnings: number;
  details: SlotValidationResult[];
} {
  const details = slots.map((slot) => validateSlot(slot, slotType));

  return {
    valid: details.filter((d) => d.isValid).length,
    invalid: details.filter((d) => !d.isValid).length,
    warnings: details.filter((d) => d.warnings.length > 0).length,
    details,
  };
}

/**
 * Logs validation results for monitoring
 */
export function logValidationResults(
  context: string,
  results: ValidationResult[],
): void {
  const invalid = results.filter((r) => !r.isValid);
  const hasWarnings = results.filter((r) => r.warnings.length > 0);

  if (invalid.length > 0) {
    console.error(`❌ [${context}] Found ${invalid.length} invalid items:`);
    invalid.forEach((result, index) => {
      console.error(`  Item ${index + 1}:`, result.errors.join("; "));
    });
  }

  if (hasWarnings.length > 0) {
    console.warn(
      `⚠️  [${context}] Found ${hasWarnings.length} items with warnings:`,
    );
    hasWarnings.forEach((result, index) => {
      console.warn(`  Item ${index + 1}:`, result.warnings.join("; "));
    });
  }

  if (invalid.length === 0 && hasWarnings.length === 0) {
    console.log(
      `✅ [${context}] All ${results.length} items validated successfully`,
    );
  }
}
