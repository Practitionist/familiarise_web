import type { SlotType } from "@/utils/schedule/types";
import { resolveOvernightStatus } from "@/utils/schedule/overnight";

/**
 * The longest a single availability row may span. Exported because the
 * merge-on-save helpers must fold to the same bound this validator enforces —
 * a longer row is dropped by the settings loader and deleted by the next save.
 */
export const MAX_DURATION_MINUTES = 12 * 60;

// Configuration constants
const VALIDATION_CONFIG = {
  MIN_DURATION_MINUTES: 30,
  MAX_DURATION_MINUTES,
  TIME_INCREMENT_MINUTES: 15,
  SESSION_INCREMENT_MINUTES: 30,
} as const;

/**
 * The granularity a consultant may PICK a boundary at, in minutes. Exported so
 * the pickers and the 15-minute step they hand the browser read one number
 * instead of a `900` literal repeated in each form.
 *
 * This is an ENTRY step, not a publishing guarantee, and the two are not the
 * same number. Publication snaps to the 30-minute booking grid, and whether a
 * value typed at this granularity already sits on that grid depends on the
 * consultant's UTC offset: 09:00 is on the grid in Asia/Kolkata (+05:30 → 03:30Z)
 * and off it in Asia/Kathmandu (+05:45 → 03:15Z). So 15 stays here — narrowing
 * it to 30 would not fix the snap (in a :45 zone a 30-minute step offers only
 * half the legal values, and it is the :00/:30 values that get snapped) and it
 * would remove a granularity a consultant may legitimately want to type in. The
 * grid is enforced where it is a fact about the instant: at save, by
 * `snapInstantsToSchedulingGrid`.
 */
export const TIME_INCREMENT_MINUTES = VALIDATION_CONFIG.TIME_INCREMENT_MINUTES;

/** The same step for a native `<input type="time" step>`, which counts seconds. */
export const PICKER_STEP_SECONDS = TIME_INCREMENT_MINUTES * 60;

// Helper function to convert HH:MM to minutes
const getMinutes = (time: string): number | null => {
  if (!time || typeof time !== "string") return null;
  const [hours, minutes] = time.split(":").map(Number);
  return !Number.isNaN(hours) &&
    !Number.isNaN(minutes) &&
    hours >= 0 &&
    hours < 24 &&
    minutes >= 0 &&
    minutes < 60
    ? hours * 60 + minutes
    : null;
};

// Helper to check if a slot spans midnight — #503 item 2, canonical rule
const isOvernightSlot = (startMinutes: number, endMinutes: number): boolean =>
  resolveOvernightStatus({ startTimeUtc: startMinutes, endTimeUtc: endMinutes })
    .isOvernight;

// Calculate slot duration handling overnight slots
const calculateSlotDuration = (
  startMinutes: number,
  endMinutes: number,
): number => {
  return isOvernightSlot(startMinutes, endMinutes)
    ? 24 * 60 - startMinutes + endMinutes
    : endMinutes - startMinutes;
};

/**
 * Validates that a time range meets basic requirements:
 * non-empty, distinct start/end, and duration within 30 min – 12 hour bounds.
 * Overnight slots (end < start) are allowed; duration is calculated across midnight.
 */
export const isValidTimeRange = (
  startTime: string,
  endTime: string,
): boolean => {
  if (!startTime || !endTime) return false;

  const startMinutes = getMinutes(startTime);
  const endMinutes = getMinutes(endTime);

  if (startMinutes === null || endMinutes === null) {
    return false;
  }

  // Check if same start and end time are invalid
  if (startMinutes === endMinutes) {
    return false;
  }

  const duration = calculateSlotDuration(startMinutes, endMinutes);

  // Validate duration constraints
  return (
    duration >= VALIDATION_CONFIG.MIN_DURATION_MINUTES &&
    duration <= VALIDATION_CONFIG.MAX_DURATION_MINUTES
  );
};

/**
 * Whether a typed value is shaped like something a consultant may pick, and
 * whether the session is a whole number of 30-minute atoms.
 *
 * Deliberately NOT a bookability check. The booking grid is a property of the
 * UTC INSTANT, and whether a 15-minute-multiple wall clock lands on it depends
 * on the consultant's offset — 10:15 in Asia/Kolkata is 04:45Z, off the grid,
 * and this function cannot know that without a zone. Rejecting every value
 * this one cannot vouch for would reject the consultant's round hours too (the
 * function has no zone, so it has no way to tell 09:00 IST from 09:00 NPT), and
 * accepting them silently is what the save path's snap now handles. So the
 * message says what this actually is: a shape rule for typed input.
 */
const validateTimeIncrements = (
  startMinutes: number,
  endMinutes: number,
): string | null => {
  if (
    startMinutes % VALIDATION_CONFIG.TIME_INCREMENT_MINUTES !== 0 ||
    endMinutes % VALIDATION_CONFIG.TIME_INCREMENT_MINUTES !== 0
  ) {
    return `Times must be in multiples of ${VALIDATION_CONFIG.TIME_INCREMENT_MINUTES} minutes`;
  }

  const duration = calculateSlotDuration(startMinutes, endMinutes);
  if (duration % VALIDATION_CONFIG.SESSION_INCREMENT_MINUTES !== 0) {
    return `Session duration must be in multiples of ${VALIDATION_CONFIG.SESSION_INCREMENT_MINUTES} minutes`;
  }

  return null;
};

// Check if duration meets requirements
const validateDuration = (
  startMinutes: number,
  endMinutes: number,
): string | null => {
  const duration = calculateSlotDuration(startMinutes, endMinutes);

  if (duration < VALIDATION_CONFIG.MIN_DURATION_MINUTES) {
    return `Session must be at least ${VALIDATION_CONFIG.MIN_DURATION_MINUTES} minutes long`;
  }

  if (duration > VALIDATION_CONFIG.MAX_DURATION_MINUTES) {
    return `Session cannot exceed ${VALIDATION_CONFIG.MAX_DURATION_MINUTES / 60} hours`;
  }

  return null;
};

// Check for overlaps between two time slots (back-to-back allowed, true overlaps rejected)
const checkSlotOverlap = (
  slot1Start: number,
  slot1End: number,
  slot2Start: number,
  slot2End: number,
): boolean => {
  const slot1IsOvernight = isOvernightSlot(slot1Start, slot1End);
  const slot2IsOvernight = isOvernightSlot(slot2Start, slot2End);

  // Convert overnight slots to ranges that can be compared
  const slot1Ranges = slot1IsOvernight
    ? [
        [slot1Start, 24 * 60],
        [0, slot1End],
      ]
    : [[slot1Start, slot1End]];

  const slot2Ranges = slot2IsOvernight
    ? [
        [slot2Start, 24 * 60],
        [0, slot2End],
      ]
    : [[slot2Start, slot2End]];

  // Check if any ranges truly overlap (back-to-back is allowed: end1 === start2)
  for (const [start1, end1] of slot1Ranges) {
    for (const [start2, end2] of slot2Ranges) {
      // Overlap exists if: start1 < end2 AND start2 < end1
      // Back-to-back (end1 === start2) is NOT an overlap
      if (start1 < end2 && start2 < end1) {
        return true;
      }
    }
  }

  return false;
};

// Validate slot against other slots for overlaps
const validateSlotOverlaps = (
  slot: SlotType,
  otherSlots: SlotType[],
): string | null => {
  const startMinutes = getMinutes(slot.startTime);
  const endMinutes = getMinutes(slot.endTime);

  if (startMinutes === null || endMinutes === null) {
    return "Invalid time format";
  }

  // Only check against valid slots
  const validSlots = otherSlots.filter(
    (s) => s.isValid && s.startTime && s.endTime,
  );

  for (const otherSlot of validSlots) {
    const otherStart = getMinutes(otherSlot.startTime);
    const otherEnd = getMinutes(otherSlot.endTime);

    if (otherStart === null || otherEnd === null) continue;

    if (checkSlotOverlap(startMinutes, endMinutes, otherStart, otherEnd)) {
      return "Slots cannot overlap";
    }
  }

  return null;
};

/**
 * Validates a single time slot against all rules (format, duration, increments,
 * overnight, overlap) and returns an updated SlotType with isValid/errorMessage set.
 * Pure function with no side effects. Back-to-back slots are allowed.
 *
 * @param slot - The slot to validate
 * @param otherSlots - Existing slots to check for overlaps against
 */
export const validateTimeSlot = (
  slot: SlotType,
  otherSlots: SlotType[],
): SlotType => {
  // Early return for empty slots
  if (!slot.startTime || !slot.endTime) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "Please select both start and end time",
    };
  }

  const startMinutes = getMinutes(slot.startTime);
  const endMinutes = getMinutes(slot.endTime);

  if (startMinutes === null || endMinutes === null) {
    return { ...slot, isValid: false, errorMessage: "Invalid time format" };
  }

  // Start and end cannot be the same
  if (startMinutes === endMinutes) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "Start and end time cannot be the same",
    };
  }

  // Validate basic time range (duration constraints etc.)
  if (!isValidTimeRange(slot.startTime, slot.endTime)) {
    return { ...slot, isValid: false, errorMessage: "Invalid time range" };
  }

  // Validate time increments
  const incrementError = validateTimeIncrements(startMinutes, endMinutes);
  if (incrementError) {
    return { ...slot, isValid: false, errorMessage: incrementError };
  }

  // Validate duration
  const durationError = validateDuration(startMinutes, endMinutes);
  if (durationError) {
    return { ...slot, isValid: false, errorMessage: durationError };
  }

  // Check for overlaps
  const overlapError = validateSlotOverlaps(slot, otherSlots);
  if (overlapError) {
    return { ...slot, isValid: false, errorMessage: overlapError };
  }

  return { ...slot, isValid: true, errorMessage: undefined };
};

/**
 * Validates all slots across all days/dates, collecting per-slot error messages.
 * Returns overall validity and a list of human-readable error strings.
 */
export const validateAllSlotsDetailed = (
  slots: Record<string, SlotType[]>,
): { isValid: boolean; errors: string[] } => {
  const errors: string[] = [];
  let isValid = true;

  Object.entries(slots).forEach(([day, daySlots]) => {
    daySlots.forEach((slot, index) => {
      if (!slot.isValid) {
        const errorMsg =
          slot.errorMessage ?? "Please complete both start and end time";
        errors.push(`${day} slot ${index + 1}: ${errorMsg}`);
        isValid = false;
      }
    });
  });

  return { isValid, errors };
};

/**
 * Computes aggregate statistics for a set of slots: total/valid/invalid counts,
 * overnight count, total duration in hours, and average duration in minutes.
 */
export const getSlotStatistics = (slots: Record<string, SlotType[]>) => {
  let totalSlots = 0;
  let validSlots = 0;
  let overnightSlots = 0;
  let totalDuration = 0;

  Object.values(slots).forEach((daySlots) => {
    daySlots.forEach((slot) => {
      totalSlots++;
      if (slot.isValid) {
        validSlots++;
        const start = getMinutes(slot.startTime);
        const end = getMinutes(slot.endTime);
        if (start !== null && end !== null) {
          if (isOvernightSlot(start, end)) {
            overnightSlots++;
          }
          totalDuration += calculateSlotDuration(start, end);
        }
      }
    });
  });

  return {
    totalSlots,
    validSlots,
    invalidSlots: totalSlots - validSlots,
    overnightSlots,
    totalDurationHours: Math.round((totalDuration / 60) * 100) / 100,
    averageDurationMinutes:
      validSlots > 0 ? Math.round(totalDuration / validSlots) : 0,
  };
};
