import { TimeSlot, calculateRequiredSlots } from "./calendarUtils";
import { AllocationService } from "./allocationService";
import { SlotCalculationService } from "./slotCalculationService";

/**
 * AUTO ALLOCATION ENHANCEMENT SYSTEM
 * ==================================
 *
 * MAJOR ENHANCEMENTS IMPLEMENTED:
 *
 * 1. PREFERENCE-BASED ALLOCATION:
 *    - Time preferences (morning 9-12, afternoon 1-5, evening 6-8)
 *    - Weekday vs weekend preferences
 *    - Configurable minimum time between sessions
 *
 * 2. MULTIPLE ALLOCATION STRATEGIES:
 *    - Consultation: "earliest-available" strategy
 *    - Webinar: "consecutive-slots" strategy for multi-hour events
 *    - Subscription/Class: "optimal-distribution" strategy with weekly spreading
 *
 * 3. SMART SCORING ALGORITHM:
 *    - Time scoring: Prime business hours (10-4) score 10, extended hours lower
 *    - Day scoring: Tuesday/Wednesday/Thursday highest, weekends lowest
 *    - Preference-based filtering before allocation
 *    - Intelligent spacing to avoid conflicts
 */

export interface AllocationOptions {
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId: string;
  
  // Duration parameters - use the appropriate one based on event type:
  // - For consultations & webinars: totalDurationInHours (total event duration)
  // - For subscriptions & classes: sessionDurationInHours (duration per session)
  totalDurationInHours?: number;      // For consultations and webinars
  sessionDurationInHours?: number;    // For subscriptions and classes
  
  // Subscription/Class specific parameters
  durationInMonths?: number;          // Total duration in months
  callsPerWeek?: number;              // Number of calls/sessions per week
  
  // Manual allocation
  requestedSlots?: TimeSlot[];
}

export interface AllocationResult {
  success: boolean;
  selectedSlots: TimeSlot[];
  error?: string;
  strategy?: string; // ENHANCEMENT: Track which allocation strategy was used
}

/**
 * AUTO ALLOCATION PREFERENCES - NEW FEATURE
 * ==========================================
 *
 * Allows users to configure their scheduling preferences:
 * - Time of day preferences (morning, afternoon, evening)
 * - Weekday vs weekend preferences
 * - Minimum spacing between sessions on same day
 */
export interface AutoAllocationPreferences {
  preferWeekdays?: boolean;
  preferMorning?: boolean; // 9 AM - 12 PM
  preferAfternoon?: boolean; // 1 PM - 5 PM
  preferEvening?: boolean; // 6 PM - 8 PM
  excludeWeekends?: boolean;
  minTimeBetweenSessions?: number; // Hours between sessions (for same day)
}

/**
 * Helper function to determine session duration based on event type and options
 */
function getSessionDuration(options: AllocationOptions): number {
  switch (options.eventType) {
    case "consultation":
    case "webinar":
      return options.totalDurationInHours || 1;
    case "subscription":
    case "class":
      return options.sessionDurationInHours || 1;
    default:
      return 1;
  }
}

/**
 * Enhanced allocation algorithms with smart preference-based selection
 */
export class AllocationAlgorithms {
  /**
   * Manual allocation - uses the slots selected by the user
   * ENHANCED: Better validation and error handling
   */
  static async manualAllocate(
    selectedSlots: TimeSlot[],
    options: AllocationOptions,
  ): Promise<AllocationResult> {
    try {
      // Get standardized session duration
      const sessionDuration = getSessionDuration(options);

      // VALIDATION: Check required slots count
      const requiredSlots = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.callsPerWeek,
        sessionDuration,
      );

      if (selectedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Expected ${requiredSlots} slots but received ${selectedSlots.length}`,
        };
      }

      // VALIDATION: No past slots allowed
      const now = new Date();
      const pastSlots = selectedSlots.filter((slot) => slot.startTime < now);
      if (pastSlots.length > 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "Cannot allocate slots in the past",
        };
      }

      // BUSINESS RULE: Webinar slots must be consecutive
      if (options.eventType === "webinar" && selectedSlots.length > 1) {
        const sortedSlots = [...selectedSlots].sort(
          (a, b) => a.startTime.getTime() - b.startTime.getTime(),
        );

        for (let i = 1; i < sortedSlots.length; i++) {
          const prevSlot = sortedSlots[i - 1];
          const currentSlot = sortedSlots[i];
          if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            return {
              success: false,
              selectedSlots: [],
              error: "Webinar slots must be consecutive",
            };
          }
        }
      }

      // BUSINESS RULE: Subscription/Class distribution validation
      if (
        options.eventType === "subscription" ||
        options.eventType === "class"
      ) {
        if (!options.callsPerWeek) {
          return {
            success: false,
            selectedSlots: [],
            error:
              "Calls per week is required for subscription/class allocation",
          };
        }

        const distributionValidation = this.validateSlotDistribution(
          selectedSlots,
          options.callsPerWeek,
        );

        if (!distributionValidation.isValid) {
          return {
            success: false,
            selectedSlots: [],
            error: distributionValidation.errorMessage,
          };
        }
      }

      // Call the allocation service
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        selectedSlots,
      );

      if (!allocationResult.success) {
        return {
          success: false,
          selectedSlots: [],
          error: allocationResult.error,
        };
      }

      return {
        success: true,
        selectedSlots: selectedSlots,
        strategy: "manual",
      };
    } catch (error) {
      console.error("Manual allocation error:", error);
      return {
        success: false,
        selectedSlots: [],
        error:
          error instanceof Error ? error.message : "Manual allocation failed",
      };
    }
  }

  /**
   * ENHANCED AUTO ALLOCATION - MAJOR FEATURE UPGRADE
   * ================================================
   *
   * NEW FEATURES:
   * 1. Preference-based filtering before allocation
   * 2. Multiple allocation strategies based on event type
   * 3. Smart scoring system for optimal slot selection
   * 4. Intelligent spacing for recurring events
   */
  static async autoAllocate(
    availableSlots: TimeSlot[],
    options: AllocationOptions,
    preferences: AutoAllocationPreferences = {},
  ): Promise<AllocationResult> {
    try {
      // Get standardized session duration
      const sessionDuration = getSessionDuration(options);
      
      // Calculate required slots using consistent logic
      const getSlotsPerSession = (hours: number) => SlotCalculationService.hoursToSlots(hours);
      
      let effectiveRequiredSlots: number;
      
      switch (options.eventType) {
        case "consultation":
        case "webinar":
          effectiveRequiredSlots = getSlotsPerSession(sessionDuration);
          break;
        case "subscription":
          // For subscriptions in auto-allocation, we allocate for one week at a time
          effectiveRequiredSlots = (options.callsPerWeek || 1) * getSlotsPerSession(sessionDuration);
          break;
        case "class":
          // Use the standardized calculation
          effectiveRequiredSlots = calculateRequiredSlots(
            options.eventType,
            options.durationInMonths,
            options.callsPerWeek,
            sessionDuration,
          );
          break;
        default:
          throw new Error(`Unsupported event type: ${options.eventType}`);
      }

      // console.log("🤖 Auto-allocation started:", {
      // eventType: options.eventType,
      // requiredSlots,
      // availableSlots: availableSlots.length,
      // preferences,
      // });

      let selectedSlots: TimeSlot[] = [];
      let strategy = "";

      // STEP 1: Filter available slots
      // For consultations, use a simple FCFS approach without preference filtering
      const filteredSlots =
        options.eventType === "consultation"
          ? availableSlots
          : this.filterSlotsByPreferences(availableSlots, preferences);

      if (
        filteredSlots.length < effectiveRequiredSlots &&
        options.eventType !== "consultation"
      ) {
        // Create period-specific error message
        const periodInfo = this.getPeriodErrorMessage(options);
        return {
          success: false,
          selectedSlots: [],
          error: `Not enough slots available${periodInfo ? ` ${periodInfo}` : ""}. Need ${effectiveRequiredSlots}, found ${filteredSlots.length}. Please add availability during the allowed period.`,
        };
      }

      // STEP 2: Apply event-specific allocation strategy
      switch (options.eventType) {
        case "consultation": {
          // STRATEGY: FCFS across all available periods, consecutive same-day slots
          selectedSlots = this.allocateConsecutiveSlots(
            filteredSlots,
            sessionDuration,
            true // same day required
          );
          strategy = "earliest-available";
          break;
        }

        case "webinar": {
          // STRATEGY: FCFS across all available periods, consecutive same-day slots
          selectedSlots = this.allocateConsecutiveSlots(
            filteredSlots,
            sessionDuration,
            true // same day required
          );
          strategy = "consecutive-slots";
          break;
        }

        case "subscription": {
          // STRATEGY: Allocate calls for current subscription period
          selectedSlots = this.allocateSubscriptionSlots(
            filteredSlots,
            options.callsPerWeek || 1,
            getSlotsPerSession(sessionDuration),
          );
          strategy = "optimal-distribution";
          break;
        }
        case "class":
          // STRATEGY: Optimal distribution across the class duration
          selectedSlots = this.allocateRecurringSlots(
            filteredSlots,
            effectiveRequiredSlots,
            options.callsPerWeek || 1,
            options.durationInMonths || 1,
            preferences,
          );
          strategy = "optimal-distribution";
          break;
      }

      if (selectedSlots.length === 0) {
        const periodInfo = this.getPeriodErrorMessage(options);
        return {
          success: false,
          selectedSlots: [],
          error: `Could not find suitable consecutive slots${periodInfo ? ` ${periodInfo}` : ""}. Please add availability during the allowed period or try manual selection.`,
        };
      }

      // Validate final slot count
      if (selectedSlots.length !== effectiveRequiredSlots) {
        const periodInfo = this.getPeriodErrorMessage(options);
        const eventTypeName = options.eventType;
        const durationText = sessionDuration === 1 ? "1 hour" : `${sessionDuration} hours`;
        
        let errorMessage: string;
        
        if (options.eventType === "consultation" || options.eventType === "webinar") {
          errorMessage = `Not enough consecutive slots available${periodInfo ? ` ${periodInfo}` : ""}. Need ${effectiveRequiredSlots} consecutive slots for ${durationText} ${eventTypeName}.`;
        } else if (options.eventType === "subscription") {
          const callsPerWeek = options.callsPerWeek || 1;
          const slotsPerCall = getSlotsPerSession(sessionDuration);
          errorMessage = `Not enough slots available${periodInfo ? ` ${periodInfo}` : ""}. Need ${callsPerWeek} calls of ${slotsPerCall} slots each (${effectiveRequiredSlots} total slots).`;
        } else {
          errorMessage = `Could only allocate ${selectedSlots.length} of ${effectiveRequiredSlots} required slots${periodInfo ? ` ${periodInfo}` : ""}.`;
        }
        
        return {
          success: false,
          selectedSlots: [],
          error: errorMessage,
        };
      }

      // STEP 3: For consultations/webinars/subscriptions, just return selected slots (no backend call)
      if (
        options.eventType === "consultation" ||
        options.eventType === "webinar" ||
        options.eventType === "subscription"
      ) {
        return {
          success: true,
          selectedSlots,
          strategy,
        };
      }

      // For other event types, proceed with backend allocation
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        selectedSlots,
      );

      if (!allocationResult.success) {
        return {
          success: false,
          selectedSlots: [],
          error: allocationResult.error,
        };
      }

      return {
        success: true,
        selectedSlots,
        strategy,
      };
    } catch (error) {
      console.error("Auto allocation error:", error);
      return {
        success: false,
        selectedSlots: [],
        error:
          error instanceof Error ? error.message : "Auto allocation failed",
      };
    }
  }

  /**
   * Pre-allocate using requested slots from the consultee
   */
  static async preAllocate(
    options: AllocationOptions,
  ): Promise<AllocationResult> {
    try {
      if (!options.requestedSlots || options.requestedSlots.length === 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "No requested slots provided",
        };
      }

      // Get standardized session duration
      const sessionDuration = getSessionDuration(options);

      const requiredSlots = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.callsPerWeek,
        sessionDuration,
      );

      if (options.requestedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Requested ${options.requestedSlots.length} slots but need ${requiredSlots}`,
        };
      }

      // Call the allocation service
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        options.requestedSlots,
        { useRequestedSlots: true },
      );

      if (!allocationResult.success) {
        return {
          success: false,
          selectedSlots: [],
          error: allocationResult.error,
        };
      }

      return {
        success: true,
        selectedSlots: options.requestedSlots,
        strategy: "requested-slots",
      };
    } catch (error) {
      console.error("Pre-allocation error:", error);
      return {
        success: false,
        selectedSlots: [],
        error: error instanceof Error ? error.message : "Pre-allocation failed",
      };
    }
  }

  /**
   * Filter slots based on user preferences
   */
  private static filterSlotsByPreferences(
    slots: TimeSlot[],
    preferences: AutoAllocationPreferences,
  ): TimeSlot[] {
    const now = new Date();

    return slots.filter((slot) => {
      // Basic filters
      if (slot.startTime <= now || !slot.isAvailable || slot.isBooked) {
        return false;
      }

      const hour = slot.startTime.getHours();
      const day = slot.startTime.getDay();

      // Weekend filter
      if (preferences.excludeWeekends && (day === 0 || day === 6)) {
        return false;
      }

      // Time preference filters
      if (preferences.preferMorning && (hour < 9 || hour >= 12)) {
        return false;
      }
      if (preferences.preferAfternoon && (hour < 13 || hour >= 17)) {
        return false;
      }
      if (preferences.preferEvening && (hour < 18 || hour >= 20)) {
        return false;
      }

      return true;
    });
  }

  /**
   * Allocate consecutive slots with improved algorithm
   * Removes weekly restriction and supports flexible time ranges
   */
  private static allocateConsecutiveSlots(
    availableSlots: TimeSlot[],
    durationHours: number,
    requireSameDay: boolean = true,
  ): TimeSlot[] {
    const requiredSlots = SlotCalculationService.hoursToSlots(durationHours); // 30-minute intervals
    const now = new Date();

    // Filter valid slots (available, not booked, in future)
    const validSlots = availableSlots
      .filter((s) => s.isAvailable && !s.isBooked && s.startTime > now)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    if (requiredSlots === 1) {
      return validSlots.slice(0, 1);
    }

    // Group by day if same-day requirement is enabled
    if (requireSameDay) {
      const byDay = new Map<string, TimeSlot[]>();
      for (const slot of validSlots) {
        const dayKey = slot.startTime.toDateString();
        if (!byDay.has(dayKey)) byDay.set(dayKey, []);
        byDay.get(dayKey)!.push(slot);
      }

      // Check each day for consecutive slots
      const orderedDays = Array.from(byDay.keys()).sort(
        (a, b) => new Date(a).getTime() - new Date(b).getTime(),
      );

      for (const dayKey of orderedDays) {
        const daySlots = byDay.get(dayKey)!;
        const consecutive = this.findConsecutiveSlots(daySlots, requiredSlots);
        if (consecutive.length === requiredSlots) {
          return consecutive;
        }
      }
    } else {
      // Allow cross-day consecutive slots
      return this.findConsecutiveSlots(validSlots, requiredSlots);
    }

    return []; // No consecutive slots found
  }

  /**
   * Helper method to find consecutive slots in a sorted array
   */
  private static findConsecutiveSlots(
    sortedSlots: TimeSlot[],
    requiredCount: number,
  ): TimeSlot[] {
    let consecutiveRun: TimeSlot[] = [];
    
    for (const currentSlot of sortedSlots) {
      if (consecutiveRun.length === 0) {
        consecutiveRun.push(currentSlot);
      } else {
        const prevSlot = consecutiveRun[consecutiveRun.length - 1];
        // Check if slots are consecutive (30-minute intervals)
        if (currentSlot.startTime.getTime() === prevSlot.endTime.getTime()) {
          consecutiveRun.push(currentSlot);
        } else {
          // Reset the run if not consecutive
          consecutiveRun = [currentSlot];
        }
      }
      
      // Return immediately when we find enough consecutive slots
      if (consecutiveRun.length >= requiredCount) {
        return consecutiveRun.slice(0, requiredCount);
      }
    }
    
    return []; // Not enough consecutive slots found
  }

  /**
   * Improved subscription allocation - removes weekly restriction
   */
  private static allocateSubscriptionSlots(
    availableSlots: TimeSlot[],
    callsPerWeek: number,
    slotsPerCall: number,
  ): TimeSlot[] {
    const now = new Date();
    const validSlots = availableSlots
      .filter((s) => s.isAvailable && !s.isBooked && s.startTime > now)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // Group by day to ensure we don't exceed one call per day
    const byDay = new Map<string, TimeSlot[]>();
    for (const slot of validSlots) {
      const dayKey = slot.startTime.toDateString();
      if (!byDay.has(dayKey)) byDay.set(dayKey, []);
      byDay.get(dayKey)!.push(slot);
    }

    const orderedDays = Array.from(byDay.keys()).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );

    const selectedSlots: TimeSlot[] = [];
    let callsAllocated = 0;

    for (const dayKey of orderedDays) {
      if (callsAllocated >= callsPerWeek) break;
      
      const daySlots = byDay.get(dayKey)!;
      const consecutiveSlots = this.findConsecutiveSlots(daySlots, slotsPerCall);
      
      if (consecutiveSlots.length === slotsPerCall) {
        selectedSlots.push(...consecutiveSlots);
        callsAllocated++;
      }
    }

    return selectedSlots;
  }

  /**
   * FCFS consultation allocator - search all available slots within allowed period
   * @deprecated - Use allocateConsecutiveSlots instead
   */
  private static allocateConsultationSlotsFcfsWeek(
    availableSlots: TimeSlot[],
    durationHours: number,
  ): TimeSlot[] {
    const required = SlotCalculationService.hoursToSlots(durationHours || 1);
    const now = new Date();

    // Use ALL available slots (already filtered by allowed period upstream)
    const validSlots = availableSlots
      .filter((s) => s.isAvailable && !s.isBooked && s.startTime > now)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // Group by day
    const byDay = new Map<string, TimeSlot[]>();
    for (const s of validSlots) {
      const key = s.startTime.toDateString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(s);
    }

    // Iterate days in chronological order
    const orderedDays = Array.from(byDay.keys()).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );

    for (const dayKey of orderedDays) {
      const daySlots = byDay.get(dayKey)!;
      // Ensure sorted
      daySlots.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

      // Scan for the first consecutive run with length >= required
      let run: TimeSlot[] = [];
      for (let i = 0; i < daySlots.length; i++) {
        const current = daySlots[i];
        if (run.length === 0) {
          run.push(current);
        } else {
          const prev = run[run.length - 1];
          if (current.startTime.getTime() === prev.endTime.getTime()) {
            run.push(current);
          } else {
            run = [current];
          }
        }
        if (run.length >= required) {
          return run.slice(0, required);
        }
      }
    }

    return [];
  }

  /**
   * Allocate consecutive slots for webinars
   */
  private static allocateWebinarSlots(
    availableSlots: TimeSlot[],
    durationHours: number,
  ): TimeSlot[] {
    const requiredSlots = Math.ceil(durationHours * 2); // 30-minute intervals

    if (requiredSlots === 1) {
      return this.allocateConsecutiveSlots(availableSlots, durationHours, true);
    }

    // Find consecutive slots
    const sortedSlots = availableSlots.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    for (let i = 0; i <= sortedSlots.length - requiredSlots; i++) {
      const consecutiveSlots = [];
      let isConsecutive = true;

      // Check if we have enough consecutive slots starting from this position
      for (let j = 0; j < requiredSlots; j++) {
        const currentSlot = sortedSlots[i + j];
        if (!currentSlot) {
          isConsecutive = false;
          break;
        }

        if (j > 0) {
          const prevSlot = consecutiveSlots[j - 1];
          if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            isConsecutive = false;
            break;
          }
        }

        consecutiveSlots.push(currentSlot);
      }

      if (isConsecutive && consecutiveSlots.length === requiredSlots) {
        return consecutiveSlots;
      }
    }

    return []; // No consecutive slots found
  }

  /**
   * FCFS webinar allocator - search all available slots within allowed period
   */
  private static allocateWebinarSlotsFcfsWeek(
    availableSlots: TimeSlot[],
    durationHours: number,
  ): TimeSlot[] {
    const required = SlotCalculationService.hoursToSlots(durationHours || 1);
    const now = new Date();

    // Use ALL available slots (already filtered by allowed period upstream)
    const validSlots = availableSlots
      .filter((s) => s.isAvailable && !s.isBooked && s.startTime > now)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // Group by day
    const byDay = new Map<string, TimeSlot[]>();
    for (const s of validSlots) {
      const key = s.startTime.toDateString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(s);
    }

    const orderedDays = Array.from(byDay.keys()).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );
    for (const dayKey of orderedDays) {
      const daySlots = byDay.get(dayKey)!;
      daySlots.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      let run: TimeSlot[] = [];
      for (const current of daySlots) {
        if (run.length === 0) {
          run.push(current);
        } else {
          const prev = run[run.length - 1];
          if (current.startTime.getTime() === prev.endTime.getTime()) {
            run.push(current);
          } else {
            run = [current];
          }
        }
        if (run.length >= required) return run.slice(0, required);
      }
    }
    return [];
  }

  /**
   * FCFS subscription allocator - search all available slots within allowed period
   */
  private static allocateSubscriptionSlotsFcfsWeek(
    availableSlots: TimeSlot[],
    callsPerWeek: number,
    slotsPerCall: number,
  ): TimeSlot[] {
    const now = new Date();

    // Use ALL available slots (already filtered by allowed period upstream)
    const validSlots = availableSlots
      .filter((s) => s.isAvailable && !s.isBooked && s.startTime > now)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    const byDay = new Map<string, TimeSlot[]>();
    for (const s of validSlots) {
      const key = s.startTime.toDateString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(s);
    }

    const orderedDays = Array.from(byDay.keys()).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );
    const selected: TimeSlot[] = [];
    let callsPicked = 0;
    for (const dayKey of orderedDays) {
      if (callsPicked >= callsPerWeek) break;
      const daySlots = byDay.get(dayKey)!;
      daySlots.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

      let run: TimeSlot[] = [];
      for (const current of daySlots) {
        if (run.length === 0) {
          run.push(current);
        } else {
          const prev = run[run.length - 1];
          if (current.startTime.getTime() === prev.endTime.getTime()) {
            run.push(current);
          } else {
            run = [current];
          }
        }
        if (run.length >= slotsPerCall) {
          selected.push(...run.slice(0, slotsPerCall));
          callsPicked += 1;
          break;
        }
      }
    }
    return selected;
  }

  /**
   * Allocate slots for recurring events (subscriptions/classes)
   */
  private static allocateRecurringSlots(
    availableSlots: TimeSlot[],
    totalSlots: number,
    callsPerWeek: number,
    durationInMonths: number,
    preferences: AutoAllocationPreferences,
  ): TimeSlot[] {
    const futureSlots = availableSlots.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    const selectedSlots: TimeSlot[] = [];
    // FIXED: Use actual duration and frequency instead of hardcoded weeks calculation
    const totalWeeks = durationInMonths; // Use actual months as weeks for allocation purposes

    // Group slots by week
    const slotsByWeek = new Map<string, TimeSlot[]>();
    futureSlots.forEach((slot) => {
      const weekStart = this.getWeekStart(slot.startTime);
      const weekKey = weekStart.toISOString();

      if (!slotsByWeek.has(weekKey)) {
        slotsByWeek.set(weekKey, []);
      }
      slotsByWeek.get(weekKey)!.push(slot);
    });

    // Sort weeks by date
    const sortedWeeks = Array.from(slotsByWeek.keys()).sort();

    // Allocate slots week by week with smart distribution
    let currentWeek = 0;
    for (const weekKey of sortedWeeks) {
      if (selectedSlots.length >= totalSlots || currentWeek >= totalWeeks) {
        break;
      }

      const weekSlots = slotsByWeek.get(weekKey)!;
      const slotsNeededThisWeek = Math.min(
        callsPerWeek,
        totalSlots - selectedSlots.length,
      );

      // Sort slots by preference and ensure minimum time between sessions
      const preferredSlots = this.sortSlotsByPreference(weekSlots);
      const selectedThisWeek = this.selectSlotsWithSpacing(
        preferredSlots,
        slotsNeededThisWeek,
        preferences.minTimeBetweenSessions || 2, // Default 2 hours minimum
      );

      selectedSlots.push(...selectedThisWeek);
      currentWeek++;
    }

    return selectedSlots;
  }

  /**
   * Select slots ensuring minimum time between sessions
   */
  private static selectSlotsWithSpacing(
    slots: TimeSlot[],
    count: number,
    minHoursBetween: number,
  ): TimeSlot[] {
    const selected: TimeSlot[] = [];
    const minMsBetween = minHoursBetween * 60 * 60 * 1000;

    for (const slot of slots) {
      if (selected.length >= count) break;

      // Check if this slot conflicts with already selected slots
      const hasConflict = selected.some((selectedSlot) => {
        const timeDiff = Math.abs(
          slot.startTime.getTime() - selectedSlot.startTime.getTime(),
        );
        return timeDiff < minMsBetween;
      });

      if (!hasConflict) {
        selected.push(slot);
      }
    }

    return selected;
  }

  /**
   * Enhanced slot preference sorting
   */
  private static sortSlotsByPreference(slots: TimeSlot[]): TimeSlot[] {
    return slots.sort((a, b) => {
      // Prefer weekdays over weekends
      const aIsWeekday = this.isWeekday(a.startTime);
      const bIsWeekday = this.isWeekday(b.startTime);

      if (aIsWeekday !== bIsWeekday) {
        return aIsWeekday ? -1 : 1;
      }

      // Prefer optimal time ranges
      const aHour = a.startTime.getHours();
      const bHour = b.startTime.getHours();

      const aScore = this.getTimeScore(aHour);
      const bScore = this.getTimeScore(bHour);

      if (aScore !== bScore) {
        return bScore - aScore; // Higher score is better
      }

      // Prefer earlier days in the week
      const aDayScore = this.getDayScore(a.startTime.getDay());
      const bDayScore = this.getDayScore(b.startTime.getDay());

      if (aDayScore !== bDayScore) {
        return bDayScore - aDayScore;
      }

      // Finally, sort by time
      return a.startTime.getTime() - b.startTime.getTime();
    });
  }

  /**
   * Check if a date is a weekday
   */
  private static isWeekday(date: Date): boolean {
    const day = date.getDay();
    return day >= 1 && day <= 5; // Monday to Friday
  }

  /**
   * Get preference score for a given hour (0-23)
   */
  private static getTimeScore(hour: number): number {
    if (hour >= 10 && hour <= 16) {
      return 10; // Prime business hours (10 AM - 4 PM)
    } else if (hour >= 9 && hour <= 17) {
      return 8; // Good business hours (9 AM - 5 PM)
    } else if (hour >= 8 && hour <= 18) {
      return 6; // Extended business hours (8 AM - 6 PM)
    } else if (hour >= 19 && hour <= 21) {
      return 4; // Evening hours (7 PM - 9 PM)
    } else {
      return 1; // Early morning or late evening
    }
  }

  /**
   * Get preference score for day of week
   */
  private static getDayScore(day: number): number {
    switch (day) {
      case 2: // Tuesday
      case 3: // Wednesday
      case 4: // Thursday
        return 10; // Best days
      case 1: // Monday
      case 5: // Friday
        return 8; // Good days
      case 6: // Saturday
        return 3; // Weekend but acceptable
      case 0: // Sunday
        return 1; // Least preferred
      default:
        return 1;
    }
  }

  /**
   * Get the start of the week for a given date
   */
  private static getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day; // Sunday as start of week
    return new Date(d.setDate(diff));
  }

  /**
   * Generate period-specific error message for better user guidance
   */
  private static getPeriodErrorMessage(options: AllocationOptions): string {
    // This will be enhanced when we add startDate/endDate to AllocationOptions
    // For now, return a generic helpful message
    if (options.eventType === "subscription") {
      return "during the subscription period";
    } else if (options.eventType === "class") {
      return "during the class period";
    }
    return "";
  }

  /**
   * Validate slot distribution for subscriptions/classes
   */
  private static validateSlotDistribution(
    slots: TimeSlot[],
    callsPerWeek: number,
  ): { isValid: boolean; errorMessage?: string } {
    const slotsByWeek = new Map<string, TimeSlot[]>();

    slots.forEach((slot) => {
      const weekStart = this.getWeekStart(slot.startTime);
      const weekKey = weekStart.toISOString();

      if (!slotsByWeek.has(weekKey)) {
        slotsByWeek.set(weekKey, []);
      }
      slotsByWeek.get(weekKey)!.push(slot);
    });

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
}
