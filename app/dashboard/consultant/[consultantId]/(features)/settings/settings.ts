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
  if (!consultant?.slotsOfAvailabilityWeekly?.length) return {};

  const formattedWeeklySlots: SlotsType = {};
  try {
    consultant.slotsOfAvailabilityWeekly.forEach((slot) => {
      try {
        if (!slot || !slot.dayOfWeekforStartTimeInUTC || !slot.slotStartTimeInUTC || !slot.slotEndTimeInUTC) {
          console.warn('Invalid weekly slot data:', slot);
          return;
        }

        const day = slot.dayOfWeekforStartTimeInUTC.toLowerCase();
        // For weekly slots, extract time directly from UTC since we store with epoch date
        const startDate = new Date(slot.slotStartTimeInUTC);
        const endDate = new Date(slot.slotEndTimeInUTC);
        
        // Extract HH:MM directly from UTC time (no timezone conversion needed for weekly slots)
        const startTime = startDate.getUTCHours().toString().padStart(2, '0') + ':' + 
                          startDate.getUTCMinutes().toString().padStart(2, '0');
        const endTime = endDate.getUTCHours().toString().padStart(2, '0') + ':' + 
                        endDate.getUTCMinutes().toString().padStart(2, '0');

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
          console.warn('Invalid time range for weekly slot:', { day, startTime, endTime });
        }
      } catch (error) {
        console.error('Error processing weekly slot:', error, slot);
      }
    });
  } catch (error) {
    console.error('Error in getInitialWeeklySlots:', error);
  }
  return formattedWeeklySlots;
};

export const getInitialCustomSlots = (
  consultant: TConsultantProfile,
): SlotsType => {
  if (!consultant?.slotsOfAvailabilityCustom?.length) return {};

  const formattedCustomSlots: SlotsType = {};
  try {
    consultant.slotsOfAvailabilityCustom.forEach((slot) => {
      try {
        if (!slot || !slot.slotStartTimeInUTC || !slot.slotEndTimeInUTC) {
          console.warn('Invalid custom slot data:', slot);
          return;
        }

        const startDate = new Date(slot.slotStartTimeInUTC);
        const endDate = new Date(slot.slotEndTimeInUTC);
        
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          console.warn('Invalid date in custom slot:', slot.slotStartTimeInUTC, slot.slotEndTimeInUTC);
          return;
        }

        // For custom slots, we need to handle timezone conversion properly
        // Convert UTC back to user's local time for display
        const dateString = getLocalDateString(startDate);
        const startTime = convertToLocalTime(new Date(slot.slotStartTimeInUTC).toISOString());
        const endTime = convertToLocalTime(new Date(slot.slotEndTimeInUTC).toISOString());
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
          console.warn('Invalid time range for custom slot:', { dateString, startTime, endTime });
        }
      } catch (error) {
        console.error('Error processing custom slot:', error, slot);
      }
    });
  } catch (error) {
    console.error('Error in getInitialCustomSlots:', error);
  }
  return formattedCustomSlots;
};

export const formatSlotsForApi = (slots: SlotsType, isWeekly: boolean) => {
  try {
    return Object.entries(slots)
      .filter(([key, daySlots]) => {
        // Ensure we have valid key and slots array
        return key && Array.isArray(daySlots) && daySlots.length > 0;
      })
      .flatMap(([key, daySlots]) =>
        daySlots
          .filter((slot) => {
            // Comprehensive slot validation
            return (
              slot &&
              typeof slot === 'object' &&
              slot.isValid === true &&
              slot.startTime &&
              slot.endTime &&
              typeof slot.startTime === 'string' &&
              typeof slot.endTime === 'string' &&
              isValidTimeRange(slot.startTime, slot.endTime)
            );
          })
          .map((slot) => {
            try {
              if (isWeekly) {
                // Validate day of week for weekly slots
                const dayOfWeek = key.toUpperCase();
                const validDays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
                if (!validDays.includes(dayOfWeek)) {
                  throw new Error(`Invalid day of week: ${dayOfWeek}`);
                }
                
                // Use a consistent UTC date for weekly slots to avoid timezone issues
                const baseDate = '1970-01-01'; // Use epoch date to avoid DST issues
                return {
                  dayOfWeekforStartTimeInUTC: dayOfWeek,
                  dayOfWeekforEndTimeInUTC: dayOfWeek,
                  slotStartTimeInUTC: `${baseDate}T${slot.startTime}:00.000Z`,
                  slotEndTimeInUTC: `${baseDate}T${slot.endTime}:00.000Z`,
                };
              } else {
                // Validate date format for custom slots
                const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
                if (!dateRegex.test(key)) {
                  throw new Error(`Invalid date format: ${key}`);
                }
                
                // Convert local time to UTC properly for custom slots
                const startDateTime = new Date(`${key}T${slot.startTime}:00`);
                const endDateTime = new Date(`${key}T${slot.endTime}:00`);
                
                return {
                  slotStartTimeInUTC: startDateTime.toISOString(),
                  slotEndTimeInUTC: endDateTime.toISOString(),
                };
              }
            } catch (error) {
              console.error('Error formatting slot for API:', error, { key, slot });
              return null; // Filter out invalid slots
            }
          })
          .filter(Boolean) // Remove null entries
      );
  } catch (error) {
    console.error('Error in formatSlotsForApi:', error, { slots, isWeekly });
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
