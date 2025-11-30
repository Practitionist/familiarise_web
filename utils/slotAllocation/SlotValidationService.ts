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
    private readonly prismaClient: typeof prisma | PrismaTransaction = prisma,
  ) {}

  /**
   * Simple slot availability check (used for lock validation)
   * Only checks for conflicts - no schedule or future validation
   *
   * USE CASE: Re-validation inside distributed lock after acquisition
   * This ensures the slot is still available before creating the booking.
   *
   * FIX Issue #11: Added slotDurationMinutes parameter for configurable slot duration
   * @param slotDurationMinutes - Duration of each slot in minutes (default: 30)
   */
  async checkSlotAvailability(
    slots: Date[],
    consultantUserId: string,
    slotDurationMinutes: number = 30,
  ): Promise<ValidationResult> {
    return await this.validateNoConflicts(slots, consultantUserId, slotDurationMinutes);
  }

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

    // FIX Issue #11: Pass slot duration from config for conflict checking
    // Calculate slot duration in minutes from hours (default to 30 minutes)
    const slotDurationMinutes = config.sessionDurationInHours
      ? Math.round(config.sessionDurationInHours * 60 / slots.length)
      : 30;

    const conflictCheck = await this.validateNoConflicts(
      slots,
      consultant.userId,
      slotDurationMinutes,
    );
    if (!conflictCheck.isValid) return conflictCheck;

    // FIX: Server-side scheduling period validation
    // This was only done client-side, which could be bypassed
    // Now enforced on the server for all subscriptions and classes
    if (config.schedulingPeriodStartsAt && config.schedulingPeriodEndsAt) {
      const periodCheck = this.validateSchedulingPeriod(
        slots,
        config.schedulingPeriodStartsAt,
        config.schedulingPeriodEndsAt,
      );
      if (!periodCheck.isValid) return periodCheck;
    }

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
   *
   * FIX: Added 5-second buffer to prevent race conditions
   *
   * RACE CONDITION SCENARIO (before fix):
   * 1. Auto-allocation finds slot at 10:00:00.000
   * 2. By the time validation runs, it's 10:00:00.001
   * 3. Slot rejected as "in the past"
   * 4. Auto-allocation fails despite valid slot
   *
   * BUFFER RATIONALE:
   * - 5 seconds accounts for processing time between operations
   * - Prevents rejecting slots that become "now" during transaction
   * - Still prevents genuine past slot attempts (minutes/hours old)
   */
  private validateSlotsInFuture(slots: Date[]): ValidationResult {
    const now = new Date();
    const BUFFER_MS = 5000; // 5-second processing time buffer
    const cutoff = new Date(now.getTime() + BUFFER_MS);
    const errors: string[] = [];

    for (const slot of slots) {
      if (slot < cutoff) {
        const secondsUntilSlot = (slot.getTime() - now.getTime()) / 1000;
        errors.push(
          `Cannot allocate slots in the past or too soon: ${slot.toLocaleString()} ` +
            `(${secondsUntilSlot >= 0 ? `only ${secondsUntilSlot.toFixed(1)}s` : `${Math.abs(secondsUntilSlot).toFixed(1)}s ago`}). ` +
            `Slots must be at least 5 seconds in the future to allow for processing time.`,
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
   *
   * CRITICAL: This prevents double-booking by detecting time range overlaps.
   *
   * WHY RANGE OVERLAP MATTERS:
   * - Each slot is 30 minutes: [startTime, endTime]
   * - Two slots overlap if: slotA.start < slotB.end AND slotB.start < slotA.end
   *
   * EXAMPLE:
   * - Existing: 10:00-10:30 (one slot)
   * - Proposed: 10:00-11:00 (two slots: 10:00-10:30, 10:30-11:00)
   * - Without range check: Only 10:00-10:30 flagged as conflict
   * - With range check: Both slots properly detected as conflicts
   *
   * DATABASE QUERY LOGIC:
   * - slotStartTimeInUTC < slotEnd: Existing slot starts before proposed ends
   * - slotEndTimeInUTC > slot: Existing slot ends after proposed starts
   * - Together: Detects ANY time period overlap
   */
  /**
   * FIX Issue #11: Slot duration is now configurable
   * Default remains 30 minutes for backwards compatibility
   * @param slotDurationMinutes - Duration of each slot in minutes (default: 30)
   */
  private async validateNoConflicts(
    slots: Date[],
    consultantUserId: string,
    slotDurationMinutes: number = 30,
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    for (const slot of slots) {
      // Calculate the end time of the proposed slot using configurable duration
      const slotEnd = new Date(slot.getTime() + slotDurationMinutes * 60 * 1000);

      const existingAppointment = await this.prismaClient.appointment.findFirst(
        {
          where: {
            AND: [
              {
                OR: [
                  { subscription: { requestStatus: RequestStatus.APPROVED } },
                  // FIX: Check ALL consultation booking states (not just APPROVED)
                  // PENDING = User submitted, awaiting consultant approval (tentative)
                  // APPROVED = Consultant approved (if no payment required)
                  // APPROVED_PENDING_PAYMENT = Consultant approved, awaiting payment
                  {
                    consultation: {
                      requestStatus: {
                        in: [
                          RequestStatus.PENDING,
                          RequestStatus.APPROVED,
                          RequestStatus.APPROVED_PENDING_PAYMENT,
                        ],
                      },
                    },
                  },
                  { webinar: { status: "SCHEDULED" } },
                  { class: { status: "SCHEDULED" } },
                ],
              },
              {
                slotsOfAppointment: {
                  some: {
                    // CRITICAL FIX: Check for range overlap instead of exact match
                    // This prevents double-booking when slots partially overlap
                    AND: [
                      { startsAt: { lt: slotEnd } }, // Existing starts before proposed ends
                      { endsAt: { gt: slot } }, // Existing ends after proposed starts
                    ],
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
            payment: true, // Need payment data to check expiry
          },
        },
      );

      if (existingAppointment) {
        // FIX: Check if consultation is APPROVED_PENDING_PAYMENT with expired payment
        // If payment expired, slot is actually free (orphaned payment bug fix)
        if (
          existingAppointment.consultation?.requestStatus ===
          RequestStatus.APPROVED_PENDING_PAYMENT
        ) {
          const payment = existingAppointment.payment?.[0];
          if (payment?.expiresAt) {
            const now = new Date();
            const paymentExpired = new Date(payment.expiresAt) < now;
            if (paymentExpired) {
              // Payment expired - slot is actually available, skip this conflict
              continue;
            }
          }
        }

        // Slot is genuinely booked - add error
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
   *
   * FIX: Use UTC methods consistently and provide detailed error messages
   * showing which slots are invalid and what patterns are expected.
   */
  private validateMatchesSchedule(
    slots: Date[],
    consultant: ConsultantAllocationData,
  ): ValidationResult {
    const errors: string[] = [];

    if (consultant.scheduleType === ScheduleType.WEEKLY) {
      // FIX: Check if slots fall WITHIN availability ranges, not just exact start time matches
      // Availability slots can be any duration (e.g., 1 hour), but we schedule in 30-minute blocks
      // Example: 9:00-10:00 availability should allow both 9:00-9:30 and 9:30-10:00 bookings

      const invalidSlots: string[] = [];
      const dayNames = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];

      for (const slot of slots) {
        const slotDay = slot.getUTCDay();
        const slotHours = slot.getUTCHours();
        const slotMinutes = slot.getUTCMinutes();
        const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000); // 30-minute slot

        // Check if this slot falls within ANY weekly availability slot
        const matchesAvailability = consultant.slotsOfAvailabilityWeekly.some(
          (availSlot) => {
            const availStart = new Date(availSlot.availabilityStartsAt);
            const availEnd = new Date(availSlot.availabilityEndsAt);
            const availDay = availStart.getUTCDay();

            // Must be same day of week
            if (slotDay !== availDay) return false;

            // Check if the requested time falls within this availability slot's time range
            // Compare ONLY the time-of-day part (hours:minutes), not the full date
            const slotTimeMinutes = slotHours * 60 + slotMinutes;
            const slotEndMinutes =
              slotEnd.getUTCHours() * 60 + slotEnd.getUTCMinutes();
            const availStartMinutes =
              availStart.getUTCHours() * 60 + availStart.getUTCMinutes();
            const availEndMinutes =
              availEnd.getUTCHours() * 60 + availEnd.getUTCMinutes();

            // Slot must start >= availability start AND end <= availability end
            return (
              slotTimeMinutes >= availStartMinutes &&
              slotEndMinutes <= availEndMinutes
            );
          },
        );

        if (!matchesAvailability) {
          const timeStr = `${slotHours.toString().padStart(2, "0")}:${slotMinutes.toString().padStart(2, "0")}`;
          invalidSlots.push(
            `${dayNames[slotDay]} at ${timeStr} UTC (${slot.toLocaleString()})`,
          );
        }
      }

      if (invalidSlots.length > 0) {
        const slotWord = invalidSlots.length === 1 ? "slot" : "slots";
        const verbTense = invalidSlots.length === 1 ? "does" : "do";
        errors.push(
          `The selected ${slotWord} ${verbTense} not match the consultant's available days and times. ` +
            `Please choose from the green "Available" slots shown in the calendar.`,
        );
      }
    } else {
      // Custom schedule - validate using OVERLAP detection (same logic as calendar display)
      // FIX: Previously only checked START times, which failed when consultant created
      // larger slots (e.g., 1-hour slot from 16:30-17:30) that the calendar breaks down
      // into multiple 30-minute display intervals (16:30-17:00 and 17:00-17:30)

      console.log("[SlotValidationService] Custom schedule validation:", {
        consultantAvailableSlots: consultant.slotsOfAvailabilityCustom
          .slice(0, 5)
          .map((s) => ({
            start: new Date(s.availabilityStartsAt).toISOString(),
            end: new Date(s.availabilityEndsAt).toISOString(),
            duration: `${(new Date(s.availabilityEndsAt).getTime() - new Date(s.availabilityStartsAt).getTime()) / (1000 * 60)} mins`,
          })),
        totalAvailable: consultant.slotsOfAvailabilityCustom.length,
        requestedSlots: slots.slice(0, 3).map((s) => s.toISOString()), // First 3 for debugging
        totalRequested: slots.length,
      });

      let hasInvalidSlots = false;
      const invalidSlotsList: string[] = [];
      for (const slot of slots) {
        // Calculate the end time of the requested slot (30-minute slots)
        const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000);

        // Check if this slot overlaps with ANY available custom slot
        // Uses same overlap logic as calendar: intervalStart < slotEnd && slotStart < intervalEnd
        const hasOverlap = consultant.slotsOfAvailabilityCustom.some(
          (availableSlot) => {
            const availableStart = new Date(availableSlot.availabilityStartsAt);
            const availableEnd = new Date(availableSlot.availabilityEndsAt);
            return slot < availableEnd && availableStart < slotEnd;
          },
        );

        if (!hasOverlap) {
          hasInvalidSlots = true;
          invalidSlotsList.push(slot.toISOString());
        }
      }

      if (hasInvalidSlots) {
        console.error("[SlotValidationService] Invalid slots found:", {
          invalidSlots: invalidSlotsList,
          availableSlotRanges: consultant.slotsOfAvailabilityCustom
            .slice(0, 10)
            .map((s) => ({
              start: new Date(s.availabilityStartsAt).toISOString(),
              end: new Date(s.availabilityEndsAt).toISOString(),
            })),
        });

        const slotWord = slots.length === 1 ? "slot" : "slots";
        const verbTense = slots.length === 1 ? "is" : "are";

        // Check if this looks like a consecutive slot issue (some slots valid, some not)
        const validSlotCount = slots.filter((slot) => {
          const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000);
          return consultant.slotsOfAvailabilityCustom.some((availableSlot) => {
            const availableStart = new Date(availableSlot.availabilityStartsAt);
            const availableEnd = new Date(availableSlot.availabilityEndsAt);
            return slot < availableEnd && availableStart < slotEnd;
          });
        }).length;
        const isConsecutiveIssue =
          validSlotCount > 0 && validSlotCount < slots.length;

        if (isConsecutiveIssue) {
          errors.push(
            `The consultant doesn't have enough consecutive availability for this ${slots.length === 2 ? "1-hour" : `${slots.length * 0.5}-hour`} event. ` +
              `Only ${validSlotCount} of ${slots.length} required time slots ${verbTense} available. ` +
              `The consultant needs to add more consecutive time slots to their schedule.`,
          );
        } else {
          errors.push(
            `The selected ${slotWord} ${verbTense} not available in the consultant's schedule. ` +
              `Please choose from the green "Available" slots shown in the calendar. ` +
              `Only specific times are available for booking.`,
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
   * UNIVERSAL VALIDATOR: Check scheduling period boundaries
   *
   * SECURITY: This is now enforced server-side (was previously only client-side)
   * Prevents bypassing scheduling period restrictions via direct API calls.
   *
   * APPLIES TO:
   * - Subscriptions: Must schedule all calls within [startDate, endDate]
   * - Classes: Must schedule all sessions within [startDate, endDate]
   *
   * NOT APPLICABLE TO:
   * - Consultations: One-time events, no scheduling period
   * - Webinars: One-time events, no scheduling period
   */
  private validateSchedulingPeriod(
    slots: Date[],
    startDate: Date,
    endDate: Date,
  ): ValidationResult {
    const errors: string[] = [];

    for (const slot of slots) {
      if (slot < startDate || slot > endDate) {
        errors.push(
          `Slot ${slot.toLocaleString()} is outside the scheduling period ` +
            `(${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}). ` +
            `All slots must be scheduled within this date range.`,
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

    // FIX: Validate duration before use
    try {
      SlotCalculationService.validateDuration(
        duration,
        "Consultation duration",
      );
    } catch (error) {
      return {
        isValid: false,
        errors: [
          error instanceof Error
            ? error.message
            : "Invalid consultation duration",
        ],
        warnings: [],
      };
    }

    // After validation, duration is guaranteed to be a valid number
    const requiredSlots = SlotCalculationService.getSlotsPerCall(duration!);

    // Check slot count
    if (slots.length !== requiredSlots) {
      errors.push(
        `Consultation requires exactly ${requiredSlots} slot${requiredSlots !== 1 ? "s" : ""} (${duration!} hour${duration! > 1 ? "s" : ""}) but ${slots.length} provided`,
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

    // FIX: Validate duration before use
    try {
      SlotCalculationService.validateDuration(duration, "Webinar duration");
    } catch (error) {
      return {
        isValid: false,
        errors: [
          error instanceof Error ? error.message : "Invalid webinar duration",
        ],
        warnings: [],
      };
    }

    // After validation, duration is guaranteed to be a valid number
    const requiredSlots = SlotCalculationService.getSlotsPerCall(duration!);

    // Check slot count
    if (slots.length !== requiredSlots) {
      const durationText = duration! === 1 ? "1 hour" : `${duration!} hours`;
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

    // FIX: Validate duration before use
    try {
      SlotCalculationService.validateDuration(
        config.sessionDurationInHours,
        "Session duration",
      );
    } catch (error) {
      return {
        isValid: false,
        errors: [
          error instanceof Error ? error.message : "Invalid session duration",
        ],
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
