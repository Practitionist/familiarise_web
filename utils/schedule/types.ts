/** A single time slot with start/end times in HH:MM format and validation state. */
export interface SlotType {
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
  isValid: boolean;
  errorMessage?: string;
}

/** Map of day/date keys to arrays of time slots (e.g., { "monday": [...], "2024-01-15": [...] }). */
export type SlotsType = Record<string, SlotType[]>;

import { DayOfWeek } from "@prisma/client";

/** Weekly slot in UTC-minute format — consumed by the onboarding server action. */
export interface WeeklySlot {
  startDay: DayOfWeek;
  endDay: DayOfWeek;
  startTimeUtc: number; // 0–1439; always <= endTimeUtc (no cross-midnight single records)
  endTimeUtc: number;
}

/** Custom (date-specific) slot as ISO strings — consumed by the onboarding server action. */
export interface CustomSlot {
  startsAt: string; // ISO 8601
  endsAt: string;   // ISO 8601
}

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
