/**
 * Service for calendar operations and data processing
 * Centralizes calendar-related business logic
 */

import { 
  TimeSlot, 
  Appointment, 
  mapWeeklySlots, 
  mapCustomSlots,
  ConsultantData,
  CalendarViewConfig,
  getSlotStatus,
} from "../utils/calendarUtils";
import { CalendarCalculationService } from "../utils/calendarCalculations";
import { SlotCalculationService } from "../utils/slotCalculationService";
import { AllocationService } from "../utils/allocationService";

export interface CalendarData {
  availableSlots: TimeSlot[];
  existingAppointments: Appointment[];
  consultantData?: ConsultantData;
  loading: boolean;
  error: string | null;
}

export interface SlotValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Service class for calendar operations
 */
export class CalendarService {
  /**
   * Process consultant availability data into time slots
   */
  static processAvailabilityData(
    consultantData: ConsultantData,
    viewConfig: CalendarViewConfig,
    intervalMinutes: number = 30,
  ): TimeSlot[] {
    const slots: TimeSlot[] = [];

    // Add weekly slots
    if (consultantData.scheduleType === "WEEKLY") {
      slots.push(...mapWeeklySlots(
        consultantData,
        viewConfig.currentDate,
        viewConfig.view,
        intervalMinutes,
      ));
    }

    // Add custom slots
    if (consultantData.scheduleType === "CUSTOM") {
      slots.push(...mapCustomSlots(consultantData, intervalMinutes));
    }

    return slots;
  }

  /**
   * Filter slots based on appointment conflicts
   */
  static filterAvailableSlots(
    slots: TimeSlot[],
    appointments: Appointment[],
  ): TimeSlot[] {
    return slots.map(slot => {
      // Check for conflicts with existing appointments
      const conflicts = appointments.filter(appointment => {
        return appointment.slotsOfAppointment?.some(apptSlot => {
          const apptStart = new Date(apptSlot.slotStartTimeInUTC);
          const apptEnd = new Date(apptSlot.slotEndTimeInUTC);
          
          return (
            slot.startTime < apptEnd && 
            slot.endTime > apptStart
          );
        });
      });

      return {
        ...slot,
        isBooked: conflicts.length > 0,
        isPartiallyBooked: conflicts.some(c => 
          c.slotsOfAppointment?.some(s => {
            const start = new Date(s.slotStartTimeInUTC);
            const end = new Date(s.slotEndTimeInUTC);
            return (
              start.getTime() !== slot.startTime.getTime() ||
              end.getTime() !== slot.endTime.getTime()
            );
          })
        ),
        appointmentDetails: conflicts.map(c => ({
          id: c.id,
          type: c.appointmentType,
          title: this.getAppointmentTitle(c),
        })),
      };
    });
  }

  /**
   * Validate selected slots for an event type
   */
  static validateSlotSelection(
    selectedSlots: TimeSlot[],
    eventType: "consultation" | "subscription" | "webinar" | "class",
    options: {
      totalDurationInHours?: number;
      sessionDurationInHours?: number;
      callsPerWeek?: number;
      requireConsecutive?: boolean;
    },
  ): SlotValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic validation
    if (selectedSlots.length === 0) {
      errors.push("No slots selected");
      return { isValid: false, errors, warnings };
    }

    // Check for past slots
    const now = new Date();
    const pastSlots = selectedSlots.filter(slot => slot.startTime < now);
    if (pastSlots.length > 0) {
      errors.push(`${pastSlots.length} slot(s) are in the past`);
    }

    // Event-specific validation
    switch (eventType) {
      case "consultation":
      case "webinar": {
        const duration = options.totalDurationInHours || 1;
        const requiredSlots = SlotCalculationService.hoursToSlots(duration);
        
        if (selectedSlots.length !== requiredSlots) {
          errors.push(`Need exactly ${requiredSlots} slots for ${duration}h ${eventType}`);
        }

        // Check consecutive requirement
        if (options.requireConsecutive !== false) {
          if (!this.areSlotsConsecutive(selectedSlots)) {
            errors.push(`${eventType} slots must be consecutive`);
          }
          
          // Check same day requirement
          if (!this.areSlotsOnSameDay(selectedSlots)) {
            errors.push(`${eventType} slots must be on the same day`);
          }
        }
        break;
      }

      case "subscription": {
        const sessionDuration = options.sessionDurationInHours || 1;
        const callsPerWeek = options.callsPerWeek || 1;
        const slotsPerCall = SlotCalculationService.hoursToSlots(sessionDuration);
        
        if (selectedSlots.length !== callsPerWeek * slotsPerCall) {
          errors.push(`Need ${callsPerWeek} calls of ${slotsPerCall} slots each`);
        }

        // Validate distribution
        const validation = this.validateSubscriptionDistribution(
          selectedSlots,
          callsPerWeek,
          slotsPerCall,
        );
        
        if (!validation.isValid) {
          errors.push(...validation.errors);
          warnings.push(...validation.warnings);
        }
        break;
      }

      case "class": {
        // Similar to subscription but may have different rules
        const sessionDuration = options.sessionDurationInHours || 1;
        const slotsPerSession = SlotCalculationService.hoursToSlots(sessionDuration);
        
        if (selectedSlots.length % slotsPerSession !== 0) {
          warnings.push(`Selected slots don't align with session duration`);
        }
        break;
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Generate footer text for calendar display
   */
  static generateFooterText(
    eventType: "consultation" | "subscription" | "webinar" | "class",
    selectedSlots: TimeSlot[],
    options: {
      totalDurationInHours?: number;
      sessionDurationInHours?: number;
      callsPerWeek?: number;
      durationInMonths?: number;
      completedSlots?: any[];
    },
  ): string {
    const selectedCount = selectedSlots.length;

    switch (eventType) {
      case "consultation":
      case "webinar": {
        const duration = options.totalDurationInHours || 1;
        const requiredSlots = SlotCalculationService.hoursToSlots(duration);
        return `Required: ${SlotCalculationService.formatConsecutiveSlots(duration)} | Selected: ${selectedCount}/${requiredSlots} slots`;
      }

      case "subscription": {
        const sessionDuration = options.sessionDurationInHours || 1;
        const callsPerWeek = options.callsPerWeek || 1;
        const slotsPerCall = SlotCalculationService.hoursToSlots(sessionDuration);
        const requiredSlots = callsPerWeek * slotsPerCall;
        
        return `Required: ${SlotCalculationService.formatDuration(sessionDuration)} per call (${SlotCalculationService.formatSlotCount(slotsPerCall)} per call) | Selected: ${selectedCount}/${requiredSlots} slots`;
      }

      case "class": {
        const sessionDuration = options.sessionDurationInHours || 1;
        const slotsPerSession = SlotCalculationService.hoursToSlots(sessionDuration);
        const sessions = Math.floor(selectedCount / slotsPerSession);
        
        return `Required: ${SlotCalculationService.formatDuration(sessionDuration)} per session | Selected: ${sessions} sessions (${selectedCount} slots)`;
      }

      default:
        return `Selected: ${selectedCount} slots`;
    }
  }

  /**
   * Private helper methods
   */
  private static getAppointmentTitle(appointment: Appointment): string {
    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return appointment.consultation?.consultationPlan?.title || "Consultation";
      case "SUBSCRIPTION":
        return appointment.subscription?.subscriptionPlan?.title || "Subscription";
      case "WEBINAR":
        return appointment.webinar?.webinarPlan?.title || "Webinar";
      case "CLASS":
        return appointment.class?.classPlan?.title || "Class";
      default:
        return "Appointment";
    }
  }

  private static areSlotsConsecutive(slots: TimeSlot[]): boolean {
    if (slots.length <= 1) return true;
    
    const sortedSlots = [...slots].sort((a, b) => 
      a.startTime.getTime() - b.startTime.getTime()
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

  private static areSlotsOnSameDay(slots: TimeSlot[]): boolean {
    if (slots.length <= 1) return true;
    
    const firstDay = slots[0].startTime.toDateString();
    return slots.every(slot => slot.startTime.toDateString() === firstDay);
  }

  private static validateSubscriptionDistribution(
    slots: TimeSlot[],
    callsPerWeek: number,
    slotsPerCall: number,
  ): SlotValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Group by day
    const byDay = new Map<string, TimeSlot[]>();
    slots.forEach(slot => {
      const day = slot.startTime.toDateString();
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(slot);
    });

    // Check daily limits
    for (const [day, daySlots] of byDay) {
      if (daySlots.length > slotsPerCall) {
        errors.push(`Too many slots on ${day} (max ${slotsPerCall} per day)`);
      }
    }

    // Check weekly distribution would go here
    // (simplified for now)

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }
}