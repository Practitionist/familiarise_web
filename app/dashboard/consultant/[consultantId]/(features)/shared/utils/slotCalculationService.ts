/**
 * Centralized service for all slot-related calculations
 * This ensures consistency across the application
 */

/**
 * Converts duration in hours to number of 30-minute slots
 */
export function hoursToSlots(durationInHours: number): number {
  if (durationInHours <= 0) {
    throw new Error("Duration must be positive");
  }
  return Math.ceil(durationInHours / 0.5);
}

/**
 * Converts number of slots to duration in hours
 */
export function slotsToHours(slots: number): number {
  if (slots <= 0) {
    throw new Error("Slots must be positive");
  }
  return slots * 0.5;
}

/**
 * Formats duration for display
 */
export function formatDuration(durationInHours: number): string {
  if (durationInHours === 1) {
    return "1 hour";
  } else if (durationInHours < 1) {
    const minutes = durationInHours * 60;
    return `${minutes} minutes`;
  } else {
    return `${durationInHours} hours`;
  }
}

/**
 * Formats slot count for display
 */
export function formatSlotCount(slots: number): string {
  if (slots === 1) {
    return "1 slot";
  } else {
    return `${slots} slots`;
  }
}

/**
 * Formats consecutive slot requirement for display
 */
export function formatConsecutiveSlots(durationInHours: number): string {
  const slots = hoursToSlots(durationInHours);
  const duration = formatDuration(durationInHours);
  const slotText = formatSlotCount(slots);
  
  return `${duration} (${slotText} consecutive)`;
}

/**
 * Service class for slot calculations
 */
export class SlotCalculationService {
  /**
   * Standard 30-minute interval in hours
   */
  static readonly SLOT_INTERVAL_HOURS = 0.5;

  /**
   * Convert hours to slots using consistent logic
   */
  static hoursToSlots(durationInHours: number): number {
    return hoursToSlots(durationInHours);
  }

  /**
   * Convert slots to hours using consistent logic
   */
  static slotsToHours(slots: number): number {
    return slotsToHours(slots);
  }

  /**
   * Format duration for user display
   */
  static formatDuration(durationInHours: number): string {
    return formatDuration(durationInHours);
  }

  /**
   * Format slot count for user display
   */
  static formatSlotCount(slots: number): string {
    return formatSlotCount(slots);
  }

  /**
   * Format consecutive slot requirement message
   */
  static formatConsecutiveSlots(durationInHours: number): string {
    return formatConsecutiveSlots(durationInHours);
  }
}