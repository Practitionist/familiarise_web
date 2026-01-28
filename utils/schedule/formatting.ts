/**
 * Shared API formatting utilities for schedule slots
 * Single source of truth for converting local slots to API format
 */

import {
  convertTimezoneToUtcWithOvernight,
  isOvernight,
  sortSlotsByTime,
} from "@/utils/dateTimeUtils";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import type { SlotsType } from "./types";

/**
 * API format for weekly slots
 */
export interface WeeklySlotApiFormat {
  dayOfWeekforStartTimeInUTC: string;
  dayOfWeekforEndTimeInUTC: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}

/**
 * API format for custom (date-specific) slots
 */
export interface CustomSlotApiFormat {
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}

/**
 * Helper function to get the next day of the week
 */
const getNextDayOfWeek = (dayOfWeek: string): string => {
  const days = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ];
  const currentIndex = days.indexOf(dayOfWeek);
  return days[(currentIndex + 1) % days.length];
};

/**
 * Formats slots for API submission.
 * Converts local times to UTC and handles overnight slot detection.
 *
 * @param slots - The slots to format (keyed by day or date)
 * @param isWeekly - Whether these are weekly recurring slots
 * @param timezone - The user's timezone (e.g., "America/New_York")
 * @returns Array of formatted slots ready for API submission
 */
export function formatSlotsForApi(
  slots: SlotsType,
  isWeekly: boolean,
  timezone: string = "UTC",
): (WeeklySlotApiFormat | CustomSlotApiFormat)[] {
  try {
    return Object.entries(slots)
      .filter(([key, daySlots]) => {
        // Ensure we have valid key and slots array
        return key && Array.isArray(daySlots) && daySlots.length > 0;
      })
      .flatMap(([key, daySlots]) => {
        // Sort slots chronologically before processing
        const sortedSlots = sortSlotsByTime(daySlots);

        return sortedSlots
          .filter((slot) => {
            // Comprehensive slot validation
            return (
              slot &&
              typeof slot === "object" &&
              slot.isValid === true &&
              slot.startTime &&
              slot.endTime &&
              typeof slot.startTime === "string" &&
              typeof slot.endTime === "string" &&
              isValidTimeRange(slot.startTime, slot.endTime)
            );
          })
          .map((slot) => {
            try {
              if (isWeekly) {
                return formatWeeklySlot(slot, key, timezone);
              } else {
                return formatCustomSlot(slot, key, timezone);
              }
            } catch (error) {
              console.error("Error formatting slot for API:", error, {
                key,
                slot,
              });
              return null;
            }
          })
          .filter(Boolean) as (WeeklySlotApiFormat | CustomSlotApiFormat)[];
      });
  } catch (error) {
    console.error("Error in formatSlotsForApi:", error, { slots, isWeekly });
    return [];
  }
}

/**
 * Formats a single weekly slot for API submission
 */
function formatWeeklySlot(
  slot: { startTime: string; endTime: string },
  dayKey: string,
  timezone: string,
): WeeklySlotApiFormat | null {
  const dayOfWeek = dayKey.toUpperCase();
  const validDays = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ];

  if (!validDays.includes(dayOfWeek)) {
    throw new Error(`Invalid day of week: ${dayOfWeek}`);
  }

  // Use a reference date for weekly slots
  const baseDate = "1970-01-01";

  const startTimeUtc = convertTimezoneToUtcWithOvernight(
    slot.startTime,
    baseDate,
    timezone,
    false, // isEndTime
  );

  const endTimeUtc = convertTimezoneToUtcWithOvernight(
    slot.endTime,
    baseDate,
    timezone,
    true, // isEndTime
    slot.startTime, // startTimeStr for overnight detection
  );

  // If conversion failed, return null to filter out this slot
  if (!startTimeUtc || !endTimeUtc) {
    return null;
  }

  const endDayOfWeek = isOvernight(slot.startTime, slot.endTime)
    ? getNextDayOfWeek(dayOfWeek)
    : dayOfWeek;

  return {
    dayOfWeekforStartTimeInUTC: dayOfWeek,
    dayOfWeekforEndTimeInUTC: endDayOfWeek,
    slotStartTimeInUTC: startTimeUtc,
    slotEndTimeInUTC: endTimeUtc,
  };
}

/**
 * Formats a single custom (date-specific) slot for API submission
 */
function formatCustomSlot(
  slot: { startTime: string; endTime: string },
  dateKey: string,
  timezone: string,
): CustomSlotApiFormat | null {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateKey)) {
    throw new Error(`Invalid date format: ${dateKey}`);
  }

  const startTimeUtc = convertTimezoneToUtcWithOvernight(
    slot.startTime,
    dateKey,
    timezone,
    false, // isEndTime
  );

  const endTimeUtc = convertTimezoneToUtcWithOvernight(
    slot.endTime,
    dateKey,
    timezone,
    true, // isEndTime
    slot.startTime, // startTimeStr for overnight detection
  );

  // If conversion failed, return null to filter out this slot
  if (!startTimeUtc || !endTimeUtc) {
    return null;
  }

  return {
    slotStartTimeInUTC: startTimeUtc,
    slotEndTimeInUTC: endTimeUtc,
  };
}
