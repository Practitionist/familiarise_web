/**
 * Slot Validation Service
 *
 * Unified validation logic for all event types.
 * Single source of truth for validation rules - eliminates duplication across routes.
 */

import prisma from "@/lib/prisma";
import { RequestStatus, ScheduleType, DayOfWeek } from "@prisma/client";
import {
  EventType,
  ValidationResult,
  PrismaTransaction,
  ConsultantAllocationData,
  EventConfig,
} from "./types";
import { SlotCalculationService } from "./SlotCalculationService";
import { SubscriptionValidationService } from "../subscriptionValidation";

/**
 * Service for validating slot allocations
 */
export class SlotValidationService {
  constructor(
    private readonly prismaClient:
      | typeof prisma
      | PrismaTransaction = prisma,
  ) {}

  /**
   * Main validation entry point
   * Routes to appropriate validator based on event type
   */
  async validate(
    eventType: EventType,
    eventId: string,
    slots: Date[],
    consultant: ConsultantAllocationData,
    config: EventConfig,
  ): Promise<ValidationResult> {
    // Universal validations (apply to all event types)
    const futureCheck = this.validateSlotsInFuture(slots);
    if (!futureCheck.isValid) return futureCheck;

    const scheduleCheck = this.validateMatchesSchedule(slots, consultant);
    if (!scheduleCheck.isValid) return scheduleCheck;

    const conflictCheck = await this.validateNoConflicts(
      slots,
      consultant.userId,
    );
    if (!conflictCheck.isValid) return conflictCheck;

    // Event-specific validations
    switch (eventType) {
      case "consultation":
        return this.validateConsultation(slots, config);

      case "subscription":
        return this.validateSubscription(eventId, slots, config);

      case "webinar":
        return this.validateWebinar(slots, config);

      case "class":
        return this.validateClass(slots, config);

      default:
        return {
          isValid: false,
          errors: [`Invalid event type: ${eventType}`],
          warnings: [],
        };
    }
  }

  /**
   * UNIVERSAL VALIDATOR: Ensure all slots are in the future
   */
  private validateSlotsInFuture(slots: Date[]): ValidationResult {
    const now = new Date();
    const errors: string[] = [];

    for (const slot of slots) {
      if (slot <= now) {
        errors.push(
          `Cannot allocate slots in the past: ${slot.toLocaleString()}`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * UNIVERSAL VALIDATOR: Check for conflicts with existing appointments
   */
  private async validateNoConflicts(
    slots: Date[],
    consultantUserId: string,
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    for (const slot of slots) {
      const existingAppointment = await this.prismaClient.appointment.findFirst(
        {
          where: {
            AND: [
              {
                OR: [
                  { subscription: { requestStatus: RequestStatus.APPROVED } },
                  { consultation: { requestStatus: RequestStatus.APPROVED } },
                  { webinar: { status: "SCHEDULED" } },
                  { class: { status: "SCHEDULED" } },
                ],
              },
              {
                slotsOfAppointment: {
                  some: {
                    slotStartTimeInUTC: slot,
                    user: {
                      some: {
                        id: consultantUserId,
                      },
                    },
                  },
                },
              },
            ],
          },
          include: {
            consultation: {
              include: {
                consultationPlan: true,
                requestedBy: {
                  include: { user: true },
                },
              },
            },
            subscription: {
              include: {
                subscriptionPlan: true,
                requestedBy: {
                  include: { user: true },
                },
              },
            },
          },
        },
      );

      if (existingAppointment) {
        let conflictDetails = `${slot.toLocaleString()}`;
        if (existingAppointment.consultation) {
          conflictDetails += ` (conflicts with consultation for ${existingAppointment.consultation.requestedBy?.user?.name || "unknown"})`;
        } else if (existingAppointment.subscription) {
          conflictDetails += ` (conflicts with subscription for ${existingAppointment.subscription.requestedBy?.user?.name || "unknown"})`;
        }
        errors.push(`Slot already booked: ${conflictDetails}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * UNIVERSAL VALIDATOR: Ensure slots match consultant's schedule
   */
  private validateMatchesSchedule(
    slots: Date[],
    consultant: ConsultantAllocationData,
  ): ValidationResult {
    const errors: string[] = [];

    if (consultant.scheduleType === ScheduleType.WEEKLY) {
      // Create a set of valid day+time patterns
      const validPatterns = new Set<string>();
      for (const slot of consultant.slotsOfAvailabilityWeekly) {
        const slotDay = new Date(slot.slotStartTimeInUTC).getDay();
        const slotHours = new Date(slot.slotStartTimeInUTC).getHours();
        const slotMinutes = new Date(slot.slotStartTimeInUTC).getMinutes();
        validPatterns.add(`${slotDay}-${slotHours}-${slotMinutes}`);
      }

      for (const slot of slots) {
        const pattern = `${slot.getDay()}-${slot.getHours()}-${slot.getMinutes()}`;
        if (!validPatterns.has(pattern)) {
          errors.push(
            `Slot ${slot.toLocaleString()} does not match consultant's weekly schedule`,
          );
        }
      }
    } else {
      // Custom schedule - validate exact datetime match
      const validTimes = new Set(
        consultant.slotsOfAvailabilityCustom.map((s) =>
          new Date(s.slotStartTimeInUTC).toISOString(),
        ),
      );

      for (const slot of slots) {
        if (!validTimes.has(slot.toISOString())) {
          errors.push(
            `Slot ${slot.toLocaleString()} is not in consultant's custom schedule`,
          );
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * UNIVERSAL VALIDATOR: Check if slots are consecutive
   * Uses 1-second tolerance for timezone/precision issues
   */
  private validateConsecutiveSlots(slots: Date[]): ValidationResult {
    if (slots.length <= 1) {
      return { isValid: true, errors: [], warnings: [] };
    }

    const sortedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());
    const toleranceMs = 1000; // 1 second tolerance
    const errors: string[] = [];

    for (let i = 1; i < sortedSlots.length; i++) {
      const prevSlot = sortedSlots[i - 1];
      const currentSlot = sortedSlots[i];

      // Expected: previous slot + 30 minutes = current slot
      const expectedNextTime = prevSlot.getTime() + 30 * 60 * 1000;
      const timeDiff = Math.abs(currentSlot.getTime() - expectedNextTime);

      if (timeDiff > toleranceMs) {
        errors.push(
          `Slots must be consecutive. Gap detected between ${prevSlot.toLocaleString()} and ${currentSlot.toLocaleString()}`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * UNIVERSAL VALIDATOR: Check if all slots are on the same day
   */
  private validateSameDaySlots(slots: Date[]): ValidationResult {
    if (slots.length <= 1) {
      return { isValid: true, errors: [], warnings: [] };
    }

    const firstSlotDay = slots[0].toDateString();
    const errors: string[] = [];

    for (const slot of slots) {
      if (slot.toDateString() !== firstSlotDay) {
        errors.push(
          `All slots must be on the same day. Found slots on ${firstSlotDay} and ${slot.toDateString()}`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * EVENT-SPECIFIC: Validate consultation slots
   * Rules: Must be same day, consecutive, and match required duration
   */
  private validateConsultation(
    slots: Date[],
    config: EventConfig,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Calculate required slots
    const duration = config.durationInHours || config.sessionDurationInHours;
    if (!duration) {
      return {
        isValid: false,
        errors: ["Consultation duration is required"],
        warnings: [],
      };
    }

    const requiredSlots = SlotCalculationService.getSlotsPerCall(duration);

    // Check slot count
    if (slots.length !== requiredSlots) {
      errors.push(
        `Consultation requires exactly ${requiredSlots} slot${requiredSlots !== 1 ? "s" : ""} (${duration} hour${duration > 1 ? "s" : ""}) but ${slots.length} provided`,
      );
    }

    // Check same day (BEFORE consecutive check - more important)
    const sameDayCheck = this.validateSameDaySlots(slots);
    if (!sameDayCheck.isValid) {
      errors.push(
        "Consultation is a one-day event - all slots must be on the same day",
      );
      // Don't check consecutiveness if not same day
      return { isValid: false, errors, warnings };
    }

    // Check consecutive
    const consecutiveCheck = this.validateConsecutiveSlots(slots);
    if (!consecutiveCheck.isValid) {
      errors.push("Consultation slots must be consecutive (no gaps allowed)");
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * EVENT-SPECIFIC: Validate subscription slots
   * Uses the existing SubscriptionValidationService
   */
  private async validateSubscription(
    subscriptionId: string,
    slots: Date[],
    config: EventConfig,
  ): Promise<ValidationResult> {
    const validationService = new SubscriptionValidationService(
      this.prismaClient as any,
    );

    const result = await validationService.validateSubscriptionSlots(
      subscriptionId,
      slots.map((s) => s.toISOString()),
    );

    return {
      isValid: result.isValid,
      errors: result.errors,
      warnings: result.warnings,
    };
  }

  /**
   * EVENT-SPECIFIC: Validate webinar slots
   * Rules: Must be consecutive and match required duration
   */
  private validateWebinar(
    slots: Date[],
    config: EventConfig,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Calculate required slots
    const duration = config.durationInHours || config.sessionDurationInHours;
    if (!duration) {
      return {
        isValid: false,
        errors: ["Webinar duration is required"],
        warnings: [],
      };
    }

    const requiredSlots = SlotCalculationService.getSlotsPerCall(duration);

    // Check slot count
    if (slots.length !== requiredSlots) {
      const durationText =
        duration === 1 ? "1 hour" : `${duration} hours`;
      errors.push(
        `Webinar (${durationText}) requires exactly ${requiredSlots} consecutive slot${requiredSlots > 1 ? "s" : ""}, but ${slots.length} provided`,
      );
    }

    // Check consecutive
    if (requiredSlots > 1) {
      const consecutiveCheck = this.validateConsecutiveSlots(slots);
      if (!consecutiveCheck.isValid) {
        errors.push("Webinar slots must be consecutive");
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * EVENT-SPECIFIC: Validate class slots
   * Rules: Must respect weekly limits and session grouping
   */
  private validateClass(slots: Date[], config: EventConfig): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate configuration
    if (!config.callsPerWeek) {
      return {
        isValid: false,
        errors: ["Classes per week is required for class validation"],
        warnings: [],
      };
    }

    if (!config.sessionDurationInHours) {
      return {
        isValid: false,
        errors: ["Session duration is required for class validation"],
        warnings: [],
      };
    }

    const slotsPerSession = SlotCalculationService.getSlotsPerCall(
      config.sessionDurationInHours,
    );

    // Group slots by day and validate each day has complete sessions
    const slotsByDay = SlotCalculationService.groupSlotsByDay(
      slots.map((s) => ({
        startTime: s,
        endTime: new Date(s.getTime() + 30 * 60 * 1000),
        isAvailable: true,
        isBooked: false,
      })),
    );

    slotsByDay.forEach((daySlots, dayKey) => {
      const sorted = [...daySlots].sort(
        (a, b) => a.startTime.getTime() - b.startTime.getTime(),
      );

      // Check if day has incomplete sessions
      if (sorted.length % slotsPerSession !== 0) {
        errors.push(
          `Day ${dayKey} has ${sorted.length} slots but needs multiples of ${slotsPerSession} (incomplete session)`,
        );
      }

      // Check consecutiveness within day
      const consecutiveCheck = this.validateConsecutiveSlots(
        sorted.map((s) => s.startTime),
      );
      if (!consecutiveCheck.isValid) {
        errors.push(`Day ${dayKey} has non-consecutive slots`);
      }
    });

    // Validate weekly limits
    const slotsByWeek = SlotCalculationService.groupSlotsByWeek(
      slots.map((s) => ({
        startTime: s,
        endTime: new Date(s.getTime() + 30 * 60 * 1000),
        isAvailable: true,
        isBooked: false,
      })),
    );

    slotsByWeek.forEach((weekSlots, weekKey) => {
      const sessionsThisWeek = Math.floor(weekSlots.length / slotsPerSession);
      if (sessionsThisWeek > config.callsPerWeek!) {
        errors.push(
          `Week of ${new Date(weekKey).toLocaleDateString()} has ${sessionsThisWeek} sessions but max is ${config.callsPerWeek}`,
        );
      }
    });

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
