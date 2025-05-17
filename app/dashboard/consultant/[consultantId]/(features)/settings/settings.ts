import { TConsultantProfile } from "@/types/consultant";
import { isValidTimeRange, validateTimeSlot } from "@/utils/timeSlotValidation";
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
  experience: string;
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

export const formatDayDisplay = (day: DayOfWeek): string => {
  return day.charAt(0) + day.slice(1).toLowerCase();
};

export const formatTimeFromDate = (date: Date): string => {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const getInitialFormData = (
  consultant: TConsultantProfile,
): FormData => ({
  description: consultant?.description || "",
  qualifications: consultant?.qualifications || "",
  specialization: consultant?.specialization || "",
  experience: consultant?.experience || "",
  scheduleType: consultant?.scheduleType || ScheduleType.WEEKLY,
  domainId: consultant?.domain?.id || "",
  subDomainIds: consultant?.subDomains?.map((sd) => sd.id) || [],
  tagIds: consultant?.tags?.map((t) => t.id) || [],
});

export const getInitialWeeklySlots = (
  consultant: TConsultantProfile,
): SlotsType => {
  if (!consultant.slotsOfAvailabilityWeekly?.length) return {};

  const formattedWeeklySlots: SlotsType = {};
  consultant.slotsOfAvailabilityWeekly.forEach((slot) => {
    const day = slot.dayOfWeekforStartTimeInUTC.toLowerCase();
    const startTime = formatTimeFromDate(new Date(slot.slotStartTimeInUTC));
    const endTime = formatTimeFromDate(new Date(slot.slotEndTimeInUTC));

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
    const startTime = formatTimeFromDate(new Date(slot.slotStartTimeInUTC));
    const endTime = formatTimeFromDate(new Date(slot.slotEndTimeInUTC));

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

// Re-export the shared validation utility
export const validateSlot = validateTimeSlot;
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

export const validateAllSlots = (slots: SlotsType): boolean => {
  return Object.values(slots).every((daySlots) =>
    daySlots.every(
      (slot) => slot.isValid && isValidTimeRange(slot.startTime, slot.endTime),
    ),
  );
};

// Calendar utilities
export const getCurrentDate = () => {
  const date = new Date();
  return date.toISOString().split("T")[0];
};

export const getDaysInMonth = (date: Date) => {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
};

export const getFirstDayOfMonth = (date: Date) => {
  return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
};

export const getMonthYearString = (date: Date) => {
  return date.toLocaleString("default", {
    month: "long",
    year: "numeric",
  });
};

export const getLocalDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
};
