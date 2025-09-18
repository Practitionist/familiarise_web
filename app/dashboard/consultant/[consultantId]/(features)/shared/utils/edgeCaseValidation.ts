/**
 * Comprehensive edge case validation for calendar allocation system
 * This handles all the critical scenarios that could cause financial loss or system errors
 */

import { TimeSlot, Appointment } from "./calendarUtils";
import { SlotCalculationService } from "./slotCalculationService";

export interface ValidationError {
  type: "CRITICAL" | "WARNING" | "INFO";
  code: string;
  message: string;
  details?: Record<string, any>;
}

export interface EdgeCaseValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  suggestions: string[];
}

/**
 * Edge case validation service for production-grade slot allocation
 */
export class EdgeCaseValidator {
  /**
   * Comprehensive validation for appointment slot allocation
   */
  static validateAppointmentAllocation(
    selectedSlots: TimeSlot[],
    eventType: "consultation" | "subscription" | "webinar" | "class",
    options: {
      totalDurationInHours?: number;
      sessionDurationInHours?: number;
      callsPerWeek?: number;
      durationInMonths?: number;
      existingAppointments?: Appointment[];
      consultantTimezone?: string;
      allowedStart?: Date;
      allowedEnd?: Date;
    },
  ): EdgeCaseValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];
    const suggestions: string[] = [];

    // 1. CRITICAL: Basic slot validation
    this.validateBasicSlots(selectedSlots, errors);

    // 2. CRITICAL: Timezone edge cases  
    this.validateTimezoneEdgeCases(selectedSlots, options.consultantTimezone, errors, warnings);

    // 3. CRITICAL: Past slot prevention
    this.validateFutureSlots(selectedSlots, errors);

    // 4. CRITICAL: Double booking prevention
    if (options.existingAppointments) {
      this.validateNoDoubleBooking(selectedSlots, options.existingAppointments, errors);
    }

    // 5. CRITICAL: Event-specific validation
    this.validateEventSpecificRules(selectedSlots, eventType, options, errors, warnings);

    // 6. WARNING: Date boundary checks
    if (options.allowedStart || options.allowedEnd) {
      this.validateDateBoundaries(selectedSlots, options.allowedStart, options.allowedEnd, warnings);
    }

    // 7. WARNING: Optimization suggestions
    this.generateOptimizationSuggestions(selectedSlots, eventType, options, suggestions);

    // 8. CRITICAL: Financial integrity checks
    this.validateFinancialIntegrity(selectedSlots, eventType, options, errors);

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions,
    };
  }

  /**
   * Critical: Basic slot validation
   */
  private static validateBasicSlots(slots: TimeSlot[], errors: ValidationError[]): void {
    if (!slots || slots.length === 0) {
      errors.push({
        type: "CRITICAL",
        code: "NO_SLOTS",
        message: "No slots provided for validation",
      });
      return;
    }

    // Check for null/undefined slots
    const invalidSlots = slots.filter(slot => !slot || !slot.startTime || !slot.endTime);
    if (invalidSlots.length > 0) {
      errors.push({
        type: "CRITICAL",
        code: "INVALID_SLOTS",
        message: `${invalidSlots.length} invalid slot(s) found`,
        details: { invalidCount: invalidSlots.length },
      });
    }

    // Check for slots with invalid time ranges
    const invalidTimeSlots = slots.filter(slot => 
      slot.startTime && slot.endTime && slot.startTime >= slot.endTime
    );
    if (invalidTimeSlots.length > 0) {
      errors.push({
        type: "CRITICAL",
        code: "INVALID_TIME_RANGE",
        message: `${invalidTimeSlots.length} slot(s) have invalid time ranges`,
        details: { invalidRangeCount: invalidTimeSlots.length },
      });
    }
  }

  /**
   * Critical: Timezone edge case validation
   */
  private static validateTimezoneEdgeCases(
    slots: TimeSlot[],
    consultantTimezone: string | undefined,
    errors: ValidationError[],
    warnings: ValidationError[],
  ): void {
    // Check for daylight saving time transitions
    const dstTransitions = this.findDSTTransitions(slots);
    if (dstTransitions.length > 0) {
      warnings.push({
        type: "WARNING",
        code: "DST_TRANSITION",
        message: "Slots span daylight saving time transitions",
        details: { transitionCount: dstTransitions.length },
      });
    }

    // Check for midnight boundary issues
    const midnightBoundary = slots.filter(slot => {
      const hour = slot.startTime.getHours();
      return hour >= 23 || hour <= 1;
    });
    if (midnightBoundary.length > 0) {
      warnings.push({
        type: "WARNING",
        code: "MIDNIGHT_BOUNDARY",
        message: "Slots near midnight may have timezone issues",
        details: { boundarySlotCount: midnightBoundary.length },
      });
    }
  }

  /**
   * Critical: Ensure no slots are in the past
   */
  private static validateFutureSlots(slots: TimeSlot[], errors: ValidationError[]): void {
    const now = new Date();
    const pastSlots = slots.filter(slot => slot.startTime < now);
    
    if (pastSlots.length > 0) {
      errors.push({
        type: "CRITICAL",
        code: "PAST_SLOTS",
        message: `${pastSlots.length} slot(s) are in the past`,
        details: { 
          pastSlotCount: pastSlots.length,
          earliestPastSlot: Math.min(...pastSlots.map(s => s.startTime.getTime())),
        },
      });
    }
  }

  /**
   * Critical: Prevent double booking
   */
  private static validateNoDoubleBooking(
    slots: TimeSlot[],
    existingAppointments: Appointment[],
    errors: ValidationError[],
  ): void {
    const conflicts: Array<{ slot: TimeSlot; appointment: Appointment }> = [];
    
    for (const slot of slots) {
      for (const appointment of existingAppointments) {
        if (appointment.slotsOfAppointment) {
          for (const apptSlot of appointment.slotsOfAppointment) {
            const apptStart = new Date(apptSlot.slotStartTimeInUTC);
            const apptEnd = new Date(apptSlot.slotEndTimeInUTC);
            
            // Check for any overlap
            if (slot.startTime < apptEnd && slot.endTime > apptStart) {
              conflicts.push({ slot, appointment });
            }
          }
        }
      }
    }

    if (conflicts.length > 0) {
      errors.push({
        type: "CRITICAL",
        code: "DOUBLE_BOOKING",
        message: `${conflicts.length} slot(s) conflict with existing appointments`,
        details: { 
          conflictCount: conflicts.length,
          conflictingAppointments: conflicts.map(c => c.appointment.id),
        },
      });
    }
  }

  /**
   * Critical: Event-specific validation rules
   */
  private static validateEventSpecificRules(
    slots: TimeSlot[],
    eventType: string,
    options: any,
    errors: ValidationError[],
    warnings: ValidationError[],
  ): void {
    switch (eventType) {
      case "consultation":
        this.validateConsultationRules(slots, options, errors, warnings);
        break;
      case "webinar":
        this.validateWebinarRules(slots, options, errors, warnings);
        break;
      case "subscription":
        this.validateSubscriptionRules(slots, options, errors, warnings);
        break;
      case "class":
        this.validateClassRules(slots, options, errors, warnings);
        break;
    }
  }

  /**
   * Consultation-specific validation
   */
  private static validateConsultationRules(
    slots: TimeSlot[],
    options: any,
    errors: ValidationError[],
    warnings: ValidationError[],
  ): void {
    const duration = options.totalDurationInHours || 1;
    const requiredSlots = SlotCalculationService.hoursToSlots(duration);
    
    // Must have exact slot count
    if (slots.length !== requiredSlots) {
      errors.push({
        type: "CRITICAL",
        code: "CONSULTATION_SLOT_COUNT",
        message: `Consultation needs exactly ${requiredSlots} slots, got ${slots.length}`,
        details: { required: requiredSlots, actual: slots.length },
      });
    }

    // Must be consecutive
    if (!this.areConsecutive(slots)) {
      errors.push({
        type: "CRITICAL",
        code: "CONSULTATION_NOT_CONSECUTIVE",
        message: "Consultation slots must be consecutive",
      });
    }

    // Must be same day
    if (!this.areSameDay(slots)) {
      errors.push({
        type: "CRITICAL",
        code: "CONSULTATION_MULTIPLE_DAYS",
        message: "Consultation slots must be on the same day",
      });
    }
  }

  /**
   * Subscription-specific validation
   */
  private static validateSubscriptionRules(
    slots: TimeSlot[],
    options: any,
    errors: ValidationError[],
    warnings: ValidationError[],
  ): void {
    const sessionDuration = options.sessionDurationInHours || 1;
    const callsPerWeek = options.callsPerWeek || 1;
    const slotsPerCall = SlotCalculationService.hoursToSlots(sessionDuration);
    const expectedSlots = callsPerWeek * slotsPerCall;

    // Check total slot count for current week
    if (slots.length !== expectedSlots) {
      errors.push({
        type: "CRITICAL",
        code: "SUBSCRIPTION_SLOT_COUNT",
        message: `Subscription needs ${expectedSlots} slots (${callsPerWeek} calls × ${slotsPerCall} slots), got ${slots.length}`,
        details: { required: expectedSlots, actual: slots.length },
      });
    }

    // Validate distribution across days
    const distribution = this.analyzeWeeklyDistribution(slots, slotsPerCall);
    if (distribution.callsPerDay.some(count => count > 1)) {
      warnings.push({
        type: "WARNING",
        code: "SUBSCRIPTION_MULTIPLE_CALLS_PER_DAY",
        message: "Multiple calls scheduled on the same day",
        details: { distribution: distribution.callsPerDay },
      });
    }
  }

  /**
   * Financial integrity validation
   */
  private static validateFinancialIntegrity(
    slots: TimeSlot[],
    eventType: string,
    options: any,
    errors: ValidationError[],
  ): void {
    // Ensure no slot is double-counted
    const uniqueSlots = new Set(slots.map(slot => slot.startTime.toISOString()));
    if (uniqueSlots.size !== slots.length) {
      errors.push({
        type: "CRITICAL",
        code: "DUPLICATE_SLOTS",
        message: "Duplicate slots detected - financial integrity violation",
        details: { unique: uniqueSlots.size, total: slots.length },
      });
    }

    // Validate monetary implications
    const totalHours = slots.length * 0.5;
    if (totalHours <= 0) {
      errors.push({
        type: "CRITICAL",
        code: "ZERO_BILLABLE_TIME",
        message: "Zero billable hours - financial integrity violation",
      });
    }
  }

  /**
   * Helper methods
   */
  private static areConsecutive(slots: TimeSlot[]): boolean {
    if (slots.length <= 1) return true;
    
    const sorted = [...slots].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startTime.getTime() !== sorted[i-1].endTime.getTime()) {
        return false;
      }
    }
    return true;
  }

  private static areSameDay(slots: TimeSlot[]): boolean {
    if (slots.length <= 1) return true;
    const firstDay = slots[0].startTime.toDateString();
    return slots.every(slot => slot.startTime.toDateString() === firstDay);
  }

  private static findDSTTransitions(slots: TimeSlot[]): TimeSlot[] {
    // Simplified DST detection - in production, use proper timezone library
    return slots.filter(slot => {
      const month = slot.startTime.getMonth();
      const day = slot.startTime.getDate();
      // March and November transitions (simplified)
      return (month === 2 && day >= 8 && day <= 14) || (month === 10 && day >= 1 && day <= 7);
    });
  }

  private static analyzeWeeklyDistribution(slots: TimeSlot[], slotsPerCall: number): {
    callsPerDay: number[];
    totalCalls: number;
  } {
    const byDay = new Map<string, TimeSlot[]>();
    slots.forEach(slot => {
      const day = slot.startTime.toDateString();
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(slot);
    });

    const callsPerDay = Array.from(byDay.values()).map(daySlots => 
      Math.floor(daySlots.length / slotsPerCall)
    );

    return {
      callsPerDay,
      totalCalls: callsPerDay.reduce((sum, calls) => sum + calls, 0),
    };
  }

  private static validateDateBoundaries(
    slots: TimeSlot[],
    allowedStart: Date | undefined,
    allowedEnd: Date | undefined,
    warnings: ValidationError[],
  ): void {
    if (!allowedStart && !allowedEnd) return;

    const outsideBoundary = slots.filter(slot => {
      if (allowedStart && slot.startTime < allowedStart) return true;
      if (allowedEnd && slot.startTime > allowedEnd) return true;
      return false;
    });

    if (outsideBoundary.length > 0) {
      warnings.push({
        type: "WARNING",
        code: "OUTSIDE_BOUNDARY",
        message: `${outsideBoundary.length} slot(s) outside allowed time boundaries`,
        details: { outsideCount: outsideBoundary.length },
      });
    }
  }

  private static generateOptimizationSuggestions(
    slots: TimeSlot[],
    eventType: string,
    options: any,
    suggestions: string[],
  ): void {
    // Add intelligent suggestions based on analysis
    if (slots.length > 10) {
      suggestions.push("Consider breaking this into multiple smaller appointments");
    }

    if (eventType === "subscription") {
      const distribution = this.analyzeWeeklyDistribution(slots, 2);
      if (distribution.callsPerDay.some(count => count === 0)) {
        suggestions.push("Consider more even distribution across weekdays");
      }
    }
  }

  private static validateWebinarRules(
    slots: TimeSlot[],
    options: any,
    errors: ValidationError[],
    warnings: ValidationError[],
  ): void {
    // Similar to consultation but may have different rules
    this.validateConsultationRules(slots, options, errors, warnings);
  }

  private static validateClassRules(
    slots: TimeSlot[],
    options: any,
    errors: ValidationError[],
    warnings: ValidationError[],
  ): void {
    // Class-specific validation would go here
    const sessionDuration = options.sessionDurationInHours || 1;
    const slotsPerSession = SlotCalculationService.hoursToSlots(sessionDuration);
    
    if (slots.length % slotsPerSession !== 0) {
      warnings.push({
        type: "WARNING",
        code: "CLASS_INCOMPLETE_SESSIONS",
        message: "Selected slots don't form complete class sessions",
        details: { slotsPerSession, totalSlots: slots.length },
      });
    }
  }
}