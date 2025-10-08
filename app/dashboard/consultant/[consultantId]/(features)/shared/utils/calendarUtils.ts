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
 * Calculates the total number of 30-minute slots required for an event.
 *
 * IMPORTANT: This function returns SLOT COUNT, not call/session count.
 *
 * For different event types:
 * - CONSULTATIONS: Returns slots needed for the session duration (e.g., 2 slots for 1 hour)
 * - WEBINARS: Returns slots needed for the session duration (e.g., 2 slots for 1 hour)
 * - CLASSES: Returns slots needed for the session duration (e.g., 2 slots for 1 hour)
 * - SUBSCRIPTIONS: Computes weeks → calls → slots (based on 30-min increments)
 *   - Uses Sunday-to-Saturday week boundaries when start/end dates are provided
 *   - Falls back to average weeks per month (4.33) when dates are not provided
 *
 * Example: A 6-month subscription with 3 calls/week and 1-hour sessions:
 * - Weeks: 26 (using Sunday boundaries)
 * - Calls: 26 × 3 = 78 calls
 * - Slots per call: 1 hour ÷ 0.5 hours = 2 slots
 * - Total slots: 78 × 2 = 156 slots
 */
export function calculateRequiredSlots(
  eventType: "consultation" | "subscription" | "webinar" | "class",
  durationInMonths?: number,
  callsPerWeek?: number,
  sessionDurationInHours?: number,
  startDate?: Date,
  endDate?: Date,
): number {
  if (!eventType) {
    throw new Error("Event type is required");
  }

  switch (eventType) {
    case "consultation":
      // For consultations, calculate based on session duration
      if (!sessionDurationInHours || sessionDurationInHours <= 0) {
        return Math.ceil(1 / 0.5); // Default 1 hour = 2 slots
      }
      return Math.ceil(sessionDurationInHours / 0.5); // 30-minute intervals

    case "webinar":
      // For webinars, calculate based on session duration
      if (!sessionDurationInHours || sessionDurationInHours <= 0) {
        return Math.ceil(1 / 0.5); // Default 1 hour = 2 slots
      }
      return Math.ceil(sessionDurationInHours / 0.5); // 30-minute intervals

    case "subscription": {
      if (sessionDurationInHours && sessionDurationInHours <= 0) {
        throw new Error(
          "Session duration must be a positive number for subscriptions",
        );
      }

      const slotsPerCall = Math.ceil((sessionDurationInHours || 1) / 0.5);

      // Validate dates against durationInMonths before using them
      if (startDate && endDate && durationInMonths) {
        const weeksFromDates = countSundayWeeksInclusive(startDate, endDate);
        const expectedWeeks = Math.ceil((durationInMonths || 0) * 4.33);

        // Check if date range roughly matches durationInMonths (±2 weeks tolerance)
        const weeksDifference = Math.abs(weeksFromDates - expectedWeeks);

        if (weeksDifference <= 2) {
          // Dates match duration - use actual dates for precision
          const totalCalls = weeksFromDates * (callsPerWeek || 1);
          return totalCalls * slotsPerCall;
        } else {
          // Dates don't match duration - log warning and use durationInMonths
          console.warn(
            `⚠️ Subscription date mismatch detected: ${weeksFromDates} weeks from dates vs ${expectedWeeks} weeks from ${durationInMonths} months. Using durationInMonths for calculation.`,
          );
        }
      }

      // Use durationInMonths calculation (either no dates provided or dates don't match)
      const weeksPerMonth = 4.33;
      const totalWeeks = Math.ceil((durationInMonths || 0) * weeksPerMonth);
      const totalCalls = totalWeeks * (callsPerWeek || 1);
      return totalCalls * slotsPerCall;
    }

    case "class": {
      // Number of slots required = (weeks × classesPerWeek) × slotsPerSession
      if (!callsPerWeek || callsPerWeek <= 0) {
        throw new Error("Calls per week must be a positive number for classes");
      }
      if (!sessionDurationInHours || sessionDurationInHours <= 0) {
        throw new Error(
          "Session duration must be a positive number for classes",
        );
      }

      const slotsPerSession = Math.ceil(sessionDurationInHours / 0.5);

      // Validate dates against durationInMonths before using them
      if (startDate && endDate && durationInMonths) {
        const weeksFromDates = countSundayWeeksInclusive(startDate, endDate);
        const expectedWeeks = Math.ceil((durationInMonths || 0) * 4.33);

        // Check if date range roughly matches durationInMonths (±2 weeks tolerance)
        const weeksDifference = Math.abs(weeksFromDates - expectedWeeks);

        if (weeksDifference <= 2) {
          // Dates match duration - use actual dates for precision
          const totalSessions = weeksFromDates * (callsPerWeek || 1);
          return totalSessions * slotsPerSession;
        } else {
          // Dates don't match duration - log warning and use durationInMonths
          console.warn(
            `⚠️ Class date mismatch detected: ${weeksFromDates} weeks from dates vs ${expectedWeeks} weeks from ${durationInMonths} months. Using durationInMonths for calculation.`,
          );
        }
      }

      // Use durationInMonths calculation (either no dates provided or dates don't match)
      const weeksPerMonth = 4.33;
      const totalWeeks = Math.ceil((durationInMonths || 0) * weeksPerMonth);
      const totalSessions = totalWeeks * (callsPerWeek || 1);
      return totalSessions * slotsPerSession;
    }

    default:
      throw new Error(`Invalid event type: ${eventType}`);
  }
}

/**
 * Count the number of distinct Sunday-start weeks overlapping [start, end].
 * The first week is the Sunday of the week containing startDate.
 * The last week is the Sunday of the week containing endDate.
 */
export function countSundayWeeksInclusive(
  startDate: Date,
  endDate: Date,
): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end < start) return 0;

  // Normalize to midnight for consistency
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  // Find the Sunday of the week containing start and end
  const startSunday = startOfWeekSunday(start);
  const endSunday = startOfWeekSunday(end);

  // Count number of Sundays from startSunday to endSunday inclusive
  let weeks = 1;
  let cursor = new Date(startSunday);
  while (cursor < endSunday) {
    cursor.setDate(cursor.getDate() + 7);
    weeks += 1;
  }
  return weeks;
}

/** Get the Sunday at 00:00:00 of the week that contains the given date. */
export function startOfWeekSunday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay(); // 0 = Sunday
  const diff = day; // days since Sunday
  const sunday = new Date(date);
  sunday.setDate(date.getDate() - diff);
  sunday.setHours(0, 0, 0, 0);
  return sunday;
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
    case "consultation": {
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
    }

    case "webinar": {
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
    }

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
 * FIXED: Validates that slots are consecutive within a single day.
 * This function checks if all slots are consecutive (end time of one slot = start time of next slot)
 * Uses tolerance for timezone/precision issues (within 1 second)
 */
export function validateDayBasedConsecutiveSlots(slots: TimeSlot[]): boolean {
  if (slots.length <= 1) return true;

  const sortedSlots = [...slots].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );

  // Check that all slots are on the same day
  const firstSlotDay = sortedSlots[0].startTime.toDateString();
  const allSameDay = sortedSlots.every(
    (slot) => slot.startTime.toDateString() === firstSlotDay,
  );
  if (!allSameDay) {
    return false;
  }

  // Check consecutiveness with tolerance for timezone/precision issues
  const toleranceMs = 1000; // 1 second tolerance
  for (let i = 1; i < sortedSlots.length; i++) {
    const prevSlot = sortedSlots[i - 1];
    const currentSlot = sortedSlots[i];

    const timeDiff = Math.abs(
      currentSlot.startTime.getTime() - prevSlot.endTime.getTime(),
    );

    if (timeDiff > toleranceMs) {
      return false;
    }
  }

  return true;
}

/**
 * Calculates call progress for subscriptions
 * Returns a clean, organized string showing progress with visual hierarchy
 */
export function calculateCallProgress(
  slots: TimeSlot[],
  sessionDurationInHours?: number,
  maxTotalCalls?: number,
): string {
  if (slots.length === 0) {
    return "No slots selected";
  }

  const slotsPerCall = Math.ceil((sessionDurationInHours || 1) / 0.5);
  const completedCalls = Math.floor(slots.length / slotsPerCall);
  const incompleteCallSlots = slots.length % slotsPerCall;

  // Group by day
  const slotsByDay = new Map<string, TimeSlot[]>();
  slots.forEach((slot) => {
    const dayKey = slot.startTime.toDateString();
    if (!slotsByDay.has(dayKey)) {
      slotsByDay.set(dayKey, []);
    }
    slotsByDay.get(dayKey)!.push(slot);
  });

  const incompleteDays = Array.from(slotsByDay.entries()).filter(
    ([_, daySlots]) => daySlots.length > 0 && daySlots.length < slotsPerCall,
  );

  // Build clean, multi-line progress text
  const lines: string[] = [];

  // Line 1: Main progress
  if (maxTotalCalls) {
    lines.push(`✅ ${completedCalls}/${maxTotalCalls} calls scheduled`);
  } else {
    lines.push(
      `✅ ${completedCalls} call${completedCalls !== 1 ? "s" : ""} scheduled`,
    );
  }

  // Line 2: Incomplete call warning (if applicable)
  if (incompleteCallSlots > 0 && incompleteDays.length > 0) {
    const [incompleteDay, incompleteDaySlots] = incompleteDays[0];
    const needed = slotsPerCall - incompleteDaySlots.length;
    const date = new Date(incompleteDay).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const duration = sessionDurationInHours || 1;
    const durationText = duration === 1 ? "1 hour" : `${duration} hours`;

    lines.push(
      `⚠️ ${date}: Add ${needed} more slot${needed !== 1 ? "s" : ""} to complete ${durationText} call`,
    );
  }

  return lines.join(" | ");
}
