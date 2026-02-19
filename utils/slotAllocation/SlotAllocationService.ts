/**
 * Slot Allocation Service
 *
 * Unified allocation algorithms for all event types.
 * Handles auto, manual, and requested slot allocation.
 */

import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  Prisma,
  RequestStatus,
  ScheduleType,
} from "@prisma/client";
import { addWeeks, addMonths } from "date-fns";
import {
  AllocationRequest,
  AllocationResult,
  EventType,
  PrismaTransaction,
  ConsultantAllocationData,
  EventConfig,
} from "./types";
import { SlotCalculationService } from "./SlotCalculationService";
import { SlotValidationService } from "./SlotValidationService";
import { buildOccupiedAppointmentFilter } from "./occupancyPolicy";

/**
 * Main service for slot allocation operations
 */
export class SlotAllocationService {
  /**
   * Main entry point for slot allocation
   * Routes to appropriate allocation method based on mode
   */
  static async allocate(request: AllocationRequest): Promise<AllocationResult> {
    try {
      switch (request.mode) {
        case "auto":
          return await this.autoAllocate(request.eventType, request.eventId);

        case "manual":
          if (!request.slots || request.slots.length === 0) {
            return {
              success: false,
              error: "Slots are required for manual allocation",
            };
          }
          return await this.manualAllocate(
            request.eventType,
            request.eventId,
            request.slots,
          );

        case "requested":
          return await this.useRequestedSlots(
            request.eventType,
            request.eventId,
          );

        default:
          return {
            success: false,
            error: `Invalid allocation mode: ${request.mode}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Allocation failed",
      };
    }
  }

  /**
   * AUTO ALLOCATION: Find and allocate first available consecutive slots
   */
  private static async autoAllocate(
    eventType: EventType,
    eventId: string,
  ): Promise<AllocationResult> {
    return await prisma.$transaction(
      async (tx) => {
        // Fetch event details and consultant info
        const eventData = await this.fetchEventData(tx, eventType, eventId);
        if (!eventData) {
          throw new Error(`${eventType} not found`);
        }

        const { consultant, config, consulteeUserId } = eventData;

        // CRITICAL FIX: Check for existing appointments to detect reschedule scenario
        // If tentative slots exist, this is a reschedule and we should preserve the original slot count
        const relationField = this.getEventRelationField(eventType);
        const existingAppointments = await tx.appointment.findMany({
          where: {
            [`${relationField}Id`]: eventId,
          } as Prisma.AppointmentWhereInput,
          include: { slotsOfAppointment: true },
        });

        // Count existing slots by tentative status
        const existingNonTentativeSlotCount = existingAppointments.reduce(
          (count, appointment) =>
            count +
            appointment.slotsOfAppointment.filter((slot) => !slot.isTentative)
              .length,
          0,
        );
        const tentativeSlotCount = existingAppointments.reduce(
          (count, appointment) =>
            count +
            appointment.slotsOfAppointment.filter((slot) => slot.isTentative)
              .length,
          0,
        );
        const isReschedule = tentativeSlotCount > 0;

        // Collect tentative appointment IDs for exclusion from conflict detection
        // During reschedule, the tentative slots will be deleted, so they should not
        // block availability or count toward weekly limits.
        const tentativeAppointmentIds = isReschedule
          ? existingAppointments
              .filter((a) =>
                a.slotsOfAppointment.some((s) => s.isTentative),
              )
              .map((a) => a.id)
          : [];

        // Calculate required slots - for reschedule, only replace tentative slots
        let requiredSlots: number;
        if (isReschedule) {
          // RESCHEDULE: Only find replacement slots for the tentative ones.
          // For full reschedule (all tentative): requiredSlots = all slots
          // For partial reschedule (some tentative): requiredSlots = tentative count only
          requiredSlots = tentativeSlotCount;
        } else {
          // INITIAL ALLOCATION: Calculate from config
          requiredSlots = SlotCalculationService.calculateRequiredSlots(
            eventType,
            config,
          );
        }

        const slotsPerCall = SlotCalculationService.getSlotsPerCall(
          config.sessionDurationInHours || config.durationInHours || 1,
        );

        // Find available slots
        // Pass tentativeAppointmentIds so their slots are excluded from bookedSlots
        const selectedSlots = await this.findAvailableSlots(
          tx,
          consultant,
          requiredSlots,
          slotsPerCall,
          eventType,
          config,
          tentativeAppointmentIds,
        );

        // Validate
        // Pass tentativeAppointmentIds so their slots don't trigger false conflicts
        const validator = new SlotValidationService(tx);
        const validation = await validator.validate(
          eventType,
          eventId,
          selectedSlots,
          consultant,
          config,
          tentativeAppointmentIds,
        );

        if (!validation.isValid) {
          throw new Error(`Validation failed: ${validation.errors.join("; ")}`);
        }

        // CRITICAL FIX: Delete existing appointments before creating new ones
        // For reschedules: only delete appointments with tentative slots (preserve confirmed ones)
        // For initial allocation: delete all (shouldn't be any, but safety measure)
        await this.deleteExistingAppointments(
          tx,
          eventType,
          eventId,
          isReschedule,
        );

        // Create appointments
        const appointments = await this.createAppointments(
          tx,
          eventType,
          eventId,
          selectedSlots,
          consultant.userId,
          consulteeUserId,
          config,
        );

        // Update event status
        await this.updateEventStatus(
          tx,
          eventType,
          eventId,
          selectedSlots[0],
          config,
        );

        return {
          success: true,
          appointments,
          warnings: validation.warnings,
        };
      },
      {
        timeout: 120000, // 120 seconds (2 min) - handles large allocations (200+ slots)
      },
    );
  }

  /**
   * MANUAL ALLOCATION: Validate and allocate user-selected slots
   *
   * IMPORTANT: This method allows consultants to manually select specific slots
   * for appointments, bypassing the auto-allocation algorithm.
   *
   * VALIDATION REQUIREMENTS:
   * 1. Slot count must be exact multiple of session duration
   *    - Example: 2.5-hour session needs 5 slots (5 × 30min)
   *    - Providing 7 slots creates incomplete appointment → rejected
   *
   * 2. All slots must pass universal validation:
   *    - In the future (not past dates)
   *    - Match consultant's availability schedule
   *    - No conflicts with existing appointments
   *
   * 3. Event-specific rules apply:
   *    - Consultations: All slots same day, consecutive
   *    - Subscriptions: Weekly limits enforced
   *    - Webinars: Consecutive slots required
   *    - Classes: Session grouping validated
   */
  private static async manualAllocate(
    eventType: EventType,
    eventId: string,
    slotStrings: string[],
  ): Promise<AllocationResult> {
    return await prisma.$transaction(
      async (tx) => {
        // Fetch event details
        const eventData = await this.fetchEventData(tx, eventType, eventId);
        if (!eventData) {
          throw new Error(`${eventType} not found`);
        }

        const { consultant, config, consulteeUserId } = eventData;

        // Convert to Date objects with validation
        const slots = slotStrings.map((s, i) => {
          const date = new Date(s);
          if (isNaN(date.getTime())) {
            throw new Error(
              `Invalid date string at position ${i + 1}: "${s}". ` +
                `Expected ISO 8601 format (e.g., "2026-03-01T09:00:00.000Z").`,
            );
          }
          return date;
        });

        // FIX: Detect and reject duplicate slots
        // Duplicates can cause validation errors, inflated counts, and DB anomalies
        const uniqueSlots = Array.from(
          new Map(slots.map((s) => [s.toISOString(), s])).values(),
        );

        if (uniqueSlots.length !== slots.length) {
          throw new Error(
            `Duplicate slots detected: ${slots.length} slots provided but only ` +
            `${uniqueSlots.length} are unique. Each slot can only be selected once.`,
          );
        }

        // Sort slots chronologically to ensure correct grouping into appointments
        // and correct schedulingPeriodStartsAt derivation from slots[0]
        slots.sort((a, b) => a.getTime() - b.getTime());

        // CRITICAL FIX: Validate slot count matches session duration requirements
        // This prevents incomplete appointments from being created
        const slotsPerCall = SlotCalculationService.getSlotsPerCall(
          config.sessionDurationInHours || config.durationInHours || 1,
        );

        if (slots.length % slotsPerCall !== 0) {
          const sessionDuration =
            config.sessionDurationInHours || config.durationInHours || 1;
          throw new Error(
            `Invalid slot count: ${slots.length} slots provided, but ${sessionDuration}-hour ` +
            `sessions require multiples of ${slotsPerCall} slots (30 minutes each). ` +
            `Valid counts: ${slotsPerCall}, ${slotsPerCall * 2}, ${slotsPerCall * 3}, etc.`,
          );
        }

        // Detect reschedule scenario: check for existing tentative slots
        const relationField = this.getEventRelationField(eventType);
        const existingAppointments = await tx.appointment.findMany({
          where: {
            [`${relationField}Id`]: eventId,
          } as Prisma.AppointmentWhereInput,
          include: { slotsOfAppointment: true },
        });

        const tentativeSlotCount = existingAppointments.reduce(
          (count, appointment) =>
            count +
            appointment.slotsOfAppointment.filter((slot) => slot.isTentative)
              .length,
          0,
        );
        const isReschedule = tentativeSlotCount > 0;

        // Collect tentative appointment IDs for exclusion from conflict detection
        const tentativeAppointmentIds = isReschedule
          ? existingAppointments
              .filter((a) =>
                a.slotsOfAppointment.some((s) => s.isTentative),
              )
              .map((a) => a.id)
          : [];

        // Validate total slot count for recurring event types
        // For reschedule: only require replacement slots for tentative count
        // For initial allocation: require full plan slot count
        if (eventType === "subscription" || eventType === "class") {
          if (isReschedule) {
            if (slots.length !== tentativeSlotCount) {
              throw new Error(
                `This reschedule requires exactly ${tentativeSlotCount} slots ` +
                `(replacing ${tentativeSlotCount} tentative slots), ` +
                `but ${slots.length} were provided.`,
              );
            }
          } else if (config.schedulingPeriodStartsAt && config.schedulingPeriodEndsAt) {
            const requiredSlots =
              SlotCalculationService.calculateRequiredSlots(eventType, config);
            if (slots.length !== requiredSlots) {
              throw new Error(
                `This ${eventType} requires exactly ${requiredSlots} slots ` +
                `(based on the scheduling period and session configuration), ` +
                `but ${slots.length} were provided.`,
              );
            }
          }
        }

        // Validate
        // Pass tentativeAppointmentIds so their slots don't trigger false conflicts
        const validator = new SlotValidationService(tx);
        const validation = await validator.validate(
          eventType,
          eventId,
          slots,
          consultant,
          config,
          tentativeAppointmentIds,
        );

        if (!validation.isValid) {
          throw new Error(`Validation failed: ${validation.errors.join("; ")}`);
        }

        // Delete existing appointments
        // For reschedules: only delete tentative slots (preserve confirmed ones)
        // For initial allocation: delete all
        await this.deleteExistingAppointments(tx, eventType, eventId, isReschedule);

        // Create appointments
        const appointments = await this.createAppointments(
          tx,
          eventType,
          eventId,
          slots,
          consultant.userId,
          consulteeUserId,
          config,
        );

        // Update event status
        await this.updateEventStatus(tx, eventType, eventId, slots[0], config);

        return {
          success: true,
          appointments,
          warnings: validation.warnings,
        };
      },
      {
        timeout: 120000, // 120 seconds (2 min) - handles large allocations (200+ slots)
      },
    );
  }

  /**
   * REQUESTED SLOTS: Use pre-selected slots from consultee
   *
   * WORKFLOW:
   * 1. Consultee submits consultation/subscription request with preferred time slots
   * 2. System creates tentative appointments with those slots
   * 3. Consultant reviews and clicks "Use Requested Slots"
   * 4. This method validates and approves those pre-created appointments
   *
   * CRITICAL VERIFICATION:
   * We must verify appointments were actually created by the consultee.
   * Without this check, a consultant could approve a request that has
   * no appointments, resulting in an APPROVED status with no bookings.
   *
   * POSSIBLE FAILURE SCENARIOS:
   * - Consultee abandoned request before creating appointments
   * - Appointments were deleted by another process
   * - Database transaction failed partially
   * - Frontend didn't submit appointments correctly
   */
  private static async useRequestedSlots(
    eventType: EventType,
    eventId: string,
  ): Promise<AllocationResult> {
    return await prisma.$transaction(
      async (tx) => {
        // Fetch event with requested slots
        const eventData = await this.fetchEventData(tx, eventType, eventId);
        if (!eventData) {
          throw new Error(`${eventType} not found`);
        }

        const { consultant, config, requestedSlots } = eventData;

        if (!requestedSlots || requestedSlots.length === 0) {
          throw new Error("No requested slots found");
        }

        // CRITICAL FIX: Verify appointments actually exist before approving
        // This prevents approving requests with no actual bookings
        const relationField = this.getEventRelationField(eventType);
        const existingAppointments = await tx.appointment.findMany({
          where: {
            [`${relationField}Id`]: eventId,
          } as Prisma.AppointmentWhereInput,
          include: { slotsOfAppointment: true },
        });

        if (existingAppointments.length === 0) {
          throw new Error(
            "Cannot approve requested slots: No appointments found. " +
            "The consultee may not have created appointments yet, or they were deleted. " +
            "Please ask the consultee to resubmit their request.",
          );
        }

        // Verify appointment slots match requested slots
        const existingSlotCount = existingAppointments.reduce(
          (sum, appointment) => sum + appointment.slotsOfAppointment.length,
          0,
        );

        if (existingSlotCount !== requestedSlots.length) {
          throw new Error(
            `Appointment mismatch: Found ${existingSlotCount} slots in appointments ` +
            `but ${requestedSlots.length} requested slots. ` +
            `The appointments may have been modified. Please review and try again.`,
          );
        }

        // Validate requested slots still meet all requirements.
        // Pass existing appointment IDs so the event's own tentative slots
        // are not flagged as conflicts during self-validation.
        const validator = new SlotValidationService(tx);
        const existingAppointmentIds = existingAppointments.map((a) => a.id);
        const validation = await validator.validate(
          eventType,
          eventId,
          requestedSlots,
          consultant,
          config,
          existingAppointmentIds,
        );

        if (!validation.isValid) {
          throw new Error(`Validation failed: ${validation.errors.join("; ")}`);
        }

        // Update event status to approved (appointments already exist and verified)
        await this.updateEventStatus(
          tx,
          eventType,
          eventId,
          requestedSlots[0],
          config,
        );

        // CRITICAL FIX: Clear isTentative flag on all slots after approval
        // This ensures slots are no longer marked as pending reschedule
        const appointmentIds = existingAppointments.map(
          (appointment) => appointment.id,
        );
        await tx.slotOfAppointment.updateMany({
          where: {
            appointmentId: { in: appointmentIds },
          },
          data: { isTentative: false },
        });

        return {
          success: true,
          appointments: existingAppointments,
          warnings: validation.warnings,
        };
      },
      {
        timeout: 120000, // 120 seconds (2 min) - handles large allocations (200+ slots)
      },
    );
  }

  /**
   * Check if a 30-minute candidate slot falls within the consultant's availability.
   * Replaces the pre-computed availableSlotsSet to eliminate the 8-week cap.
   */
  private static isWithinAvailability(
    candidate: Date,
    consultant: ConsultantAllocationData,
  ): boolean {
    if (consultant.scheduleType === ScheduleType.WEEKLY) {
      return consultant.slotsOfAvailabilityWeekly.some((slot) => {
        const slotStart = new Date(slot.availabilityStartsAt);
        const slotEnd = new Date(slot.availabilityEndsAt);

        // Must match day of week (UTC)
        if (candidate.getUTCDay() !== slotStart.getUTCDay()) return false;

        // Candidate time must be within [slotStart time, slotEnd time) in UTC
        const candidateMinutes =
          candidate.getUTCHours() * 60 + candidate.getUTCMinutes();
        const startMinutes =
          slotStart.getUTCHours() * 60 + slotStart.getUTCMinutes();
        const endMinutes =
          slotEnd.getUTCHours() * 60 + slotEnd.getUTCMinutes();

        return candidateMinutes >= startMinutes && candidateMinutes < endMinutes;
      });
    } else {
      // CUSTOM schedule: candidate must fall within a specific date range
      const thirtyMinMs = 30 * 60 * 1000;
      return consultant.slotsOfAvailabilityCustom.some((slot) => {
        const slotStart = new Date(slot.availabilityStartsAt);
        const slotEnd = new Date(slot.availabilityEndsAt);

        return (
          candidate >= slotStart &&
          candidate.getTime() + thirtyMinMs <= slotEnd.getTime()
        );
      });
    }
  }

  /**
   * Find available consecutive slots for auto-allocation
   */
  private static async findAvailableSlots(
    tx: PrismaTransaction,
    consultant: ConsultantAllocationData,
    totalSlotsNeeded: number,
    slotsPerCall: number,
    eventType: EventType,
    config: EventConfig,
    excludeAppointmentIds: string[] = [],
  ): Promise<Date[]> {
    // Get all existing booked slots for this consultant
    // FIX Bug #15: Use centralized occupancy policy for consistent conflict detection
    const appointmentFilter: Prisma.AppointmentWhereInput[] = [
      {
        OR: buildOccupiedAppointmentFilter(),
      },
      {
        slotsOfAppointment: {
          some: {
            user: {
              some: { id: consultant.userId },
            },
          },
        },
      },
    ];

    // Exclude tentative appointments during reschedule — they'll be deleted,
    // so their slots should not block availability or count toward weekly limits.
    if (excludeAppointmentIds.length > 0) {
      appointmentFilter.push({
        NOT: { id: { in: excludeAppointmentIds } },
      });
    }

    const existingAppointments = await tx.appointment.findMany({
      where: {
        AND: appointmentFilter,
      },
      include: {
        slotsOfAppointment: true,
      },
    });

    const bookedSlots = new Set(
      existingAppointments.flatMap((appointment) =>
        appointment.slotsOfAppointment.map((slot) =>
          new Date(slot.startsAt).toISOString(),
        ),
      ),
    );

    // Get consultant's available time slots
    const availableTimeSlots =
      consultant.scheduleType === ScheduleType.WEEKLY
        ? consultant.slotsOfAvailabilityWeekly
        : consultant.slotsOfAvailabilityCustom;

    if (!availableTimeSlots.length) {
      throw new Error("No availability slots configured for consultant");
    }

    // Sort by UTC time of day to prioritize earlier slots
    const sortedSlots = [...availableTimeSlots].sort((a, b) => {
      const timeA =
        new Date(a.availabilityStartsAt).getUTCHours() * 60 +
        new Date(a.availabilityStartsAt).getUTCMinutes();
      const timeB =
        new Date(b.availabilityStartsAt).getUTCHours() * 60 +
        new Date(b.availabilityStartsAt).getUTCMinutes();
      return timeA - timeB;
    });

    const now = new Date();
    const selectedSlots: Date[] = [];

    // For consultations/webinars: find one consecutive block, searching multiple weeks
    if (eventType === "consultation" || eventType === "webinar") {
      const maxWeeksToSearch = eventType === "consultation" ? 8 : 4;

      if (consultant.scheduleType === ScheduleType.WEEKLY) {
        for (let week = 0; week < maxWeeksToSearch; week++) {
          for (const slot of sortedSlots) {
            const baseStart = this.getNextOccurrence(
              slot.availabilityStartsAt,
              consultant.scheduleType,
            );

            const candidateStart = new Date(baseStart);
            if (week > 0) {
              candidateStart.setUTCDate(
                candidateStart.getUTCDate() + week * 7,
              );
            }

            if (
              candidateStart < now ||
              bookedSlots.has(candidateStart.toISOString())
            ) {
              continue;
            }

            // Try to build consecutive block
            const consecutiveBlock: Date[] = [];
            let currentTime = new Date(candidateStart);

            for (let i = 0; i < slotsPerCall; i++) {
              const currentTimeStr = currentTime.toISOString();

              if (
                bookedSlots.has(currentTimeStr) ||
                !this.isWithinAvailability(currentTime, consultant) ||
                currentTime < now
              ) {
                break;
              }
              consecutiveBlock.push(new Date(currentTime));
              currentTime = new Date(currentTime.getTime() + 30 * 60 * 1000);
            }

            if (consecutiveBlock.length === slotsPerCall) {
              return consecutiveBlock;
            }
          }
        }
      } else {
        // CUSTOM schedule: iterate all available slots directly
        for (const slot of sortedSlots) {
          const slotStart = new Date(slot.availabilityStartsAt);

          if (slotStart < now || bookedSlots.has(slotStart.toISOString())) {
            continue;
          }

          const consecutiveBlock: Date[] = [];
          let currentTime = new Date(slotStart);

          for (let i = 0; i < slotsPerCall; i++) {
            const currentTimeStr = currentTime.toISOString();

            if (
              bookedSlots.has(currentTimeStr) ||
              !this.isWithinAvailability(currentTime, consultant) ||
              currentTime < now
            ) {
              break;
            }
            consecutiveBlock.push(new Date(currentTime));
            currentTime = new Date(currentTime.getTime() + 30 * 60 * 1000);
          }

          if (consecutiveBlock.length === slotsPerCall) {
            return consecutiveBlock;
          }
        }
      }

      throw new Error(
        `No ${slotsPerCall} consecutive slots available for ${eventType}`,
      );
    }

    // For subscriptions/classes: find distributed slots across weeks
    const startDate = config.schedulingPeriodStartsAt || new Date();
    const endDate =
      config.schedulingPeriodEndsAt ||
      addMonths(startDate, config.durationInMonths || 1);
    const callsPerWeek = config.callsPerWeek || 1;

    // Build a map of existing confirmed calls per week.
    // During partial reschedule, weeks with confirmed appointments already
    // have calls that must count toward the weekly limit.
    const existingCallsPerWeek = new Map<string, number>();
    for (const apt of existingAppointments) {
      if (apt.slotsOfAppointment.length === 0) continue;
      const firstSlot = apt.slotsOfAppointment.reduce((earliest, s) =>
        new Date(s.startsAt) < new Date(earliest.startsAt) ? s : earliest,
      );
      const weekStart = SlotCalculationService.startOfWeekSunday(
        new Date(firstSlot.startsAt),
      );
      const weekKey = weekStart.toISOString();
      existingCallsPerWeek.set(
        weekKey,
        (existingCallsPerWeek.get(weekKey) || 0) + 1,
      );
    }

    let currentWeek = SlotCalculationService.startOfWeekSunday(startDate);
    const totalWeeks = SlotCalculationService.countWeeks(startDate, endDate);

    for (
      let week = 0;
      week < totalWeeks && selectedSlots.length < totalSlotsNeeded;
      week++
    ) {
      // Initialize with existing confirmed calls (important during partial reschedule)
      const weekKey = currentWeek.toISOString();
      let callsThisWeek = existingCallsPerWeek.get(weekKey) || 0;

      for (let day = 0; day < 7 && callsThisWeek < callsPerWeek; day++) {
        const currentDay = new Date(currentWeek);
        currentDay.setUTCDate(currentDay.getUTCDate() + day);

        // Find first available slot on this day
        for (const slot of sortedSlots) {
          const slotTime = this.matchSlotToDay(
            slot.availabilityStartsAt,
            currentDay,
            consultant.scheduleType,
          );

          if (
            !slotTime ||
            slotTime < now ||
            slotTime < startDate ||
            slotTime > endDate
          ) {
            continue;
          }

          // Try to build consecutive block for this call
          const callSlots: Date[] = [];
          let currentTime = new Date(slotTime);

          for (let i = 0; i < slotsPerCall; i++) {
            const currentTimeStr = currentTime.toISOString();
            if (
              bookedSlots.has(currentTimeStr) ||
              !this.isWithinAvailability(currentTime, consultant) ||
              currentTime < now
            ) {
              break;
            }
            callSlots.push(new Date(currentTime));
            currentTime = new Date(currentTime.getTime() + 30 * 60 * 1000);
          }

          if (callSlots.length === slotsPerCall) {
            selectedSlots.push(...callSlots);
            callSlots.forEach((s) => bookedSlots.add(s.toISOString()));
            callsThisWeek++;
            break; // Found slot for this day, move to next day
          }
        }
      }

      currentWeek = addWeeks(currentWeek, 1);
    }

    if (selectedSlots.length < totalSlotsNeeded) {
      throw new Error(
        `Could only find ${selectedSlots.length} of ${totalSlotsNeeded} required slots`,
      );
    }

    return selectedSlots.sort((a, b) => a.getTime() - b.getTime());
  }

  /**
   * Get next occurrence of a weekly slot starting from now
   *
   * FIX: Ensure returned slot matches the exact day-of-week, hour, and minute
   * pattern from the consultant's weekly schedule.
   */
  private static getNextOccurrence(slotTime: Date, scheduleType: string): Date {
    if (scheduleType === ScheduleType.CUSTOM) {
      return new Date(slotTime);
    }

    const now = new Date();
    const slotDate = new Date(slotTime);
    const targetDay = slotDate.getUTCDay(); // Use UTC day to match validation
    const targetHours = slotDate.getUTCHours();
    const targetMinutes = slotDate.getUTCMinutes();
    const currentDay = now.getUTCDay();

    // Calculate days until next occurrence
    let daysToAdd = targetDay - currentDay;
    if (daysToAdd < 0) {
      daysToAdd += 7; // Next week
    } else if (daysToAdd === 0) {
      // Same day - check if time has passed
      const nowHours = now.getUTCHours();
      const nowMinutes = now.getUTCMinutes();
      if (
        nowHours > targetHours ||
        (nowHours === targetHours && nowMinutes >= targetMinutes)
      ) {
        daysToAdd = 7; // Next week
      }
    }

    const nextOccurrence = new Date(now);
    nextOccurrence.setUTCDate(now.getUTCDate() + daysToAdd);
    nextOccurrence.setUTCHours(targetHours, targetMinutes, 0, 0);

    return nextOccurrence;
  }

  /**
   * Match a weekly slot pattern to a specific day
   *
   * FIX: Use UTC methods consistently to match validation logic
   */
  private static matchSlotToDay(
    slotTime: Date,
    targetDay: Date,
    scheduleType: string,
  ): Date | null {
    if (scheduleType === ScheduleType.CUSTOM) {
      // Only match if exact same day (use UTC for consistency)
      const slotDate = new Date(slotTime);
      const slotDateStr = `${slotDate.getUTCFullYear()}-${slotDate.getUTCMonth()}-${slotDate.getUTCDate()}`;
      const targetDateStr = `${targetDay.getUTCFullYear()}-${targetDay.getUTCMonth()}-${targetDay.getUTCDate()}`;

      if (slotDateStr === targetDateStr) {
        return new Date(slotTime);
      }
      return null;
    }

    // Weekly: match day of week using UTC
    const slotDate = new Date(slotTime);
    const slotDayOfWeek = slotDate.getUTCDay();
    const targetDayOfWeek = targetDay.getUTCDay();

    if (slotDayOfWeek === targetDayOfWeek) {
      const result = new Date(targetDay);
      result.setUTCHours(
        slotDate.getUTCHours(),
        slotDate.getUTCMinutes(),
        0,
        0,
      );
      return result;
    }

    return null;
  }

  /**
   * Create appointment records for allocated slots
   *
   * ARCHITECTURE:
   * - One Appointment = One call/session
   * - Each Appointment contains multiple SlotOfAppointment records
   * - Number of slots per appointment = session duration / 30 minutes
   *
   * EXAMPLE: 2.5-hour subscription call
   * - Creates 1 Appointment record
   * - With 5 SlotOfAppointment records (2.5h ÷ 0.5h = 5 slots)
   * - Each slot: [startTime, startTime + 30min]
   *
   * DEFENSIVE VALIDATION:
   * This is a defensive check - slot count should already be validated
   * by the caller, but we verify again to prevent data corruption.
   */
  private static async createAppointments(
    tx: PrismaTransaction,
    eventType: EventType,
    eventId: string,
    slots: Date[],
    consultantUserId: string,
    consulteeUserId?: string,
    config?: EventConfig,
  ): Promise<any[]> {
    const slotsPerCall = SlotCalculationService.getSlotsPerCall(
      config?.sessionDurationInHours || config?.durationInHours || 1,
    );

    // DEFENSIVE CHECK: Ensure slots divide evenly into complete appointments
    // This should never fail if validation was done correctly, but prevents
    // database corruption if validation was bypassed
    if (slots.length % slotsPerCall !== 0) {
      throw new Error(
        `INTERNAL ERROR: Cannot create appointments - ${slots.length} slots ` +
        `cannot be evenly divided into ${slotsPerCall}-slot sessions. ` +
        `This indicates a validation bug.`,
      );
    }

    // Group slots by call (consecutive blocks)
    const calls: Date[][] = [];
    for (let i = 0; i < slots.length; i += slotsPerCall) {
      calls.push(slots.slice(i, i + slotsPerCall));
    }

    // CRITICAL: For consultations/webinars, ensure only ONE appointment is created
    if (
      (eventType === "consultation" || eventType === "webinar") &&
      calls.length > 1
    ) {
      throw new Error(
        `INTERNAL ERROR: ${eventType} should create exactly 1 appointment, but ${calls.length} were grouped. ` +
        `This indicates non-consecutive slots were provided. Slots: ${slots.map((s) => s.toISOString()).join(", ")}`,
      );
    }

    // Create appointment for each call
    const appointments = await Promise.all(
      calls.map((callSlots) => {
        const slotsToCreate = callSlots.map((slotStart) => {
          const endTime = new Date(slotStart.getTime() + 30 * 60 * 1000);
          return {
            startsAt: slotStart,
            endsAt: endTime,
            isTentative: false,
            user: {
              connect: consulteeUserId
                ? [{ id: consultantUserId }, { id: consulteeUserId }]
                : [{ id: consultantUserId }],
            },
          };
        });

        return tx.appointment.create({
          data: {
            appointmentType: this.getAppointmentType(eventType),
            [this.getEventRelationField(eventType)]: {
              connect: { id: eventId },
            },
            slotsOfAppointment: {
              create: slotsToCreate,
            },
          },
          include: {
            slotsOfAppointment: true,
          },
        });
      }),
    );

    return appointments;
  }

  /**
   * Delete existing appointments for an event
   *
   * @param onlyTentative - If true, only delete tentative SlotOfAppointment records,
   *                        preserving confirmed slots and their parent appointments.
   *                        Appointments are only deleted if they have zero remaining slots
   *                        after tentative slot removal. This is used for partial reschedules.
   */
  private static async deleteExistingAppointments(
    tx: PrismaTransaction,
    eventType: EventType,
    eventId: string,
    onlyTentative: boolean = false,
  ): Promise<void> {
    const relationField = this.getEventRelationField(eventType);
    const whereClause = {
      [`${relationField}Id`]: eventId,
    } as Prisma.AppointmentWhereInput;

    if (onlyTentative) {
      // Find appointments with tentative slots for this event
      const appointments = await tx.appointment.findMany({
        where: whereClause,
        include: { slotsOfAppointment: true },
      });

      for (const appointment of appointments) {
        const tentativeSlots = appointment.slotsOfAppointment.filter(
          (slot) => slot.isTentative,
        );
        const confirmedSlots = appointment.slotsOfAppointment.filter(
          (slot) => !slot.isTentative,
        );

        if (tentativeSlots.length > 0) {
          // Delete only tentative slots, preserving confirmed ones
          await tx.slotOfAppointment.deleteMany({
            where: {
              id: { in: tentativeSlots.map((slot) => slot.id) },
            },
          });

          // If no confirmed slots remain, delete the now-empty appointment
          if (confirmedSlots.length === 0) {
            await tx.appointment.delete({
              where: { id: appointment.id },
            });
          }
        }
      }
    } else {
      // Full delete: remove all appointments for this event
      const existingAppointments = await tx.appointment.findMany({
        where: whereClause,
      });

      await Promise.all(
        existingAppointments.map((appointment) =>
          tx.appointment.delete({ where: { id: appointment.id } }),
        ),
      );
    }
  }

  /**
   * Update event status after allocation
   */
  private static async updateEventStatus(
    tx: PrismaTransaction,
    eventType: EventType,
    eventId: string,
    firstSlot: Date,
    config: EventConfig,
  ): Promise<void> {
    const updates: any = {};

    switch (eventType) {
      case "consultation":
      case "subscription":
        updates.requestStatus = RequestStatus.APPROVED;
        if (eventType === "subscription") {
          // FIX: Only set schedulingPeriod if not already configured
          // This prevents overwriting the user's scheduling period with the first allocated slot
          // which could cause slots to appear outside the intended scheduling window
          if (
            !config.schedulingPeriodStartsAt ||
            !config.schedulingPeriodEndsAt
          ) {
            updates.schedulingPeriodStartsAt = firstSlot;
            updates.schedulingPeriodEndsAt = addMonths(
              firstSlot,
              config.durationInMonths || 1,
            );
          }
        }
        break;

      case "webinar":
        // Webinar model does NOT have startDate/endDate fields
        // Start date is stored in the Appointment's slots
        updates.status = "SCHEDULED";
        break;

      case "class":
        // Class model HAS schedulingPeriod fields
        // FIX Bug #19: Use addMonths instead of addWeeks * 4 for accurate month boundaries
        updates.status = "SCHEDULED";
        updates.schedulingPeriodStartsAt = firstSlot;
        updates.schedulingPeriodEndsAt = addMonths(
          firstSlot,
          config.durationInMonths || 1,
        );
        break;
    }

    // Dynamic model access by eventType requires type assertion — TypeScript can't
    // statically verify tx["consultation"] etc. from a computed string.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tx as any)[eventType].update({
      where: { id: eventId },
      data: updates,
    });
  }

  /**
   * Fetch event data including consultant and config
   */
  private static async fetchEventData(
    tx: PrismaTransaction,
    eventType: EventType,
    eventId: string,
  ): Promise<{
    consultant: ConsultantAllocationData;
    config: EventConfig;
    consulteeUserId?: string;
    requestedSlots?: Date[];
  } | null> {
    const include = this.getEventInclude(eventType);
    // Dynamic model access by eventType — same as updateEventStatus above
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = await (tx as any)[eventType].findUnique({
      where: { id: eventId },
      include,
    });

    if (!event) return null;

    // Extract consultant profile based on event type
    let consultantProfile: any;
    let config: EventConfig;
    let consulteeUserId: string | undefined;
    let requestedSlots: Date[] | undefined;

    switch (eventType) {
      case "consultation":
        consultantProfile = event.consultationPlan?.consultantProfile;
        config = {
          durationInHours: event.consultationPlan?.durationInHours,
        };
        consulteeUserId = event.requestedBy?.user?.id;
        requestedSlots = event.appointment?.slotsOfAppointment?.map(
          (s: any) => new Date(s.startsAt),
        );
        break;

      case "subscription":
        consultantProfile = event.subscriptionPlan?.consultantProfile;
        config = {
          durationInMonths: event.subscriptionPlan?.durationInMonths,
          callsPerWeek: event.subscriptionPlan?.callsPerWeek,
          sessionDurationInHours:
            event.subscriptionPlan?.sessionDurationInHours,
          totalSessions: event.subscriptionPlan?.totalSessions,
          schedulingPeriodStartsAt: event.schedulingPeriodStartsAt,
          schedulingPeriodEndsAt: event.schedulingPeriodEndsAt,
        };
        consulteeUserId = event.requestedBy?.user?.id;
        requestedSlots = event.appointments?.flatMap((app: any) =>
          app.slotsOfAppointment.map((s: any) => new Date(s.startsAt)),
        );
        break;

      case "webinar":
        consultantProfile = event.webinarPlan?.consultantProfile;
        config = {
          durationInHours: event.webinarPlan?.durationInHours,
        };
        break;

      case "class":
        consultantProfile = event.classPlan?.consultantProfile;
        const classContents = event.classPlan?.classContents || [];
        const sessionDuration =
          classContents.length > 0
            ? classContents.reduce(
              (sum: number, c: any) => sum + c.hoursAllotted,
              0,
            ) / classContents.length
            : event.classPlan?.sessionDurationInHours || 1;

        config = {
          durationInMonths: event.classPlan?.durationInMonths,
          callsPerWeek: event.classPlan?.meetingsPerWeek,
          sessionDurationInHours: sessionDuration,
          totalSessions: event.classPlan?.totalSessions,
          schedulingPeriodStartsAt: event.schedulingPeriodStartsAt,
          schedulingPeriodEndsAt: event.schedulingPeriodEndsAt,
        };
        break;
    }

    if (!consultantProfile) {
      throw new Error("Consultant profile not found");
    }

    // FIX: Validate date ordering for events with scheduling periods
    // This prevents bugs in auto-allocation and week calculation
    if (config.schedulingPeriodStartsAt && config.schedulingPeriodEndsAt) {
      if (config.schedulingPeriodStartsAt >= config.schedulingPeriodEndsAt) {
        throw new Error(
          `Invalid date range: schedulingPeriodStartsAt (${config.schedulingPeriodStartsAt.toISOString()}) ` +
          `must be before schedulingPeriodEndsAt (${config.schedulingPeriodEndsAt.toISOString()}). ` +
          `Please check the ${eventType} configuration.`,
        );
      }
    }

    return {
      consultant: {
        userId: consultantProfile.user.id,
        scheduleType: consultantProfile.scheduleType,
        slotsOfAvailabilityWeekly: consultantProfile.slotsOfAvailabilityWeekly,
        slotsOfAvailabilityCustom: consultantProfile.slotsOfAvailabilityCustom,
        timezone: consultantProfile.user.timezone,
      },
      config,
      consulteeUserId,
      requestedSlots,
    };
  }

  /**
   * Get Prisma appointment type enum
   */
  private static getAppointmentType(eventType: EventType): AppointmentsType {
    const map: Record<EventType, AppointmentsType> = {
      consultation: AppointmentsType.CONSULTATION,
      subscription: AppointmentsType.SUBSCRIPTION,
      webinar: AppointmentsType.WEBINAR,
      class: AppointmentsType.CLASS,
    };
    return map[eventType];
  }

  /**
   * Get event relation field name for Prisma
   */
  private static getEventRelationField(eventType: EventType): string {
    return eventType;
  }

  /**
   * Get Prisma include object for event fetching
   */
  private static getEventInclude(eventType: EventType): any {
    const baseInclude = {
      consultantProfile: {
        select: {
          user: true,
          scheduleType: true,
          slotsOfAvailabilityWeekly: true,
          slotsOfAvailabilityCustom: true,
        },
      },
    };

    switch (eventType) {
      case "consultation":
        return {
          consultationPlan: { include: baseInclude },
          requestedBy: { include: { user: true } },
          appointment: { include: { slotsOfAppointment: true } },
        };

      case "subscription":
        return {
          subscriptionPlan: { include: baseInclude },
          requestedBy: { include: { user: true } },
          appointments: { include: { slotsOfAppointment: true } },
        };

      case "webinar":
        return {
          webinarPlan: { include: baseInclude },
        };

      case "class":
        return {
          classPlan: {
            include: {
              ...baseInclude,
              classContents: true,
            },
          },
          appointments: { include: { slotsOfAppointment: true } },
        };
    }
  }
}
