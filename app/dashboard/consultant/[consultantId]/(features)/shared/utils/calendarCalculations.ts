/**
 * Calendar calculation utilities extracted from UnifiedCalendar
 * These functions handle call counting, progress calculation, etc.
 */

import { TimeSlot, AppointmentSlot } from "./calendarUtils";

/**
 * Helper function to check if a UTC date is outside the [allowedStart, allowedEnd] bounds.
 */
export function isOutsideAllowedRange(
  dateUtc: Date,
  allowedStart?: Date,
  allowedEnd?: Date,
): boolean {
  if (allowedStart && dateUtc < allowedStart) return true;
  if (allowedEnd && dateUtc > allowedEnd) return true;
  return false;
}

/**
 * Formats the allowed [start, end] range for user-facing messages.
 */
export function formatAllowedRange(allowedStart?: Date, allowedEnd?: Date): string {
  const startText = allowedStart ? allowedStart.toLocaleString() : "-";
  const endText = allowedEnd ? allowedEnd.toLocaleString() : "-";
  return `${startText} to ${endText}`;
}

/**
 * Count completed calls for a specific week by checking if slots are in the past
 */
export function countCompletedCallsForWeek(
  completedSlots: AppointmentSlot[],
  slotsPerCall: number,
  weekStart: Date,
  weekEnd: Date,
): number {
  const now = new Date();
  const slotsInWeek = completedSlots.filter((slot) => {
    const start = new Date(slot.slotStartTimeInUTC);
    return start >= weekStart && start <= weekEnd && start < now;
  });

  return Math.floor(slotsInWeek.length / slotsPerCall);
}

/**
 * Count completed + selected calls for a specific week
 * This function helps validate that users haven't exceeded weekly call limits
 */
export function countCompletedSelectedCallsForWeek(
  selectedSlots: TimeSlot[],
  slotsPerCall: number,
  weekStart: Date,
  weekEnd: Date,
): number {
  // Group slots by day (calls must be on same day)
  const byDay = new Map<string, TimeSlot[]>();
  selectedSlots.forEach((slot) => {
    const start = slot.startTime;
    const key = start.toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(slot);
  });

  let completedCalls = 0;
  for (const [dayKey, daySlots] of byDay) {
    const dayDate = new Date(dayKey);
    if (dayDate >= weekStart && dayDate <= weekEnd) {
      // Count complete calls (groups of consecutive slots)
      const sortedSlots = daySlots.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      let consecutiveCount = 0;
      let currentRun: TimeSlot[] = [];
      
      for (const slot of sortedSlots) {
        if (currentRun.length === 0) {
          currentRun.push(slot);
        } else {
          const lastSlot = currentRun[currentRun.length - 1];
          if (slot.startTime.getTime() === lastSlot.endTime.getTime()) {
            currentRun.push(slot);
          } else {
            // End of run - check if complete
            if (currentRun.length >= slotsPerCall) {
              consecutiveCount += Math.floor(currentRun.length / slotsPerCall);
            }
            currentRun = [slot];
          }
        }
      }
      
      // Check final run
      if (currentRun.length >= slotsPerCall) {
        consecutiveCount += Math.floor(currentRun.length / slotsPerCall);
      }
      
      completedCalls += consecutiveCount;
    }
  }

  return completedCalls;
}

/**
 * Count completed classes for a class event
 */
export function countCompletedClassesForClass(
  completedSlots: AppointmentSlot[],
  slotsPerSession: number,
): number {
  if (completedSlots.length === 0) return 0;

  const now = new Date();
  const pastSlots = completedSlots.filter((slot) => {
    const end = new Date(slot.slotEndTimeInUTC || slot.slotStartTimeInUTC);
    return end < now;
  });

  return Math.floor(pastSlots.length / slotsPerSession);
}

/**
 * Service class for calendar calculations
 */
export class CalendarCalculationService {
  /**
   * Validate if a date is within allowed range
   */
  static isWithinAllowedRange(
    date: Date,
    allowedStart?: Date,
    allowedEnd?: Date,
  ): boolean {
    return !isOutsideAllowedRange(date, allowedStart, allowedEnd);
  }

  /**
   * Format range for display
   */
  static formatAllowedRange(allowedStart?: Date, allowedEnd?: Date): string {
    return formatAllowedRange(allowedStart, allowedEnd);
  }

  /**
   * Calculate call progress for subscriptions
   */
  static calculateCallProgress(
    completedSlots: AppointmentSlot[],
    selectedSlots: TimeSlot[],
    slotsPerCall: number,
    weekStart: Date,
    weekEnd: Date,
  ): {
    completedCalls: number;
    selectedCalls: number;
    totalCalls: number;
  } {
    const completedCalls = countCompletedCallsForWeek(
      completedSlots,
      slotsPerCall,
      weekStart,
      weekEnd,
    );
    
    const selectedCalls = countCompletedSelectedCallsForWeek(
      selectedSlots,
      slotsPerCall,
      weekStart,
      weekEnd,
    );

    return {
      completedCalls,
      selectedCalls,
      totalCalls: completedCalls + selectedCalls,
    };
  }

  /**
   * Calculate class progress
   */
  static calculateClassProgress(
    completedSlots: AppointmentSlot[],
    selectedSlots: TimeSlot[],
    slotsPerSession: number,
  ): {
    completedSessions: number;
    selectedSessions: number;
    totalSessions: number;
  } {
    const completedSessions = countCompletedClassesForClass(
      completedSlots,
      slotsPerSession,
    );

    // For classes, selected sessions are just the count of selected slots divided by slots per session
    const selectedSessions = Math.floor(selectedSlots.length / slotsPerSession);

    return {
      completedSessions,
      selectedSessions,
      totalSessions: completedSessions + selectedSessions,
    };
  }
}