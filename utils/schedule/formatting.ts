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
import { resolveOvernightStatus } from "@/utils/schedule/overnight";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import { DayOfWeek } from "@prisma/client";
import type { CustomSlot, SlotsType, WeeklySlot } from "./types";

/**
 * API format for weekly slots (dashboard → PUT /api/user/consultants/[id])
 */
export interface WeeklySlotApiFormat {
  dayOfWeekforStartTimeInUTC: string;
  dayOfWeekforEndTimeInUTC: string;
  startsAt: string;
  endsAt: string;
}

/**
 * API format for custom (date-specific) slots
 */
export interface CustomSlotApiFormat {
  startsAt: string;
  endsAt: string;
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
 * Shift a day of the week by an offset (positive or negative).
 */
const shiftDayOfWeek = (dayOfWeek: string, offset: number): string => {
  const days = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ];
  const idx = days.indexOf(dayOfWeek);
  return days[(((idx + offset) % 7) + 7) % 7];
};

/**
 * Formats slots for API submission (dashboard save path).
 * Converts local times to UTC and handles overnight slot detection.
 * Overnight slots produce a single record with startDay !== endDay.
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
          // flatMap because formatWeeklySlot returns an array (may be empty on error)
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
                console.error("Error formatting custom slot for API:", error, {
                  key,
                  slot,
                });
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
 * Overnight slots produce a single record with startDay !== endDay.
 *
 * Handles timezone edge cases where a slot that is overnight in local time
 * may be same-day in UTC (e.g., IST 23:00→02:00 = UTC 17:30→20:30),
 * and vice versa.
 */
function formatWeeklySlot(
  slot: { startTime: string; endTime: string; isOvernightUTC?: boolean },
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
  // #503 item 2 — canonical resolver replaces the inline OR of two rules.
  const { isOvernight: overnight } = resolveOvernightStatus({
    startTime: slot.startTime,
    endTime: slot.endTime,
    isOvernightUTC: slot.isOvernightUTC,
  });

  const startUTC = convertTimezoneToUtc(slot.startTime, baseDate, timezone);
  if (!startUTC) return [];

  const endUTC = overnight
    ? slot.endTime === "00:00"
      ? convertTimezoneToUtc("00:00", nextDate, timezone)
      : convertTimezoneToUtc(slot.endTime, nextDate, timezone)
    : convertTimezoneToUtc(slot.endTime, baseDate, timezone);
  if (!endUTC) return [];

  // Extract UTC minutes — these are always correct regardless of epoch dates
  const startMin = dateToMinuteUtc(new Date(startUTC));
  const endMin = dateToMinuteUtc(new Date(endUTC));

  // Determine the actual UTC start day.
  // For isOvernightUTC slots the day key IS the DB's UTC startDay — use it directly.
  // For other slots, compute day offset from the timezone conversion.
  let actualStartDay: string;
  if (slot.isOvernightUTC) {
    actualStartDay = dayOfWeek;
  } else {
    const baseDateMs = new Date(baseDate + "T00:00:00Z").getTime();
    const startDayOffset = Math.floor(
      (new Date(startUTC).getTime() - baseDateMs) / 86400000,
    );
    actualStartDay = shiftDayOfWeek(dayOfWeek, startDayOffset);
  }

  // Determine if actually overnight in UTC from the minutes
  const isOvernightInUtc = resolveOvernightStatus({
    startTimeUtc: startMin,
    endTimeUtc: endMin,
  }).isOvernight;

  if (isOvernightInUtc) {
    return [
      {
        dayOfWeekforStartTimeInUTC: actualStartDay,
        dayOfWeekforEndTimeInUTC: getNextDayOfWeek(actualStartDay),
        startsAt: startUTC,
        endsAt: endUTC,
      },
    ];
  }

  return [
    {
      dayOfWeekforStartTimeInUTC: actualStartDay,
      dayOfWeekforEndTimeInUTC: actualStartDay,
      startsAt: startUTC,
      endsAt: endUTC,
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
    startsAt: startTimeUtc,
    endsAt: endTimeUtc,
  };
}

/**
 * Converts a SlotsType map (local HH:MM) into WeeklySlot records (UTC minutes, 0–1439)
 * ready for the onboarding server action.
 *
 * Overnight slots produce a single record with startDay !== endDay.
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
        const startUTC = convertTimezoneToUtc(
          slot.startTime,
          baseDate,
          timezone,
        );
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
          const endDay = getNextDayOfWeek(startDay) as DayOfWeek;
          // Single overnight record with startDay !== endDay
          return [
            {
              startDay,
              endDay,
              startTimeUtc: startMinutes,
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
 * Overnight slots produce a single record where endsAt is on the next calendar day.
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
        const startUTC = convertTimezoneToUtc(
          slot.startTime,
          dateString,
          timezone,
        );
        const endUTC = convertTimezoneToUtc(
          slot.endTime,
          overnight ? nextDateStr : dateString,
          timezone,
        );
        if (!startUTC || !endUTC) return [];

        // Both overnight and same-day: single record
        return [{ startsAt: startUTC, endsAt: endUTC }];
      });
  });
}
