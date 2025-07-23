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
 * - Classes: Sessions-based, max 4hrs/day, use durationInMonths + sessionDurationInHours
 * - Subscriptions: 1 call/day limit, use durationInMonths + sessionDurationInHours per call
 * - Consultations: One-time events, use durationInHours for consultation duration
 *
 * DURATION FIELD USAGE:
 * - durationInHours: For consultations & webinars (single session duration)
 * - durationInMonths: For subscriptions & classes (overall plan duration)
 * - sessionDurationInHours: For subscriptions & classes (each individual session duration)
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

  // Basic slot count validation
  if (slots.length < limits.minSlots) {
    result.isValid = false;
    result.errors.push(
      `Minimum ${limits.minSlots} slots required, ${slots.length} selected`
    );
  }

  if (slots.length > limits.maxSlots) {
    result.isValid = false;
    result.errors.push(
      `Maximum ${limits.maxSlots} slots allowed, ${slots.length} selected`
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
      result.dailyCallsValid = validateDailyCalls(
        slots,
        constraints.maxCallsPerDay!
      );
      result.totalCallsValid = validateTotalCalls(
        slots,
        constraints.maxTotalCalls
      );

      if (!result.dailyCallsValid) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${constraints.maxCallsPerDay} call per day exceeded`
        );
      }

      if (!result.totalCallsValid && constraints.maxTotalCalls) {
        result.isValid = false;
        result.errors.push(
          `Maximum ${constraints.maxTotalCalls} total calls exceeded`
        );
      }
      break;

    case "consultation":
      // No additional validation for consultations
      break;
  }

  // Weekly distribution validation for recurring events
  if (
    (eventType === "class" || eventType === "subscription") &&
    options.callsPerWeek
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
 */
function validateSessionDistribution(
  slots: TimeSlot[],
  maxSessions: number
): boolean {
  const dailySessions = new Map<string, number>();

  slots.forEach((slot) => {
    const dateKey = slot.startTime.toDateString();
    dailySessions.set(dateKey, (dailySessions.get(dateKey) || 0) + 1);
  });

  return Array.from(dailySessions.values()).every(
    (sessions) => sessions <= maxSessions
  );
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
  }, [selectedSlots]);

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
            toast({
              variant: "destructive",
              title: "Selection Limit",
              description: `Maximum ${slotLimits.maxSlots} slots allowed for ${eventType}`,
            });
            return current;
          }

          // Event-specific validation
          const validation = validateEventSlots(
            newSelection,
            eventType,
            eventConstraints,
            slotLimits,
            options
          );

          if (!validation.isValid && validation.errors.length > 0) {
            toast({
              variant: "destructive",
              title: "Invalid Selection",
              description: validation.errors[0],
            });
            return current;
          }

          return newSelection.sort(
            (a, b) => a.startTime.getTime() - b.startTime.getTime()
          );
        }
      });
    },
    [eventType, eventConstraints, slotLimits, options, toast]
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
        toast({
          variant: "destructive",
          title: "Invalid Selection",
          description: validation.errors[0] || "Invalid slot selection",
        });
      }
    },
    [selectedSlots, eventType, eventConstraints, slotLimits, options, toast]
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
   * Validate current slot selection
   */
  const validateSlots = useCallback(() => {
    return validateEventSlots(
      selectedSlots,
      eventType,
      eventConstraints,
      slotLimits,
      options
    );
  }, [selectedSlots, eventType, eventConstraints, slotLimits, options]);

  /**
   * Validate specific slots without selecting them
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
