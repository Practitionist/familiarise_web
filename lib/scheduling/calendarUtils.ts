import { TCustomSlot, TWeeklySlot } from "@/types/slots";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { formatDayKey, formatWeekKey } from "./allocationMessages";

// Core types for the unified calendar system. CalendarInterval is the UI cell:
// a BookableInterval plus display-only flags and the tooltip payload (#1554).
export interface CalendarInterval {
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

/**
 * Calculate required 30-minute slots for different event types.
 * Delegates to ScheduleCalculationService as the single source of truth,
 * adapting the legacy parameter signature for backward compatibility.
 */
export function calculateRequiredSlots(
  eventType: "consultation" | "subscription" | "webinar" | "class",
  durationInMonths?: number,
  sessionsPerWeek?: number,
  durationInHours?: number,
  startDate?: Date,
  endDate?: Date,
  totalSessions?: number,
): number {
  return ScheduleCalculationService.calculateRequiredSlots(eventType, {
    durationInMonths,
    sessionsPerWeek,
    durationInHours,
    sessionDurationInHours: durationInHours,
    schedulingPeriodStartsAt: startDate,
    schedulingPeriodEndsAt: endDate,
    totalSessions,
  });
}

/**
 * A selected session for display: one consecutive run of 30-minute atoms,
 * collapsed so a 1-hour pick reads as one chip ("Thu 24 Sep ·
 * 11:00 am–12:00 pm") instead of two atom rows. Sorted ascending by start.
 */
export interface SelectedSession {
  start: Date;
  end: Date;
}

/**
 * Collapse selected 30-minute atoms into consecutive runs, sorted by start.
 * Pure: sorts a copy, never mutates. A run that crosses local midnight stays one run.
 */
export function groupSelectedIntoSessions(
  selectedSlots: CalendarInterval[],
): SelectedSession[] {
  const sorted = [...selectedSlots].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );
  const sessions: SelectedSession[] = [];
  for (const slot of sorted) {
    const open = sessions[sessions.length - 1];
    if (
      open &&
      slot.startTime.getTime() === open.end.getTime() &&
      slot.endTime.getTime() > open.end.getTime()
    ) {
      open.end = slot.endTime;
    } else {
      sessions.push({ start: slot.startTime, end: slot.endTime });
    }
  }
  return sessions;
}

/**
 * The selection as whole sessions: each run from `groupSelectedIntoSessions`,
 * cut into `slotsPerSession`-atom pieces from its start, so two back-to-back
 * picks stay two sessions and one across midnight stays one. A shorter tail is
 * its own piece.
 */
export function splitIntoSessions(
  selectedSlots: CalendarInterval[],
  slotsPerSession: number,
): SelectedSession[] {
  const sessionMs = Math.max(1, slotsPerSession) * 30 * 60 * 1000;
  return groupSelectedIntoSessions(selectedSlots).flatMap((run) => {
    const pieces: SelectedSession[] = [];
    for (
      let startMs = run.start.getTime();
      startMs < run.end.getTime();
      startMs += sessionMs
    ) {
      pieces.push({
        start: new Date(startMs),
        end: new Date(Math.min(startMs + sessionMs, run.end.getTime())),
      });
    }
    return pieces;
  });
}

/**
 * Count the number of distinct Sunday-start weeks overlapping [start, end].
 * Delegates to ScheduleCalculationService.countWeeks as the single source of truth.
 */
export const countSundayWeeksInclusive =
  ScheduleCalculationService.countWeeks.bind(ScheduleCalculationService);

/**
 * Get the Sunday at 00:00:00 of the week that contains the given date.
 * Delegates to ScheduleCalculationService.startOfWeekSunday as the single source of truth.
 */
export const startOfWeekSunday =
  ScheduleCalculationService.startOfWeekSunday.bind(ScheduleCalculationService);

/**
 * Groups slots by UTC Sunday week for subscription/class validation — the
 * same bucketing the server validates with.
 */
export function groupSlotsByWeek(
  slots: CalendarInterval[],
  schedulingTimezone?: string,
): Map<string, CalendarInterval[]> {
  const slotsByWeek = new Map<string, CalendarInterval[]>();

  slots.forEach((slot) => {
    const weekKey = ScheduleCalculationService.weekKey(
      slot.startTime,
      schedulingTimezone,
    );

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
  slots: CalendarInterval[],
  slotsPerWeek: number,
  schedulingTimezone?: string,
): { isValid: boolean; errorMessage?: string } {
  const slotsByWeek = groupSlotsByWeek(slots, schedulingTimezone);

  for (const [weekKey, weekSlots] of Array.from(slotsByWeek.entries())) {
    if (weekSlots.length > slotsPerWeek) {
      return {
        isValid: false,
        errorMessage: `Too many slots selected for the ${formatWeekKey(weekKey)} (max ${slotsPerWeek} allowed)`,
      };
    }
  }

  return { isValid: true };
}

/**
 * FIXED: Validates that slots are consecutive within a single day.
 * This function checks if all slots are consecutive (end time of one slot = start time of next slot)
 * Uses tolerance for timezone/precision issues (within 1 second)
 */
export function validateDayBasedConsecutiveSlots(
  slots: CalendarInterval[],
  schedulingTimezone?: string,
): boolean {
  if (slots.length <= 1) return true;

  const sortedSlots = [...slots].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );

  // Check that all slots are on the same scheduling-timezone day (server parity)
  const firstSlotDay = ScheduleCalculationService.dayKey(
    sortedSlots[0].startTime,
    schedulingTimezone,
  );
  const allSameDay = sortedSlots.every(
    (slot) =>
      ScheduleCalculationService.dayKey(slot.startTime, schedulingTimezone) ===
      firstSlotDay,
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
  slots: CalendarInterval[],
  sessionDurationInHours?: number,
  maxTotalCalls?: number,
  schedulingTimezone?: string,
): string {
  if (slots.length === 0) {
    return "No slots selected";
  }

  const slotsPerCall = Math.ceil((sessionDurationInHours || 1) / 0.5);
  const completedCalls = Math.floor(slots.length / slotsPerCall);
  const incompleteCallSlots = slots.length % slotsPerCall;

  // Group by scheduling-timezone day
  const slotsByDay = new Map<string, CalendarInterval[]>();
  slots.forEach((slot) => {
    const dayKey = ScheduleCalculationService.dayKey(
      slot.startTime,
      schedulingTimezone,
    );
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
    const date = formatDayKey(incompleteDay);
    const duration = sessionDurationInHours || 1;
    const durationText = duration === 1 ? "1 hour" : `${duration} hours`;

    lines.push(
      `⚠️ ${date}: Add ${needed} more slot${needed !== 1 ? "s" : ""} to complete ${durationText} call`,
    );
  }

  return lines.join(" | ");
}
