import { TCustomSlot, TWeeklySlot } from "@/types/slots";
import {
  SlotOfAvailabilityCustom,
  SlotOfAvailabilityWeekly,
  DayOfWeek,
  ScheduleType,
  AppointmentsType,
} from "@prisma/client";
import { startOfWeek } from "date-fns";

// Core types for the unified calendar system
export interface TimeSlot {
  startTime: Date;
  endTime: Date;
  isAvailable: boolean;
  isBooked: boolean;
  isPartiallyBooked?: boolean;
  isConflicting?: boolean;
  originalSlot?: TWeeklySlot | TCustomSlot;
  appointmentDetails?: AppointmentDetail[];
}

export interface AppointmentDetail {
  id: string;
  type: string;
  title: string;
  with?: string;
}

export interface AppointmentSlot {
  id?: string;
  slotStartTimeInUTC: string | Date;
  slotEndTimeInUTC: string | Date;
  isTentative?: boolean;
  appointmentDetails?: AppointmentDetail;
}

export interface Appointment {
  id: string;
  appointmentType: AppointmentsType;
  slotsOfAppointment?: AppointmentSlot[];
  webinar?: { status: string; webinarPlan?: { title: string } };
  class?: { status: string; classPlan?: { title: string } };
  consultation?: {
    requestStatus: string;
    consultationPlan?: { title: string };
    requestedBy?: { user?: { name: string } };
  };
  subscription?: {
    requestStatus: string;
    subscriptionPlan?: { title: string };
    requestedBy?: { user?: { name: string } };
  };
}

export interface ConsultantData {
  scheduleType: ScheduleType;
  slotsOfAvailabilityWeekly: SlotOfAvailabilityWeekly[];
  slotsOfAvailabilityCustom: SlotOfAvailabilityCustom[];
  user?: {
    currentTimezone?: string;
  };
}

export interface CalendarViewConfig {
  view: "week" | "month";
  currentDate: Date;
  browserTimezone: string;
}

export interface SlotStatus {
  isAvailable: boolean;
  isBooked: boolean;
  isPartiallyBooked: boolean;
  isConflicting: boolean;
  isDisabled: boolean;
  isInPast: boolean;
  overlappingAppointments: AppointmentDetail[];
  intervalStartUTCString: string;
  intervalEndUTCString: string;
}

// Day index mapping for weekday calculations
const DAY_INDEX: Record<DayOfWeek, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

/**
 * Maps weekly availability slots to calendar time slots
 */
export function mapWeeklySlots(
  consultantData: ConsultantData,
  currentDate: Date,
  view: "week" | "month" = "week",
  intervalMinutes: number = 30, // Configurable interval duration
): TimeSlot[] {
  if (
    consultantData.scheduleType !== ScheduleType.WEEKLY ||
    !consultantData.slotsOfAvailabilityWeekly?.length
  ) {
    return [];
  }

  // Get the start and end dates based on view
  let startDate: Date, endDate: Date;
  if (view === "week") {
    startDate = startOfWeek(currentDate);
    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
  } else {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    startDate = new Date(year, month, 1);
    endDate = new Date(year, month + 1, 0);
  }

  // Create slots for each weekly pattern within the date range
  const slots: TimeSlot[] = [];
  const iterDate = new Date(startDate);

  while (iterDate <= endDate) {
    const dayOfWeek = iterDate.getDay();
    const matchingSlots = consultantData.slotsOfAvailabilityWeekly.filter(
      (slot) => DAY_INDEX[slot.dayOfWeekforStartTimeInUTC] === dayOfWeek,
    );

    matchingSlots.forEach((slot) => {
      const startTime = new Date(slot.slotStartTimeInUTC);
      const endTime = new Date(slot.slotEndTimeInUTC);

      // FIXED: Create new date objects to avoid mutations
      const slotStartTime = new Date(iterDate);
      slotStartTime.setHours(
        startTime.getHours(),
        startTime.getMinutes(),
        0,
        0,
      );

      const slotEndTime = new Date(iterDate);
      slotEndTime.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0);

      // Handle slots that cross midnight
      if (slotEndTime <= slotStartTime) {
        slotEndTime.setDate(slotEndTime.getDate() + 1);
      }

      // Create slots with configurable intervals
      let currentHour = new Date(slotStartTime);
      while (currentHour < slotEndTime) {
        const nextInterval = new Date(currentHour);
        nextInterval.setMinutes(currentHour.getMinutes() + intervalMinutes);

        const endTimeForSlot =
          nextInterval > slotEndTime ? slotEndTime : nextInterval;

        slots.push({
          startTime: new Date(currentHour),
          endTime: new Date(endTimeForSlot),
          isAvailable: true,
          isBooked: false,
          originalSlot: slot,
        });

        currentHour = nextInterval;
      }
    });

    // FIXED: Create new date object to avoid mutations
    iterDate.setDate(iterDate.getDate() + 1);
  }

  return slots;
}

/**
 * Maps custom availability slots to calendar time slots
 */
export function mapCustomSlots(
  consultantData: ConsultantData,
  intervalMinutes: number = 30, // Configurable interval duration
): TimeSlot[] {
  if (
    consultantData.scheduleType !== ScheduleType.CUSTOM ||
    !consultantData.slotsOfAvailabilityCustom?.length
  ) {
    return [];
  }

  const slots: TimeSlot[] = [];

  consultantData.slotsOfAvailabilityCustom.forEach((slot) => {
    const startTime = new Date(slot.slotStartTimeInUTC);
    const endTime = new Date(slot.slotEndTimeInUTC);

    // Create intervals with configurable duration for the custom slot
    let currentInterval = new Date(startTime);
    while (currentInterval < endTime) {
      const nextInterval = new Date(currentInterval);
      nextInterval.setMinutes(currentInterval.getMinutes() + intervalMinutes);

      const endTimeForSlot = nextInterval > endTime ? endTime : nextInterval;

      slots.push({
        startTime: new Date(currentInterval),
        endTime: new Date(endTimeForSlot),
        isAvailable: true,
        isBooked: false,
        originalSlot: slot,
      });

      currentInterval = nextInterval;
    }
  });

  return slots;
}

/**
 * Checks if two time slots overlap
 */
export function slotsOverlap(slot1: TimeSlot, slot2: AppointmentSlot): boolean {
  const slot1Start = slot1.startTime.getTime();
  const slot1End = slot1.endTime.getTime();
  const slot2Start = new Date(slot2.slotStartTimeInUTC).getTime();
  const slot2End = new Date(slot2.slotEndTimeInUTC).getTime();

  return slot1Start < slot2End && slot1End > slot2Start;
}

/**
 * Gets the status of a specific time slot
 */
export function getSlotStatus(
  interval: { hour: number; minute: number },
  date: Date,
  availableSlots: TimeSlot[],
  existingAppointments: Appointment[],
  intervalMinutes: number = 30, // Configurable interval duration
): SlotStatus {
  const slotStart = new Date(date);
  slotStart.setHours(interval.hour, interval.minute, 0, 0);
  const slotEnd = new Date(slotStart);
  slotEnd.setMinutes(slotStart.getMinutes() + intervalMinutes);

  const now = new Date();
  const isInPast = slotStart < now;

  // Check if this slot is available
  const isAvailable = availableSlots.some((availSlot) => {
    const availStart = availSlot.startTime.getTime();
    const availEnd = availSlot.endTime.getTime();
    return slotStart.getTime() >= availStart && slotEnd.getTime() <= availEnd;
  });

  // Check for overlapping appointments
  const overlappingAppointments: AppointmentDetail[] = [];
  let isBooked = false;
  let isPartiallyBooked = false;

  existingAppointments.forEach((appointment) => {
    appointment.slotsOfAppointment?.forEach((apptSlot) => {
      const apptStart = new Date(apptSlot.slotStartTimeInUTC);
      const apptEnd = new Date(apptSlot.slotEndTimeInUTC);

      // Check if slots overlap
      if (slotStart < apptEnd && slotEnd > apptStart) {
        let title = "Unknown Appointment";
        let withUser = "";

        if (appointment.appointmentType === AppointmentsType.CONSULTATION) {
          title =
            appointment.consultation?.consultationPlan?.title || "Consultation";
          withUser = appointment.consultation?.requestedBy?.user?.name || "";
        } else if (
          appointment.appointmentType === AppointmentsType.SUBSCRIPTION
        ) {
          title =
            appointment.subscription?.subscriptionPlan?.title || "Subscription";
          withUser = appointment.subscription?.requestedBy?.user?.name || "";
        } else if (appointment.appointmentType === AppointmentsType.WEBINAR) {
          title = appointment.webinar?.webinarPlan?.title || "Webinar";
        } else if (appointment.appointmentType === AppointmentsType.CLASS) {
          title = appointment.class?.classPlan?.title || "Class";
        }

        overlappingAppointments.push({
          id: appointment.id,
          type: appointment.appointmentType,
          title: withUser ? `${title} with ${withUser}` : title,
          with: withUser,
        });

        // Determine booking status
        if (
          slotStart.getTime() === apptStart.getTime() &&
          slotEnd.getTime() === apptEnd.getTime()
        ) {
          isBooked = true;
        } else {
          isPartiallyBooked = true;
        }
      }
    });
  });

  const isConflicting = overlappingAppointments.length > 1;
  const isDisabled = !isAvailable || isBooked || isInPast;

  return {
    isAvailable,
    isBooked,
    isPartiallyBooked,
    isConflicting,
    isDisabled,
    isInPast,
    overlappingAppointments,
    intervalStartUTCString: slotStart.toISOString(),
    intervalEndUTCString: slotEnd.toISOString(),
  };
}

/**
 * Formats appointment slots for API submission
 */
export function formatSlotsForAPI(slots: TimeSlot[]): string[] {
  return slots.map((slot) => slot.startTime.toISOString());
}

/**
 * Calculates required slots for different event types
 * FIXED: Uses actual appointment data instead of hardcoded calculations
 */
export function calculateRequiredSlots(
  eventType: "consultation" | "subscription" | "webinar" | "class",
  durationInMonths?: number,
  callsPerWeek?: number,
  sessionDurationInHours?: number,
): number {
  if (!eventType) {
    throw new Error("Event type is required");
  }

  switch (eventType) {
    case "consultation":
      // For consultations, calculate based on session duration
      if (!sessionDurationInHours || sessionDurationInHours <= 0) {
        throw new Error("Consultation duration must be a positive number");
      }
      return Math.ceil(sessionDurationInHours / 0.5); // 30-minute intervals

    case "webinar":
      // For webinars, calculate based on session duration
      if (!sessionDurationInHours || sessionDurationInHours <= 0) {
        return Math.ceil(1 * 2); // Default 1 hour = 2 slots
      }
      return Math.ceil(sessionDurationInHours * 2); // 30-minute intervals

    case "subscription":
      // FIXED: Use actual subscription plan data instead of hardcoded calculations
      // The subscription plan already contains the exact number of calls needed
      if (!durationInMonths || durationInMonths <= 0) {
        throw new Error(
          "Duration in months must be a positive number for subscriptions",
        );
      }
      if (!callsPerWeek || callsPerWeek <= 0) {
        throw new Error(
          "Calls per week must be a positive number for subscriptions",
        );
      }
      if (!sessionDurationInHours || sessionDurationInHours <= 0) {
        throw new Error(
          "Session duration must be a positive number for subscriptions",
        );
      }

      // Calculate total calls based on actual duration and frequency
      const totalCalls = durationInMonths * callsPerWeek;
      const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);
      return totalCalls * slotsPerCall;

    case "class":
      // FIXED: Use actual class plan data instead of hardcoded calculations
      // The class plan already contains the exact number of sessions needed
      if (!durationInMonths || durationInMonths <= 0) {
        throw new Error(
          "Duration in months must be a positive number for classes",
        );
      }
      if (!callsPerWeek || callsPerWeek <= 0) {
        throw new Error("Calls per week must be a positive number for classes");
      }
      if (!sessionDurationInHours || sessionDurationInHours <= 0) {
        throw new Error(
          "Session duration must be a positive number for classes",
        );
      }

      // Calculate total sessions based on actual duration and frequency
      const totalSessions = durationInMonths * callsPerWeek;
      const slotsPerSession = Math.ceil(sessionDurationInHours / 0.5);
      return totalSessions * slotsPerSession;

    default:
      throw new Error(`Invalid event type: ${eventType}`);
  }
}

/**
 * Validates selected slots for a specific event type
 */
export function validateSelectedSlots(
  selectedSlots: TimeSlot[],
  eventType: "consultation" | "subscription" | "webinar" | "class",
  requiredSlots?: number,
  sessionDurationInHours?: number,
): { isValid: boolean; errorMessage?: string } {
  if (selectedSlots.length === 0) {
    return { isValid: false, errorMessage: "Please select at least one slot" };
  }

  switch (eventType) {
    case "consultation":
      // FIXED: Validate consultation slots based on required duration
      const consultationRequiredSlots =
        requiredSlots ||
        calculateRequiredSlots(
          eventType,
          undefined,
          undefined,
          sessionDurationInHours,
        );

      if (selectedSlots.length !== consultationRequiredSlots) {
        return {
          isValid: false,
          errorMessage: `This Consultation requires exactly ${consultationRequiredSlots} slot${consultationRequiredSlots !== 1 ? "s" : ""} (${sessionDurationInHours || 1} hour${(sessionDurationInHours || 1) > 1 ? "s" : ""})`,
        };
      }

      // FIXED: Check same-day requirement FIRST (before consecutive check)
      if (selectedSlots.length > 1) {
        const firstSlotDay = selectedSlots[0].startTime.toDateString();
        const allSameDay = selectedSlots.every(
          (slot) => slot.startTime.toDateString() === firstSlotDay,
        );
        if (!allSameDay) {
          return {
            isValid: false,
            errorMessage:
              "Consultation is a one-day event - all slots must be on the same day",
          };
        }
      }

      // FIXED: Only check consecutiveness if all slots are on the same day
      if (
        selectedSlots.length > 1 &&
        !validateDayBasedConsecutiveSlots(selectedSlots)
      ) {
        return {
          isValid: false,
          errorMessage:
            "Consultation slots must be consecutive within the same day",
        };
      }
      break;

    case "webinar":
      // For webinars, calculate required slots based on session duration
      const webinarRequiredSlots =
        requiredSlots ||
        calculateRequiredSlots(
          eventType,
          undefined,
          undefined,
          sessionDurationInHours,
        );
      if (selectedSlots.length !== webinarRequiredSlots) {
        const durationText = sessionDurationInHours
          ? `${sessionDurationInHours} hour${sessionDurationInHours > 1 ? "s" : ""}`
          : "1 hour";
        return {
          isValid: false,
          errorMessage: `Webinar (${durationText}) requires exactly ${webinarRequiredSlots} consecutive slot${webinarRequiredSlots > 1 ? "s" : ""}`,
        };
      }

      // Validate that slots are consecutive for multi-slot webinars
      if (webinarRequiredSlots > 1) {
        const sortedSlots = [...selectedSlots].sort(
          (a, b) => a.startTime.getTime() - b.startTime.getTime(),
        );
        for (let i = 1; i < sortedSlots.length; i++) {
          const prevSlot = sortedSlots[i - 1];
          const currentSlot = sortedSlots[i];
          if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            return {
              isValid: false,
              errorMessage: "Webinar slots must be consecutive",
            };
          }
        }
      }
      break;

    case "subscription":
    case "class":
      if (requiredSlots && selectedSlots.length !== requiredSlots) {
        return {
          isValid: false,
          errorMessage: `${eventType === "subscription" ? "Subscription" : "Class"} requires exactly ${requiredSlots} slots`,
        };
      }
      break;

    default:
      return { isValid: false, errorMessage: "Invalid event type" };
  }

  // Check for slots in the past
  const now = new Date();
  const pastSlots = selectedSlots.filter((slot) => slot.startTime < now);
  if (pastSlots.length > 0) {
    return { isValid: false, errorMessage: "Cannot select slots in the past" };
  }

  return { isValid: true };
}

/**
 * Groups slots by week for subscription/class validation
 */
export function groupSlotsByWeek(slots: TimeSlot[]): Map<string, TimeSlot[]> {
  const slotsByWeek = new Map<string, TimeSlot[]>();

  slots.forEach((slot) => {
    const weekStart = startOfWeek(slot.startTime);
    const weekKey = weekStart.toISOString();

    if (!slotsByWeek.has(weekKey)) {
      slotsByWeek.set(weekKey, []);
    }
    slotsByWeek.get(weekKey)!.push(slot);
  });

  return slotsByWeek;
}

/**
 * Validates slot distribution for subscriptions/classes
 */
export function validateSlotDistribution(
  slots: TimeSlot[],
  callsPerWeek: number,
): { isValid: boolean; errorMessage?: string } {
  const slotsByWeek = groupSlotsByWeek(slots);

  for (const [weekKey, weekSlots] of Array.from(slotsByWeek.entries())) {
    if (weekSlots.length > callsPerWeek) {
      const weekDate = new Date(weekKey);
      return {
        isValid: false,
        errorMessage: `Too many slots selected for week of ${weekDate.toLocaleDateString()} (max ${callsPerWeek} allowed)`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Gets appointment title from appointment data
 */
export function getAppointmentTitle(appointment: Appointment): string {
  switch (appointment.appointmentType) {
    case AppointmentsType.CONSULTATION:
      return (
        appointment.consultation?.consultationPlan?.title || "Consultation"
      );
    case AppointmentsType.SUBSCRIPTION:
      return (
        appointment.subscription?.subscriptionPlan?.title || "Subscription"
      );
    case AppointmentsType.WEBINAR:
      return appointment.webinar?.webinarPlan?.title || "Webinar";
    case AppointmentsType.CLASS:
      return appointment.class?.classPlan?.title || "Class";
    default:
      return "Unknown Appointment";
  }
}

/**
 * Gets the user name for consultations/subscriptions
 */
export function getAppointmentUser(appointment: Appointment): string {
  if (appointment.appointmentType === AppointmentsType.CONSULTATION) {
    return appointment.consultation?.requestedBy?.user?.name || "";
  }
  if (appointment.appointmentType === AppointmentsType.SUBSCRIPTION) {
    return appointment.subscription?.requestedBy?.user?.name || "";
  }
  return "";
}

/**
 * NEW: Validates that slots are consecutive within a single day.
 * This function checks if all slots are consecutive (end time of one slot = start time of next slot)
 */
export function validateDayBasedConsecutiveSlots(slots: TimeSlot[]): boolean {
  if (slots.length <= 1) return true;

  const sortedSlots = [...slots].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );

  for (let i = 1; i < sortedSlots.length; i++) {
    const prevSlot = sortedSlots[i - 1];
    const currentSlot = sortedSlots[i];

    if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
      return false;
    }
  }

  return true;
}

/**
 * NEW: Calculates call progress for subscriptions
 * Returns a string showing progress of calls completed vs total calls needed
 */
export function calculateCallProgress(
  slots: TimeSlot[],
  sessionDurationInHours?: number,
  maxTotalCalls?: number,
): string {
  if (slots.length === 0) {
    return "No slots selected";
  }

  const slotsPerCall = Math.ceil((sessionDurationInHours || 1) / 0.5); // 30-minute intervals
  const completedCalls = Math.floor(slots.length / slotsPerCall);
  const incompleteCallSlots = slots.length % slotsPerCall;

  // Group by day to show daily progress
  const slotsByDay = new Map<string, TimeSlot[]>();
  slots.forEach((slot) => {
    const dayKey = slot.startTime.toDateString();
    if (!slotsByDay.has(dayKey)) {
      slotsByDay.set(dayKey, []);
    }
    slotsByDay.get(dayKey)!.push(slot);
  });

  const daysWithSlots = Array.from(slotsByDay.entries()).filter(
    ([_, daySlots]) => daySlots.length > 0,
  );

  let progressText = `${completedCalls} call${completedCalls !== 1 ? "s" : ""} completed`;

  if (maxTotalCalls) {
    progressText += ` of ${maxTotalCalls} total`;
  }

  if (incompleteCallSlots > 0) {
    progressText += `, ${incompleteCallSlots} slot${incompleteCallSlots !== 1 ? "s" : ""} remaining for next call`;
  }

  if (daysWithSlots.length > 0) {
    const incompleteDays = daysWithSlots.filter(
      ([_, daySlots]) => daySlots.length > 0 && daySlots.length < slotsPerCall,
    );

    if (incompleteDays.length > 0) {
      const incompleteDay = incompleteDays[0][0];
      const incompleteDaySlots = incompleteDays[0][1];
      const needed = slotsPerCall - incompleteDaySlots.length;
      progressText += ` | Call on ${incompleteDay} needs ${needed} more consecutive slots`;
    }
  }

  return progressText;
}
