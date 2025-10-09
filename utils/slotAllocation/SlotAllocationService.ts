/**
 * Slot Allocation Service
 *
 * Unified allocation algorithms for all event types.
 * Handles auto, manual, and requested slot allocation.
 */

import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  RequestStatus,
  ScheduleType,
  DayOfWeek,
} from "@prisma/client";
import { addHours, addWeeks, addMonths } from "date-fns";
import {
  AllocationRequest,
  AllocationResult,
  AllocationMode,
  EventType,
  PrismaTransaction,
  ConsultantAllocationData,
  EventConfig,
} from "./types";
import { SlotCalculationService } from "./SlotCalculationService";
import { SlotValidationService } from "./SlotValidationService";

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
    return await prisma.$transaction(async (tx) => {
      // Fetch event details and consultant info
      const eventData = await this.fetchEventData(tx, eventType, eventId);
      if (!eventData) {
        throw new Error(`${eventType} not found`);
      }

      const { consultant, config, consulteeUserId } = eventData;

      // Calculate required slots
      const requiredSlots = SlotCalculationService.calculateRequiredSlots(
        eventType,
        config,
      );
      const slotsPerCall = SlotCalculationService.getSlotsPerCall(
        config.sessionDurationInHours || config.durationInHours || 1,
      );

      // Find available slots
      const selectedSlots = await this.findAvailableSlots(
        tx,
        consultant,
        requiredSlots,
        slotsPerCall,
        eventType,
        config,
      );

      // Validate
      const validator = new SlotValidationService(tx as any);
      const validation = await validator.validate(
        eventType,
        eventId,
        selectedSlots,
        consultant,
        config,
      );

      if (!validation.isValid) {
        throw new Error(`Validation failed: ${validation.errors.join("; ")}`);
      }

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
    });
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
    return await prisma.$transaction(async (tx) => {
      // Fetch event details
      const eventData = await this.fetchEventData(tx, eventType, eventId);
      if (!eventData) {
        throw new Error(`${eventType} not found`);
      }

      const { consultant, config, consulteeUserId } = eventData;

      // Convert to Date objects
      const slots = slotStrings.map((s) => new Date(s));

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

      // Validate
      const validator = new SlotValidationService(tx as any);
      const validation = await validator.validate(
        eventType,
        eventId,
        slots,
        consultant,
        config,
      );

      if (!validation.isValid) {
        throw new Error(`Validation failed: ${validation.errors.join("; ")}`);
      }

      // Delete existing appointments if any
      await this.deleteExistingAppointments(tx, eventType, eventId);

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
    });
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
    return await prisma.$transaction(async (tx) => {
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
      const existingAppointments = await (tx as any).appointment.findMany({
        where: { [`${relationField}Id`]: eventId },
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
        (sum: number, app: any) => sum + app.slotsOfAppointment.length,
        0,
      );

      if (existingSlotCount !== requestedSlots.length) {
        throw new Error(
          `Appointment mismatch: Found ${existingSlotCount} slots in appointments ` +
            `but ${requestedSlots.length} requested slots. ` +
            `The appointments may have been modified. Please review and try again.`,
        );
      }

      // Validate requested slots still meet all requirements
      const validator = new SlotValidationService(tx as any);
      const validation = await validator.validate(
        eventType,
        eventId,
        requestedSlots,
        consultant,
        config,
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

      return {
        success: true,
        appointments: existingAppointments,
        warnings: validation.warnings,
      };
    });
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
  ): Promise<Date[]> {
    // Get all existing booked slots for this consultant
    const existingAppointments = await (tx as any).appointment.findMany({
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
                user: {
                  some: { id: consultant.userId },
                },
              },
            },
          },
        ],
      },
      include: {
        slotsOfAppointment: true,
      },
    });

    const bookedSlots = new Set(
      existingAppointments.flatMap((app: any) =>
        app.slotsOfAppointment.map((slot: any) =>
          new Date(slot.slotStartTimeInUTC).toISOString(),
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

    // Sort by time of day to prioritize earlier slots
    const sortedSlots = [...availableTimeSlots].sort((a, b) => {
      const timeA = new Date(a.slotStartTimeInUTC).getHours();
      const timeB = new Date(b.slotStartTimeInUTC).getHours();
      return timeA - timeB;
    });

    const now = new Date();
    const selectedSlots: Date[] = [];

    // For consultations/webinars: find one consecutive block
    if (eventType === "consultation" || eventType === "webinar") {
      for (const slot of sortedSlots) {
        const slotStart = this.getNextOccurrence(
          slot.slotStartTimeInUTC,
          consultant.scheduleType,
        );

        if (slotStart < now || bookedSlots.has(slotStart.toISOString())) {
          continue;
        }

        // Try to build consecutive block
        const consecutiveBlock: Date[] = [];
        let currentTime = new Date(slotStart);

        for (let i = 0; i < slotsPerCall; i++) {
          if (bookedSlots.has(currentTime.toISOString()) || currentTime < now) {
            break;
          }
          consecutiveBlock.push(new Date(currentTime));
          currentTime = new Date(currentTime.getTime() + 30 * 60 * 1000);
        }

        if (consecutiveBlock.length === slotsPerCall) {
          return consecutiveBlock;
        }
      }

      throw new Error(
        `No ${slotsPerCall} consecutive slots available for ${eventType}`,
      );
    }

    // For subscriptions/classes: find distributed slots across weeks
    const startDate = config.startDate || new Date();
    const endDate =
      config.endDate || addMonths(startDate, config.durationInMonths || 1);
    const callsPerWeek = config.callsPerWeek || 1;

    let currentWeek = SlotCalculationService.startOfWeekSunday(startDate);
    const totalWeeks = SlotCalculationService.countWeeks(startDate, endDate);

    for (
      let week = 0;
      week < totalWeeks && selectedSlots.length < totalSlotsNeeded;
      week++
    ) {
      let slotsThisWeek = 0;

      for (let day = 0; day < 7 && slotsThisWeek < callsPerWeek; day++) {
        const currentDay = new Date(currentWeek);
        currentDay.setDate(currentDay.getDate() + day);

        // Find first available slot on this day
        for (const slot of sortedSlots) {
          const slotTime = this.matchSlotToDay(
            slot.slotStartTimeInUTC,
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
            if (
              bookedSlots.has(currentTime.toISOString()) ||
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
            slotsThisWeek++;
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
   */
  private static getNextOccurrence(slotTime: Date, scheduleType: string): Date {
    if (scheduleType === ScheduleType.CUSTOM) {
      return new Date(slotTime);
    }

    const now = new Date();
    const targetDay = new Date(slotTime).getDay();
    const currentDay = now.getDay();

    const daysToAdd = (targetDay - currentDay + 7) % 7;
    const nextOccurrence = new Date(now);
    nextOccurrence.setDate(now.getDate() + daysToAdd);
    nextOccurrence.setHours(
      new Date(slotTime).getHours(),
      new Date(slotTime).getMinutes(),
      0,
      0,
    );

    return nextOccurrence;
  }

  /**
   * Match a weekly slot pattern to a specific day
   */
  private static matchSlotToDay(
    slotTime: Date,
    targetDay: Date,
    scheduleType: string,
  ): Date | null {
    if (scheduleType === ScheduleType.CUSTOM) {
      // Only match if exact same day
      if (new Date(slotTime).toDateString() === targetDay.toDateString()) {
        return new Date(slotTime);
      }
      return null;
    }

    // Weekly: match day of week
    if (new Date(slotTime).getDay() === targetDay.getDay()) {
      const result = new Date(targetDay);
      result.setHours(
        new Date(slotTime).getHours(),
        new Date(slotTime).getMinutes(),
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

    // Create appointment for each call
    const appointments = await Promise.all(
      calls.map((callSlots) =>
        (tx as any).appointment.create({
          data: {
            appointmentType: this.getAppointmentType(eventType),
            [this.getEventRelationField(eventType)]: {
              connect: { id: eventId },
            },
            slotsOfAppointment: {
              create: callSlots.map((slotStart) => ({
                slotStartTimeInUTC: slotStart,
                slotEndTimeInUTC: new Date(
                  slotStart.getTime() + 30 * 60 * 1000,
                ),
                isTentative: false,
                user: {
                  connect: consulteeUserId
                    ? [{ id: consultantUserId }, { id: consulteeUserId }]
                    : [{ id: consultantUserId }],
                },
              })),
            },
          },
          include: {
            slotsOfAppointment: true,
          },
        }),
      ),
    );

    return appointments;
  }

  /**
   * Delete existing appointments for an event
   */
  private static async deleteExistingAppointments(
    tx: PrismaTransaction,
    eventType: EventType,
    eventId: string,
  ): Promise<void> {
    const relationField = this.getEventRelationField(eventType);

    const existing = await (tx as any).appointment.findMany({
      where: { [`${relationField}Id`]: eventId },
    });

    await Promise.all(
      existing.map((app: any) =>
        (tx as any).appointment.delete({ where: { id: app.id } }),
      ),
    );
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
          updates.startDate = firstSlot;
          updates.endDate = addMonths(firstSlot, config.durationInMonths || 1);
        }
        break;

      case "webinar":
      case "class":
        updates.status = "SCHEDULED";
        updates.startDate = firstSlot;
        if (eventType === "class") {
          updates.endDate = addWeeks(
            firstSlot,
            (config.durationInMonths || 1) * 4,
          );
        }
        break;
    }

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
          (s: any) => new Date(s.slotStartTimeInUTC),
        );
        break;

      case "subscription":
        consultantProfile = event.subscriptionPlan?.consultantProfile;
        config = {
          durationInMonths: event.subscriptionPlan?.durationInMonths,
          callsPerWeek: event.subscriptionPlan?.callsPerWeek,
          sessionDurationInHours:
            event.subscriptionPlan?.sessionDurationInHours,
          startDate: event.startDate,
          endDate: event.endDate,
        };
        consulteeUserId = event.requestedBy?.user?.id;
        requestedSlots = event.appointments?.flatMap((app: any) =>
          app.slotsOfAppointment.map(
            (s: any) => new Date(s.slotStartTimeInUTC),
          ),
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
          callsPerWeek: event.classPlan?.callsPerWeek,
          sessionDurationInHours: sessionDuration,
          startDate: event.startDate,
          endDate: event.endDate,
        };
        break;
    }

    if (!consultantProfile) {
      throw new Error("Consultant profile not found");
    }

    // FIX: Validate date ordering for events with scheduling periods
    // This prevents bugs in auto-allocation and week calculation
    if (config.startDate && config.endDate) {
      if (config.startDate >= config.endDate) {
        throw new Error(
          `Invalid date range: startDate (${config.startDate.toISOString()}) ` +
            `must be before endDate (${config.endDate.toISOString()}). ` +
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
        currentTimezone: consultantProfile.user.currentTimezone,
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
