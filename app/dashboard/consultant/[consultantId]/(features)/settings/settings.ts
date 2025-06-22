import { TConsultantProfile } from "@/types/consultant";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import { getLocalDateString, convertToLocalTime } from "@/utils/dateTimeUtils";
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
): SlotsType => {
  if (!consultant.slotsOfAvailabilityWeekly?.length) return {};

  const formattedWeeklySlots: SlotsType = {};
  consultant.slotsOfAvailabilityWeekly.forEach((slot) => {
    const day = slot.dayOfWeekforStartTimeInUTC.toLowerCase();
    const startTime = convertToLocalTime(slot.slotStartTimeInUTC.toISOString());
    const endTime = convertToLocalTime(slot.slotEndTimeInUTC.toISOString());

    // Only add valid slots
    if (isValidTimeRange(startTime, endTime)) {
      if (!formattedWeeklySlots[day]) {
        formattedWeeklySlots[day] = [];
      }
      formattedWeeklySlots[day].push({
        startTime,
        endTime,
        isValid: true,
      });
    }
  });
  return formattedWeeklySlots;
};

export const getInitialCustomSlots = (
  consultant: TConsultantProfile,
): SlotsType => {
  if (!consultant.slotsOfAvailabilityCustom?.length) return {};

  const formattedCustomSlots: SlotsType = {};
  consultant.slotsOfAvailabilityCustom.forEach((slot) => {
    const date = new Date(slot.slotStartTimeInUTC);
    const dateString = getLocalDateString(date);
    const startTime = convertToLocalTime(slot.slotStartTimeInUTC.toISOString());
    const endTime = convertToLocalTime(slot.slotEndTimeInUTC.toISOString());

    // Only add valid slots
    if (isValidTimeRange(startTime, endTime)) {
      if (!formattedCustomSlots[dateString]) {
        formattedCustomSlots[dateString] = [];
      }
      formattedCustomSlots[dateString].push({
        startTime,
        endTime,
        isValid: true,
      });
    }
  });
  return formattedCustomSlots;
};

export const formatSlotsForApi = (slots: SlotsType, isWeekly: boolean) => {
  return Object.entries(slots).flatMap(([key, slots]) =>
    slots
      .filter((slot) => slot.isValid)
      // Add additional validation to prevent 12 AM to 12 AM slots
      .filter((slot) => isValidTimeRange(slot.startTime, slot.endTime))
      .map((slot) => {
        if (isWeekly) {
          return {
            dayOfWeekforStartTimeInUTC: key.toUpperCase(),
            dayOfWeekforEndTimeInUTC: key.toUpperCase(),
            slotStartTimeInUTC: `2024-01-01T${slot.startTime}:00Z`,
            slotEndTimeInUTC: `2024-01-01T${slot.endTime}:00Z`,
          };
        } else {
          return {
            slotStartTimeInUTC: `${key}T${slot.startTime}:00Z`,
            slotEndTimeInUTC: `${key}T${slot.endTime}:00Z`,
          };
        }
      }),
  );
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

