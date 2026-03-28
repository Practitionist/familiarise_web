import {
  TimeSlot,
  calculateRequiredSlots,
  countSundayWeeksInclusive,
  validateSlotDistribution,
} from "./calendarUtils";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import { isRecurringEventType } from "@/utils/slotAllocation/types";
import { AllocationService } from "./allocationService";

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
  durationInMonths?: number;
  callsPerWeek?: number;
  sessionDurationInHours?: number;
  durationInHours?: number; // FIXED: Add durationInHours for consultations and webinars
  startDate?: Date; // Required for subscriptions and classes
  endDate?: Date; // Required for subscriptions and classes
  totalSessions?: number; // Authoritative session count from plan (overrides weeks × callsPerWeek)
  requestedSlots?: TimeSlot[];
  pastConfirmedSlotCount?: number; // For in-progress recurring events
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
      // VALIDATION: Check required slots count
      // Pass durationInHours for consultations/webinars, sessionDurationInHours for subscriptions/classes
      const rawRequired = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.callsPerWeek,
        options.durationInHours || options.sessionDurationInHours,
        options.startDate,
        options.endDate,
        options.totalSessions,
      );

      // For in-progress recurring events, subtract past confirmed slots
      const pastCount = options.pastConfirmedSlotCount || 0;
      const requiredSlots =
        isRecurringEventType(options.eventType) && pastCount > 0
          ? Math.max(0, rawRequired - pastCount)
          : rawRequired;

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

        // Calculate slotsPerWeek based on actual session duration
        // slotsPerSession = sessionDurationInHours / 0.5 (since each slot is 30 min)
        // slotsPerWeek = callsPerWeek * slotsPerSession
        const slotsPerSession = Math.ceil(
          (options.sessionDurationInHours || 1) / 0.5,
        );
        const slotsPerWeek = options.callsPerWeek * slotsPerSession;

        const distributionValidation = validateSlotDistribution(
          selectedSlots,
          slotsPerWeek,
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
      console.warn("Manual allocation error:", error);
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
      // Calculate required slots based on event type
      // Pass durationInHours for consultations/webinars, sessionDurationInHours for subscriptions/classes
      const rawRequired = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.callsPerWeek,
        options.durationInHours || options.sessionDurationInHours,
        options.startDate,
        options.endDate,
        options.totalSessions,
      );

      // For in-progress recurring events, subtract past confirmed slots
      const pastCount = options.pastConfirmedSlotCount || 0;
      const requiredSlots =
        isRecurringEventType(options.eventType) && pastCount > 0
          ? Math.max(0, rawRequired - pastCount)
          : rawRequired;

      let selectedSlots: TimeSlot[] = [];
      let strategy = "";

      // STEP 1: Filter available slots based on user preferences
      const filteredSlots = this.filterSlotsByPreferences(
        availableSlots,
        preferences,
      );

      if (filteredSlots.length < requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Not enough slots available after applying preferences. Need ${requiredSlots}, found ${filteredSlots.length}`,
        };
      }

      // STEP 2: Apply event-specific allocation strategy
      switch (options.eventType) {
        case "consultation":
          // STRATEGY: Earliest available slot with best preference scoring
          selectedSlots = this.allocateConsultationSlots(
            filteredSlots,
            options.durationInHours || 1, // FIXED: Use durationInHours for consultations
          );
          strategy = "earliest-available";
          break;

        case "webinar":
          // STRATEGY: Consecutive slots for multi-hour events
          selectedSlots = this.allocateWebinarSlots(
            filteredSlots,
            options.durationInHours || 1, // FIXED: Use durationInHours for webinars
          );
          strategy = "consecutive-slots";
          break;

        case "subscription":
        case "class":
          // STRATEGY: Optimal distribution across weeks with spacing
          selectedSlots = this.allocateRecurringSlots(
            filteredSlots,
            requiredSlots,
            options.callsPerWeek || 1,
            preferences,
            options,
          );
          strategy = "optimal-distribution";
          break;

        default:
          return {
            success: false,
            selectedSlots: [],
            error: `Unsupported event type: ${options.eventType}`,
          };
      }

      if (selectedSlots.length === 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "Could not find suitable slots with current preferences",
        };
      }

      if (selectedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Could only allocate ${selectedSlots.length} of ${requiredSlots} required slots`,
        };
      }

      // STEP 3: Call allocation service
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
      console.warn("Auto allocation error:", error);
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

      // Calculate required slots for validation
      // Pass durationInHours for consultations/webinars, sessionDurationInHours for subscriptions/classes
      const requiredSlots = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.callsPerWeek,
        options.durationInHours || options.sessionDurationInHours,
        options.startDate,
        options.endDate,
        options.totalSessions,
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
      console.warn("Pre-allocation error:", error);
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
   * Allocate consecutive slots for consultations.
   * Returns an array of 30-minute TimeSlot objects or empty array if no valid block found.
   */
  private static allocateConsultationSlots(
    availableSlots: TimeSlot[],
    durationHours: number,
  ): TimeSlot[] {
    const requiredSlots = Math.ceil(durationHours / 0.5); // 30-minute intervals

    if (requiredSlots === 1) {
      const sortedSlots = this.sortSlotsByPreference(availableSlots);
      return sortedSlots.slice(0, 1);
    }

    const sortedSlots = availableSlots.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    // FIX: Use Math.ceil(durationHours) to determine how many 1-hour availability
    // blocks are needed, then generate exactly `requiredSlots` 30-min slots from
    // the contiguous range. Previously each block was always split into exactly 2
    // slots, which broke for non-1-hour sessions (e.g. 1.5hr → needed 3, got 4).
    const oneHourBlocksNeeded = Math.ceil(durationHours);
    for (let i = 0; i <= sortedSlots.length - oneHourBlocksNeeded; i++) {
      const consecutive1HourSlots: TimeSlot[] = [];
      let isConsecutive = true;

      for (let j = 0; j < oneHourBlocksNeeded; j++) {
        const currentSlot = sortedSlots[i + j];
        if (!currentSlot) {
          isConsecutive = false;
          break;
        }

        if (j > 0) {
          const prevSlot = consecutive1HourSlots[j - 1];
          if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            isConsecutive = false;
            break;
          }
        }

        consecutive1HourSlots.push(currentSlot);
      }

      if (
        !isConsecutive ||
        consecutive1HourSlots.length < oneHourBlocksNeeded
      ) {
        continue;
      }

      // Generate exactly `requiredSlots` 30-minute slots from the contiguous block
      const blockStart = consecutive1HourSlots[0].startTime;
      const thirtyMinSlots: TimeSlot[] = [];
      for (let k = 0; k < requiredSlots; k++) {
        const slotStart = new Date(blockStart.getTime() + k * 30 * 60000);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60000);
        thirtyMinSlots.push({
          ...consecutive1HourSlots[0],
          startTime: slotStart,
          endTime: slotEnd,
        });
      }

      return thirtyMinSlots;
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
      return this.allocateConsultationSlots(availableSlots, durationHours);
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
   * Allocate slots for recurring events (subscriptions/classes).
   * Distributes calls across weeks, respecting callsPerWeek limits.
   * Returns an array of 30-minute TimeSlot objects.
   */
  private static allocateRecurringSlots(
    availableSlots: TimeSlot[],
    totalSlots: number,
    callsPerWeek: number,
    preferences: AutoAllocationPreferences,
    options: AllocationOptions,
  ): TimeSlot[] {
    if (!options.startDate || !options.endDate) {
      return [];
    }

    const sessionDurationInHours = options.sessionDurationInHours || 1;
    const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);
    // FIX: Track 30-min slot count correctly. Previously, slotsNeededThisWeek
    // counted calls but was compared against totalSlots (30-min slot count),
    // and the final split always produced exactly 2 slots per selected block
    // regardless of session duration. Now we track calls and convert properly.
    const totalCallsNeeded = Math.floor(totalSlots / slotsPerCall);
    const hoursPerCall = Math.ceil(sessionDurationInHours);

    const sortedAvailableSlots = availableSlots.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    const futureSlots = sortedAvailableSlots.filter((slot) => {
      const startsAfterOrOnBegin =
        slot.startTime.getTime() >= options.startDate!.getTime();
      const endsBeforeOrOnEnd =
        slot.endTime.getTime() <= options.endDate!.getTime();
      return startsAfterOrOnBegin && endsBeforeOrOnEnd;
    });

    // Group slots by week
    const slotsByWeek = new Map<string, TimeSlot[]>();
    futureSlots.forEach((slot) => {
      const weekStart = SlotCalculationService.startOfWeekSunday(
        slot.startTime,
      );
      const weekKey = weekStart.toISOString();

      if (!slotsByWeek.has(weekKey)) {
        slotsByWeek.set(weekKey, []);
      }
      slotsByWeek.get(weekKey)!.push(slot);
    });

    const sortedWeeks = Array.from(slotsByWeek.keys()).sort();
    const totalWeeks = countSundayWeeksInclusive(
      options.startDate,
      options.endDate,
    );

    // Allocate calls week by week
    const selectedCalls: TimeSlot[][] = [];
    let currentWeek = 0;

    for (const weekKey of sortedWeeks) {
      if (
        selectedCalls.length >= totalCallsNeeded ||
        currentWeek >= totalWeeks
      ) {
        break;
      }

      const weekSlots = slotsByWeek.get(weekKey)!;
      const callsNeededThisWeek = Math.min(
        callsPerWeek,
        totalCallsNeeded - selectedCalls.length,
      );

      // Sort slots by preference
      const preferredSlots = this.sortSlotsByPreference(weekSlots);

      // For each call needed this week, find a consecutive block of availability
      const callsThisWeek = this.selectCallsFromWeek(
        preferredSlots,
        callsNeededThisWeek,
        hoursPerCall,
        slotsPerCall,
        preferences.minTimeBetweenSessions || 2,
      );

      selectedCalls.push(...callsThisWeek);
      currentWeek++;
    }

    // Flatten all calls into a single array of 30-min slots
    return selectedCalls.flat();
  }

  /**
   * Select multiple calls from a week's available slots, each requiring
   * consecutive 1-hour blocks to cover the session duration.
   * Returns an array of call groups, each being an array of 30-min slots.
   */
  private static selectCallsFromWeek(
    weekSlots: TimeSlot[],
    callsNeeded: number,
    hoursPerCall: number,
    slotsPerCall: number,
    minHoursBetween: number,
  ): TimeSlot[][] {
    const calls: TimeSlot[][] = [];
    const usedSlotIndices = new Set<number>();
    const minMsBetween = minHoursBetween * 60 * 60 * 1000;

    const sortedSlots = [...weekSlots].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    for (let i = 0; i <= sortedSlots.length - slotsPerCall; i++) {
      if (calls.length >= callsNeeded) break;
      if (usedSlotIndices.has(i)) continue;

      // Try to find `slotsPerCall` consecutive 30-min slots starting at i
      const blockIndices: number[] = [];
      let isConsecutive = true;

      for (let j = 0; j < slotsPerCall; j++) {
        const idx = i + j;
        if (idx >= sortedSlots.length || usedSlotIndices.has(idx)) {
          isConsecutive = false;
          break;
        }
        if (j > 0) {
          const prevSlot = sortedSlots[i + j - 1];
          const curSlot = sortedSlots[idx];
          if (curSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            isConsecutive = false;
            break;
          }
        }
        blockIndices.push(idx);
      }

      if (!isConsecutive || blockIndices.length < slotsPerCall) continue;

      // Check spacing against already selected calls
      const blockStart = sortedSlots[blockIndices[0]].startTime;
      const hasConflict = calls.some((existingCall) => {
        const existingStart = existingCall[0].startTime;
        return (
          Math.abs(blockStart.getTime() - existingStart.getTime()) <
          minMsBetween
        );
      });
      if (hasConflict) continue;

      // Generate exactly `slotsPerCall` 30-min slots from this block
      const thirtyMinSlots: TimeSlot[] = [];
      for (let k = 0; k < slotsPerCall; k++) {
        const slotStart = new Date(blockStart.getTime() + k * 30 * 60000);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60000);
        thirtyMinSlots.push({
          ...sortedSlots[blockIndices[0]],
          startTime: slotStart,
          endTime: slotEnd,
        });
      }

      calls.push(thirtyMinSlots);
      blockIndices.forEach((idx) => usedSlotIndices.add(idx));
    }

    return calls;
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
}
