import { TConsultantProfile } from "@/types/consultant";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import {
  getLocalDateString,
  convertToLocalTime,
  convertUtcToTimezone,
  extractTimeFromUtcSlot,
  convertTimezoneToUtc,
  sortSlotsByTime,
} from "@/utils/dateTimeUtils";
import { toZonedTime } from "date-fns-tz";
import { DayOfWeek, ScheduleType } from "@prisma/client";
export interface SlotType {
  startTime: string;
  endTime: string;
  isValid: boolean;
  errorMessage?: string;
}

export type SlotsType = Record<string, SlotType[]>;

export interface FormData {
  description: string;
  qualifications: string;
  specialization: string;
  experience: number;
  scheduleType: ScheduleType;
  domainId: string;
  subDomainIds: string[];
  tagIds: string[];
}

export interface Domain {
  id: string;
  name: string;
}

export interface SubDomain {
  id: string;
  name: string;
  domainId: string;
}

export interface Tag {
  id: string;
  name: string;
  domainId: string;
}

export const DAYS_OF_WEEK: DayOfWeek[] = [
  DayOfWeek.MONDAY,
  DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY,
  DayOfWeek.THURSDAY,
  DayOfWeek.FRIDAY,
  DayOfWeek.SATURDAY,
  DayOfWeek.SUNDAY,
];

// formatDayDisplay is now imported from timeUtils

// formatTimeFromDate removed - using convertToLocalTime from timeUtils

export const getInitialFormData = (
  consultant: TConsultantProfile,
): FormData => ({
  description: consultant?.description ?? "",
  qualifications: consultant?.qualifications ?? "",
  specialization: consultant?.specialization ?? "",
  experience: consultant?.experience ?? 0,
  scheduleType: consultant?.scheduleType ?? ScheduleType.WEEKLY,
  domainId: consultant?.domain?.id ?? "",
  subDomainIds: consultant?.subDomains?.map((sd) => sd.id) ?? [],
  tagIds: consultant?.tags?.map((t) => t.id) ?? [],
});

export const getInitialWeeklySlots = (
  consultant: TConsultantProfile,
  timezone: string = "UTC",
): SlotsType => {
  if (!consultant?.slotsOfAvailabilityWeekly?.length) return {};

  const formattedWeeklySlots: SlotsType = {};
  try {
    consultant.slotsOfAvailabilityWeekly.forEach((slot) => {
      try {
        if (!slot || !slot.slotStartTimeInUTC || !slot.slotEndTimeInUTC) {
          console.warn("Invalid weekly slot data:", slot);
          return;
        }

        // Use the day-of-week stored in the database. This is the consultant's
        // intended day for the recurring slot. The time will be converted,
        // but the day grouping should remain consistent with the original setting.
        const day = (slot.dayOfWeekforStartTimeInUTC as string).toLowerCase();

        // Use timezone-aware time extraction so displayed times stay correct
        const startTime = extractTimeFromUtcSlot(
          slot.slotStartTimeInUTC.toString(),
          timezone,
        );
        const endTime = extractTimeFromUtcSlot(
          slot.slotEndTimeInUTC.toString(),
          timezone,
        );

        // Only add valid slots with proper error handling
        if (isValidTimeRange(startTime, endTime)) {
          if (!formattedWeeklySlots[day]) {
            formattedWeeklySlots[day] = [];
          }
          formattedWeeklySlots[day].push({
            startTime,
            endTime,
            isValid: true,
          });
        } else {
          console.warn("Invalid time range for weekly slot:", {
            day,
            startTime,
            endTime,
          });
        }
      } catch (error) {
        console.error("Error processing weekly slot:", error, slot);
      }
    });
  } catch (error) {
    console.error("Error in getInitialWeeklySlots:", error);
  }

  // Sort slots chronologically within each day
  Object.keys(formattedWeeklySlots).forEach((day) => {
    formattedWeeklySlots[day] = sortSlotsByTime(formattedWeeklySlots[day]);
  });

  return formattedWeeklySlots;
};

export const getInitialCustomSlots = (
  consultant: TConsultantProfile,
  timezone: string = "UTC",
): SlotsType => {
  if (!consultant?.slotsOfAvailabilityCustom?.length) return {};

  const formattedCustomSlots: SlotsType = {};
  try {
    consultant.slotsOfAvailabilityCustom.forEach((slot) => {
      try {
        if (!slot || !slot.slotStartTimeInUTC || !slot.slotEndTimeInUTC) {
          console.warn("Invalid custom slot data:", slot);
          return;
        }

        const startDate = new Date(slot.slotStartTimeInUTC);
        const endDate = new Date(slot.slotEndTimeInUTC);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          console.warn(
            "Invalid date in custom slot:",
            slot.slotStartTimeInUTC,
            slot.slotEndTimeInUTC,
          );
          return;
        }

        // For custom slots, use timezone-aware conversion
        // Get the date in the specified timezone
        const dateString = startDate.toLocaleDateString("en-CA", {
          timeZone: timezone,
        }); // en-CA gives YYYY-MM-DD format

        const startTime = convertUtcToTimezone(
          slot.slotStartTimeInUTC.toString(),
          timezone,
        );
        const endTime = convertUtcToTimezone(
          slot.slotEndTimeInUTC.toString(),
          timezone,
        );

        // Only add valid slots with proper error handling
        if (isValidTimeRange(startTime, endTime)) {
          if (!formattedCustomSlots[dateString]) {
            formattedCustomSlots[dateString] = [];
          }
          formattedCustomSlots[dateString].push({
            startTime,
            endTime,
            isValid: true,
          });
        } else {
          console.warn("Invalid time range for custom slot:", {
            dateString,
            startTime,
            endTime,
          });
        }
      } catch (error) {
        console.error("Error processing custom slot:", error, slot);
      }
    });
  } catch (error) {
    console.error("Error in getInitialCustomSlots:", error);
  }

  // Sort slots chronologically within each date
  Object.keys(formattedCustomSlots).forEach((dateString) => {
    formattedCustomSlots[dateString] = sortSlotsByTime(
      formattedCustomSlots[dateString],
    );
  });

  return formattedCustomSlots;
};

export const formatSlotsForApi = (
  slots: SlotsType,
  isWeekly: boolean,
  timezone: string = "UTC",
) => {
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
                // Validate day of week for weekly slots
                const dayOfWeek = key.toUpperCase();
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

                // For weekly slots, convert timezone-aware time back to UTC with epoch date
                const baseDate = "1970-01-01";
                const startTimeUtc = convertTimezoneToUtc(
                  slot.startTime,
                  baseDate,
                  timezone,
                );
                const endTimeUtc = convertTimezoneToUtc(
                  slot.endTime,
                  baseDate,
                  timezone,
                );

                return {
                  dayOfWeekforStartTimeInUTC: dayOfWeek,
                  dayOfWeekforEndTimeInUTC: dayOfWeek,
                  slotStartTimeInUTC:
                    startTimeUtc || `${baseDate}T${slot.startTime}:00.000Z`,
                  slotEndTimeInUTC:
                    endTimeUtc || `${baseDate}T${slot.endTime}:00.000Z`,
                };
              } else {
                // Validate date format for custom slots
                const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
                if (!dateRegex.test(key)) {
                  throw new Error(`Invalid date format: ${key}`);
                }

                // Convert timezone-aware time to UTC for custom slots
                const startTimeUtc = convertTimezoneToUtc(
                  slot.startTime,
                  key,
                  timezone,
                );
                const endTimeUtc = convertTimezoneToUtc(
                  slot.endTime,
                  key,
                  timezone,
                );

                return {
                  slotStartTimeInUTC:
                    startTimeUtc ||
                    new Date(`${key}T${slot.startTime}:00`).toISOString(),
                  slotEndTimeInUTC:
                    endTimeUtc ||
                    new Date(`${key}T${slot.endTime}:00`).toISOString(),
                };
              }
            } catch (error) {
              console.error("Error formatting slot for API:", error, {
                key,
                slot,
              });
              return null; // Filter out invalid slots
            }
          })
          .filter(Boolean); // Remove null entries
      });
  } catch (error) {
    console.error("Error in formatSlotsForApi:", error, { slots, isWeekly });
    return []; // Return empty array on error to prevent API failures
  }
};

// Calendar utilities - using centralized functions from timeUtils
export const getCurrentDate = () => {
  const date = new Date();
  return date.toISOString().split("T")[0];
};

export const getMonthYearString = (date: Date) => {
  return date.toLocaleString("default", {
    month: "long",
    year: "numeric",
  });
};
