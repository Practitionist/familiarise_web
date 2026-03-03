/**
 * Shared API formatting utilities for schedule slots
 * Single source of truth for converting local slots to API format
 */

import {
  convertTimezoneToUtc,
  convertTimezoneToUtcWithOvernight,
  getLocalDateString,
  isOvernight,
  sortSlotsByTime,
} from "@/utils/dateTimeUtils";
import { dateToMinuteUtc } from "@/utils/slotAllocation/slotTimeUtils";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import { DayOfWeek } from "@prisma/client";
import type { CustomSlot, SlotsType, WeeklySlot } from "./types";

/**
 * API format for weekly slots (dashboard → PUT /api/user/consultants/[id])
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
 * Formats slots for API submission (dashboard save path).
 * Converts local times to UTC and handles overnight slot detection.
 * Weekly overnight slots are split into two records (one per UTC day).
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

        const validSlots = sortedSlots.filter((slot) => {
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
        });

        if (isWeekly) {
          // flatMap because formatWeeklySlot may return 2 records for overnight slots
          return validSlots.flatMap((slot) => {
            try {
              return formatWeeklySlot(slot, key, timezone);
            } catch (error) {
              console.error("Error formatting weekly slot for API:", error, {
                key,
                slot,
              });
              return [];
            }
          });
        } else {
          return validSlots
            .map((slot) => {
              try {
                return formatCustomSlot(slot, key, timezone);
              } catch (error) {
                console.error(
                  "Error formatting custom slot for API:",
                  error,
                  { key, slot },
                );
                return null;
              }
            })
            .filter(Boolean) as CustomSlotApiFormat[];
        }
      });
  } catch (error) {
    console.error("Error in formatSlotsForApi:", error, { slots, isWeekly });
    return [];
  }
}

/**
 * Formats a single weekly slot for API submission.
 * Overnight slots (crossing local midnight) are split into two records so that
 * every record has startTimeUtc <= endTimeUtc (monotonic, no cross-midnight singles).
 */
function formatWeeklySlot(
  slot: { startTime: string; endTime: string },
  dayKey: string,
  timezone: string,
): WeeklySlotApiFormat[] {
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

  const baseDate = "1970-01-01";
  const nextDate = "1970-01-02";
  const overnight = isOvernight(slot.startTime, slot.endTime);

  const startUTC = convertTimezoneToUtc(slot.startTime, baseDate, timezone);
  if (!startUTC) return [];

  if (overnight) {
    // "00:00" end = "until end of day" → single record ending at 23:59 local time
    if (slot.endTime === "00:00") {
      const justBeforeMidnightUTC = convertTimezoneToUtc(
        "23:59",
        baseDate,
        timezone,
      );
      if (!justBeforeMidnightUTC) return [];
      return [
        {
          dayOfWeekforStartTimeInUTC: dayOfWeek,
          dayOfWeekforEndTimeInUTC: dayOfWeek,
          slotStartTimeInUTC: startUTC,
          slotEndTimeInUTC: justBeforeMidnightUTC,
        },
      ];
    }

    // General overnight: split at local midnight → two records
    const midnightUTC = convertTimezoneToUtc("00:00", nextDate, timezone);
    const endUTC = convertTimezoneToUtc(slot.endTime, nextDate, timezone);
    if (!midnightUTC || !endUTC) return [];

    // One minute before local midnight
    const justBeforeMidnightUTC = new Date(
      new Date(midnightUTC).getTime() - 60_000,
    ).toISOString();
    const nextDay = getNextDayOfWeek(dayOfWeek);

    return [
      {
        dayOfWeekforStartTimeInUTC: dayOfWeek,
        dayOfWeekforEndTimeInUTC: dayOfWeek,
        slotStartTimeInUTC: startUTC,
        slotEndTimeInUTC: justBeforeMidnightUTC,
      },
      {
        dayOfWeekforStartTimeInUTC: nextDay,
        dayOfWeekforEndTimeInUTC: nextDay,
        slotStartTimeInUTC: midnightUTC,
        slotEndTimeInUTC: endUTC,
      },
    ];
  }

  const endUTC = convertTimezoneToUtc(slot.endTime, baseDate, timezone);
  if (!endUTC) return [];

  return [
    {
      dayOfWeekforStartTimeInUTC: dayOfWeek,
      dayOfWeekforEndTimeInUTC: dayOfWeek,
      slotStartTimeInUTC: startUTC,
      slotEndTimeInUTC: endUTC,
    },
  ];
}

/**
 * Formats a single custom (date-specific) slot for API submission.
 * Overnight handling delegates to convertTimezoneToUtcWithOvernight.
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

/**
 * Converts a SlotsType map (local HH:MM) into WeeklySlot records (UTC minutes, 0–1439)
 * ready for the onboarding server action.
 *
 * Overnight slots are split into two monotonic records (one per UTC-local day).
 * Every resulting record satisfies startTimeUtc <= endTimeUtc.
 */
export function buildWeeklySlotsForSave(
  slots: SlotsType,
  timezone: string,
): WeeklySlot[] {
  const baseDate = "1970-01-01";
  const nextDate = "1970-01-02";

  return Object.entries(slots).flatMap(([day, daySlots]) => {
    return sortSlotsByTime(daySlots)
      .filter((s) => s.startTime && s.endTime && s.isValid)
      .flatMap((slot): WeeklySlot[] => {
        const overnight = isOvernight(slot.startTime, slot.endTime);
        const startUTC = convertTimezoneToUtc(slot.startTime, baseDate, timezone);
        const endUTC = convertTimezoneToUtc(
          slot.endTime,
          overnight ? nextDate : baseDate,
          timezone,
        );
        if (!startUTC || !endUTC) return [];

        const startMinutes = dateToMinuteUtc(new Date(startUTC));
        const endMinutes = dateToMinuteUtc(new Date(endUTC));
        const startDay = day.toUpperCase() as DayOfWeek;

        if (overnight) {
          // "00:00" end = "until end of day" → single record ending at minute 1439
          if (slot.endTime === "00:00") {
            return [
              {
                startDay,
                endDay: startDay,
                startTimeUtc: startMinutes,
                endTimeUtc: 1439,
              },
            ];
          }

          // General overnight: split at local midnight
          const midnightUTC = convertTimezoneToUtc("00:00", nextDate, timezone);
          if (!midnightUTC) return [];
          const midnightMinutes = dateToMinuteUtc(new Date(midnightUTC));
          // One minute before local midnight in UTC minutes.
          // (midnightMinutes + 1439) % 1440 handles UTC (0 → 1439) correctly.
          const justBefore = (midnightMinutes + 1439) % 1440;
          const endDay = getNextDayOfWeek(startDay) as DayOfWeek;

          return [
            {
              startDay,
              endDay: startDay,
              startTimeUtc: startMinutes,
              endTimeUtc: justBefore,
            },
            {
              startDay: endDay,
              endDay,
              startTimeUtc: midnightMinutes,
              endTimeUtc: endMinutes,
            },
          ];
        }

        return [
          {
            startDay,
            endDay: startDay,
            startTimeUtc: startMinutes,
            endTimeUtc: endMinutes,
          },
        ];
      });
  });
}

/**
 * Converts a SlotsType map (local HH:MM, keyed by YYYY-MM-DD) into CustomSlot
 * records (ISO strings) ready for the onboarding server action.
 *
 * Overnight slots are split into two records (before/after local midnight).
 */
export function buildCustomSlotsForSave(
  slots: SlotsType,
  timezone: string,
): CustomSlot[] {
  return Object.entries(slots).flatMap(([dateString, daySlots]) => {
    const nextDateObj = new Date(dateString);
    nextDateObj.setDate(nextDateObj.getDate() + 1);
    const nextDateStr = getLocalDateString(nextDateObj);

    return sortSlotsByTime(daySlots)
      .filter((s) => s.startTime && s.endTime && s.isValid)
      .flatMap((slot): CustomSlot[] => {
        const overnight = isOvernight(slot.startTime, slot.endTime);
        const startUTC = convertTimezoneToUtc(slot.startTime, dateString, timezone);
        const endUTC = convertTimezoneToUtc(
          slot.endTime,
          overnight ? nextDateStr : dateString,
          timezone,
        );
        if (!startUTC || !endUTC) return [];

        if (overnight) {
          // "00:00" end = "until end of day" → single record (endUTC is midnight next day)
          if (slot.endTime === "00:00") {
            return [{ startsAt: startUTC, endsAt: endUTC }];
          }

          // General overnight: split at local midnight
          const midnightUTC = convertTimezoneToUtc(
            "00:00",
            nextDateStr,
            timezone,
          );
          if (!midnightUTC) return [];
          // One minute before local midnight
          const justBeforeMidnight = new Date(
            new Date(midnightUTC).getTime() - 60_000,
          ).toISOString();

          return [
            { startsAt: startUTC, endsAt: justBeforeMidnight },
            { startsAt: midnightUTC, endsAt: endUTC },
          ];
        }

        return [{ startsAt: startUTC, endsAt: endUTC }];
      });
  });
}
