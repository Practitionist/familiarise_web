import { TConsultantProfile } from "@/types/consultant";
import {
  convertUtcToTimezone,
  extractTimeFromUtcSlot,
  sortSlotsByTime,
} from "@/utils/dateTimeUtils";
import { minuteUtcToDate } from "@/utils/slotAllocation/slotTimeUtils";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import type { SlotsType } from "@/utils/schedule/types";
import { DayOfWeek, ScheduleType, SessionType } from "@prisma/client";

export interface FormData {
  description: string;
  experience: number;
  scheduleType: ScheduleType;
  domainId: string;
  subDomainIds: string[];
  tagIds: string[];
  // New fields
  headline: string;
  websiteUrl: string;
  twitterUrl: string;
  githubUrl: string;
  linkedinUrl: string; // Stored on User model, not ConsultantProfile
  videoIntroUrl: string;
  languages: string[];
  toolsAndTechnologies: string[];
  mentoringStyle: string;
  sessionTypes: SessionType[];
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

/** Extracts editable form fields from a consultant profile into initial form state. */
export const getInitialFormData = (
  consultant: TConsultantProfile,
): FormData => ({
  description: consultant?.description ?? "",
  experience: consultant?.experience ?? 0,
  scheduleType: consultant?.scheduleType ?? ScheduleType.WEEKLY,
  domainId: consultant?.domain?.id ?? "",
  subDomainIds: consultant?.subDomains?.map((sd) => sd.id) ?? [],
  tagIds: consultant?.tags?.map((t) => t.id) ?? [],
  // New fields
  headline: consultant?.headline ?? "",
  websiteUrl: consultant?.websiteUrl ?? "",
  twitterUrl: consultant?.twitterUrl ?? "",
  githubUrl: consultant?.githubUrl ?? "",
  linkedinUrl: consultant?.user?.linkedinUrl ?? "", // From User model
  videoIntroUrl: consultant?.videoIntroUrl ?? "",
  languages: consultant?.languages ?? [],
  toolsAndTechnologies: consultant?.toolsAndTechnologies ?? [],
  mentoringStyle: consultant?.mentoringStyle ?? "",
  sessionTypes: consultant?.sessionTypes ?? [],
});

/**
 * Converts a consultant's persisted weekly availability (UTC) into local-time
 * SlotType entries grouped by lowercase day-of-week key.
 */
export const getInitialWeeklySlots = (
  consultant: TConsultantProfile,
  timezone: string = "UTC",
): SlotsType => {
  if (!consultant?.slotsOfAvailabilityWeekly?.length) return {};

  const formattedWeeklySlots: SlotsType = {};
  const refDate = new Date("1970-01-05T00:00:00Z");
  try {
    consultant.slotsOfAvailabilityWeekly.forEach((slot) => {
      try {
        if (
          !slot ||
          slot.startTimeUtc == null ||
          slot.endTimeUtc == null
        ) {
          console.warn("Invalid weekly slot data:", slot);
          return;
        }

        // Use the day-of-week stored in the database. This is the consultant's
        // intended day for the recurring slot. The time will be converted,
        // but the day grouping should remain consistent with the original setting.
        const day = (slot.startDay as string).toLowerCase();

        // Convert Int minutes to a temporary Date to leverage existing timezone
        // conversion, then extract local time string for display.
        const startTime = extractTimeFromUtcSlot(
          minuteUtcToDate(slot.startTimeUtc, refDate).toISOString(),
          timezone,
        );
        const endTime = extractTimeFromUtcSlot(
          minuteUtcToDate(slot.endTimeUtc, refDate).toISOString(),
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

/**
 * Converts a consultant's persisted custom availability (UTC) into local-time
 * SlotType entries grouped by YYYY-MM-DD date key.
 */
export const getInitialCustomSlots = (
  consultant: TConsultantProfile,
  timezone: string = "UTC",
): SlotsType => {
  if (!consultant?.slotsOfAvailabilityCustom?.length) return {};

  const formattedCustomSlots: SlotsType = {};
  try {
    consultant.slotsOfAvailabilityCustom.forEach((slot) => {
      try {
        if (!slot || !slot.availabilityStartsAt || !slot.availabilityEndsAt) {
          console.warn("Invalid custom slot data:", slot);
          return;
        }

        const startDate = new Date(slot.availabilityStartsAt);
        const endDate = new Date(slot.availabilityEndsAt);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          console.warn(
            "Invalid date in custom slot:",
            slot.availabilityStartsAt,
            slot.availabilityEndsAt,
          );
          return;
        }

        // For custom slots, use timezone-aware conversion
        // Get the date in the specified timezone
        const dateString = startDate.toLocaleDateString("en-CA", {
          timeZone: timezone,
        }); // en-CA gives YYYY-MM-DD format

        const startTime = convertUtcToTimezone(
          slot.availabilityStartsAt.toString(),
          timezone,
        );
        const endTime = convertUtcToTimezone(
          slot.availabilityEndsAt.toString(),
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

/** Returns a human-readable "Month Year" string (e.g., "January 2025") for the calendar header. */
export const getMonthYearString = (date: Date) => {
  return date.toLocaleString("default", {
    month: "long",
    year: "numeric",
  });
};
