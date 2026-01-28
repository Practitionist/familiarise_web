/**
 * Unified type definitions for schedule/slot validation
 * Single source of truth - import from here instead of defining locally
 */

/**
 * Represents a single time slot with validation state
 */
export interface SlotType {
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
  isValid: boolean;
  errorMessage?: string;
}

/**
 * A record of slots keyed by day (for weekly) or date string (for custom)
 * - Weekly: keys are lowercase day names ("monday", "tuesday", etc.)
 * - Custom: keys are date strings in YYYY-MM-DD format
 */
export type SlotsType = Record<string, SlotType[]>;

/**
 * Detailed validation feedback for a set of slots
 */
export interface ValidationFeedback {
  isValid: boolean;
  errors: string[];
  validSlots: number;
  totalSlots: number;
  invalidSlots: number;
  overnightSlots: number;
  totalDurationHours: number;
  hasSlots: boolean;
}

/**
 * Result of validating a single time slot
 */
export interface ValidationResult {
  slot: SlotType;
  needsSplitting?: {
    currentDaySlot: SlotType;
    nextDaySlot: SlotType;
    nextKey: string;
  };
}

/**
 * Schedule type enum matching Prisma schema
 */
export type ScheduleTypeValue = "WEEKLY" | "CUSTOM";
