/**
 * Slot Calculation Service
 *
 * Single source of truth for all slot-related calculations.
 * Handles week counting, slot requirements, progress tracking, and grouping logic.
 */

import { startOfWeek } from "date-fns";
import { EventType, EventConfig, TimeSlot, ProgressInfo } from "./types";

/**
 * Service for calculating slots, weeks, and progress
 */
export class SlotCalculationService {
  /**
   * Count the number of distinct Sunday-start weeks overlapping [start, end].
   * This is the SINGLE implementation used across the entire app.
   *
   * The first week is the Sunday of the week containing startDate.
   * The last week is the Sunday of the week containing endDate.
   *
   * Example: Jan 1 (Monday) to Feb 1 (Thursday):
   * - Week 1: Sunday Dec 29
   * - Week 2: Sunday Jan 5
   * - Week 3: Sunday Jan 12
   * - Week 4: Sunday Jan 19
   * - Week 5: Sunday Jan 26
   * = 5 weeks total
   */
  static countWeeks(startDate: Date, endDate: Date): number {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (end < start) return 0;

    // Normalize to midnight for consistency
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    // Find the Sunday of the week containing start and end
    const startSunday = this.startOfWeekSunday(start);
    const endSunday = this.startOfWeekSunday(end);

    // Count number of Sundays from startSunday to endSunday inclusive
    let weeks = 1;
    let cursor = new Date(startSunday);
    while (cursor < endSunday) {
      cursor.setDate(cursor.getDate() + 7);
      weeks += 1;
    }
    return weeks;
  }

  /**
   * Get the Sunday at 00:00:00 of the week that contains the given date.
   */
  static startOfWeekSunday(d: Date): Date {
    const date = new Date(d);
    const day = date.getDay(); // 0 = Sunday
    const diff = day; // days since Sunday
    const sunday = new Date(date);
    sunday.setDate(date.getDate() - diff);
    sunday.setHours(0, 0, 0, 0);
    return sunday;
  }

  /**
   * Validate duration parameter for all event types
   *
   * CRITICAL SAFETY CHECK:
   * Duration is used in division and slot calculations throughout the app.
   * Invalid values (0, negative, Infinity, undefined) can cause:
   * - Division by zero errors
   * - Infinite loops in slot allocation
   * - Negative slot counts
   * - Database corruption
   *
   * This centralized validation ensures all services use consistent rules.
   *
   * @param duration - The duration value to validate
   * @param fieldName - Descriptive name for error messages (e.g., "sessionDurationInHours")
   * @throws {Error} If duration is invalid
   */
  static validateDuration(duration: number | undefined, fieldName: string): void {
    if (duration === undefined || duration === null) {
      throw new Error(`${fieldName} is required but was not provided`);
    }

    if (typeof duration !== 'number') {
      throw new Error(
        `${fieldName} must be a number, but received type: ${typeof duration}`,
      );
    }

    if (duration <= 0) {
      throw new Error(
        `${fieldName} must be positive, but received: ${duration}`,
      );
    }

    if (!Number.isFinite(duration)) {
      throw new Error(
        `${fieldName} must be a finite number, but received: ${duration}`,
      );
    }

    // Additional sanity check: duration should be reasonable (0.5 to 24 hours)
    if (duration > 24) {
      console.warn(
        `⚠️ ${fieldName} is unusually large (${duration} hours). Maximum expected is 24 hours.`,
      );
    }

    if (duration < 0.5) {
      throw new Error(
        `${fieldName} must be at least 0.5 hours (30 minutes), but received: ${duration}`,
      );
    }
  }

  /**
   * Calculate the total number of 30-minute slots required for an event.
   *
   * IMPORTANT: This function returns SLOT COUNT, not call/session count.
   *
   * For different event types:
   * - CONSULTATIONS: Returns slots needed for the session duration (e.g., 2 slots for 1 hour)
   * - WEBINARS: Returns slots needed for the session duration (e.g., 2 slots for 1 hour)
   * - CLASSES: Returns total slots for all sessions (weeks × calls/week × slots/session)
   * - SUBSCRIPTIONS: Computes weeks → calls → slots (based on 30-min increments)
   */
  static calculateRequiredSlots(
    eventType: EventType,
    config: EventConfig,
  ): number {
    if (!eventType) {
      throw new Error("Event type is required");
    }

    switch (eventType) {
      case "consultation": {
        const duration =
          config.durationInHours || config.sessionDurationInHours;
        if (!duration || duration <= 0) {
          console.warn(
            "⚠️ Consultation duration missing or invalid. Using default: 1 hour",
          );
          return Math.ceil(1 / 0.5); // Default 1 hour = 2 slots
        }
        return Math.ceil(duration / 0.5); // 30-minute intervals
      }

      case "webinar": {
        const duration =
          config.durationInHours || config.sessionDurationInHours;
        if (!duration || duration <= 0) {
          return Math.ceil(1 / 0.5); // Default 1 hour = 2 slots
        }
        return Math.ceil(duration / 0.5); // 30-minute intervals
      }

      case "subscription": {
        // Use exact Sunday-boundary week counting when dates are provided
        if (config.startDate && config.endDate) {
          let sessionDuration = config.sessionDurationInHours;
          if (!sessionDuration || sessionDuration <= 0) {
            console.warn(
              "⚠️ Subscription session duration missing or invalid. Using default: 1 hour",
            );
            sessionDuration = 1; // Default 1 hour
          }
          const totalWeeks = this.countWeeks(config.startDate, config.endDate);
          const totalCalls = totalWeeks * (config.callsPerWeek || 1);
          const slotsPerCall = Math.ceil((sessionDuration || 1) / 0.5);
          return totalCalls * slotsPerCall;
        }

        // Fallback to average weeks per month when dates are not provided
        const weeksPerMonth = 4.33;
        const totalWeeks = Math.ceil(
          (config.durationInMonths || 0) * weeksPerMonth,
        );
        const totalCalls = totalWeeks * (config.callsPerWeek || 1);
        const slotsPerCall = Math.ceil(
          (config.sessionDurationInHours || 1) / 0.5,
        );
        return totalCalls * slotsPerCall;
      }

      case "class": {
        if (!config.callsPerWeek || config.callsPerWeek <= 0) {
          throw new Error(
            "Calls per week must be a positive number for classes",
          );
        }
        const sessionDuration = config.sessionDurationInHours;
        if (!sessionDuration || sessionDuration <= 0) {
          throw new Error(
            "Session duration must be a positive number for classes",
          );
        }

        const slotsPerSession = Math.ceil(sessionDuration / 0.5);

        // Use exact Sunday-boundary week counting when dates are provided
        if (config.startDate && config.endDate) {
          const totalWeeks = this.countWeeks(config.startDate, config.endDate);
          const totalSessions = totalWeeks * (config.callsPerWeek || 1);
          return totalSessions * slotsPerSession;
        }

        // Fallback to average weeks per month when dates are not provided
        const weeksPerMonth = 4.33;
        const totalWeeks = Math.ceil(
          (config.durationInMonths || 0) * weeksPerMonth,
        );
        const totalSessions = totalWeeks * (config.callsPerWeek || 1);
        return totalSessions * slotsPerSession;
      }

      default:
        throw new Error(`Invalid event type: ${eventType}`);
    }
  }

  /**
   * Calculate how many slots are needed per call/session (30-min increments)
   */
  static getSlotsPerCall(sessionDurationInHours: number): number {
    return Math.ceil(sessionDurationInHours / 0.5);
  }

  /**
   * Calculate progress for UI display
   * Returns user-friendly progress information
   */
  static calculateProgress(
    selectedSlots: TimeSlot[],
    eventType: EventType,
    config: EventConfig,
  ): ProgressInfo {
    const sessionDuration =
      config.sessionDurationInHours || config.durationInHours || 1;
    const slotsPerCall = this.getSlotsPerCall(sessionDuration);

    let scheduled = 0;
    let required = 0;

    switch (eventType) {
      case "consultation":
      case "webinar":
        // Single event - just check if enough consecutive slots selected
        scheduled = selectedSlots.length >= slotsPerCall ? 1 : 0;
        required = 1;
        break;

      case "subscription":
      case "class": {
        // Count complete calls/sessions (full consecutive slot groups)
        scheduled = this.countCompletedCalls(selectedSlots, slotsPerCall);

        // Calculate total required calls/sessions
        if (config.startDate && config.endDate && config.callsPerWeek) {
          const weeks = this.countWeeks(config.startDate, config.endDate);
          required = weeks * config.callsPerWeek;
        } else if (config.durationInMonths && config.callsPerWeek) {
          const weeks = Math.ceil(config.durationInMonths * 4.33);
          required = weeks * config.callsPerWeek;
        }
        break;
      }
    }

    const remaining = Math.max(0, required - scheduled);
    const displayText = this.formatProgressText(
      eventType,
      scheduled,
      required,
      remaining,
      sessionDuration,
      config.callsPerWeek,
    );

    return {
      scheduled,
      required,
      remaining,
      sessionDuration,
      displayText,
    };
  }

  /**
   * Count completed calls/sessions from selected slots
   * A completed call is a set of consecutive slots on the same day
   */
  private static countCompletedCalls(
    selectedSlots: TimeSlot[],
    slotsPerCall: number,
  ): number {
    if (!selectedSlots?.length) return 0;

    // Group slots by day
    const slotsByDay = this.groupSlotsByDay(selectedSlots);

    let completed = 0;
    slotsByDay.forEach((daySlots) => {
      const sorted = [...daySlots].sort(
        (a, b) => a.startTime.getTime() - b.startTime.getTime(),
      );

      // Check if this day has enough consecutive slots for a complete call
      if (sorted.length >= slotsPerCall) {
        let consecutiveCount = 1;
        for (let i = 1; i < sorted.length; i++) {
          if (
            sorted[i].startTime.getTime() === sorted[i - 1].endTime.getTime()
          ) {
            consecutiveCount++;
            if (consecutiveCount === slotsPerCall) {
              completed++;
              consecutiveCount = 0; // Reset for next potential call
            }
          } else {
            consecutiveCount = 1; // Reset on gap
          }
        }
      }
    });

    return completed;
  }

  /**
   * Group time slots by day
   */
  static groupSlotsByDay(slots: TimeSlot[]): Map<string, TimeSlot[]> {
    const slotsByDay = new Map<string, TimeSlot[]>();

    for (const slot of slots) {
      const dayKey = slot.startTime.toDateString();
      if (!slotsByDay.has(dayKey)) {
        slotsByDay.set(dayKey, []);
      }
      slotsByDay.get(dayKey)!.push(slot);
    }

    return slotsByDay;
  }

  /**
   * Group time slots by week (Sunday-Saturday)
   */
  static groupSlotsByWeek(slots: TimeSlot[]): Map<string, TimeSlot[]> {
    const slotsByWeek = new Map<string, TimeSlot[]>();

    for (const slot of slots) {
      const weekStart = startOfWeek(slot.startTime);
      const weekKey = weekStart.toISOString();

      if (!slotsByWeek.has(weekKey)) {
        slotsByWeek.set(weekKey, []);
      }
      slotsByWeek.get(weekKey)!.push(slot);
    }

    return slotsByWeek;
  }

  /**
   * Format progress text for UI display
   * Clear, user-friendly text without technical jargon
   */
  private static formatProgressText(
    eventType: EventType,
    scheduled: number,
    required: number,
    remaining: number,
    sessionDuration: number,
    callsPerWeek?: number,
  ): string {
    const durationText =
      sessionDuration === 1 ? "1 hour" : `${sessionDuration} hours`;
    const sessionWord = eventType === "class" ? "session" : "call";
    const sessionWordPlural = eventType === "class" ? "sessions" : "calls";

    if (eventType === "consultation" || eventType === "webinar") {
      if (scheduled === 0) {
        return `Select ${required} ${sessionWord} (${durationText})`;
      }
      return `✅ ${sessionWord.charAt(0).toUpperCase() + sessionWord.slice(1)} scheduled`;
    }

    // For subscriptions and classes
    if (scheduled === 0) {
      const limitText = callsPerWeek
        ? ` | Limit: ${callsPerWeek}/${eventType === "class" ? "week" : "week"}`
        : "";
      return `📅 Schedule ${required} ${sessionWordPlural} (${durationText} each)${limitText}`;
    } else if (remaining > 0) {
      const limitText = callsPerWeek ? ` | ${callsPerWeek}/week` : "";
      return `✅ ${scheduled} scheduled | ⏳ ${remaining} remaining (${durationText} each)${limitText}`;
    } else {
      return `✅ All ${required} ${sessionWordPlural} scheduled`;
    }
  }
}
