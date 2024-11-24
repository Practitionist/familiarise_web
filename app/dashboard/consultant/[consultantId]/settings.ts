import { DayOfWeek, ScheduleType } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";

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
  language: string;
  level: string;
  prerequisites: string;
  domainId: string;
  subDomainIds: string[];
  tagIds: string[];
}

export interface ServiceSettings {
  language: string;
  level: string;
  prerequisites: string;
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
  language: "English",
  level: "Beginner",
  prerequisites: "",
  domainId: consultant?.domain?.id || "",
  subDomainIds: consultant?.subDomains?.map((sd) => sd.id) || [],
  tagIds: consultant?.tags?.map((t) => t.id) || [],
});

export const getInitialServiceSettings = (
  consultant: TConsultantProfile,
): ServiceSettings => {
  const firstConsultationPlan = consultant.consultationPlans?.[0];
  const firstSubscriptionPlan = consultant.subscriptionPlans?.[0];
  const firstWebinarPlan = consultant.webinarPlans?.[0];
  const firstClassPlan = consultant.classPlans?.[0];

  return {
    language:
      firstConsultationPlan?.language ||
      firstSubscriptionPlan?.language ||
      firstWebinarPlan?.language ||
      firstClassPlan?.language ||
      "English",
    level:
      firstConsultationPlan?.level ||
      firstSubscriptionPlan?.level ||
      firstWebinarPlan?.level ||
      firstClassPlan?.level ||
      "Beginner",
    prerequisites:
      firstConsultationPlan?.prerequisites ||
      firstSubscriptionPlan?.prerequisites ||
      firstWebinarPlan?.prerequisites ||
      firstClassPlan?.prerequisites ||
      "",
  };
};

export const getInitialWeeklySlots = (
  consultant: TConsultantProfile,
): SlotsType => {
  if (!consultant.slotsOfAvailabilityWeekly?.length) return {};

  const formattedWeeklySlots: SlotsType = {};
  consultant.slotsOfAvailabilityWeekly.forEach((slot) => {
    const day = slot.dayOfWeekforStartTimeInUTC.toLowerCase();
    if (!formattedWeeklySlots[day]) {
      formattedWeeklySlots[day] = [];
    }
    formattedWeeklySlots[day].push({
      startTime: formatTimeFromDate(new Date(slot.slotStartTimeInUTC)),
      endTime: formatTimeFromDate(new Date(slot.slotEndTimeInUTC)),
      isValid: true,
    });
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

    if (!formattedCustomSlots[dateString]) {
      formattedCustomSlots[dateString] = [];
    }
    formattedCustomSlots[dateString].push({
      startTime: formatTimeFromDate(new Date(slot.slotStartTimeInUTC)),
      endTime: formatTimeFromDate(new Date(slot.slotEndTimeInUTC)),
      isValid: true,
    });
  });
  return formattedCustomSlots;
};

export const validateSlot = (
  slot: SlotType,
  otherSlots: SlotType[],
): SlotType => {
  const getMinutes = (time: string): number | null => {
    const [hours, minutes] = time.split(":").map(Number);
    return !isNaN(hours) && !isNaN(minutes) ? hours * 60 + minutes : null;
  };

  const startMinutes = getMinutes(slot.startTime);
  const endMinutes = getMinutes(slot.endTime);

  if (startMinutes === null || endMinutes === null) {
    return { ...slot, isValid: false, errorMessage: "Invalid time format" };
  }

  if (endMinutes <= startMinutes) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "End time must be after start time",
    };
  }

  if (startMinutes % 15 !== 0 || endMinutes % 15 !== 0) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "Times must be in multiples of 15 minutes",
    };
  }

  if (endMinutes - startMinutes < 30) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "Session must be at least 30 minutes long",
    };
  }

  for (const otherSlot of otherSlots) {
    const otherStartMinutes = getMinutes(otherSlot.startTime);
    const otherEndMinutes = getMinutes(otherSlot.endTime);
    if (otherStartMinutes === null || otherEndMinutes === null) continue;

    if (
      (startMinutes >= otherStartMinutes &&
        startMinutes < otherEndMinutes + 15) ||
      (endMinutes > otherStartMinutes - 15 && endMinutes <= otherEndMinutes) ||
      (startMinutes <= otherStartMinutes && endMinutes >= otherEndMinutes)
    ) {
      return {
        ...slot,
        isValid: false,
        errorMessage: "Must have at least a 15-minute break between sessions",
      };
    }
  }

  return { ...slot, isValid: true, errorMessage: undefined };
};

export const formatSlotsForApi = (slots: SlotsType, isWeekly: boolean) => {
  return Object.entries(slots).flatMap(([key, slots]) =>
    slots
      .filter((slot) => slot.isValid)
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
    daySlots.every((slot) => slot.isValid),
  );
};

export const updateConsultantSettings = async (
  consultantId: string,
  formData: FormData,
  weeklySlots: SlotsType,
  customSlots: SlotsType,
) => {
  const response = await fetch(`/api/user/consultants/${consultantId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...formData,
      slotsOfAvailabilityWeekly: formatSlotsForApi(weeklySlots, true),
      slotsOfAvailabilityCustom: formatSlotsForApi(customSlots, false),
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to update settings");
  }

  return response.json();
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
