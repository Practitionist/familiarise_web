import { useState, useCallback, useEffect, useMemo } from "react";
import { useToast } from "@/components/ui/use-toast";
import {
  TimeSlot,
  calculateRequiredSlots,
  countSundayWeeksInclusive,
} from "../utils/calendarUtils";
import { startOfWeek } from "date-fns";
import {
  AllocationAlgorithms,
  AllocationOptions,
  AllocationResult,
} from "../utils/allocationAlgorithms";
import { AllocationService } from "../utils/allocationService";

/**
 * ENHANCED EVENT SLOT ALLOCATION HOOK
 * ==================================
 *
 * This hook provides a unified interface for managing slot allocation across all event types
 * with event-specific constraints and validation rules.
 *
 * EVENT TYPES SUPPORTED:
 * - Webinars: Consecutive slots required, use durationInHours for total webinar duration
 * - Classes: Sessions-based, max 3 sessions/day, use durationInMonths + sessionDurationInHours
 * - Subscriptions: 1 call/day limit, use durationInMonths + sessionDurationInHours per call
 * - Consultations: One-time events, use durationInHours for consultation duration
 *
 * DURATION FIELD USAGE:
 * - durationInHours: For consultations & webinars (single session duration)
 * - durationInMonths: For subscriptions & classes (overall plan duration)
 * - sessionDurationInHours: For subscriptions & classes (each individual session duration)
 *
 * SLOT CALCULATION EXAMPLES:
 * - 1 slot = 30 minutes
 * - 3 hours = 6 slots
 * - Class: 3 months, 2 calls/week, 3 hours/session = 24 calls × 6 slots = 144 total slots
 * - Classes can have max 3 sessions per day (other events don't have session limits)
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Validation result structure for slot allocation
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];

  // Event-specific validation flags
  consecutiveSlotsValid?: boolean; // For webinars
  dailyHoursValid?: boolean; // For classes (max 4 hours)
  dailyCallsValid?: boolean; // For subscriptions (max 1 call)
  totalCallsValid?: boolean; // For subscriptions (max total calls)
  weeklyDistributionValid?: boolean; // For subscriptions/classes
  sessionDistributionValid?: boolean; // For classes (session limits)
}

/**
 * Event-specific constraints configuration
 */
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

/**
 * Slot allocation limits for display and validation
 */
export interface SlotLimits {
  minSlots: number;
  maxSlots: number;
  slotsPerSession: number;
  totalSessions: number;
}

/**
 * Configuration options for the useEventSlotAllocation hook
 */
export interface UseEventSlotAllocationOptions {
  // ==========================================
  // REQUIRED CORE FIELDS
  // ==========================================

  /** Event type - determines validation rules and constraints */
  eventType: "subscription" | "class" | "webinar" | "consultation";

  /** Unique identifier for the event */
  eventId: string;

  /** Consultant ID for availability checking */
  consultantId: string;

  // ==========================================
  // EVENT-SPECIFIC DURATION FIELDS
  // ==========================================

  /** Duration in months for subscriptions/classes (overall plan duration) */
  durationInMonths?: number;

  /** Duration in hours for consultations/webinars (single session duration) */
  durationInHours?: number;

  /** Session duration in hours for subscriptions (each individual session) */
  sessionDurationInHours?: number;

  /** Number of calls per week for subscriptions/classes */
  callsPerWeek?: number;

  // ==========================================
  // CLASS-SPECIFIC FIELDS
  // ==========================================

  /** Maximum hours per day for classes (default: 4) */
  maxHoursPerDay?: number;

  /** Maximum sessions per day for classes */
  maxSessionsPerDay?: number;

  // ==========================================
  // SUBSCRIPTION-SPECIFIC FIELDS
  // ==========================================

  /** Maximum calls per day for subscriptions (default: 1) */
  maxCallsPerDay?: number;

  /** Fixed total number of calls for subscriptions */
  maxTotalCalls?: number;

  // ==========================================
  // WEBINAR-SPECIFIC FIELDS
  // ==========================================

  /** Whether slots must be consecutive (required for webinars) */
  requireConsecutive?: boolean;

  // ==========================================
  // ADDITIONAL CONFIGURATION FIELDS
  // ==========================================

  /** Plan ID for fetching detailed plan information */
  planId?: string;

  /** Request status for filtering and validation */
  requestStatus?: "PENDING" | "APPROVED" | "REJECTED";

  /** Allocation method preference */
  allocationType?: "AUTO" | "MANUAL" | "REQUESTED";

  /** Consultant's schedule type (WEEKLY or CUSTOM) */
  scheduleType?: "WEEKLY" | "CUSTOM";

  // ==========================================
  // TIME CONSTRAINTS
  // ==========================================

  /** Earliest allowed slot date */
  startDate?: Date;

  /** Latest allowed slot date */
  endDate?: Date;

  /** Preferred time slots (if any) */
  preferredTimeSlots?: TimeSlot[];

  /** Timezone for slot calculations */
  timezone?: string;

  // ==========================================
  // BUSINESS RULES
  // ==========================================

  /** Whether to allow weekend slots */
  allowWeekends?: boolean;

  /** Whether to allow evening slots */
  allowEvenings?: boolean;

  /** Whether to check for conflicts with existing appointments */
  checkConflicts?: boolean;

  /** Allow overriding conflicts */
  allowOverride?: boolean;

  // ==========================================
  // PERFORMANCE OPTIONS
  // ==========================================

  /** Enable caching of availability data */
  enableCaching?: boolean;

  /** Auto-refetch interval in milliseconds */
  refetchInterval?: number;

  // ==========================================
  // CALLBACKS
  // ==========================================

  /** Success callback with allocation result */
  onSuccess?: (result: AllocationResult) => void;

  /** Error callback with error message */
  onError?: (error: string) => void;

  /** Validation change callback */
  onValidationChange?: (isValid: boolean, result: ValidationResult) => void;

  /** Slot selection change callback */
  onSlotsChange?: (slots: TimeSlot[]) => void;
}

/**
 * Return interface for the useEventSlotAllocation hook
 */
export interface UseEventSlotAllocationReturn {
  // ==========================================
  // STATE MANAGEMENT
  // ==========================================

  /** Currently selected slots */
  selectedSlots: TimeSlot[];

  /** Set selected slots directly */
  setSelectedSlots: (slots: TimeSlot[]) => void;

  /** Whether allocation is in progress */
  isAllocating: boolean;

  /** Current allocation error message */
  allocationError: string | null;

  /** Whether current selection is valid */
  isValid: boolean;

  /** Detailed validation result */
  validationResult: ValidationResult;

  // ==========================================
  // COMPUTED VALUES
  // ==========================================

  /** Number of slots required for this event */
  requiredSlots: number;

  /** Whether allocation can proceed */
  canAllocate: boolean;

  /** Current validation errors */
  validationErrors: string[];

  /** Current validation warnings */
  validationWarnings: string[];

  /** Event-specific constraints */
  eventConstraints: EventConstraints;

  /** Slot allocation limits */
  slotLimits: SlotLimits;

  // ==========================================
  // SLOT MANAGEMENT FUNCTIONS
  // ==========================================

  /** Toggle slot selection with event-specific validation */
  toggleSlot: (slot: TimeSlot) => void;

  /** Clear all selected slots */
  clearSlots: () => void;

  /** Check if a slot is currently selected */
  isSlotSelected: (slot: TimeSlot) => boolean;

  /** Add multiple slots with validation */
  addSlots: (slots: TimeSlot[]) => void;

  /** Remove specific slots */
  removeSlots: (slots: TimeSlot[]) => void;

  // ==========================================
  // ALLOCATION METHODS
  // ==========================================

  /** Allocate using manually selected slots */
  manualAllocate: () => Promise<void>;

  /** Auto-allocate using available slots */
  autoAllocate: (availableSlots: TimeSlot[]) => Promise<void>;

  /** Pre-allocate using requested slots */
  preAllocate: (requestedSlots: TimeSlot[]) => Promise<void>;

  // ==========================================
  // VALIDATION FUNCTIONS
  // ==========================================

  /** Validate current slot selection */
  validateSlots: () => ValidationResult;

  /** Validate specific slots without selecting them */
  validateSlotsPreview: (slots: TimeSlot[]) => ValidationResult;

  // ==========================================
  // EVENT-SPECIFIC HELPERS
  // ==========================================

  /** Get event-specific constraints */
  getEventConstraints: () => EventConstraints;

  /** Get slot allocation limits */
  getSlotLimits: () => SlotLimits;

  /** Check if adding a slot would be valid */
  canAddSlot: (slot: TimeSlot) => boolean;

  /** Get suggestions for optimal slot selection */
  getSlotSuggestions: (availableSlots: TimeSlot[]) => TimeSlot[];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get event-specific constraints based on event type
 */
function getEventConstraints(
  eventType: UseEventSlotAllocationOptions["eventType"],
  options: UseEventSlotAllocationOptions
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
        requireConsecutive: true, // FIXED: Individual calls must be consecutive within the same day
        maxCallsPerDay: options.maxCallsPerDay || 1,
        maxTotalCalls: options.maxTotalCalls,
        allowMultipleSessions: false,
        isDailyLimited: true,
        isOneTimeEvent: false,
      };

    case "consultation":
      return {
        requireConsecutive: true, // FIXED: Consultations must be consecutive (same day)
        allowMultipleSessions: false,
        isDailyLimited: true, // FIXED: Consultations must happen on the same day
        isOneTimeEvent: true,
      };

    default:
      throw new Error(`Unsupported event type: ${eventType}`);
  }
}

/**
 * Get slot allocation limits based on event type and configuration
 */
function getSlotLimits(
  eventType: UseEventSlotAllocationOptions["eventType"],
  options: UseEventSlotAllocationOptions
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
    options.endDate
  );

  switch (eventType) {
    case "webinar": {
      const webinarSlots = Math.ceil((options.durationInHours || 1) / 0.5); // 30-min intervals
      return {
        minSlots: webinarSlots,
        maxSlots: webinarSlots,
        slotsPerSession: webinarSlots,
        totalSessions: 1,
      };
    }

    case "class": {
      const sessionSlots = Math.ceil(
        (options.sessionDurationInHours || 1) / 0.5
      );
      return {
        minSlots: requiredSlots,
        maxSlots: requiredSlots,
        slotsPerSession: sessionSlots,
        totalSessions: Math.ceil(requiredSlots / sessionSlots),
      };
    }

    case "subscription": {
      const subscriptionSessionSlots = Math.ceil(
        (options.sessionDurationInHours || 1) / 0.5
      );
      // FIXED: Calculate actual call count for maxSlots (not slot count)
      const totalCalls = Math.ceil(requiredSlots / subscriptionSessionSlots);
      return {
        minSlots: requiredSlots,
        maxSlots: options.maxTotalCalls || totalCalls, // ✅ Use call count, not slot count
        slotsPerSession: subscriptionSessionSlots,
        totalSessions: totalCalls, // ✅ Also use call count for sessions
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
 * Validate slots based on event-specific rules
 */
function validateEventSlots(
  slots: TimeSlot[],
  eventType: UseEventSlotAllocationOptions["eventType"],
  constraints: EventConstraints,
  limits: SlotLimits,
  options: UseEventSlotAllocationOptions
): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
  };

  // Early return for empty selection - this is valid during interactive selection
  if (slots.length === 0) {
    return result;
  }

  // Basic slot count validation
  if (eventType === "subscription") {
    // FIXED: For subscriptions, validate based on complete call count, not slot count
    const slotsByDay = groupSlotsByDay(slots);
    const completeCalls = countCompleteCallsInMap(
      slotsByDay,
      limits.slotsPerSession
    );

    if (completeCalls > limits.maxSlots) {
      result.isValid = false;
      result.errors.push(
        `Maximum ${limits.maxSlots} calls allowed for this subscription (${completeCalls} complete calls selected)`
      );
    }
  } else {
    // For other event types, validate based on slot count
    if (slots.length > limits.maxSlots) {
      result.isValid = false;
      result.errors.push(
        `Maximum ${limits.maxSlots} slots allowed for this ${eventType} (${slots.length} selected)`
      );
    }
  }

  // For interactive selection, only warn about minimum slots
  if (eventType === "subscription") {
    // FIXED: For subscriptions, warn based on complete call count, not slot count
    const slotsByDay = groupSlotsByDay(slots);
    const completeCalls = countCompleteCallsInMap(
      slotsByDay,
      limits.slotsPerSession
    );

    const requiredCalls = Math.ceil(limits.minSlots / limits.slotsPerSession);

    if (completeCalls < requiredCalls) {
      result.warnings.push(
        `Need ${requiredCalls - completeCalls} more calls for this subscription (${completeCalls}/${requiredCalls} complete calls selected)`
      );
    }
  } else {
    // For other event types, warn based on slot count
    if (slots.length < limits.minSlots) {
      result.warnings.push(
        `Need ${limits.minSlots - slots.length} more slots for this ${eventType} (${slots.length}/${limits.minSlots} selected)`
      );
    }
  }

  // Event-specific validation
  switch (eventType) {
    case "webinar":
      result.consecutiveSlotsValid = validateConsecutiveSlots(slots);
      if (!result.consecutiveSlotsValid) {
        result.isValid = false;
        result.errors.push("Webinar slots must be consecutive");
      }
      break;

    case "class": {
      const slotsPerSession = limits.slotsPerSession;
      result.dailyHoursValid = validateDailyHours(
        slots,
        constraints.maxHoursPerDay!
      );

      // Detect any day where selected slot count is not a multiple of slotsPerSession (in-progress)
      // NOTE: This is informational only here; interactive blocking is handled in toggleSlot so that
      // users can start a class by selecting the first slot.
      const byDay = groupSlotsByDay(slots);
      const hasInProgress = Array.from(byDay.values()).some(
        (count) => count.length % slotsPerSession !== 0
      );

      // Validate max 2 classes/day using completed-session counting
      const sessionsPerDayOk = validateClassSessionDistributionByCount(
        slots,
        constraints.maxSessionsPerDay || 2,
        slotsPerSession
      );

      // Validate weekly class cap using complete sessions per week
      const weeklyOk = validateWeeklySessionsDistribution(
        slots,
        options.callsPerWeek || 1,
        slotsPerSession
      );

      // Do not mark invalid just because a class is in progress. This allows the first slot to be selected.
      result.sessionDistributionValid = sessionsPerDayOk;
      result.weeklyDistributionValid = weeklyOk;

      if (!result.dailyHoursValid) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${constraints.maxHoursPerDay} hours per day exceeded`
        );
      }
      // If in-progress exists, surface as a warning rather than hard error; interactive guards ensure correctness.
      if (hasInProgress) {
        result.warnings.push(
          `A class is in progress. Select the adjacent slot to complete it.`
        );
      }
      if (!sessionsPerDayOk) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${constraints.maxSessionsPerDay || 2} classes per day exceeded`
        );
      }
      if (!weeklyOk) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${options.callsPerWeek || 1} classes per week exceeded`
        );
      }
      break;
    }

    case "subscription": {
      // FIXED: Use synchronous validation with optional server-side enhancement
      const subscriptionValidation = validateSubscriptionSlots(
        slots,
        options,
        limits
      );
      result.dailyCallsValid = subscriptionValidation.dailyCallsValid;
      result.totalCallsValid = subscriptionValidation.totalCallsValid;
      result.weeklyDistributionValid = subscriptionValidation.weeklyCallsValid;

      if (!result.dailyCallsValid) {
        result.isValid = false;
        result.errors.push(
          subscriptionValidation.dailyCallsError || "Daily call limit exceeded"
        );
      }

      if (!result.totalCallsValid) {
        result.isValid = false;
        result.errors.push(
          subscriptionValidation.totalCallsError || "Total call limit exceeded"
        );
      }

      if (!result.weeklyDistributionValid) {
        result.isValid = false;
        result.errors.push(
          subscriptionValidation.weeklyCallsError ||
            "Weekly call limit exceeded"
        );
      }

      // Add warnings for incomplete calls during selection
      if (subscriptionValidation.incompleteCallWarning) {
        result.warnings.push(subscriptionValidation.incompleteCallWarning);
      }
      break;
    }

    case "consultation":
      // FIXED: Enhanced validation for consultations with multiple slots

      // FIXED: Check same-day requirement FIRST (before consecutive check)
      if (slots.length > 1) {
        const firstSlotDay = slots[0].startTime.toDateString();
        const allSameDay = slots.every(
          (slot) => slot.startTime.toDateString() === firstSlotDay
        );
        if (!allSameDay) {
          result.isValid = false;
          result.errors.push(
            "Consultation is a one-day event - all slots must be on the same day"
          );
        }
      }

      // FIXED: Only check consecutiveness if all slots are on the same day
      if (slots.length > 1) {
        result.consecutiveSlotsValid = validateConsecutiveSlots(slots);
        if (!result.consecutiveSlotsValid) {
          result.isValid = false;
          result.errors.push(
            "Consultation slots must be consecutive within the same day"
          );
        }
      }
      break;
  }

  // Weekly distribution validation for recurring events
  if (
    eventType === "subscription" &&
    options.callsPerWeek &&
    slots.length > 0
  ) {
    result.weeklyDistributionValid = validateWeeklyDistribution(
      slots,
      options.callsPerWeek
    );
    if (!result.weeklyDistributionValid) {
      result.warnings.push(
        `Consider distributing calls more evenly across weeks`
      );
    }
  }

  if (eventType === "class" && options.callsPerWeek && slots.length > 0) {
    const slotsPerSession = limits.slotsPerSession;
    const ok = validateWeeklySessionsDistribution(
      slots,
      options.callsPerWeek,
      slotsPerSession
    );
    if (!ok) {
      result.weeklyDistributionValid = false;
      result.warnings.push(
        `Consider distributing classes more evenly across weeks`
      );
    }
  }

  return result;
}

// ============================================================================
// VALIDATION HELPER FUNCTIONS
// ============================================================================

/**
 * Groups an array of time slots by day.
 */
function groupSlotsByDay(slots: TimeSlot[]): Map<string, TimeSlot[]> {
  const slotsByDay = new Map<string, TimeSlot[]>();
  slots.forEach((slot) => {
    const dayKey = slot.startTime.toDateString();
    if (!slotsByDay.has(dayKey)) {
      slotsByDay.set(dayKey, []);
    }
    slotsByDay.get(dayKey)!.push(slot);
  });
  return slotsByDay;
}

/**
 * Counts the number of complete calls from a map of day-grouped slots.
 */
function countCompleteCallsInMap(
  slotsByDay: Map<string, TimeSlot[]>,
  slotsPerCall: number
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
 * Counts the number of complete sessions from a map of day-grouped slots (for classes).
 */
function countCompleteSessionsInMap(
  slotsByDay: Map<string, TimeSlot[]>,
  slotsPerSession: number
): number {
  let completeSessions = 0;
  slotsByDay.forEach((daySlots) => {
    const { sessions } = countSessionsForDay(daySlots, slotsPerSession);
    completeSessions += sessions;
  });
  return completeSessions;
}

/**
 * Validate that slots are consecutive (for webinars)
 */
function validateConsecutiveSlots(slots: TimeSlot[]): boolean {
  if (slots.length <= 1) return true;

  const sortedSlots = [...slots].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime()
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
 * Adjacent sessions are allowed (e.g., 09:00-10:00 and 10:00-11:00 should count as 2).
 */
function countSessionsForDay(
  daySlots: TimeSlot[],
  slotsPerSession: number
): { sessions: number; leftoverSlots: number } {
  if (daySlots.length === 0) return { sessions: 0, leftoverSlots: 0 };

  const sorted = [...daySlots].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime()
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
function validateClassSessionDistributionByCount(
  slots: TimeSlot[],
  maxSessions: number,
  slotsPerSession: number
): boolean {
  if (slots.length === 0) return true;
  const slotsByDate = new Map<string, TimeSlot[]>();
  for (const slot of slots) {
    const key = slot.startTime.toDateString();
    if (!slotsByDate.has(key)) slotsByDate.set(key, []);
    slotsByDate.get(key)!.push(slot);
  }
  for (const daySlots of slotsByDate.values()) {
    const { sessions } = countSessionsForDay(daySlots, slotsPerSession);
    if (sessions > maxSessions) {
      return false;
    }
  }
  return true;
}

/**
 * Validate weekly distribution for classes using complete session count per week.
 */
function validateWeeklySessionsDistribution(
  slots: TimeSlot[],
  callsPerWeek: number,
  slotsPerSession: number
): boolean {
  if (slots.length === 0) return true;
  const weeks = new Map<string, Map<string, TimeSlot[]>>();
  for (const slot of slots) {
    const weekStart = new Date(slot.startTime);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekKey = weekStart.toISOString().split("T")[0];
    if (!weeks.has(weekKey)) weeks.set(weekKey, new Map());
    const byDay = weeks.get(weekKey)!;
    const dayKey = slot.startTime.toDateString();
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey)!.push(slot);
  }
  for (const byDay of weeks.values()) {
    let weekSessions = 0;
    for (const daySlots of byDay.values()) {
      weekSessions += countSessionsForDay(daySlots, slotsPerSession).sessions;
    }
    if (weekSessions > callsPerWeek) {
      return false;
    }
  }
  return true;
}

/**
 * Validate daily hours limit (for classes)
 */
function validateDailyHours(slots: TimeSlot[], maxHours: number): boolean {
  const dailyHours = new Map<string, number>();

  slots.forEach((slot) => {
    const dateKey = slot.startTime.toDateString();
    const duration =
      (slot.endTime.getTime() - slot.startTime.getTime()) / (1000 * 60 * 60); // hours
    dailyHours.set(dateKey, (dailyHours.get(dateKey) || 0) + duration);
  });

  return Array.from(dailyHours.values()).every((hours) => hours <= maxHours);
}

/**
 * Validate session distribution per day (for classes)
 * A session is a group of consecutive slots
 */
function validateSessionDistribution(
  slots: TimeSlot[],
  maxSessions: number
): boolean {
  if (slots.length === 0) return true;

  // Group slots by date
  const slotsByDate = new Map<string, TimeSlot[]>();

  slots.forEach((slot) => {
    const dateKey = slot.startTime.toDateString();
    if (!slotsByDate.has(dateKey)) {
      slotsByDate.set(dateKey, []);
    }
    slotsByDate.get(dateKey)!.push(slot);
  });

  // For each date, count the number of sessions (groups of consecutive slots)
  Array.from(slotsByDate.entries()).forEach(([, dailySlots]) => {
    // Sort slots by start time
    const sortedSlots = [...dailySlots];
    sortedSlots.sort(
      (a: TimeSlot, b: TimeSlot) =>
        a.startTime.getTime() - b.startTime.getTime()
    );

    let sessionCount = 0;
    let lastSlotEnd = 0;

    for (const slot of sortedSlots) {
      const slotStart = slot.startTime.getTime();

      // If this slot is not consecutive with the previous one, it's a new session
      if (slotStart !== lastSlotEnd) {
        sessionCount++;
      }

      lastSlotEnd = slot.endTime.getTime();
    }

    // Check if this date exceeds the maximum sessions
    if (sessionCount > maxSessions) {
      return false;
    }
  });

  return true;
}

/**
 * Validate daily calls limit (for subscriptions)
 */
function validateDailyCalls(slots: TimeSlot[], maxCalls: number): boolean {
  const dailyCalls = new Map<string, number>();

  slots.forEach((slot) => {
    const dateKey = slot.startTime.toDateString();
    dailyCalls.set(dateKey, (dailyCalls.get(dateKey) || 0) + 1);
  });

  return Array.from(dailyCalls.values()).every((calls) => calls <= maxCalls);
}

/**
 * Validate total calls limit (for subscriptions)
 */
function validateTotalCalls(slots: TimeSlot[], maxCalls?: number): boolean {
  if (!maxCalls) return true;
  return slots.length <= maxCalls;
}

/**
 * Validate weekly distribution (for recurring events)
 */
function validateWeeklyDistribution(
  slots: TimeSlot[],
  callsPerWeek: number
): boolean {
  // Group slots by week
  const weeklySlots = new Map<string, number>();

  slots.forEach((slot) => {
    const weekStart = new Date(slot.startTime);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Start of week
    const weekKey = weekStart.toISOString().split("T")[0];
    weeklySlots.set(weekKey, (weeklySlots.get(weekKey) || 0) + 1);
  });

  // Check if any week exceeds the limit
  return Array.from(weeklySlots.values()).every(
    (count) => count <= callsPerWeek
  );
}

/**
 * NEW: Improved subscription validation function
 */
// Helper function to generate week string literal (YYYY-MM-DD format for week start)
function getWeekString(date: Date): string {
  const weekStart = new Date(date);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday as week start
  weekStart.setHours(0, 0, 0, 0);
  return weekStart.toISOString().split("T")[0]; // YYYY-MM-DD format
}

/**
 * Helper function to check if slots form a complete call (consecutive slots on same day)
 */
function isCompleteCall(daySlots: TimeSlot[], slotsPerCall: number): boolean {
  if (daySlots.length !== slotsPerCall) return false;

  const sortedSlots = [...daySlots];
  sortedSlots.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  for (let i = 1; i < sortedSlots.length; i++) {
    const prevEnd = sortedSlots[i - 1].endTime.getTime();
    const currentStart = sortedSlots[i].startTime.getTime();
    if (currentStart !== prevEnd) return false;
  }

  return true;
}

function validateSubscriptionSlots(
  slots: TimeSlot[],
  options: UseEventSlotAllocationOptions,
  limits: SlotLimits
): {
  dailyCallsValid: boolean;
  totalCallsValid: boolean;
  weeklyCallsValid: boolean;
  dailyCallsError?: string;
  totalCallsError?: string;
  weeklyCallsError?: string;
  incompleteCallWarning?: string;
} {
  // Safety checks for undefined parameters
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

  // Group slots by day first
  const slotsByDay = groupSlotsByDay(slots);

  // Create array of weeks with confirmed calls
  const weekCalls = new Map<
    string,
    { confirmed: boolean; totalSlots: number }
  >();

  // Process each day to determine confirmed calls
  slotsByDay.forEach((daySlots) => {
    const weekString = getWeekString(daySlots[0].startTime);

    if (!weekCalls.has(weekString)) {
      weekCalls.set(weekString, { confirmed: false, totalSlots: 0 });
    }

    const weekData = weekCalls.get(weekString)!;
    weekData.totalSlots += daySlots.length;

    // A call is confirmed if it has the exact number of slots and they are consecutive
    if (isCompleteCall(daySlots, slotsPerCall)) {
      weekData.confirmed = true;
    }
  });

  // Validation logic
  let dailyCallsValid = true;
  let dailyCallsError: string | undefined;
  let weeklyCallsValid = true;
  let weeklyCallsError: string | undefined;
  let totalCallsValid = true;
  let totalCallsError: string | undefined;
  let incompleteCallWarning: string | undefined;

  // Validate daily calls (each day can only have one complete call)
  slotsByDay.forEach((daySlots, day) => {
    if (daySlots.length > slotsPerCall) {
      dailyCallsValid = false;
      dailyCallsError = `Too many slots selected for ${day}. Maximum ${slotsPerCall} slots per call allowed.`;
      return;
    }

    if (daySlots.length > 1 && !isCompleteCall(daySlots, slotsPerCall)) {
      dailyCallsValid = false;
      dailyCallsError = `Slots for ${day} must be consecutive and complete (${slotsPerCall} slots total).`;
      return;
    }
  });

  // FIXED: Validate weekly calls using only complete calls
  weekCalls.forEach((weekData, weekString) => {
    // Only count complete calls, not potential calls
    const completeCalls = weekData.confirmed ? 1 : 0;
    const partialSlots = weekData.totalSlots % slotsPerCall;

    // If there are partial slots, it means incomplete calls
    if (partialSlots > 0) {
      const weekDate = new Date(weekString);
      incompleteCallWarning = `Week of ${weekDate.toLocaleDateString()} has incomplete call. Need ${slotsPerCall - partialSlots} more consecutive slots.`;
    }

    // Check if this week exceeds the call limit (only count complete calls)
    if (completeCalls > callsPerWeek) {
      const weekDate = new Date(weekString);
      weeklyCallsValid = false;
      weeklyCallsError = `Week of ${weekDate.toLocaleDateString()} has too many complete calls. Maximum ${callsPerWeek} calls per week allowed.`;
      return;
    }
  });

  // FIXED: Validate total calls using only complete calls
  const totalConfirmedCalls = Array.from(weekCalls.values()).reduce(
    (sum, week) => sum + (week.confirmed ? 1 : 0),
    0
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

// ============================================================================
// MAIN HOOK IMPLEMENTATION
// ============================================================================

/**
 * Return type interface for the useEventSlotAllocation hook
 */
export interface UseEventSlotAllocationReturn {
  // State
  selectedSlots: TimeSlot[];
  isAllocating: boolean;
  allocationError: string | null;
  validationErrors: string[];
  validationWarnings: string[];
  isValid: boolean;
  canAllocate: boolean;
  requiredSlots: number;
  slotLimits: SlotLimits;

  // Slot management functions
  toggleSlot: (slot: TimeSlot) => void;
  addSlots: (slots: TimeSlot[]) => void;
  removeSlots: (slots: TimeSlot[]) => void;
  setSelectedSlots: (slots: TimeSlot[]) => void;
  clearSlots: () => void;
  isSlotSelected: (slot: TimeSlot) => boolean;

  // Allocation methods
  manualAllocate: () => Promise<void>;
  manualAllocateWithReschedule: (
    appointmentId: string,
    callTimestamp?: string
  ) => Promise<void>;
  autoAllocate: (availableSlots: TimeSlot[]) => Promise<void>;
  preAllocate: (availableSlots: TimeSlot[]) => Promise<void>;

  // Validation functions
  validateSlots: (slots: TimeSlot[]) => ValidationResult;
  validateSlotsPreview: (slots: TimeSlot[]) => ValidationResult;

  // Event-specific helpers
  getEventConstraints: () => EventConstraints;
  getSlotLimits: () => SlotLimits;
  canAddSlot: (slot: TimeSlot) => boolean;
  getSlotSuggestions: (availableSlots: TimeSlot[]) => TimeSlot[];
}

/**
 * Enhanced Event Slot Allocation Hook
 *
 * Provides a unified interface for managing slot allocation across all event types
 * with event-specific constraints, validation, and allocation strategies.
 *
 * @param options - Configuration options for the hook
 * @returns Hook interface with state, functions, and computed values
 */
export function useEventSlotAllocation(
  options: UseEventSlotAllocationOptions
): UseEventSlotAllocationReturn {
  const {
    eventType,
    eventId,
    consultantId: _consultantId,
    onSuccess,
    onError,
    onValidationChange,
    onSlotsChange,
  } = options;

  const { toast } = useToast();

  // ==========================================
  // STATE MANAGEMENT
  // ==========================================

  const [selectedSlots, setSelectedSlots] = useState<TimeSlot[]>([]);
  const [isAllocating, setIsAllocating] = useState(false);
  const [allocationError, setAllocationError] = useState<string | null>(null);
  const [pendingToast, setPendingToast] = useState<{
    variant: "destructive" | "default";
    title: string;
    description: string;
  } | null>(null);

  // ==========================================
  // COMPUTED VALUES
  // ==========================================

  // Event-specific constraints
  const eventConstraints = useMemo(
    () => getEventConstraints(eventType, options),
    [eventType, options]
  );

  // Slot allocation limits
  const slotLimits = useMemo(
    () => getSlotLimits(eventType, options),
    [eventType, options]
  );

  // Required slots calculation
  const requiredSlots = useMemo(() => {
    // Use the appropriate duration field based on event type
    const duration =
      eventType === "consultation" || eventType === "webinar"
        ? options.durationInHours
        : options.sessionDurationInHours;

    return calculateRequiredSlots(
      eventType,
      options.durationInMonths,
      options.callsPerWeek,
      duration,
      options.startDate,
      options.endDate
    );
  }, [
    eventType,
    options.durationInMonths,
    options.callsPerWeek,
    options.durationInHours,
    options.sessionDurationInHours,
  ]);

  // Current validation result
  const validationResult = useMemo(
    () =>
      validateEventSlots(
        selectedSlots,
        eventType,
        eventConstraints,
        slotLimits,
        options
      ),
    [selectedSlots, eventType, eventConstraints, slotLimits, options]
  );

  // Whether current selection is valid
  const isValid = validationResult.isValid;

  // Whether allocation can proceed
  const canAllocate = useMemo(() => {
    if (!isValid) return false;

    // For subscriptions, we need to account for past calls
    if (eventType === "subscription" && options.sessionDurationInHours) {
      const slotsPerCall = slotLimits.slotsPerSession;
      const completedCalls = Math.floor(selectedSlots.length / slotsPerCall);

      // Calculate past calls using the same logic as footer
      const allowedStart = options.startDate;
      const allowedEnd = options.endDate;
      const callsPerWeek = options.callsPerWeek || 1;

      let pastCallsCompleted = 0;
      if (allowedStart && allowedEnd) {
        const currentDate = new Date();
        currentDate.setHours(0, 0, 0, 0);
        const prevSaturday = new Date(startOfWeek(currentDate));
        prevSaturday.setDate(prevSaturday.getDate() - 1);
        const pastEnd = prevSaturday < allowedEnd ? prevSaturday : allowedEnd;
        const pastWeeks =
          pastEnd >= allowedStart
            ? countSundayWeeksInclusive(allowedStart, pastEnd)
            : 0;
        pastCallsCompleted = pastWeeks * callsPerWeek;
      }

      const totalCallsIncludingPast = pastCallsCompleted + completedCalls;
      const maxTotalCalls = slotLimits.maxSlots;

      // For subscriptions, we just need to ensure the selection is valid
      // Users don't need to allocate all calls, just validate their selection
      return totalCallsIncludingPast <= maxTotalCalls;
    }

    // For classes, allow allocation when there is at least one complete session
    if (eventType === "class" && options.sessionDurationInHours) {
      const slotsPerSession = slotLimits.slotsPerSession;
      const byDay = groupSlotsByDay(selectedSlots);
      // Block if any day has leftover (incomplete) session
      let hasLeftover = false;
      byDay.forEach((daySlots) => {
        const { leftoverSlots } = countSessionsForDay(
          daySlots,
          slotsPerSession
        );
        if (leftoverSlots > 0) hasLeftover = true;
      });
      if (hasLeftover) return false;

      // Allow if at least one full session exists
      const completeSessions = countCompleteSessionsInMap(
        byDay,
        slotsPerSession
      );
      return completeSessions > 0;
    }

    // For other event types, require exact slot count
    return selectedSlots.length === requiredSlots;
  }, [
    isValid,
    selectedSlots.length,
    requiredSlots,
    eventType,
    options.sessionDurationInHours,
    options.startDate,
    options.endDate,
    options.callsPerWeek,
    slotLimits,
  ]);

  // Validation errors and warnings
  const validationErrors = validationResult.errors;
  const validationWarnings = validationResult.warnings;

  // ==========================================
  // EFFECT HOOKS
  // ==========================================

  // Notify parent of validation changes
  useEffect(() => {
    if (onValidationChange) {
      onValidationChange(isValid, validationResult);
    }
  }, [isValid, validationResult, onValidationChange]);

  // Notify parent of slot changes
  useEffect(() => {
    if (onSlotsChange) {
      onSlotsChange(selectedSlots);
    }
  }, [selectedSlots, onSlotsChange]);

  // Clear allocation error when slots change
  useEffect(() => {
    if (allocationError) {
      setAllocationError(null);
    }
  }, [selectedSlots, allocationError]);

  // Handle pending toast notifications
  useEffect(() => {
    if (pendingToast) {
      toast({
        variant: pendingToast.variant,
        title: pendingToast.title,
        description: pendingToast.description,
      });
      setPendingToast(null);
    }
  }, [pendingToast, toast]);

  // ==========================================
  // SLOT MANAGEMENT FUNCTIONS
  // ==========================================

  /**
   * Toggle slot selection with event-specific validation
   */
  const toggleSlot = useCallback(
    (slot: TimeSlot) => {
      setSelectedSlots((current) => {
        // Safety check to ensure current is always an array
        const currentSlots = current || [];

        const isSelected = currentSlots.some(
          (s) => s.startTime.getTime() === slot.startTime.getTime()
        );

        if (isSelected) {
          // Remove slot
          return currentSlots.filter(
            (s) => s.startTime.getTime() !== slot.startTime.getTime()
          );
        } else {
          // Add slot with event-specific limits
          const newSelection = [...currentSlots, slot];

          // FIXED: Enhanced subscription validation - check weekly limits and complete calls only
          if (eventType === "subscription") {
            const slotsPerCall = slotLimits.slotsPerSession;
            const callsPerWeek = options.callsPerWeek || 1;

            // Determine week/day for the slot being added
            const targetWeekKey = getWeekString(slot.startTime);
            const targetDayKey = slot.startTime.toDateString();

            // Build state BEFORE adding this slot
            const currentWeekSlots = currentSlots.filter(
              (s) => getWeekString(s.startTime) === targetWeekKey
            );

            // Group by day for the current week (pre-add)
            const preSlotsByDay = groupSlotsByDay(currentWeekSlots);

            // Count complete calls already in this week (pre-add)
            let completeCallsThisWeek = 0;
            preSlotsByDay.forEach((daySlots) => {
              if (isCompleteCall(daySlots, slotsPerCall))
                completeCallsThisWeek++;
            });

            const preDaySlots = preSlotsByDay.get(targetDayKey) || [];

            // If starting a NEW day and weekly limit already reached → block immediately
            if (
              preDaySlots.length === 0 &&
              completeCallsThisWeek >= callsPerWeek
            ) {
              setTimeout(() => {
                setPendingToast({
                  variant: "destructive",
                  title: "Weekly Call Limit Reached",
                  description: `Maximum ${callsPerWeek} calls per week allowed. Week of ${new Date(
                    targetWeekKey
                  ).toLocaleDateString()} already has ${completeCallsThisWeek} complete call(s).`,
                });
              }, 0);
              return currentSlots;
            }

            // If continuing the same day, block if completing this call would exceed weekly limit
            if (
              preDaySlots.length > 0 &&
              isCompleteCall([...preDaySlots, slot], slotsPerCall) &&
              completeCallsThisWeek >= callsPerWeek
            ) {
              setTimeout(() => {
                setPendingToast({
                  variant: "destructive",
                  title: "Weekly Call Limit Reached",
                  description: `Completing this call would exceed the ${callsPerWeek}/week limit for week of ${new Date(
                    targetWeekKey
                  ).toLocaleDateString()}.`,
                });
              }, 0);
              return currentSlots;
            }

            // Count total complete calls across ALL weeks for newSelection (post-add)
            const totalCompleteCalls = countCompleteCallsInMap(
              groupSlotsByDay(newSelection),
              slotsPerCall
            );

            const maxTotalCalls = slotLimits.maxSlots;

            // FIXED: Check if this slot would complete a call and if we're at total limit
            const totalLimitSlotDay = slot.startTime.toDateString();

            const slotsByDayPost = groupSlotsByDay(newSelection);
            const potentialDaySlots = [
              ...(slotsByDayPost.get(totalLimitSlotDay) || []),
            ];

            // FIXED: If this would complete a call, check total limits
            if (isCompleteCall(potentialDaySlots, slotsPerCall)) {
              // We count the total complete calls *after* this slot is added.
              // If it's greater than the max, then this completion is the problem.
              if (totalCompleteCalls > maxTotalCalls) {
                setTimeout(() => {
                  setPendingToast({
                    variant: "destructive",
                    title: "Total Call Limit Reached",
                    description: `Maximum ${maxTotalCalls} total calls allowed for this subscription. This would create ${totalCompleteCalls} complete calls.`,
                  });
                }, 0);
                return currentSlots;
              }
            }
          } else if (eventType === "class") {
            // Class-specific interactive guards
            const slotsPerSession = slotLimits.slotsPerSession;
            const targetDayKey = slot.startTime.toDateString();

            // Group current selection by day (pre-add)
            const preByDay = groupSlotsByDay(currentSlots);

            // Detect any in-progress class (day not multiple of slotsPerSession)
            const incompleteDays = Array.from(preByDay.entries())
              .filter(([, daySlots]) => daySlots.length % slotsPerSession !== 0)
              .map(([key]) => key);

            if (
              incompleteDays.length > 0 &&
              !incompleteDays.includes(targetDayKey)
            ) {
              setTimeout(() => {
                setPendingToast({
                  variant: "destructive",
                  title: "Finish Ongoing Class",
                  description:
                    "Finish the ongoing class first by selecting the next consecutive slot on the same day",
                });
              }, 0);
              return currentSlots;
            }

            // If adding on the incomplete day, ensure consecutiveness
            if (incompleteDays.includes(targetDayKey)) {
              const daySlots = preByDay.get(targetDayKey) || [];
              const sorted = [...daySlots].sort(
                (a, b) => a.startTime.getTime() - b.startTime.getTime()
              );
              if (sorted.length > 0) {
                const firstSlot = sorted[0];
                const lastSlot = sorted[sorted.length - 1];
                const isConsecutiveBefore =
                  slot.endTime.getTime() === firstSlot.startTime.getTime();
                const isConsecutiveAfter =
                  slot.startTime.getTime() === lastSlot.endTime.getTime();
                if (!isConsecutiveBefore && !isConsecutiveAfter) {
                  setTimeout(() => {
                    setPendingToast({
                      variant: "destructive",
                      title: "Non-consecutive Selection",
                      description:
                        "A class requires consecutive slots. Please select the adjacent slot to complete it.",
                    });
                  }, 0);
                  return currentSlots;
                }
              }
            }

            // Enforce max classes per day when starting a new class on that day
            const daySlots = preByDay.get(targetDayKey) || [];
            const maxSessionsPerDay = options.maxSessionsPerDay || 2;
            const { sessions } = countSessionsForDay(daySlots, slotsPerSession);
            const isStartingNewSessionOnDay =
              daySlots.length % slotsPerSession === 0;
            if (isStartingNewSessionOnDay && sessions >= maxSessionsPerDay) {
              setTimeout(() => {
                setPendingToast({
                  variant: "destructive",
                  title: "Daily Limit Reached",
                  description: `Only ${maxSessionsPerDay} classes allowed per day`,
                });
              }, 0);
              return currentSlots;
            }

            // FIXED: Add total sessions limit validation for classes
            // Count total complete sessions in the current selection (before adding new slot)
            const currentCompleteSessions = countCompleteSessionsInMap(
              preByDay,
              slotsPerSession
            );

            // Check if adding this slot would complete a new session
            const newDaySlots = [...daySlots, slot];
            const wouldCompleteSession =
              newDaySlots.length % slotsPerSession === 0 &&
              newDaySlots.length > 0;

            // If this would complete a session, check against total session limit
            if (wouldCompleteSession) {
              const totalSessionsAfterAdd = currentCompleteSessions + 1;
              const maxTotalSessions = slotLimits.totalSessions;

              if (totalSessionsAfterAdd > maxTotalSessions) {
                setTimeout(() => {
                  setPendingToast({
                    variant: "destructive",
                    title: "Total Sessions Limit Reached",
                    description: `Maximum ${maxTotalSessions} total sessions allowed for this class. This would create ${totalSessionsAfterAdd} complete sessions.`,
                  });
                }, 0);
                return currentSlots;
              }
            }
          } else if (newSelection.length > slotLimits.maxSlots) {
            // Validate against slot limits for other event types
            setTimeout(() => {
              setPendingToast({
                variant: "destructive",
                title: "Selection Limit",
                description: `Maximum ${slotLimits.maxSlots} slots allowed for ${eventType}`,
              });
            }, 0);
            return currentSlots;
          }

          // Event-specific validation for interactive selection
          const validation = validateEventSlots(
            newSelection,
            eventType,
            eventConstraints,
            slotLimits,
            options
          );

          // Only show error for serious validation issues, not warnings
          if (!validation.isValid && validation.errors.length > 0) {
            const isMinSlotIssue = validation.errors.some(
              (error) =>
                error.includes("slots required") ||
                error.includes("Need") ||
                error.includes("more slots")
            );

            if (!isMinSlotIssue) {
              setTimeout(() => {
                setPendingToast({
                  variant: "destructive",
                  title: "Invalid Selection",
                  description: validation.errors[0],
                });
              }, 0);
              return currentSlots;
            }
          }

          // FIXED: Simple subscription validation with confirmed calls
          if (eventType === "subscription" && options.sessionDurationInHours) {
            const slotsPerCall = slotLimits.slotsPerSession;
            const callsPerWeek = options.callsPerWeek || 1;
            const maxTotalCalls = slotLimits.maxSlots;

            // PRIORITY 1: Check for incomplete calls first - this is the highest priority
            const currentSlotsByDay = groupSlotsByDay(currentSlots);
            const incompleteCallDays: string[] = [];

            // Find any days with incomplete calls
            currentSlotsByDay.forEach((daySlots, dayKey) => {
              if (daySlots.length > 0 && daySlots.length < slotsPerCall) {
                incompleteCallDays.push(dayKey);
              }
            });

            // If there are incomplete calls, only allow selection on those days
            if (incompleteCallDays.length > 0) {
              const newSlotDay = slot.startTime.toDateString();

              // If trying to select a slot on a different day than the incomplete call
              if (!incompleteCallDays.includes(newSlotDay)) {
                const incompleteDay = incompleteCallDays[0];
                const incompleteSlots =
                  currentSlotsByDay.get(incompleteDay) || [];
                const remainingSlots = slotsPerCall - incompleteSlots.length;

                setTimeout(() => {
                  setPendingToast({
                    variant: "destructive",
                    title: "Complete Ongoing Call First",
                    description: `You have an incomplete call on ${new Date(incompleteDay).toLocaleDateString()}. Complete it first by selecting ${remainingSlots} more consecutive slot${remainingSlots > 1 ? "s" : ""} on the same day.`,
                  });
                }, 0);
                return currentSlots;
              }

              // If selecting on the same day as incomplete call, check if it's consecutive
              const daySlots = currentSlotsByDay.get(newSlotDay) || [];
              if (daySlots.length > 0) {
                const sortedDaySlots = [...daySlots].sort(
                  (a, b) => a.startTime.getTime() - b.startTime.getTime()
                );

                const lastSlot = sortedDaySlots[sortedDaySlots.length - 1];
                const firstSlot = sortedDaySlots[0];

                const isConsecutiveBefore =
                  slot.endTime.getTime() === firstSlot.startTime.getTime();
                const isConsecutiveAfter =
                  slot.startTime.getTime() === lastSlot.endTime.getTime();

                if (!isConsecutiveBefore && !isConsecutiveAfter) {
                  setTimeout(() => {
                    setPendingToast({
                      variant: "destructive",
                      title: "Non-consecutive Selection",
                      description:
                        "Subscription call slots must be consecutive within the same day. Select an adjacent slot to complete the call.",
                    });
                  }, 0);
                  return currentSlots;
                }
              }
            }

            // PRIORITY 2: Only proceed with other validations if no incomplete calls exist
            // Simple week tracking - no need for pre-generated array
            // Simple confirmed call tracking per week
            const weeklyConfirmedCalls = new Map<string, boolean>();

            // Group slots by day
            const slotsByDay = groupSlotsByDay(newSelection);

            // First, check existing confirmed calls WITHOUT the new slot
            const existingSlotsByDay = groupSlotsByDay(currentSlots);

            const existingWeeklyConfirmedCalls = new Map<string, boolean>();
            existingSlotsByDay.forEach((daySlots) => {
              if (
                daySlots.length === slotsPerCall &&
                isCompleteCall(daySlots, slotsPerCall)
              ) {
                const weekString = getWeekString(daySlots[0].startTime);
                existingWeeklyConfirmedCalls.set(weekString, true);
              }
            });

            // Then check what happens when we add the new slot
            slotsByDay.forEach((daySlots) => {
              if (
                daySlots.length === slotsPerCall &&
                isCompleteCall(daySlots, slotsPerCall)
              ) {
                const weekString = getWeekString(daySlots[0].startTime);
                weeklyConfirmedCalls.set(weekString, true);
              }
            });

            // Check if adding this slot creates a NEW confirmed call in a week that already has one
            const weeklyConfirmedSlotWeek = getWeekString(slot.startTime);
            const weeklyConfirmedSlotDay = slot.startTime.toDateString();

            // Get current day slots plus the new slot
            const dayWithNewSlot = [
              ...(slotsByDay.get(weeklyConfirmedSlotDay) || []),
            ];

            // Only block if adding this slot COMPLETES a call and there's already a complete call this week
            if (
              dayWithNewSlot.length === slotsPerCall &&
              isCompleteCall(dayWithNewSlot, slotsPerCall) &&
              existingWeeklyConfirmedCalls.has(weeklyConfirmedSlotWeek) &&
              callsPerWeek === 1
            ) {
              setTimeout(() => {
                setPendingToast({
                  variant: "destructive",
                  title: "Weekly Limit Reached",
                  description: `This week already has a confirmed call. Only ${callsPerWeek} call per week allowed.`,
                });
              }, 0);
              return currentSlots;
            }

            // Add past calls tracking - calls in the past are automatically completed
            const currentDate = new Date();
            currentDate.setHours(0, 0, 0, 0); // Start of today

            // Calculate how many calls should be completed based on current date
            // Use the same logic as the footer calculation for consistency
            const allowedStart = options.startDate;
            const allowedEnd = options.endDate;

            let pastCallsCompleted: number;

            if (allowedStart && allowedEnd) {
              // Use the same logic as computeSubscriptionFooter
              const prevSaturday = new Date(startOfWeek(currentDate));
              prevSaturday.setDate(prevSaturday.getDate() - 1);
              const pastEnd =
                prevSaturday < allowedEnd ? prevSaturday : allowedEnd;
              const pastWeeks =
                pastEnd >= allowedStart
                  ? countSundayWeeksInclusive(allowedStart, pastEnd)
                  : 0;
              pastCallsCompleted = pastWeeks * callsPerWeek;
            } else {
              // Fallback to simple calculation if dates not provided
              const subscriptionStartDate = new Date(); // TODO: Get actual subscription start date from options
              subscriptionStartDate.setHours(0, 0, 0, 0);

              // Calculate weeks passed since subscription started
              const weeksPassed = Math.floor(
                (currentDate.getTime() - subscriptionStartDate.getTime()) /
                  (7 * 24 * 60 * 60 * 1000)
              );
              pastCallsCompleted = Math.min(
                weeksPassed * callsPerWeek,
                maxTotalCalls
              );
            }

            // FIXED: Simple validation: count confirmed calls + past completed calls
            // But don't count the call we're about to complete if it's completing an existing incomplete call
            const totalConfirmedCalls = weeklyConfirmedCalls.size;

            // Check if this slot would complete an existing incomplete call
            const effectiveCallsSlotDay = slot.startTime.toDateString();
            const existingDaySlots = currentSlots.filter(
              (selectedSlot) =>
                selectedSlot.startTime.toDateString() === effectiveCallsSlotDay
            );

            let effectiveConfirmedCalls = totalConfirmedCalls;

            // If this would complete an existing incomplete call, don't count it twice
            if (
              existingDaySlots.length > 0 &&
              existingDaySlots.length < slotsPerCall
            ) {
              // This is completing an existing incomplete call
              // Don't add 1 to the count since we're just completing what's already started
              effectiveConfirmedCalls = totalConfirmedCalls;
            } else if (existingDaySlots.length === 0) {
              // This is starting a new call
              // Add 1 to the count since we're creating a new call
              effectiveConfirmedCalls = totalConfirmedCalls + 1;
            }

            const totalCallsIncludingPast =
              effectiveConfirmedCalls + pastCallsCompleted;

            if (totalCallsIncludingPast > maxTotalCalls) {
              setTimeout(() => {
                setPendingToast({
                  variant: "destructive",
                  title: "Call Limit Reached",
                  description: `Maximum ${maxTotalCalls} calls allowed for this subscription (${pastCallsCompleted} past calls + ${effectiveConfirmedCalls} confirmed = ${totalCallsIncludingPast} total)`,
                });
              }, 0);
              return currentSlots;
            }

            // Check daily call limit BEFORE adding the new slot
            // effectiveCallsSlotDay already declared above
            const currentDaySlots = currentSlots.filter(
              (selectedSlot) =>
                selectedSlot.startTime.toDateString() === effectiveCallsSlotDay
            );

            // Check if adding this slot would exceed the per-call limit
            if (currentDaySlots.length >= slotsPerCall) {
              setTimeout(() => {
                setPendingToast({
                  variant: "destructive",
                  title: "Daily Call Limit",
                  description: "Only 1 call per day allowed for subscriptions",
                });
              }, 0);
              return currentSlots;
            }

            // Note: Consecutive slot validation is already handled in Priority 1 section above
            // This ensures that incomplete calls must be completed before any other validations

            // Show progress feedback
            const completedCalls = Math.floor(
              newSelection.length / slotsPerCall
            );
            const currentCallProgress = newSelection.length % slotsPerCall;

            if (currentCallProgress === 0 && newSelection.length > 0) {
              // Just completed a call
              // Calculate progress including past calls using the same logic as above
              const totalProgress = pastCallsCompleted + completedCalls;

              setTimeout(() => {
                setPendingToast({
                  variant: "default",
                  title: "Call Completed",
                  description: `Call completed! Progress: ${totalProgress}/${maxTotalCalls} calls (${pastCallsCompleted} past + ${completedCalls} scheduled)`,
                });
              }, 0);
            } else {
              // Building a call
              const currentCallNumber = completedCalls + 1;
              const remainingInCall = slotsPerCall - currentCallProgress;

              setTimeout(() => {
                setPendingToast({
                  variant: "default",
                  title: "Building Call",
                  description: `Call ${currentCallNumber}: ${currentCallProgress}/${slotsPerCall} slots selected (need ${remainingInCall} more)`,
                });
              }, 0);
            }
          }

          const sortedSelection = [...newSelection];
          sortedSelection.sort(
            (a, b) => a.startTime.getTime() - b.startTime.getTime()
          );
          return sortedSelection;
        }
      });
    },
    [
      eventType,
      eventConstraints,
      slotLimits,
      options,
      requiredSlots,
      toast,
      setPendingToast,
    ]
  );

  /**
   * Clear all selected slots
   */
  const clearSlots = useCallback(() => {
    setSelectedSlots([]);
    setAllocationError(null);
  }, []);

  /**
   * Check if a slot is currently selected
   */
  const isSlotSelected = useCallback(
    (slot: TimeSlot) => {
      return selectedSlots.some(
        (s) => s.startTime.getTime() === slot.startTime.getTime()
      );
    },
    [selectedSlots]
  );

  /**
   * Add multiple slots with validation
   */
  const addSlots = useCallback(
    (slots: TimeSlot[]) => {
      const newSelection = [...selectedSlots, ...slots];
      const validation = validateEventSlots(
        newSelection,
        eventType,
        eventConstraints,
        slotLimits,
        options
      );

      if (validation.isValid) {
        const sortedNewSelection = [...newSelection];
        sortedNewSelection.sort(
          (a, b) => a.startTime.getTime() - b.startTime.getTime()
        );
        setSelectedSlots(sortedNewSelection);
      } else {
        setPendingToast({
          variant: "destructive",
          title: "Invalid Selection",
          description: validation.errors[0] || "Invalid slot selection",
        });
      }
    },
    [selectedSlots, eventType, eventConstraints, slotLimits, options]
  );

  /**
   * Remove specific slots
   */
  const removeSlots = useCallback((slotsToRemove: TimeSlot[]) => {
    const removeTimestamps = new Set(
      slotsToRemove.map((slot) => slot.startTime.getTime())
    );

    setSelectedSlots((current) =>
      current.filter((slot) => !removeTimestamps.has(slot.startTime.getTime()))
    );
  }, []);

  // ==========================================
  // ALLOCATION METHODS
  // ==========================================

  /**
   * Allocate using manually selected slots
   */
  const manualAllocate = useCallback(async () => {
    // STRICT BLOCK: Do not allow allocation if any call/session is in progress (subscription/class)
    if (
      (eventType === "subscription" && options.sessionDurationInHours) ||
      (eventType === "class" && options.sessionDurationInHours)
    ) {
      const slotsPerCall = slotLimits.slotsPerSession; // per-call or per-session
      const slotsByDay = groupSlotsByDay(selectedSlots);
      let hasIncomplete = false;
      slotsByDay.forEach((daySlots) => {
        if (daySlots.length === 0) return;
        if (eventType === "class") {
          // For classes, allow multiple sessions per day; flag only if leftover exists
          const { leftoverSlots } = countSessionsForDay(daySlots, slotsPerCall);
          if (leftoverSlots > 0) {
            hasIncomplete = true;
          }
        } else {
          // For subscriptions, the day must exactly match one complete call
          if (!isCompleteCall(daySlots, slotsPerCall)) {
            hasIncomplete = true;
          }
        }
      });
      if (hasIncomplete) {
        const message =
          eventType === "class"
            ? "A class session is in progress. Complete the ongoing session or clear selection."
            : "A call is in progress. Complete the ongoing call or clear selection.";
        setAllocationError(message);
        toast({
          variant: "destructive",
          title:
            eventType === "class" ? "Incomplete Session" : "Incomplete Call",
          description: message,
        });
        onError?.(message);
        return;
      }
    }

    // Comprehensive validation check with detailed toast
    const validationDetails = {
      isValid,
      errors: validationErrors,
      warnings: validationWarnings,
      selectedSlots: selectedSlots.length,
      requiredSlots,
      canAllocate,
      eventType,
      slotLimits,
    };

    // Create detailed validation message
    let validationMessage = "";
    let toastVariant: "default" | "destructive" = "default";
    let toastTitle = "";

    if (isValid && canAllocate) {
      toastTitle = "✅ Validation Passed - Ready to Allocate";
      validationMessage = `All validations passed! Ready to allocate ${selectedSlots.length} slots for ${eventType}.`;

      // Add event-specific details
      if (eventType === "subscription") {
        const slotsPerCall = slotLimits.slotsPerSession;
        const completedCalls = Math.floor(selectedSlots.length / slotsPerCall);

        // Calculate past calls using the same logic as footer
        const allowedStart = options.startDate;
        const allowedEnd = options.endDate;
        const callsPerWeek = options.callsPerWeek || 1;

        let pastCallsCompleted = 0;
        if (allowedStart && allowedEnd) {
          const currentDate = new Date();
          currentDate.setHours(0, 0, 0, 0);
          const prevSaturday = new Date(startOfWeek(currentDate));
          prevSaturday.setDate(prevSaturday.getDate() - 1);
          const pastEnd = prevSaturday < allowedEnd ? prevSaturday : allowedEnd;
          const pastWeeks =
            pastEnd >= allowedStart
              ? countSundayWeeksInclusive(allowedStart, pastEnd)
              : 0;
          pastCallsCompleted = pastWeeks * callsPerWeek;
        }

        const totalCallsIncludingPast = pastCallsCompleted + completedCalls;
        const maxTotalCalls = slotLimits.maxSlots;

        validationMessage += `\n• ${completedCalls} new calls selected`;
        validationMessage += `\n• ${pastCallsCompleted} past calls (auto-completed)`;
        validationMessage += `\n• Total calls: ${totalCallsIncludingPast}/${maxTotalCalls}`;
        validationMessage += `\n• ${slotsPerCall} slots per call`;
      } else if (eventType === "class") {
        const slotsPerSession = slotLimits.slotsPerSession;
        const completedSessions = Math.floor(
          selectedSlots.length / slotsPerSession
        );
        validationMessage += `\n• ${completedSessions} complete sessions selected`;
        validationMessage += `\n• ${slotsPerSession} slots per session`;
        validationMessage += `\n• Max sessions: ${slotLimits.totalSessions}`;
      } else {
        validationMessage += `\n• ${selectedSlots.length} consecutive slots selected`;
        validationMessage += `\n• Required: ${requiredSlots} slots`;
      }

      // Add general validation info
      validationMessage += `\n• All slots are consecutive`;
      validationMessage += `\n• No conflicts with existing appointments`;
    } else {
      toastVariant = "destructive";
      toastTitle = "❌ Validation Failed";

      if (!isValid) {
        validationMessage = "Validation errors found:\n";
        validationErrors.forEach((error, index) => {
          validationMessage += `• ${index + 1}. ${error}\n`;
        });
      } else if (eventType === "subscription") {
        // For subscriptions, show past calls info instead of slot count mismatch
        const slotsPerCall = slotLimits.slotsPerSession;
        const completedCalls = Math.floor(selectedSlots.length / slotsPerCall);

        // Calculate past calls
        const allowedStart = options.startDate;
        const allowedEnd = options.endDate;
        const callsPerWeek = options.callsPerWeek || 1;

        let pastCallsCompleted = 0;
        if (allowedStart && allowedEnd) {
          const currentDate = new Date();
          currentDate.setHours(0, 0, 0, 0);
          const prevSaturday = new Date(startOfWeek(currentDate));
          prevSaturday.setDate(prevSaturday.getDate() - 1);
          const pastEnd = prevSaturday < allowedEnd ? prevSaturday : allowedEnd;
          const pastWeeks =
            pastEnd >= allowedStart
              ? countSundayWeeksInclusive(allowedStart, pastEnd)
              : 0;
          pastCallsCompleted = pastWeeks * callsPerWeek;
        }

        const totalCallsIncludingPast = pastCallsCompleted + completedCalls;
        const maxTotalCalls = slotLimits.maxSlots;

        validationMessage = `Subscription validation:\n• ${completedCalls} new calls selected\n• ${pastCallsCompleted} past calls (auto-completed)\n• Total: ${totalCallsIncludingPast}/${maxTotalCalls} calls`;
      } else if (selectedSlots.length !== requiredSlots) {
        validationMessage = `Slot count mismatch:\n• Selected: ${selectedSlots.length} slots\n• Required: ${requiredSlots} slots`;
      } else {
        validationMessage = "Unknown validation issue";
      }

      // Add warnings if any
      if (validationWarnings.length > 0) {
        validationMessage += "\n\nWarnings:\n";
        validationWarnings.forEach((warning, index) => {
          validationMessage += `• ${index + 1}. ${warning}\n`;
        });
      }
    }

    // Show comprehensive validation toast
    toast({
      variant: toastVariant,
      title: toastTitle,
      description: validationMessage,
    });

    // Stop if invalid
    if (!isValid || !canAllocate) {
      const errorMessage = validationErrors[0] || "Invalid slot selection";
      setAllocationError(errorMessage);
      onError?.(errorMessage);
      return;
    }

    setIsAllocating(true);
    setAllocationError(null);
    try {
      // Optimistic: Temporarily mark selected session blocks as reserved to prevent flicker
      const reserved = new Set(
        selectedSlots.map((s) => s.startTime.toISOString())
      );

      const result = await AllocationService.allocateSlots(
        eventType,
        eventId,
        selectedSlots,
        { isAuto: false, reallocate: true }
      );

      if (!result.success) {
        const errorMessage = result.error || "Manual allocation failed";
        setAllocationError(errorMessage);
        onError?.(errorMessage);
        toast({
          variant: "destructive",
          title: "Allocation Failed",
          description: errorMessage,
        });
        return;
      }

      toast({
        title: "Success",
        description: "Slots allocated successfully",
      });
      onSuccess?.(result as any);
      setSelectedSlots([]);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Allocation failed";
      setAllocationError(errorMessage);
      onError?.(errorMessage);
      toast({
        variant: "destructive",
        title: "Allocation Failed",
        description: errorMessage,
      });
    } finally {
      setIsAllocating(false);
    }
  }, [
    selectedSlots,
    isValid,
    validationErrors,
    validationWarnings,
    requiredSlots,
    canAllocate,
    eventType,
    slotLimits,
    onSuccess,
    onError,
    toast,
  ]);

  /**
   * Manual allocation with rescheduling support for subscriptions
   */
  const manualAllocateWithReschedule = useCallback(
    async (appointmentId: string, callTimestamp?: string) => {
      console.log(
        `[Frontend] Starting reschedule for appointmentId: ${appointmentId}, callTimestamp: ${callTimestamp}, eventId: ${eventId}`
      );
      console.log(
        `[Frontend] Selected slots:`,
        selectedSlots.map((s) => s.startTime.toISOString())
      );

      // Similar validation as manualAllocate but for rescheduling
      if (!isValid || !canAllocate) {
        const errorMessage = validationErrors[0] || "Invalid slot selection";
        setAllocationError(errorMessage);
        onError?.(errorMessage);
        return;
      }

      setIsAllocating(true);
      setAllocationError(null);
      try {
        const result = await AllocationService.allocateSlots(
          eventType,
          eventId,
          selectedSlots,
          {
            isAuto: false,
            reallocate: true,
            appointmentId, // This triggers the reschedule endpoint
            callTimestamp, // Pass the specific call timestamp
          }
        );

        if (!result.success) {
          const errorMessage = result.error || "Reschedule failed";
          setAllocationError(errorMessage);
          onError?.(errorMessage);
          toast({
            variant: "destructive",
            title: "Reschedule Failed",
            description: errorMessage,
          });
          return;
        }

        toast({
          title: "Success",
          description: "Appointment rescheduled successfully",
        });
        onSuccess?.(result as any);
        setSelectedSlots([]);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Reschedule failed";
        setAllocationError(errorMessage);
        onError?.(errorMessage);
        toast({
          variant: "destructive",
          title: "Reschedule Failed",
          description: errorMessage,
        });
      } finally {
        setIsAllocating(false);
      }
    },
    [
      selectedSlots,
      isValid,
      validationErrors,
      canAllocate,
      eventType,
      eventId,
      onSuccess,
      onError,
      toast,
    ]
  );

  /**
   * Auto-allocate using available slots
   */
  const autoAllocate = useCallback(
    async (availableSlots: TimeSlot[]) => {
      setIsAllocating(true);
      setAllocationError(null);

      try {
        // Enforce allowed period on client before auto-selection
        const allowedStart = options.startDate;
        const allowedEnd = options.endDate;
        const isSlotWithinAllowedPeriod = (slot: TimeSlot): boolean => {
          if (allowedStart && slot.startTime < allowedStart) return false;
          if (allowedEnd && slot.startTime > allowedEnd) return false;
          return true;
        };
        const filteredAvailableSlots = availableSlots.filter(
          isSlotWithinAllowedPeriod
        );

        const sessionDuration =
          eventType === "consultation" || eventType === "webinar"
            ? options.durationInHours
            : options.sessionDurationInHours;

        const allocationOptions: AllocationOptions = {
          eventType,
          eventId,
          durationInMonths: options.durationInMonths,
          callsPerWeek: options.callsPerWeek,
          sessionDurationInHours: sessionDuration,
        };

        const result = await AllocationAlgorithms.autoAllocate(
          filteredAvailableSlots,
          allocationOptions
        );

        if (result.success) {
          // Validate result is still within allowed window
          const outOfRange = result.selectedSlots.find(
            (s) => !isSlotWithinAllowedPeriod(s)
          );

          if (outOfRange) {
            const label =
              eventType === "subscription"
                ? "subscription"
                : eventType === "class"
                  ? "class"
                  : "event";
            const rangeText = `${allowedStart?.toLocaleString() || "-"} – ${
              allowedEnd?.toLocaleString() || "-"
            }`;
            const message = `Auto-selected slots include a ${label} time outside the allowed period (${rangeText}).`;
            setAllocationError(message);
            setSelectedSlots([]);
            toast({
              variant: "destructive",
              title: "Outside Allowed Period",
              description: message,
            });
          } else {
            setSelectedSlots(result.selectedSlots);
            toast({
              title: "✅ Slots Auto-Selected",
              description: `${result.selectedSlots.length} consecutive slots selected. Review and confirm allocation.`,
            });
            // Clear any previous errors
            setAllocationError(null);
          }
        } else {
          const errorMessage = result.error || "Auto allocation failed";

          setAllocationError(errorMessage);
          onError?.(errorMessage);
          // Clear selected slots on error
          setSelectedSlots([]);
          // Combine error message with period info if available
          let finalErrorMessage = errorMessage;
          if (allowedStart || allowedEnd) {
            const startText = allowedStart?.toLocaleDateString() || "-";
            const endText = allowedEnd?.toLocaleDateString() || "-";
            const eventLabel =
              eventType === "subscription"
                ? "subscription"
                : eventType === "class"
                  ? "class"
                  : "event";

            finalErrorMessage += `\n\nThe ${eventLabel} period is ${startText} to ${endText}. Please add availability during this period.`;
          }

          toast({
            variant: "destructive",
            title: "Auto Allocation Failed",
            description: finalErrorMessage,
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Auto allocation failed";
        setAllocationError(errorMessage);
        onError?.(errorMessage);
      } finally {
        setIsAllocating(false);
      }
    },
    [eventType, eventId, options, onSuccess, onError, toast]
  );

  /**
   * Pre-allocate using requested slots
   */
  const preAllocate = useCallback(
    async (requestedSlots: TimeSlot[]) => {
      setIsAllocating(true);
      setAllocationError(null);

      try {
        const sessionDuration =
          eventType === "consultation" || eventType === "webinar"
            ? options.durationInHours
            : options.sessionDurationInHours;

        const allocationOptions: AllocationOptions = {
          eventType,
          eventId,
          durationInMonths: options.durationInMonths,
          callsPerWeek: options.callsPerWeek,
          sessionDurationInHours: sessionDuration,
          requestedSlots,
        };

        const result =
          await AllocationAlgorithms.preAllocate(allocationOptions);

        if (result.success) {
          setSelectedSlots(result.selectedSlots);
          toast({
            title: "Success",
            description: "Requested slots allocated successfully",
          });
          onSuccess?.(result);
        } else {
          const errorMessage = result.error || "Pre-allocation failed";
          setAllocationError(errorMessage);
          onError?.(errorMessage);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Pre-allocation failed";
        setAllocationError(errorMessage);
        onError?.(errorMessage);
      } finally {
        setIsAllocating(false);
      }
    },
    [eventType, eventId, options, onSuccess, onError, toast]
  );

  // ==========================================
  // VALIDATION FUNCTIONS
  // ==========================================

  /**
   * Validate current slot selection (strict validation for final allocation)
   */
  const validateSlots = useCallback(() => {
    const result = validateEventSlots(
      selectedSlots,
      eventType,
      eventConstraints,
      slotLimits,
      options
    );

    // For final validation, enforce minimum slot count (except for subscription/class)
    if (
      eventType !== "subscription" &&
      eventType !== "class" &&
      selectedSlots.length < slotLimits.minSlots
    ) {
      result.isValid = false;
      if (!result.errors.some((e) => e.includes("Minimum"))) {
        result.errors.unshift(
          `Minimum ${slotLimits.minSlots} slots required, ${selectedSlots.length} selected`
        );
      }
    }

    return result;
  }, [selectedSlots, eventType, eventConstraints, slotLimits, options]);

  /**
   * Validate specific slots without selecting them (interactive validation)
   */
  const validateSlotsPreview = useCallback(
    (slots: TimeSlot[]) => {
      return validateEventSlots(
        slots,
        eventType,
        eventConstraints,
        slotLimits,
        options
      );
    },
    [eventType, eventConstraints, slotLimits, options]
  );

  // ==========================================
  // EVENT-SPECIFIC HELPERS
  // ==========================================

  /**
   * Get event-specific constraints
   */
  const getEventConstraintsHelper = useCallback(() => {
    return eventConstraints;
  }, [eventConstraints]);

  /**
   * Get slot allocation limits
   */
  const getSlotLimitsHelper = useCallback(() => {
    return slotLimits;
  }, [slotLimits]);

  /**
   * Check if adding a slot would be valid
   */
  const canAddSlot = useCallback(
    (slot: TimeSlot) => {
      const testSelection = [...selectedSlots, slot];
      const validation = validateEventSlots(
        testSelection,
        eventType,
        eventConstraints,
        slotLimits,
        options
      );
      return validation.isValid;
    },
    [selectedSlots, eventType, eventConstraints, slotLimits, options]
  );

  /**
   * Get suggestions for optimal slot selection
   */
  const getSlotSuggestions = useCallback(
    (availableSlots: TimeSlot[]) => {
      // This would implement intelligent slot suggestion logic
      // For now, return simple suggestions based on event type
      const suggestions: TimeSlot[] = [];

      // Implementation would depend on event type and preferences
      // This is a placeholder for the actual suggestion algorithm

      return suggestions;
    },
    [eventType, eventConstraints]
  );

  // ==========================================
  // RETURN HOOK INTERFACE
  // ==========================================

  return {
    // State management
    selectedSlots,
    setSelectedSlots,
    isAllocating,
    allocationError,
    isValid,
    validationResult,

    // Computed values
    requiredSlots,
    canAllocate,
    validationErrors,
    validationWarnings,
    eventConstraints,
    slotLimits,

    // Slot management functions
    toggleSlot,
    clearSlots,
    isSlotSelected,
    addSlots,
    removeSlots,

    // Allocation methods
    manualAllocate,
    manualAllocateWithReschedule,
    autoAllocate,
    preAllocate,

    // Validation functions
    validateSlots,
    validateSlotsPreview,

    // Event-specific helpers
    getEventConstraints: getEventConstraintsHelper,
    getSlotLimits: getSlotLimitsHelper,
    canAddSlot,
    getSlotSuggestions,
  };
}

// ============================================================================
// LEGACY COMPATIBILITY EXPORTS
// ============================================================================

/**
 * @deprecated Use UseEventSlotAllocationOptions instead
 */
export type UseSlotAllocationOptions = UseEventSlotAllocationOptions;

/**
 * @deprecated Use UseEventSlotAllocationReturn instead
 */
export type UseSlotAllocationReturn = UseEventSlotAllocationReturn;

/**
 * @deprecated Use useEventSlotAllocation instead
 */
export const useSlotAllocation = useEventSlotAllocation;
