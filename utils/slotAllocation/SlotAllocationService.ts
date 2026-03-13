/**
 * Slot Allocation Service
 *
 * Unified allocation algorithms for all event types.
 * Handles auto, manual, and requested slot allocation.
 */

import prisma from "@/lib/prisma";
import {
  Appointment,
  AppointmentsType,
  Prisma,
  RequestStatus,
  ScheduleType,
  SlotOfAppointment,
} from "@prisma/client";
import { addWeeks, addMonths } from "date-fns";
import {
  AllocationErrorCode,
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
import { lockAutoAllocate, unlockAutoAllocate } from "@/utils/appointmentlock";
import {
  DAY_OF_WEEK_TO_INDEX,
  isMinuteWithinWeeklySlot,
  TWENTY_FOUR_HOURS_IN_MS,
} from "./slotTimeUtils";
import {
  AllocationValidationError,
  AllocationNotFoundError,
  AllocationConflictError,
} from "./errors";

type AppointmentWithSlots = Appointment & {
  slotsOfAppointment: SlotOfAppointment[];
};

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
              errorCode: "VALIDATION_ERROR",
              httpStatus: 400,
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
            errorCode: "INVALID_MODE",
            httpStatus: 400,
          };
      }
    } catch (error) {
      const { errorCode, httpStatus } = this.classifyError(error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Allocation failed",
        errorCode,
        httpStatus,
      };
    }
  }

  /**
   * Classifies an unknown error into a structured error code and HTTP status.
   * Called from the allocate() catch block to avoid string-prefix checks in routes.
   */
  private static classifyError(error: unknown): {
    errorCode: AllocationErrorCode;
    httpStatus: number;
  } {
    // Typed error classes — primary classification mechanism
    if (error instanceof AllocationValidationError) {
      return { errorCode: error.errorCode, httpStatus: error.httpStatus };
    }
    if (error instanceof AllocationNotFoundError) {
      return { errorCode: error.errorCode, httpStatus: error.httpStatus };
    }
    if (error instanceof AllocationConflictError) {
      return { errorCode: error.errorCode, httpStatus: error.httpStatus };
    }

    // Prisma unique constraint violation (P2002) — concurrent duplicate booking race
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return { errorCode: "LOCK_CONTENTION", httpStatus: 409 };
    }

    // Fallback: string matching for errors thrown by dependencies or legacy code paths
    const msg = error instanceof Error ? error.message : "";
    if (
      msg.includes("lock") ||
      msg.includes("Lock") ||
      msg.includes("in progress")
    ) {
      return { errorCode: "LOCK_CONTENTION", httpStatus: 409 };
    }
    if (msg.includes("not found") || msg.includes("no consultant")) {
      return { errorCode: "NOT_FOUND", httpStatus: 400 };
    }
    return { errorCode: "UNKNOWN_ERROR", httpStatus: 500 };
  }

  /**
   * Lightweight pre-fetch to get consultantProfileId for lock acquisition.
   * Runs OUTSIDE the transaction, before the distributed lock is acquired.
   *
   * FIX Issue #1 from Architecture Review (#446):
   * autoAllocate() needs a consultant-level lock to prevent concurrent
   * auto-allocations from double-booking the same slots.
   */
  private static async getConsultantProfileId(
    eventType: EventType,
    eventId: string,
  ): Promise<string | null> {
    switch (eventType) {
      case "consultation": {
        const event = await prisma.consultation.findUnique({
          where: { id: eventId },
          select: {
            consultationPlan: { select: { consultantProfileId: true } },
          },
        });
        return event?.consultationPlan?.consultantProfileId ?? null;
      }
      case "subscription": {
        const event = await prisma.subscription.findUnique({
          where: { id: eventId },
          select: {
            subscriptionPlan: { select: { consultantProfileId: true } },
          },
        });
        return event?.subscriptionPlan?.consultantProfileId ?? null;
      }
      case "webinar": {
        const event = await prisma.webinar.findUnique({
          where: { id: eventId },
          select: {
            webinarPlan: { select: { consultantProfileId: true } },
          },
        });
        return event?.webinarPlan?.consultantProfileId ?? null;
      }
      case "class": {
        const event = await prisma.class.findUnique({
          where: { id: eventId },
          select: { classPlan: { select: { consultantProfileId: true } } },
        });
        return event?.classPlan?.consultantProfileId ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * AUTO ALLOCATION: Find and allocate first available consecutive slots
   *
   * FIX Issue #1 from Architecture Review (#446):
   * Wrapped in a consultant-level distributed lock to prevent concurrent
   * auto-allocations from reading the same slots as "available" and
   * double-booking. The lock is acquired BEFORE the Prisma transaction
   * and released in a finally block to guarantee cleanup.
   */
  private static async autoAllocate(
    eventType: EventType,
    eventId: string,
  ): Promise<AllocationResult> {
    // Pre-fetch consultantProfileId for lock key (lightweight, outside transaction)
    const consultantProfileId = await this.getConsultantProfileId(
      eventType,
      eventId,
    );
    if (!consultantProfileId) {
      return {
        success: false,
        error: `${eventType} not found or has no consultant`,
        errorCode: "NOT_FOUND",
        httpStatus: 400,
      };
    }

    // Acquire consultant-level distributed lock before the transaction
    const lock = await lockAutoAllocate(consultantProfileId);
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Fetch event details and consultant info
          const eventData = await this.fetchEventData(tx, eventType, eventId);
          if (!eventData) {
            throw new AllocationNotFoundError(`${eventType} not found`);
          }

          const { consultant, config, consulteeUserId } = eventData;

          // CRITICAL FIX: Check for existing appointments to detect reschedule scenario
          // If tentative slots exist, this is a reschedule and we should preserve the original slot count
          const relationField = this.getEventRelationField(eventType);
          const existingAppointments: AppointmentWithSlots[] =
            await tx.appointment.findMany({
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

          // Detect in-progress reallocation: past confirmed slots exist for recurring events
          const now = new Date();
          const pastConfirmedSlotCount = isReschedule
            ? 0
            : existingAppointments.reduce(
                (count, appt) =>
                  count +
                  appt.slotsOfAppointment.filter(
                    (slot) => !slot.isTentative && new Date(slot.endsAt) <= now,
                  ).length,
                0,
              );
          const isInProgressReallocation =
            !isReschedule &&
            pastConfirmedSlotCount > 0 &&
            (eventType === "class" || eventType === "subscription");

          // Guard: for classes/subscriptions, reject re-allocation when already fully scheduled.
          // Webinars are handled by the DB unique constraint on webinarId (P2002 → 409).
          // Classes/subscriptions have no such constraint, so we enforce it here to prevent
          // concurrent auto-allocate calls from creating duplicate session sets.
          // For in-progress reallocation, only count FUTURE confirmed slots.
          if (
            (eventType === "class" || eventType === "subscription") &&
            !isReschedule &&
            existingNonTentativeSlotCount > 0
          ) {
            const requiredForGuard =
              SlotCalculationService.calculateRequiredSlots(eventType, config);
            const futureNonTentativeSlotCount =
              existingNonTentativeSlotCount - pastConfirmedSlotCount;
            if (
              !isInProgressReallocation &&
              existingNonTentativeSlotCount >= requiredForGuard
            ) {
              throw new AllocationConflictError(
                `Event is already fully allocated with ${existingNonTentativeSlotCount} confirmed slot(s).`,
              );
            }
            // For in-progress: only block if future slots alone meet the future requirement
            if (
              isInProgressReallocation &&
              futureNonTentativeSlotCount >=
                requiredForGuard - pastConfirmedSlotCount
            ) {
              throw new AllocationConflictError(
                `Event's future slots are already fully allocated (${futureNonTentativeSlotCount} future slot(s), ${pastConfirmedSlotCount} past).`,
              );
            }
          }

          // Collect appointment IDs to exclude from conflict detection and weekly limits.
          // For reschedule: exclude tentative appointments (they'll be deleted)
          // For initial/in-progress allocation: exclude ALL existing appointments (they'll be deleted or preserved)
          const appointmentIdsToExclude = isReschedule
            ? existingAppointments
                .filter((a) => a.slotsOfAppointment.some((s) => s.isTentative))
                .map((a) => a.id)
            : existingAppointments.map((a) => a.id);

          // Calculate required slots
          let requiredSlots: number;
          if (isReschedule) {
            // Use calculateRequiredSlots instead of tentativeSlotCount.
            // Class creation (crud-with-plan) creates 1 full-duration slot per appointment,
            // but the allocation system works with 30-min slots (slotsPerSession per appointment).
            // tentativeSlotCount would be 8 for an 8-session class, but we actually need 16
            // (8 sessions × 2 thirty-minute slots each).
            requiredSlots = SlotCalculationService.calculateRequiredSlots(
              eventType,
              config,
            );
          } else {
            const fullRequired = SlotCalculationService.calculateRequiredSlots(
              eventType,
              config,
            );
            // For in-progress reallocation, only allocate future slots
            requiredSlots = isInProgressReallocation
              ? fullRequired - pastConfirmedSlotCount
              : fullRequired;
          }

          const slotsPerCall = SlotCalculationService.getSlotsPerCall(
            config.sessionDurationInHours || config.durationInHours || 1,
          );

          // Find available slots
          // Pass appointmentIdsToExclude so their slots are excluded from bookedSlots
          // Pass existingAppointments so callsPerWeek is scoped to this event only
          const selectedSlots = await this.findAvailableSlots(
            tx,
            consultant,
            requiredSlots,
            slotsPerCall,
            eventType,
            config,
            appointmentIdsToExclude,
            existingAppointments,
          );

          // Validate
          // Pass appointmentIdsToExclude so their slots don't trigger false conflicts
          const validator = new SlotValidationService(tx);
          const validation = await validator.validate(
            eventType,
            eventId,
            selectedSlots,
            consultant,
            config,
            appointmentIdsToExclude,
          );

          if (!validation.isValid) {
            throw new AllocationValidationError(
              `Validation failed: ${validation.errors.join("; ")}`,
            );
          }

          // CRITICAL FIX: Delete existing appointments before creating new ones
          // For reschedules: only delete appointments with tentative slots (preserve confirmed ones)
          // For in-progress: only delete future slots (preserve past confirmed ones)
          // For initial allocation: delete all (shouldn't be any, but safety measure)
          const { enrolledUserIds } = await this.deleteExistingAppointments(
            tx,
            eventType,
            eventId,
            isReschedule,
            isInProgressReallocation,
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

          // Reconnect enrolled users to new slots (for group events like classes)
          if (enrolledUserIds.length > 0) {
            await this.reconnectEnrolledUsers(
              tx,
              appointments,
              enrolledUserIds,
              consultant.userId,
            );
          }

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
    } finally {
      await unlockAutoAllocate(lock);
    }
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
    // Pre-fetch consultantProfileId for lock key (lightweight, outside transaction)
    const consultantProfileId = await this.getConsultantProfileId(
      eventType,
      eventId,
    );
    if (!consultantProfileId) {
      return {
        success: false,
        error: `${eventType} not found or has no consultant`,
        errorCode: "NOT_FOUND",
        httpStatus: 400,
      };
    }

    // Acquire consultant-level distributed lock before the transaction.
    // Without this, concurrent manual allocations for the same subscription/class
    // can both pass validateNoConflicts() and create duplicate appointments.
    const lock = await lockAutoAllocate(consultantProfileId);
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Fetch event details
          const eventData = await this.fetchEventData(tx, eventType, eventId);
          if (!eventData) {
            throw new AllocationNotFoundError(`${eventType} not found`);
          }

          const { consultant, config, consulteeUserId } = eventData;

          // Convert to Date objects with validation
          const slots = slotStrings.map((s, i) => {
            const date = new Date(s);
            if (isNaN(date.getTime())) {
              throw new AllocationValidationError(
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
            throw new AllocationValidationError(
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
            throw new AllocationValidationError(
              `Invalid slot count: ${slots.length} slots provided, but ${sessionDuration}-hour ` +
                `sessions require multiples of ${slotsPerCall} slots (30 minutes each). ` +
                `Valid counts: ${slotsPerCall}, ${slotsPerCall * 2}, ${slotsPerCall * 3}, etc.`,
            );
          }

          // Detect reschedule scenario: check for existing tentative slots
          const relationField = this.getEventRelationField(eventType);
          const existingAppointments: AppointmentWithSlots[] =
            await tx.appointment.findMany({
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

          // Detect in-progress reallocation: past confirmed slots exist for recurring events
          const now = new Date();
          const pastConfirmedSlotCount = isReschedule
            ? 0
            : existingAppointments.reduce(
                (count, appt) =>
                  count +
                  appt.slotsOfAppointment.filter(
                    (slot) => !slot.isTentative && new Date(slot.endsAt) <= now,
                  ).length,
                0,
              );
          const isInProgressReallocation =
            !isReschedule &&
            pastConfirmedSlotCount > 0 &&
            (eventType === "class" || eventType === "subscription");

          // Collect appointment IDs to exclude from conflict detection and weekly limits.
          // For reschedule: exclude tentative appointments (they'll be deleted)
          // For initial/in-progress allocation: exclude ALL existing appointments
          const appointmentIdsToExclude = isReschedule
            ? existingAppointments
                .filter((a) => a.slotsOfAppointment.some((s) => s.isTentative))
                .map((a) => a.id)
            : existingAppointments.map((a) => a.id);

          // Validate total slot count for recurring event types
          if (eventType === "subscription" || eventType === "class") {
            if (isReschedule) {
              // Use calculateRequiredSlots instead of tentativeSlotCount.
              // Class creation creates 1 full-duration slot per appointment,
              // but the allocation system works with 30-min slots.
              const rescheduleRequired =
                SlotCalculationService.calculateRequiredSlots(
                  eventType,
                  config,
                );
              if (slots.length !== rescheduleRequired) {
                throw new AllocationValidationError(
                  `This reschedule requires exactly ${rescheduleRequired} slots ` +
                    `(replacing ${tentativeSlotCount} tentative slots), ` +
                    `but ${slots.length} were provided.`,
                );
              }
            } else if (isInProgressReallocation) {
              // In-progress: only future slots expected, past ones are preserved
              const fullRequired =
                SlotCalculationService.calculateRequiredSlots(
                  eventType,
                  config,
                );
              const expectedFutureSlots = fullRequired - pastConfirmedSlotCount;
              if (slots.length !== expectedFutureSlots) {
                throw new AllocationValidationError(
                  `In-progress ${eventType}: ${pastConfirmedSlotCount} past slot(s) preserved. ` +
                    `Expected ${expectedFutureSlots} future slots, but ${slots.length} were provided.`,
                );
              }
            } else if (
              config.schedulingPeriodStartsAt &&
              config.schedulingPeriodEndsAt
            ) {
              const requiredSlots =
                SlotCalculationService.calculateRequiredSlots(
                  eventType,
                  config,
                );
              if (slots.length !== requiredSlots) {
                throw new AllocationValidationError(
                  `This ${eventType} requires exactly ${requiredSlots} slots ` +
                    `(based on the scheduling period and session configuration), ` +
                    `but ${slots.length} were provided.`,
                );
              }
            }
          }

          // Validate
          // Pass appointmentIdsToExclude so their slots don't trigger false conflicts
          const validator = new SlotValidationService(tx);
          const validation = await validator.validate(
            eventType,
            eventId,
            slots,
            consultant,
            config,
            appointmentIdsToExclude,
          );

          if (!validation.isValid) {
            throw new AllocationValidationError(
              `Validation failed: ${validation.errors.join("; ")}`,
            );
          }

          // Delete existing appointments
          // For reschedules: only delete tentative slots (preserve confirmed ones)
          // For in-progress: only delete future slots (preserve past confirmed ones)
          // For initial allocation: delete all
          const { enrolledUserIds } = await this.deleteExistingAppointments(
            tx,
            eventType,
            eventId,
            isReschedule,
            isInProgressReallocation,
          );

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

          // Reconnect enrolled users to new slots (for group events like classes)
          if (enrolledUserIds.length > 0) {
            await this.reconnectEnrolledUsers(
              tx,
              appointments,
              enrolledUserIds,
              consultant.userId,
            );
          }

          // Update event status
          await this.updateEventStatus(
            tx,
            eventType,
            eventId,
            slots[0],
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
    } finally {
      await unlockAutoAllocate(lock);
    }
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
          throw new AllocationNotFoundError(`${eventType} not found`);
        }

        const { consultant, config, requestedSlots } = eventData;

        if (!requestedSlots || requestedSlots.length === 0) {
          throw new AllocationValidationError("No requested slots found");
        }

        // CRITICAL FIX: Verify appointments actually exist before approving
        // This prevents approving requests with no actual bookings
        const relationField = this.getEventRelationField(eventType);
        const existingAppointments: AppointmentWithSlots[] =
          await tx.appointment.findMany({
            where: {
              [`${relationField}Id`]: eventId,
            } as Prisma.AppointmentWhereInput,
            include: { slotsOfAppointment: true },
          });

        if (existingAppointments.length === 0) {
          throw new AllocationValidationError(
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
          throw new AllocationValidationError(
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
          throw new AllocationValidationError(
            `Validation failed: ${validation.errors.join("; ")}`,
          );
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
   *
   * FIX Issue #6: Now uses Int (minutes since midnight UTC) directly
   * instead of extracting hours/minutes from DateTime objects.
   *
   * Handles overnight (cross-midnight) availability slots where
   * endTimeUtc <= startTimeUtc (e.g., 22:00→02:00 spanning two days).
   * Mirrors the logic from SlotValidationService.validateMatchesSchedule().
   */
  private static isWithinAvailability(
    candidate: Date,
    consultant: ConsultantAllocationData,
  ): boolean {
    if (consultant.scheduleType === ScheduleType.WEEKLY) {
      const candidateDay = candidate.getUTCDay();
      const candidateMinutes =
        candidate.getUTCHours() * 60 + candidate.getUTCMinutes();

      return consultant.slotsOfAvailabilityWeekly.some((slot) =>
        isMinuteWithinWeeklySlot(
          candidateDay,
          candidateMinutes,
          30, // all atomic slots are 30 minutes
          slot.startDay,
          slot.startTimeUtc,
          slot.endTimeUtc,
          slot.utcOffsetMinutes,
        ),
      );
    } else {
      // CUSTOM schedule: candidate must fall within a specific date range
      const thirtyMinMs = 30 * 60 * 1000;
      return consultant.slotsOfAvailabilityCustom.some((slot) => {
        const slotStart = new Date(slot.startsAt);
        const slotEnd = new Date(slot.endsAt);

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
    eventOwnAppointments: AppointmentWithSlots[] = [],
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

    // Validate availability exists
    const hasWeeklySlots = consultant.slotsOfAvailabilityWeekly.length > 0;
    const hasCustomSlots = consultant.slotsOfAvailabilityCustom.length > 0;
    if (
      (consultant.scheduleType === ScheduleType.WEEKLY && !hasWeeklySlots) ||
      (consultant.scheduleType === ScheduleType.CUSTOM && !hasCustomSlots)
    ) {
      throw new AllocationValidationError(
        "No availability slots configured for consultant",
      );
    }

    const now = new Date();
    const selectedSlots: Date[] = [];

    // Sort weekly slots by next calendar occurrence (not raw clock time)
    // so auto-allocation picks the chronologically earliest slot first.
    // Without this, Tue 08:00 (480min) would sort before Mon 09:00 (540min).
    const sortedWeekly =
      consultant.scheduleType === ScheduleType.WEEKLY
        ? [...consultant.slotsOfAvailabilityWeekly]
            .map((slot) => ({
              slot,
              nextOccurrence: this.getNextOccurrenceWeekly(
                slot.startDay,
                slot.startTimeUtc,
                slot.utcOffsetMinutes,
              ),
            }))
            .sort(
              (a, b) => a.nextOccurrence.getTime() - b.nextOccurrence.getTime(),
            )
            .map((w) => w.slot)
        : [];
    const sortedCustom =
      consultant.scheduleType === ScheduleType.CUSTOM
        ? [...consultant.slotsOfAvailabilityCustom].sort(
            (a, b) =>
              new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
          )
        : [];

    // For consultations/webinars: find one consecutive block, searching multiple weeks
    if (eventType === "consultation" || eventType === "webinar") {
      const maxWeeksToSearch = eventType === "consultation" ? 8 : 4;

      if (consultant.scheduleType === ScheduleType.WEEKLY) {
        for (let week = 0; week < maxWeeksToSearch; week++) {
          for (const slot of sortedWeekly) {
            const baseStart = this.getNextOccurrenceWeekly(
              slot.startDay,
              slot.startTimeUtc,
              slot.utcOffsetMinutes,
            );

            const candidateStart = new Date(baseStart);
            if (week > 0) {
              candidateStart.setUTCDate(candidateStart.getUTCDate() + week * 7);
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
        // CUSTOM schedule: iterate pre-sorted slots
        for (const slot of sortedCustom) {
          const slotStart = new Date(slot.startsAt);

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

      throw new AllocationValidationError(
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
    // IMPORTANT: Only count THIS event's own appointments (not consultations or
    // other event types), and exclude the tentative ones being replaced.
    const excludeSet = new Set(excludeAppointmentIds);
    const existingCallsPerWeek = new Map<string, number>();
    for (const apt of eventOwnAppointments) {
      if (excludeSet.has(apt.id)) continue; // skip tentative (being replaced)
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
        if (consultant.scheduleType === ScheduleType.WEEKLY) {
          for (const slot of sortedWeekly) {
            const slotTime = this.matchWeeklySlotToDay(
              slot.startDay,
              slot.startTimeUtc,
              currentDay,
              slot.utcOffsetMinutes,
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
              break;
            }
          }
        } else {
          for (const slot of sortedCustom) {
            const slotTime = this.matchCustomSlotToDay(
              slot.startsAt,
              currentDay,
            );

            if (
              !slotTime ||
              slotTime < now ||
              slotTime < startDate ||
              slotTime > endDate
            ) {
              continue;
            }

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
              break;
            }
          }
        }
      }

      currentWeek = addWeeks(currentWeek, 1);
    }

    if (selectedSlots.length < totalSlotsNeeded) {
      throw new AllocationValidationError(
        `Could only find ${selectedSlots.length} of ${totalSlotsNeeded} required slots`,
      );
    }

    return selectedSlots.sort((a, b) => a.getTime() - b.getTime());
  }

  /**
   * Get next occurrence of a weekly slot starting from now.
   * Uses Int (startTimeUtc) and DayOfWeek enum string directly.
   *
   * FIX Issue #6: No longer parses DateTime objects for time extraction.
   * FIX BUG-2: Applies UTC day adjustment using utcOffsetMinutes so that
   * a slot on "MONDAY" in local time is correctly resolved to the UTC day
   * (e.g., IST Monday 01:00 = UTC Sunday 19:30).
   */
  private static getNextOccurrenceWeekly(
    startDay: string,
    startTimeUtc: number,
    utcOffsetMinutes: number = 0,
  ): Date {
    const now = new Date();
    const localDay = DAY_OF_WEEK_TO_INDEX[startDay];
    if (localDay === undefined) {
      throw new Error(`Invalid day of week: ${startDay}`);
    }

    // Compute the actual UTC day-of-week, matching isMinuteWithinWeeklySlot() logic.
    // Formula: utcDay = (localDay - floor((startTimeUtc + offset) / 1440)) mod 7
    const localStartMinutes = startTimeUtc + utcOffsetMinutes;
    const dayAdjust = Math.floor(localStartMinutes / 1440);
    const targetDay = (((localDay - dayAdjust) % 7) + 7) % 7;

    const targetHours = Math.floor(startTimeUtc / 60);
    const targetMinutes = startTimeUtc % 60;
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
   * Match a weekly slot pattern to a specific target day.
   * Uses Int startTimeUtc and DayOfWeek string directly.
   *
   * FIX BUG-2: Applies UTC day adjustment so that a local-day slot
   * is matched against the correct UTC day-of-week.
   */
  private static matchWeeklySlotToDay(
    startDay: string,
    startTimeUtc: number,
    targetDay: Date,
    utcOffsetMinutes: number = 0,
  ): Date | null {
    const localDay = DAY_OF_WEEK_TO_INDEX[startDay];
    if (localDay === undefined) return null;

    // Compute actual UTC day-of-week (same formula as isMinuteWithinWeeklySlot)
    const localStartMinutes = startTimeUtc + utcOffsetMinutes;
    const dayAdjust = Math.floor(localStartMinutes / 1440);
    const slotDayOfWeek = (((localDay - dayAdjust) % 7) + 7) % 7;

    const targetDayOfWeek = targetDay.getUTCDay();

    if (slotDayOfWeek === targetDayOfWeek) {
      const result = new Date(targetDay);
      result.setUTCHours(
        Math.floor(startTimeUtc / 60),
        startTimeUtc % 60,
        0,
        0,
      );
      return result;
    }

    return null;
  }

  /**
   * Match a custom slot to a specific target day.
   */
  private static matchCustomSlotToDay(
    slotTime: Date,
    targetDay: Date,
  ): Date | null {
    const slotDate = new Date(slotTime);
    // Use ISO date string for reliable comparison (always YYYY-MM-DD format).
    // Previous code used getUTCMonth() (0-indexed) without padding, which was fragile.
    const slotDateStr = slotDate.toISOString().split("T")[0];
    const targetDateStr = targetDay.toISOString().split("T")[0];

    if (slotDateStr === targetDateStr) {
      return new Date(slotTime);
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
   * Reconnect enrolled users to newly created slots.
   * Used during in-progress reallocation of group events (classes):
   * when future slots are deleted and recreated, the enrolled users'
   * M2M links are lost. This restores them on the new slots.
   */
  private static async reconnectEnrolledUsers(
    tx: PrismaTransaction,
    appointments: AppointmentWithSlots[],
    enrolledUserIds: string[],
    consultantUserId: string,
  ): Promise<void> {
    // Filter out the consultant (already connected via createAppointments)
    const userIdsToConnect = enrolledUserIds.filter(
      (id) => id !== consultantUserId,
    );
    if (userIdsToConnect.length === 0) return;

    const connectData = userIdsToConnect.map((id) => ({ id }));
    for (const appointment of appointments) {
      for (const slot of appointment.slotsOfAppointment) {
        await tx.slotOfAppointment.update({
          where: { id: slot.id },
          data: { user: { connect: connectData } },
        });
      }
    }
  }

  /**
   * Delete existing appointments for an event
   *
   * @param onlyTentative - If true, only delete tentative SlotOfAppointment records,
   *                        preserving confirmed slots and their parent appointments.
   *                        Appointments are only deleted if they have zero remaining slots
   *                        after tentative slot removal. This is used for partial reschedules.
   * @param preservePastSlots - If true (and onlyTentative is false), only delete future slots,
   *                            preserving past confirmed slots and their MeetingSession records.
   *                            Used for in-progress reallocation of classes/subscriptions.
   * @returns preservedSlotCount - Number of past slots that were preserved.
   * @returns enrolledUserIds - User IDs connected to deleted future slots (for reconnection).
   */
  private static async deleteExistingAppointments(
    tx: PrismaTransaction,
    eventType: EventType,
    eventId: string,
    onlyTentative: boolean = false,
    preservePastSlots: boolean = false,
  ): Promise<{ preservedSlotCount: number; enrolledUserIds: string[] }> {
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
        const hasConfirmed = appointment.slotsOfAppointment.some(
          (slot) => !slot.isTentative,
        );
        const hasTentative = appointment.slotsOfAppointment.some(
          (slot) => slot.isTentative,
        );

        if (hasTentative) {
          // Delete only tentative slots using a direct query (not stale IDs)
          await tx.slotOfAppointment.deleteMany({
            where: {
              appointmentId: appointment.id,
              isTentative: true,
            },
          });

          // If no confirmed slots exist, delete the now-empty appointment
          if (!hasConfirmed) {
            await tx.appointment.delete({
              where: { id: appointment.id },
            });
          }
        }
      }
      return { preservedSlotCount: 0, enrolledUserIds: [] };
    } else if (preservePastSlots) {
      // In-progress reallocation: only delete future slots, preserve past ones
      const now = new Date();
      const appointments = await tx.appointment.findMany({
        where: whereClause,
        include: {
          slotsOfAppointment: {
            include: {
              user: { select: { id: true } },
              meetingSession: { select: { id: true, endedAt: true } },
            },
          },
        },
      });

      let preservedSlotCount = 0;
      const enrolledUserIdSet = new Set<string>();
      const imminentCutoff = new Date(now.getTime() + TWENTY_FOUR_HOURS_IN_MS);

      for (const appointment of appointments) {
        const pastSlots = appointment.slotsOfAppointment.filter(
          (slot) => new Date(slot.endsAt) <= now,
        );
        const futureSlots = appointment.slotsOfAppointment.filter(
          (slot) => new Date(slot.endsAt) > now,
        );

        // Guard: preserve slots that are imminent (<24h) or have active sessions
        const protectedFutureSlots = futureSlots.filter(
          (slot) =>
            new Date(slot.startsAt) < imminentCutoff ||
            (slot.meetingSession && !slot.meetingSession.endedAt),
        );
        const deletableFutureSlots = futureSlots.filter(
          (slot) =>
            new Date(slot.startsAt) >= imminentCutoff &&
            (!slot.meetingSession || slot.meetingSession.endedAt !== null),
        );

        preservedSlotCount += pastSlots.length + protectedFutureSlots.length;

        // Capture enrolled user IDs from deletable future slots before deletion
        for (const slot of deletableFutureSlots) {
          for (const user of slot.user) {
            enrolledUserIdSet.add(user.id);
          }
        }

        if (deletableFutureSlots.length > 0) {
          await tx.slotOfAppointment.deleteMany({
            where: {
              appointmentId: appointment.id,
              id: { in: deletableFutureSlots.map((s) => s.id) },
            },
          });
        }

        // Only delete the appointment if no slots remain at all
        if (pastSlots.length === 0 && protectedFutureSlots.length === 0) {
          await tx.appointment.delete({ where: { id: appointment.id } });
        }
      }

      return {
        preservedSlotCount,
        enrolledUserIds: Array.from(enrolledUserIdSet),
      };
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
      return { preservedSlotCount: 0, enrolledUserIds: [] };
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
    switch (eventType) {
      case "consultation":
        await tx.consultation.update({
          where: { id: eventId },
          data: { requestStatus: RequestStatus.APPROVED },
        });
        break;

      case "subscription":
        await tx.subscription.update({
          where: { id: eventId },
          data: {
            requestStatus: RequestStatus.APPROVED,
            // FIX: Only set schedulingPeriod if not already configured
            // This prevents overwriting the user's scheduling period with the first allocated slot
            // which could cause slots to appear outside the intended scheduling window
            ...(!config.schedulingPeriodStartsAt ||
            !config.schedulingPeriodEndsAt
              ? {
                  schedulingPeriodStartsAt: firstSlot,
                  schedulingPeriodEndsAt: addMonths(
                    firstSlot,
                    config.durationInMonths || 1,
                  ),
                }
              : {}),
          },
        });
        break;

      case "webinar":
        // Webinar model does NOT have startDate/endDate fields
        // Start date is stored in the Appointment's slots
        await tx.webinar.update({
          where: { id: eventId },
          data: { status: "SCHEDULED" },
        });
        break;

      case "class":
        // Class model HAS schedulingPeriod fields
        // FIX: Only set schedulingPeriod if not already configured — same guard as SUBSCRIPTION.
        // Overwriting an explicitly-set period on re-allocation shifts the window, allowing
        // slots outside the original range to pass the scheduling-period validation check.
        await tx.class.update({
          where: { id: eventId },
          data: {
            status: "SCHEDULED",
            ...(!config.schedulingPeriodStartsAt ||
            !config.schedulingPeriodEndsAt
              ? {
                  schedulingPeriodStartsAt: firstSlot,
                  schedulingPeriodEndsAt: addMonths(
                    firstSlot,
                    config.durationInMonths || 2,
                  ),
                }
              : {}),
          },
        });
        break;
    }
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
    const consultantProfileSelect = {
      select: {
        user: true,
        scheduleType: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
      },
    } as const;

    let consultantProfile:
      | {
          user: { id: string; timezone?: string | null };
          scheduleType: "WEEKLY" | "CUSTOM";
          slotsOfAvailabilityWeekly: ConsultantAllocationData["slotsOfAvailabilityWeekly"];
          slotsOfAvailabilityCustom: ConsultantAllocationData["slotsOfAvailabilityCustom"];
        }
      | null
      | undefined;
    let config: EventConfig;
    let consulteeUserId: string | undefined;
    let requestedSlots: Date[] | undefined;

    switch (eventType) {
      case "consultation": {
        const event = await tx.consultation.findUnique({
          where: { id: eventId },
          include: {
            consultationPlan: {
              include: { consultantProfile: consultantProfileSelect },
            },
            requestedBy: { include: { user: true } },
            appointment: { include: { slotsOfAppointment: true } },
          },
        });
        if (!event) return null;
        consultantProfile = event.consultationPlan?.consultantProfile;
        config = {
          durationInHours: event.consultationPlan?.durationInHours,
        };
        consulteeUserId = event.requestedBy?.user?.id;
        requestedSlots = event.appointment?.slotsOfAppointment?.map(
          (s) => new Date(s.startsAt),
        );
        break;
      }

      case "subscription": {
        const event = await tx.subscription.findUnique({
          where: { id: eventId },
          include: {
            subscriptionPlan: {
              include: { consultantProfile: consultantProfileSelect },
            },
            requestedBy: { include: { user: true } },
            appointments: { include: { slotsOfAppointment: true } },
          },
        });
        if (!event) return null;
        consultantProfile = event.subscriptionPlan?.consultantProfile;
        config = {
          durationInMonths: event.subscriptionPlan?.durationInMonths,
          callsPerWeek: event.subscriptionPlan?.callsPerWeek,
          sessionDurationInHours:
            event.subscriptionPlan?.sessionDurationInHours,
          totalSessions: event.subscriptionPlan?.totalSessions,
          schedulingPeriodStartsAt: event.schedulingPeriodStartsAt ?? undefined,
          schedulingPeriodEndsAt: event.schedulingPeriodEndsAt ?? undefined,
        };
        consulteeUserId = event.requestedBy?.user?.id;
        requestedSlots = event.appointments?.flatMap((app) =>
          app.slotsOfAppointment.map((s) => new Date(s.startsAt)),
        );
        break;
      }

      case "webinar": {
        const event = await tx.webinar.findUnique({
          where: { id: eventId },
          include: {
            webinarPlan: {
              include: { consultantProfile: consultantProfileSelect },
            },
          },
        });
        if (!event) return null;
        consultantProfile = event.webinarPlan?.consultantProfile;
        config = {
          durationInHours: event.webinarPlan?.durationInHours,
        };
        break;
      }

      case "class": {
        const event = await tx.class.findUnique({
          where: { id: eventId },
          include: {
            classPlan: {
              include: {
                consultantProfile: consultantProfileSelect,
                classContents: true,
              },
            },
            appointments: { include: { slotsOfAppointment: true } },
          },
        });
        if (!event) return null;
        consultantProfile = event.classPlan?.consultantProfile;
        const classContents = event.classPlan?.classContents || [];
        const sessionDuration =
          classContents.length > 0
            ? classContents.reduce((sum, c) => sum + c.hoursAllotted, 0) /
              classContents.length
            : event.classPlan?.sessionDurationInHours || 1;

        config = {
          durationInMonths: event.classPlan?.durationInMonths,
          callsPerWeek: event.classPlan?.meetingsPerWeek,
          sessionDurationInHours: sessionDuration,
          totalSessions: event.classPlan?.totalSessions,
          schedulingPeriodStartsAt: event.schedulingPeriodStartsAt ?? undefined,
          schedulingPeriodEndsAt: event.schedulingPeriodEndsAt ?? undefined,
        };
        break;
      }
    }

    if (!consultantProfile) {
      throw new AllocationNotFoundError("Consultant profile not found");
    }

    // FIX: Validate date ordering for events with scheduling periods
    // This prevents bugs in auto-allocation and week calculation
    if (config.schedulingPeriodStartsAt && config.schedulingPeriodEndsAt) {
      if (config.schedulingPeriodStartsAt >= config.schedulingPeriodEndsAt) {
        throw new AllocationValidationError(
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
        timezone: consultantProfile.user.timezone ?? undefined,
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
}
