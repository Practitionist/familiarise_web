import { TimeSlot, calculateRequiredSlots } from "./calendarUtils";
import { AllocationService } from "./allocationService";

export interface AllocationOptions {
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId: string;
  durationInMonths?: number;
  callsPerWeek?: number;
  sessionDurationInHours?: number;
  requestedSlots?: TimeSlot[];
}

export interface AllocationResult {
  success: boolean;
  selectedSlots: TimeSlot[];
  error?: string;
}

/**
 * Allocation algorithms for different scenarios
 */
export class AllocationAlgorithms {
  /**
   * Manual allocation - uses the slots selected by the user
   */
  static async manualAllocate(
    selectedSlots: TimeSlot[],
    options: AllocationOptions
  ): Promise<AllocationResult> {
    try {
      // Validate the selected slots count
      const requiredSlots = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.callsPerWeek,
        options.sessionDurationInHours
      );

      if (selectedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Expected ${requiredSlots} slots but received ${selectedSlots.length}`,
        };
      }

      // Validate slots are not in the past
      const now = new Date();
      const pastSlots = selectedSlots.filter((slot) => slot.startTime < now);
      if (pastSlots.length > 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "Cannot allocate slots in the past",
        };
      }

      // For subscriptions/classes, validate distribution
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
          options.callsPerWeek
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
        selectedSlots
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
   * Auto allocation - automatically finds the best available slots
   */
  static async autoAllocate(
    availableSlots: TimeSlot[],
    options: AllocationOptions
  ): Promise<AllocationResult> {
    try {
      const requiredSlots = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.callsPerWeek,
        options.sessionDurationInHours
      );

      let selectedSlots: TimeSlot[] = [];

      if (
        options.eventType === "consultation" ||
        options.eventType === "webinar"
      ) {
        // For single-slot events, find the earliest available slot
        selectedSlots = this.findEarliestAvailableSlots(availableSlots, 1);
      } else {
        // For multi-slot events (subscription/class), use smart distribution
        selectedSlots = this.findOptimalSlotDistribution(
          availableSlots,
          requiredSlots,
          options.callsPerWeek!,
          options.durationInMonths!
        );
      }

      if (selectedSlots.length < requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Could not find ${requiredSlots} available slots. Only ${selectedSlots.length} slots available.`,
        };
      }

      // Call the allocation service with auto flag
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        selectedSlots,
        { isAuto: true }
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
    options: AllocationOptions
  ): Promise<AllocationResult> {
    try {
      if (!options.requestedSlots || options.requestedSlots.length === 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "No requested slots provided",
        };
      }

      const requiredSlots = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.callsPerWeek,
        options.sessionDurationInHours
      );

      if (options.requestedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Expected ${requiredSlots} requested slots but received ${options.requestedSlots.length}`,
        };
      }

      // Validate requested slots for consultation/subscription
      if (
        options.eventType === "consultation" ||
        options.eventType === "subscription"
      ) {
        const validationResult = await AllocationService.validateSlots(
          options.eventType,
          options.eventId,
          options.requestedSlots
        );

        if (!validationResult.success) {
          return {
            success: false,
            selectedSlots: [],
            error: validationResult.error,
          };
        }

        // Check for conflicts
        if (
          validationResult.data?.conflicts &&
          validationResult.data.conflicts.length > 0
        ) {
          return {
            success: false,
            selectedSlots: [],
            error:
              "Some requested slots have conflicts with existing appointments",
          };
        }
      }

      // Call the allocation service with useRequestedSlots flag
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        options.requestedSlots,
        { useRequestedSlots: true }
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
   * Find the earliest available slots
   */
  private static findEarliestAvailableSlots(
    availableSlots: TimeSlot[],
    count: number
  ): TimeSlot[] {
    const now = new Date();

    // Filter out past slots and sort by time
    const futureSlots = availableSlots
      .filter(
        (slot) => slot.startTime > now && slot.isAvailable && !slot.isBooked
      )
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    return futureSlots.slice(0, count);
  }

  /**
   * Find optimal slot distribution for subscriptions/classes
   */
  private static findOptimalSlotDistribution(
    availableSlots: TimeSlot[],
    totalSlots: number,
    callsPerWeek: number,
    durationInMonths: number
  ): TimeSlot[] {
    const now = new Date();
    const futureSlots = availableSlots
      .filter(
        (slot) => slot.startTime > now && slot.isAvailable && !slot.isBooked
      )
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    const selectedSlots: TimeSlot[] = [];
    const totalWeeks = durationInMonths * 4;

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

    // Allocate slots week by week
    let currentWeek = 0;
    for (const weekKey of sortedWeeks) {
      if (selectedSlots.length >= totalSlots || currentWeek >= totalWeeks) {
        break;
      }

      const weekSlots = slotsByWeek.get(weekKey)!;
      const slotsNeededThisWeek = Math.min(
        callsPerWeek,
        totalSlots - selectedSlots.length
      );

      // Sort slots by preference (earlier in the day, specific days)
      const preferredSlots = this.sortSlotsByPreference(weekSlots);

      // Take the best slots for this week
      const selectedThisWeek = preferredSlots.slice(0, slotsNeededThisWeek);
      selectedSlots.push(...selectedThisWeek);

      currentWeek++;
    }

    return selectedSlots;
  }

  /**
   * Sort slots by preference (earlier times, preferred days)
   */
  private static sortSlotsByPreference(slots: TimeSlot[]): TimeSlot[] {
    return slots.sort((a, b) => {
      // Prefer weekdays over weekends
      const aIsWeekday = this.isWeekday(a.startTime);
      const bIsWeekday = this.isWeekday(b.startTime);

      if (aIsWeekday !== bIsWeekday) {
        return aIsWeekday ? -1 : 1;
      }

      // Prefer earlier times (9 AM - 5 PM are most preferred)
      const aHour = a.startTime.getHours();
      const bHour = b.startTime.getHours();

      const aScore = this.getTimeScore(aHour);
      const bScore = this.getTimeScore(bHour);

      if (aScore !== bScore) {
        return bScore - aScore; // Higher score is better
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
    if (hour >= 9 && hour <= 17) {
      return 10; // Best time (9 AM - 5 PM)
    } else if (hour >= 8 && hour <= 19) {
      return 5; // Good time (8 AM - 7 PM)
    } else {
      return 1; // Acceptable time
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
   * Validate slot distribution for subscriptions/classes
   */
  private static validateSlotDistribution(
    slots: TimeSlot[],
    callsPerWeek: number
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
