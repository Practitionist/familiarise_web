/** A single time slot with start/end times in HH:MM format and validation state. */
export interface SlotType {
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
  isValid: boolean;
  errorMessage?: string;
}

/** Map of day/date keys to arrays of time slots (e.g., { "monday": [...], "2024-01-15": [...] }). */
export type SlotsType = Record<string, SlotType[]>;

/** Aggregated validation and statistics feedback for a set of slots. */
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
