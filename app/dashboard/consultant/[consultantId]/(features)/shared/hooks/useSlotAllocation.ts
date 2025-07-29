import { useState, useCallback, useEffect, useMemo } from "react";
import { useToast } from "@/components/ui/use-toast";
import {
  TimeSlot,
  validateSelectedSlots,
  calculateRequiredSlots,
  AppointmentDetail,
} from "../utils/calendarUtils";
import {
  AllocationAlgorithms,
  AllocationOptions,
  AllocationResult,
} from "../utils/allocationAlgorithms";

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
        maxHoursPerDay: options.maxHoursPerDay || 4,
        maxSessionsPerDay: options.maxSessionsPerDay || 3,
        allowMultipleSessions: true,
        isDailyLimited: true,
        isOneTimeEvent: false,
      };

    case "subscription":
      return {
        requireConsecutive: false,
        maxCallsPerDay: options.maxCallsPerDay || 1,
        maxTotalCalls: options.maxTotalCalls,
        allowMultipleSessions: false,
        isDailyLimited: true,
        isOneTimeEvent: false,
      };

    case "consultation":
      return {
        requireConsecutive: false,
        allowMultipleSessions: false,
        isDailyLimited: false,
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
    duration
  );

  switch (eventType) {
    case "webinar":
      const webinarSlots = Math.ceil((options.durationInHours || 1) / 0.5); // 30-min intervals
      return {
        minSlots: webinarSlots,
        maxSlots: webinarSlots,
        slotsPerSession: webinarSlots,
        totalSessions: 1,
      };

    case "class":
      const sessionSlots = Math.ceil(
        (options.sessionDurationInHours || 1) / 0.5
      );
      return {
        minSlots: requiredSlots,
        maxSlots: requiredSlots,
        slotsPerSession: sessionSlots,
        totalSessions: Math.ceil(requiredSlots / sessionSlots),
      };

    case "subscription":
      const subscriptionSessionSlots = Math.ceil(
        (options.sessionDurationInHours || 1) / 0.5
      );
      return {
        minSlots: requiredSlots,
        maxSlots: options.maxTotalCalls || requiredSlots,
        slotsPerSession: subscriptionSessionSlots,
        totalSessions: requiredSlots,
      };

    case "consultation":
      const consultationSlots = Math.ceil((options.durationInHours || 1) / 0.5);
      return {
        minSlots: consultationSlots,
        maxSlots: consultationSlots,
        slotsPerSession: consultationSlots,
        totalSessions: 1,
      };

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
  if (slots.length > limits.maxSlots) {
    result.isValid = false;
    result.errors.push(
      `Maximum ${limits.maxSlots} slots allowed, ${slots.length} selected`
    );
  }

  // For interactive selection, only warn about minimum slots
  if (slots.length < limits.minSlots) {
    result.warnings.push(
      `Need ${limits.minSlots - slots.length} more slots (${slots.length}/${limits.minSlots} selected)`
    );
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

    case "class":
      result.dailyHoursValid = validateDailyHours(
        slots,
        constraints.maxHoursPerDay!
      );
      result.sessionDistributionValid = validateSessionDistribution(
        slots,
        constraints.maxSessionsPerDay!
      );

      if (!result.dailyHoursValid) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${constraints.maxHoursPerDay} hours per day exceeded`
        );
      }

      if (!result.sessionDistributionValid) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${constraints.maxSessionsPerDay} sessions per day exceeded`
        );
      }
      break;

    case "subscription":
      // FIXED: Better subscription validation
      const subscriptionValidation = validateSubscriptionSlots(slots, options);
      result.dailyCallsValid = subscriptionValidation.dailyCallsValid;
      result.totalCallsValid = subscriptionValidation.totalCallsValid;

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

      // Add warnings for incomplete calls during selection
      if (subscriptionValidation.incompleteCallWarning) {
        result.warnings.push(subscriptionValidation.incompleteCallWarning);
      }
      break;

    case "consultation":
      // Simple validation for consultations
      if (slots.length > 1) {
        result.isValid = false;
        result.errors.push("Consultation requires only 1 slot");
      }
      break;
  }

  // Weekly distribution validation for recurring events
  if (
    (eventType === "class" || eventType === "subscription") &&
    options.callsPerWeek &&
    slots.length > 0
  ) {
    result.weeklyDistributionValid = validateWeeklyDistribution(
      slots,
      options.callsPerWeek
    );
    if (!result.weeklyDistributionValid) {
      result.warnings.push(
        `Consider distributing slots more evenly across weeks`
      );
    }
  }

  return result;
}

// ============================================================================
// VALIDATION HELPER FUNCTIONS
// ============================================================================

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
  for (const [date, dailySlots] of Array.from(slotsByDate.entries())) {
    // Sort slots by start time
    const sortedSlots = dailySlots.sort(
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
  }

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
function validateSubscriptionSlots(
  slots: TimeSlot[],
  options: UseEventSlotAllocationOptions
): {
  dailyCallsValid: boolean;
  totalCallsValid: boolean;
  dailyCallsError?: string;
  totalCallsError?: string;
  incompleteCallWarning?: string;
} {
  const sessionDurationHours = options.sessionDurationInHours || 1;
  const slotsPerCall = Math.ceil(sessionDurationHours / 0.5);
  const maxCallsPerDay = options.maxCallsPerDay || 1;
  const maxTotalCalls = options.maxTotalCalls;

  // Group slots by day
  const slotsByDay = new Map<string, TimeSlot[]>();
  slots.forEach((slot) => {
    const dayKey = slot.startTime.toDateString();
    if (!slotsByDay.has(dayKey)) {
      slotsByDay.set(dayKey, []);
    }
    slotsByDay.get(dayKey)!.push(slot);
  });

  // Validate daily calls
  let dailyCallsValid = true;
  let dailyCallsError: string | undefined;

  for (const [day, daySlots] of Array.from(slotsByDay.entries())) {
    // Check if slots for this day exceed the per-call limit
    if (daySlots.length > slotsPerCall) {
      dailyCallsValid = false;
      dailyCallsError = `Too many slots selected for ${day}. Maximum ${slotsPerCall} slots (${sessionDurationHours}h) per call allowed.`;
      break;
    }

    // Check if slots for this day are consecutive (if more than 1)
    if (daySlots.length > 1) {
      const sortedSlots = daySlots.sort(
        (a: TimeSlot, b: TimeSlot) =>
          a.startTime.getTime() - b.startTime.getTime()
      );

      for (let i = 1; i < sortedSlots.length; i++) {
        const prevSlot = sortedSlots[i - 1];
        const currentSlot = sortedSlots[i];

        if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
          dailyCallsValid = false;
          dailyCallsError = `Slots for ${day} must be consecutive to form a complete call.`;
          break;
        }
      }

      if (!dailyCallsValid) break;
    }
  }

  // Validate total calls
  let totalCallsValid = true;
  let totalCallsError: string | undefined;

  if (maxTotalCalls && slots.length > maxTotalCalls * slotsPerCall) {
    totalCallsValid = false;
    totalCallsError = `Maximum ${maxTotalCalls} calls allowed for this subscription.`;
  }

  // Generate warning for incomplete calls
  let incompleteCallWarning: string | undefined;
  const incompleteDays = Array.from(slotsByDay.entries()).filter(
    ([day, daySlots]) => daySlots.length > 0 && daySlots.length < slotsPerCall
  );

  if (incompleteDays.length > 0) {
    const incompleteDay = incompleteDays[0][0];
    const incompleteDaySlots = incompleteDays[0][1];
    const needed = slotsPerCall - incompleteDaySlots.length;
    incompleteCallWarning = `Call on ${incompleteDay} needs ${needed} more consecutive slots to complete.`;
  }

  return {
    dailyCallsValid,
    totalCallsValid,
    dailyCallsError,
    totalCallsError,
    incompleteCallWarning,
  };
}

// ============================================================================
// MAIN HOOK IMPLEMENTATION
// ============================================================================

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
    consultantId,
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
      duration
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
  const canAllocate = isValid && selectedSlots.length === requiredSlots;

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
        const isSelected = current.some(
          (s) => s.startTime.getTime() === slot.startTime.getTime()
        );

        if (isSelected) {
          // Remove slot
          return current.filter(
            (s) => s.startTime.getTime() !== slot.startTime.getTime()
          );
        } else {
          // Add slot with event-specific limits
          const newSelection = [...current, slot];

          // Validate against limits
          if (newSelection.length > slotLimits.maxSlots) {
            setTimeout(() => {
              setPendingToast({
                variant: "destructive",
                title: "Selection Limit",
                description: `Maximum ${slotLimits.maxSlots} slots allowed for ${eventType}`,
              });
            }, 0);
            return current;
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
              return current;
            }
          }

          // FIXED: Subscription-specific validation
          if (eventType === "subscription" && options.sessionDurationInHours) {
            const slotsPerCall = Math.ceil(
              options.sessionDurationInHours / 0.5
            );
            const totalCalls = Math.ceil(requiredSlots / slotsPerCall);

            // Check if we're exceeding the total call limit
            if (newSelection.length > requiredSlots) {
              setTimeout(() => {
                setPendingToast({
                  variant: "destructive",
                  title: "Call Limit Reached",
                  description: `Maximum ${totalCalls} calls allowed for this subscription`,
                });
              }, 0);
              return current;
            }

            // Check daily call limit BEFORE adding the new slot
            const newSlotDay = slot.startTime.toDateString();
            const currentDaySlots = current.filter(
              (selectedSlot) =>
                selectedSlot.startTime.toDateString() === newSlotDay
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
              return current;
            }

            // If we have existing slots for this day, check if the new slot would be consecutive
            if (currentDaySlots.length > 0) {
              // Sort existing slots for this day
              const sortedDaySlots = currentDaySlots.sort(
                (a, b) => a.startTime.getTime() - b.startTime.getTime()
              );

              // Check if the new slot would be consecutive with existing slots
              const lastSlot = sortedDaySlots[sortedDaySlots.length - 1];
              const firstSlot = sortedDaySlots[0];

              // New slot should be either immediately before the first slot or after the last slot
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
                      "Subscription call slots must be consecutive within the same day",
                  });
                }, 0);
                return current;
              }
            }

            // Show progress feedback
            const completedCalls = Math.floor(
              newSelection.length / slotsPerCall
            );
            const currentCallProgress = newSelection.length % slotsPerCall;

            if (currentCallProgress === 0 && newSelection.length > 0) {
              // Just completed a call
              setTimeout(() => {
                setPendingToast({
                  variant: "default",
                  title: "Call Completed",
                  description: `Call ${completedCalls} completed (${completedCalls}/${totalCalls} total calls)`,
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

          return newSelection.sort(
            (a, b) => a.startTime.getTime() - b.startTime.getTime()
          );
        }
      });
    },
    [eventType, eventConstraints, slotLimits, options, requiredSlots]
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
        setSelectedSlots(
          newSelection.sort(
            (a, b) => a.startTime.getTime() - b.startTime.getTime()
          )
        );
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
    if (!isValid) {
      const errorMessage = validationErrors[0] || "Invalid slot selection";
      setAllocationError(errorMessage);
      onError?.(errorMessage);
      return;
    }

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
      };

      const result = await AllocationAlgorithms.manualAllocate(
        selectedSlots,
        allocationOptions
      );

      if (result.success) {
        toast({
          title: "Success",
          description: "Slots allocated successfully",
        });
        onSuccess?.(result);
      } else {
        const errorMessage = result.error || "Manual allocation failed";
        setAllocationError(errorMessage);
        onError?.(errorMessage);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Allocation failed";
      setAllocationError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setIsAllocating(false);
    }
  }, [
    selectedSlots,
    isValid,
    validationErrors,
    eventType,
    eventId,
    options,
    onSuccess,
    onError,
    toast,
  ]);

  /**
   * Auto-allocate using available slots
   */
  const autoAllocate = useCallback(
    async (availableSlots: TimeSlot[]) => {
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
        };

        const result = await AllocationAlgorithms.autoAllocate(
          availableSlots,
          allocationOptions
        );

        if (result.success) {
          setSelectedSlots(result.selectedSlots);
          toast({
            title: "Success",
            description: "Slots auto-allocated successfully",
          });
          onSuccess?.(result);
        } else {
          const errorMessage = result.error || "Auto allocation failed";
          setAllocationError(errorMessage);
          onError?.(errorMessage);
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

    // For final validation, enforce minimum slot count
    if (selectedSlots.length < slotLimits.minSlots) {
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
