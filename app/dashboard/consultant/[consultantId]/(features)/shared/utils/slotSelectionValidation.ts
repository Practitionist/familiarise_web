import { TimeSlot, calculateRequiredSlots } from "./calendarUtils";
import { formatDayKey, formatWeekKey } from "./allocationMessages";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";

/**
 * Pure client-side selection validation for the Allocate Slots calendar.
 * Extracted from useSlotAllocation so the rules are unit-testable and can
 * later move server-side (#997 Phase 3).
 *
 * All daily/weekly bucketing uses SlotCalculationService's day/week keys in
 * the event's scheduling timezone (default Asia/Kolkata, ADR B9) — the same
 * keys the server validates with. Browser-local bucketing here caused
 * client/server verdict divergence for slots near day boundaries.
 */

export type ClientEventType =
  | "subscription"
  | "class"
  | "webinar"
  | "consultation";

/** The subset of hook options the validators need (structurally compatible
 * with UseEventSlotAllocationOptions). */
export interface SlotValidationOptions {
  callsPerWeek?: number;
  maxHoursPerDay?: number;
  maxSessionsPerDay?: number;
  maxCallsPerDay?: number;
  maxTotalCalls?: number;
  durationInMonths?: number;
  durationInHours?: number;
  sessionDurationInHours?: number;
  startDate?: Date;
  endDate?: Date;
  pastConfirmedSlotCount?: number;
  /** Timezone that defines the limit day/week buckets (ADR B9). Comes from
   * the event's schedulingTimezone; defaults to Asia/Kolkata. */
  schedulingTimezone?: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];

  consecutiveSlotsValid?: boolean;
  dailyHoursValid?: boolean;
  dailyCallsValid?: boolean;
  totalCallsValid?: boolean;
  weeklyDistributionValid?: boolean;
  sessionDistributionValid?: boolean;
}

export interface EventConstraints {
  requireConsecutive: boolean;
  maxHoursPerDay?: number;
  maxCallsPerDay?: number;
  maxSessionsPerDay?: number;
  maxTotalCalls?: number;
  allowMultipleSessions: boolean;
  isDailyLimited: boolean;
  isOneTimeEvent: boolean;
}

export interface SlotLimits {
  minSlots: number;
  maxSlots: number;
  slotsPerSession: number;
  totalSessions: number;
}

export const dayKey = (d: Date, timeZone?: string): string =>
  SlotCalculationService.dayKey(d, timeZone);

export const weekKey = (d: Date, timeZone?: string): string =>
  SlotCalculationService.weekKey(d, timeZone);

/**
 * Get event-specific constraints based on event type
 */
export function getEventConstraints(
  eventType: ClientEventType,
  options: SlotValidationOptions,
): EventConstraints {
  switch (eventType) {
    case "webinar":
      return {
        requireConsecutive: true,
        allowMultipleSessions: false,
        isDailyLimited: false,
        isOneTimeEvent: true,
      };

    case "class":
      return {
        requireConsecutive: false,
        // Max 2 classes permissible on the same day
        maxHoursPerDay:
          options.maxHoursPerDay || (options.sessionDurationInHours || 1) * 2,
        maxSessionsPerDay: options.maxSessionsPerDay || 2,
        allowMultipleSessions: true,
        isDailyLimited: true,
        isOneTimeEvent: false,
      };

    case "subscription":
      return {
        requireConsecutive: true, // individual calls must be consecutive within the same day
        maxCallsPerDay: options.maxCallsPerDay || 1,
        maxTotalCalls: options.maxTotalCalls,
        allowMultipleSessions: false,
        isDailyLimited: true,
        isOneTimeEvent: false,
      };

    case "consultation":
      return {
        requireConsecutive: true, // consultations are a single same-day block
        allowMultipleSessions: false,
        isDailyLimited: true,
        isOneTimeEvent: true,
      };

    default:
      throw new Error(`Unsupported event type: ${eventType}`);
  }
}

/**
 * Get slot allocation limits based on event type and configuration
 */
export function getSlotLimits(
  eventType: ClientEventType,
  options: SlotValidationOptions,
): SlotLimits {
  // Use the appropriate duration field based on event type
  const duration =
    eventType === "consultation" || eventType === "webinar"
      ? options.durationInHours
      : options.sessionDurationInHours;

  const requiredSlots = calculateRequiredSlots(
    eventType,
    options.durationInMonths,
    options.callsPerWeek,
    duration,
    options.startDate,
    options.endDate,
  );

  switch (eventType) {
    case "webinar": {
      const webinarSlots = Math.ceil((options.durationInHours || 1) / 0.5);
      return {
        minSlots: webinarSlots,
        maxSlots: webinarSlots,
        slotsPerSession: webinarSlots,
        totalSessions: 1,
      };
    }

    case "class": {
      const sessionSlots = Math.ceil(
        (options.sessionDurationInHours || 1) / 0.5,
      );
      // maxTotalCalls (from classPlan.totalSessions) is authoritative when
      // provided; otherwise fall back to the period-based calculation.
      const effectiveTotalSessions =
        options.maxTotalCalls && options.maxTotalCalls > 0
          ? options.maxTotalCalls
          : Math.ceil(requiredSlots / sessionSlots);
      const effectiveMaxSlots = effectiveTotalSessions * sessionSlots;
      return {
        minSlots: effectiveMaxSlots,
        maxSlots: effectiveMaxSlots,
        slotsPerSession: sessionSlots,
        totalSessions: effectiveTotalSessions,
      };
    }

    case "subscription": {
      const subscriptionSessionSlots = Math.ceil(
        (options.sessionDurationInHours || 1) / 0.5,
      );
      const totalCalls = Math.ceil(requiredSlots / subscriptionSessionSlots);
      const rawMaxCalls = options.maxTotalCalls || totalCalls;
      // Subtract past completed sessions so the interactive guard caps at
      // remaining sessions for in-progress events.
      const pastSessions = Math.floor(
        (options.pastConfirmedSlotCount || 0) / subscriptionSessionSlots,
      );
      return {
        minSlots: requiredSlots,
        maxSlots: rawMaxCalls - pastSessions,
        slotsPerSession: subscriptionSessionSlots,
        totalSessions: totalCalls,
      };
    }

    case "consultation": {
      const consultationSlots = Math.ceil((options.durationInHours || 1) / 0.5);
      return {
        minSlots: consultationSlots,
        maxSlots: consultationSlots,
        slotsPerSession: consultationSlots,
        totalSessions: 1,
      };
    }

    default:
      return {
        minSlots: 0,
        maxSlots: 0,
        slotsPerSession: 0,
        totalSessions: 0,
      };
  }
}

/**
 * Groups an array of time slots by scheduling-timezone day.
 */
export function groupSlotsByDay(
  slots: TimeSlot[],
  timeZone?: string,
): Map<string, TimeSlot[]> {
  const slotsByDay = new Map<string, TimeSlot[]>();
  slots.forEach((slot) => {
    const key = dayKey(slot.startTime, timeZone);
    if (!slotsByDay.has(key)) {
      slotsByDay.set(key, []);
    }
    slotsByDay.get(key)!.push(slot);
  });
  return slotsByDay;
}

/**
 * Counts the number of complete calls from a map of day-grouped slots.
 */
export function countCompleteCallsInMap(
  slotsByDay: Map<string, TimeSlot[]>,
  slotsPerCall: number,
): number {
  let completeCalls = 0;
  slotsByDay.forEach((daySlots) => {
    if (isCompleteCall(daySlots, slotsPerCall)) {
      completeCalls++;
    }
  });
  return completeCalls;
}

/**
 * Validate that slots are consecutive (for webinars/consultations)
 */
export function validateConsecutiveSlots(slots: TimeSlot[]): boolean {
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
 * Counts complete class sessions within a single day based on slotsPerSession.
 * Adjacent sessions are allowed (e.g., 09:00-10:00 and 10:00-11:00 count as 2).
 */
export function countSessionsForDay(
  daySlots: TimeSlot[],
  slotsPerSession: number,
): { sessions: number; leftoverSlots: number } {
  if (daySlots.length === 0) return { sessions: 0, leftoverSlots: 0 };

  const sorted = [...daySlots].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );

  let runCount = 0;
  let sessions = 0;
  let lastEnd: number | null = null;

  for (const s of sorted) {
    if (lastEnd !== null && s.startTime.getTime() !== lastEnd) {
      sessions += Math.floor(runCount / slotsPerSession);
      runCount = 0;
    }
    runCount += 1;
    lastEnd = s.endTime.getTime();
    if (runCount >= slotsPerSession) {
      sessions += Math.floor(runCount / slotsPerSession);
      runCount = runCount % slotsPerSession;
    }
  }

  return { sessions, leftoverSlots: runCount };
}

/**
 * Validate max sessions per day for classes using slotsPerSession semantics.
 */
export function validateClassSessionDistributionByCount(
  slots: TimeSlot[],
  maxSessions: number,
  slotsPerSession: number,
  timeZone?: string,
): boolean {
  if (slots.length === 0) return true;
  for (const [, daySlots] of Array.from(groupSlotsByDay(slots, timeZone))) {
    const { sessions } = countSessionsForDay(daySlots, slotsPerSession);
    if (sessions > maxSessions) return false;
  }
  return true;
}

/**
 * Validate weekly distribution for classes using complete session count per week.
 */
export function validateWeeklySessionsDistribution(
  slots: TimeSlot[],
  callsPerWeek: number,
  slotsPerSession: number,
  timeZone?: string,
): boolean {
  if (slots.length === 0) return true;
  const weeks = new Map<string, Map<string, TimeSlot[]>>();
  for (const slot of slots) {
    const wk = weekKey(slot.startTime, timeZone);
    if (!weeks.has(wk)) weeks.set(wk, new Map());
    const byDay = weeks.get(wk)!;
    const dk = dayKey(slot.startTime, timeZone);
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk)!.push(slot);
  }
  for (const [, byDay] of Array.from(weeks)) {
    let weekSessions = 0;
    for (const [, daySlots] of Array.from(byDay)) {
      weekSessions += countSessionsForDay(daySlots, slotsPerSession).sessions;
    }
    if (weekSessions > callsPerWeek) return false;
  }
  return true;
}

/**
 * Validate daily hours limit (for classes)
 */
export function validateDailyHours(
  slots: TimeSlot[],
  maxHours: number,
  timeZone?: string,
): boolean {
  const dailyHours = new Map<string, number>();

  slots.forEach((slot) => {
    const dateKey = dayKey(slot.startTime, timeZone);
    const duration =
      (slot.endTime.getTime() - slot.startTime.getTime()) / (1000 * 60 * 60);
    dailyHours.set(dateKey, (dailyHours.get(dateKey) || 0) + duration);
  });

  return Array.from(dailyHours.values()).every((hours) => hours <= maxHours);
}

/**
 * Validate weekly distribution (for recurring events)
 */
export function validateWeeklyDistribution(
  slots: TimeSlot[],
  callsPerWeek: number,
  slotsPerSession?: number,
  timeZone?: string,
): boolean {
  const weeklySlots = new Map<string, number>();

  slots.forEach((slot) => {
    const wk = weekKey(slot.startTime, timeZone);
    weeklySlots.set(wk, (weeklySlots.get(wk) || 0) + 1);
  });

  // Convert slot count to call count before comparing against callsPerWeek
  const slotMultiplier = slotsPerSession || 1;
  return Array.from(weeklySlots.values()).every(
    (slotCount) => Math.floor(slotCount / slotMultiplier) <= callsPerWeek,
  );
}

/**
 * Check if slots form a complete call (consecutive slots on same day)
 */
export function isCompleteCall(
  daySlots: TimeSlot[],
  slotsPerCall: number,
): boolean {
  if (daySlots.length !== slotsPerCall) return false;

  const sortedSlots = [...daySlots].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );

  for (let i = 1; i < sortedSlots.length; i++) {
    const prevEnd = sortedSlots[i - 1].endTime.getTime();
    const currentStart = sortedSlots[i].startTime.getTime();
    if (currentStart !== prevEnd) return false;
  }

  return true;
}

/**
 * Finds the maximal consecutive group of slots that contains the given slot,
 * within a sorted array of same-day slots.
 * Used for group deselection: clicking any slot in a session deselects the
 * entire session.
 */
export function findConsecutiveGroupContaining(
  targetSlot: TimeSlot,
  sortedDaySlots: TimeSlot[],
): TimeSlot[] {
  if (sortedDaySlots.length === 0) return [targetSlot];

  const targetIndex = sortedDaySlots.findIndex(
    (s) => s.startTime.getTime() === targetSlot.startTime.getTime(),
  );

  if (targetIndex === -1) return [targetSlot];

  let startIdx = targetIndex;
  while (startIdx > 0) {
    const prev = sortedDaySlots[startIdx - 1];
    const curr = sortedDaySlots[startIdx];
    if (prev.endTime.getTime() === curr.startTime.getTime()) {
      startIdx--;
    } else {
      break;
    }
  }

  let endIdx = targetIndex;
  while (endIdx < sortedDaySlots.length - 1) {
    const curr = sortedDaySlots[endIdx];
    const next = sortedDaySlots[endIdx + 1];
    if (curr.endTime.getTime() === next.startTime.getTime()) {
      endIdx++;
    } else {
      break;
    }
  }

  return sortedDaySlots.slice(startIdx, endIdx + 1);
}

export interface SubscriptionSlotValidation {
  dailyCallsValid: boolean;
  totalCallsValid: boolean;
  weeklyCallsValid: boolean;
  dailyCallsError?: string;
  totalCallsError?: string;
  weeklyCallsError?: string;
  incompleteCallWarning?: string;
}

export function validateSubscriptionSlots(
  slots: TimeSlot[],
  options: SlotValidationOptions,
  limits: SlotLimits,
): SubscriptionSlotValidation {
  if (!slots || !Array.isArray(slots)) {
    return {
      dailyCallsValid: false,
      totalCallsValid: false,
      weeklyCallsValid: false,
      dailyCallsError: "Invalid slots provided",
    };
  }

  if (!options) {
    return {
      dailyCallsValid: false,
      totalCallsValid: false,
      weeklyCallsValid: false,
      dailyCallsError: "Invalid options provided",
    };
  }

  const { slotsPerSession: slotsPerCall } = limits;
  const callsPerWeek = options.callsPerWeek || 1;
  const maxTotalCalls = limits.maxSlots;
  const timeZone = options.schedulingTimezone;

  const slotsByDay = groupSlotsByDay(slots, timeZone);

  const weekCalls = new Map<
    string,
    { completeCallsCount: number; totalSlots: number }
  >();

  slotsByDay.forEach((daySlots) => {
    const wk = weekKey(daySlots[0].startTime, timeZone);

    if (!weekCalls.has(wk)) {
      weekCalls.set(wk, { completeCallsCount: 0, totalSlots: 0 });
    }

    const weekData = weekCalls.get(wk)!;
    weekData.totalSlots += daySlots.length;

    if (isCompleteCall(daySlots, slotsPerCall)) {
      weekData.completeCallsCount++;
    }
  });

  let dailyCallsValid = true;
  let dailyCallsError: string | undefined;
  let weeklyCallsValid = true;
  let weeklyCallsError: string | undefined;
  let totalCallsValid = true;
  let totalCallsError: string | undefined;
  let incompleteCallWarning: string | undefined;

  // Each day can only carry one complete, consecutive call
  slotsByDay.forEach((daySlots, day) => {
    if (daySlots.length > slotsPerCall) {
      dailyCallsValid = false;
      dailyCallsError = `Only 1 session per day allowed. ${formatDayKey(day)} already has a complete session selected — choose a different day.`;
      return;
    }

    if (daySlots.length > 1 && !isCompleteCall(daySlots, slotsPerCall)) {
      dailyCallsValid = false;
      dailyCallsError = `Slots for ${formatDayKey(day)} must be consecutive and complete (${slotsPerCall} slots total).`;
      return;
    }
  });

  weekCalls.forEach((weekData, wk) => {
    const completeCalls = weekData.completeCallsCount;
    const partialSlots = weekData.totalSlots % slotsPerCall;

    if (partialSlots > 0) {
      incompleteCallWarning = `The ${formatWeekKey(wk)} has an incomplete call. Need ${slotsPerCall - partialSlots} more consecutive slots.`;
    }

    if (completeCalls > callsPerWeek) {
      weeklyCallsValid = false;
      weeklyCallsError = `The ${formatWeekKey(wk)} has ${completeCalls} complete calls. Maximum ${callsPerWeek} calls per week allowed.`;
      return;
    }
  });

  const totalConfirmedCalls = Array.from(weekCalls.values()).reduce(
    (sum, week) => sum + week.completeCallsCount,
    0,
  );

  if (maxTotalCalls && totalConfirmedCalls > maxTotalCalls) {
    totalCallsValid = false;
    totalCallsError = `Maximum ${maxTotalCalls} calls allowed for this subscription. Currently have ${totalConfirmedCalls} confirmed calls.`;
  }

  return {
    dailyCallsValid,
    totalCallsValid,
    weeklyCallsValid,
    dailyCallsError,
    totalCallsError,
    weeklyCallsError,
    incompleteCallWarning,
  };
}

/**
 * Validate slots based on event-specific rules
 */
export function validateEventSlots(
  slots: TimeSlot[],
  eventType: ClientEventType,
  constraints: EventConstraints,
  limits: SlotLimits,
  options: SlotValidationOptions,
): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
  };

  // Empty selection is valid during interactive selection
  if (slots.length === 0) {
    return result;
  }

  const timeZone = options.schedulingTimezone;

  // Basic slot count validation
  if (eventType === "subscription") {
    // Subscriptions validate on complete call count, not slot count
    const slotsByDay = groupSlotsByDay(slots, timeZone);
    const completeCalls = countCompleteCallsInMap(
      slotsByDay,
      limits.slotsPerSession,
    );

    if (completeCalls > limits.maxSlots) {
      result.isValid = false;
      result.errors.push(
        `Maximum ${limits.maxSlots} calls allowed for this subscription (${completeCalls} complete calls selected)`,
      );
    }

    const requiredCalls = Math.ceil(limits.minSlots / limits.slotsPerSession);

    if (completeCalls < requiredCalls) {
      result.warnings.push(
        `Need ${requiredCalls - completeCalls} more calls for this subscription (${completeCalls}/${requiredCalls} complete calls selected)`,
      );
    }
  } else {
    if (slots.length > limits.maxSlots) {
      result.isValid = false;
      result.errors.push(
        `Maximum ${limits.maxSlots} slots allowed for this ${eventType} (${slots.length} selected)`,
      );
    }

    if (slots.length < limits.minSlots) {
      result.warnings.push(
        `Need ${limits.minSlots - slots.length} more slots for this ${eventType} (${slots.length}/${limits.minSlots} selected)`,
      );
    }
  }

  // Event-specific validation
  switch (eventType) {
    case "webinar":
      result.consecutiveSlotsValid = validateConsecutiveSlots(slots);

      // Only enforce error if user has selected all required slots
      if (slots.length >= limits.minSlots && !result.consecutiveSlotsValid) {
        result.isValid = false;
        result.errors.push("Webinar slots must be consecutive");
      } else if (!result.consecutiveSlotsValid && slots.length > 1) {
        result.warnings.push(
          "Select consecutive slots to complete the webinar",
        );
      }
      break;

    case "class": {
      const slotsPerSession = limits.slotsPerSession;
      result.dailyHoursValid = validateDailyHours(
        slots,
        constraints.maxHoursPerDay!,
        timeZone,
      );

      // Days with a slot count that isn't a multiple of slotsPerSession are
      // in-progress; informational only — interactive blocking happens in
      // toggleSlot so users can start a class by selecting the first slot.
      const byDay = groupSlotsByDay(slots, timeZone);
      const hasInProgress = Array.from(byDay.values()).some(
        (count) => count.length % slotsPerSession !== 0,
      );

      const sessionsPerDayOk = validateClassSessionDistributionByCount(
        slots,
        constraints.maxSessionsPerDay || 2,
        slotsPerSession,
        timeZone,
      );

      const weeklyOk = validateWeeklySessionsDistribution(
        slots,
        options.callsPerWeek || 1,
        slotsPerSession,
        timeZone,
      );

      result.sessionDistributionValid = sessionsPerDayOk;
      result.weeklyDistributionValid = weeklyOk;

      if (!result.dailyHoursValid) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${constraints.maxHoursPerDay} hours per day exceeded`,
        );
      }
      if (hasInProgress) {
        result.warnings.push(
          `A class is in progress. Select the adjacent slot to complete it.`,
        );
      }
      if (!sessionsPerDayOk) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${constraints.maxSessionsPerDay || 2} classes per day exceeded`,
        );
      }
      if (!weeklyOk) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${options.callsPerWeek || 1} classes per week exceeded`,
        );
      }
      break;
    }

    case "subscription": {
      const subscriptionValidation = validateSubscriptionSlots(
        slots,
        options,
        limits,
      );
      result.dailyCallsValid = subscriptionValidation.dailyCallsValid;
      result.totalCallsValid = subscriptionValidation.totalCallsValid;
      result.weeklyDistributionValid = subscriptionValidation.weeklyCallsValid;

      if (!result.dailyCallsValid) {
        result.isValid = false;
        result.errors.push(
          subscriptionValidation.dailyCallsError || "Daily call limit exceeded",
        );
      }

      if (!result.totalCallsValid) {
        result.isValid = false;
        result.errors.push(
          subscriptionValidation.totalCallsError || "Total call limit exceeded",
        );
      }

      if (!result.weeklyDistributionValid) {
        result.isValid = false;
        result.errors.push(
          subscriptionValidation.weeklyCallsError ||
            "Weekly call limit exceeded",
        );
      }

      if (subscriptionValidation.incompleteCallWarning) {
        result.warnings.push(subscriptionValidation.incompleteCallWarning);
      }
      break;
    }

    case "consultation":
      // Same scheduling-timezone day first (matches the server's same-day
      // rule), then consecutiveness.
      if (slots.length > 1) {
        const firstSlotDay = dayKey(slots[0].startTime, timeZone);
        const allSameDay = slots.every(
          (slot) => dayKey(slot.startTime, timeZone) === firstSlotDay,
        );
        if (!allSameDay) {
          result.isValid = false;
          result.errors.push(
            "Consultation is a one-day event - all slots must be on the same day",
          );
        }

        result.consecutiveSlotsValid = validateConsecutiveSlots(slots);
        if (!result.consecutiveSlotsValid) {
          result.isValid = false;
          result.errors.push(
            "Consultation slots must be consecutive within the same day",
          );
        }
      }
      break;
  }

  // Weekly distribution soft check for subscriptions
  if (
    eventType === "subscription" &&
    options.callsPerWeek &&
    slots.length > 0
  ) {
    result.weeklyDistributionValid = validateWeeklyDistribution(
      slots,
      options.callsPerWeek,
      limits.slotsPerSession,
      timeZone,
    );
    if (!result.weeklyDistributionValid) {
      result.warnings.push(
        `Consider distributing calls more evenly across weeks`,
      );
    }
  }

  if (eventType === "class" && options.callsPerWeek && slots.length > 0) {
    const slotsPerSession = limits.slotsPerSession;
    const ok = validateWeeklySessionsDistribution(
      slots,
      options.callsPerWeek,
      slotsPerSession,
      timeZone,
    );
    if (!ok) {
      result.weeklyDistributionValid = false;
      result.warnings.push(
        `Consider distributing classes more evenly across weeks`,
      );
    }
  }

  return result;
}
