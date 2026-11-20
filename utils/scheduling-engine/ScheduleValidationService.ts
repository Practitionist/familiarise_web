/**
 * Slot Validation Service
 *
 * Unified validation logic for all event types.
 * Single source of truth for validation rules - eliminates duplication across routes.
 */

import { reportSentryError } from "@/lib/observability/report";
import prisma, { type PrismaLike } from "@/lib/prisma";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import {
  isBeyondBookingHorizon,
  MAX_BOOKING_HORIZON_DAYS,
} from "@/lib/booking/lead-time";
import {
  isDeadOccurrence,
  SCHEDULING_INTERVAL_MS,
} from "@/lib/appointments/occurrences";

/** A stored occurrence as the cap counters read it. */
type ExistingOccurrenceRow = {
  id: string;
  appointmentId: string;
  startsAt: Date | string;
  isTentative: boolean;
  completionStatus?: string | null;
  deletedAt?: Date | string | null;
};
import {
  AppointmentStatus,
  ScheduleType,
  BookingSource,
  PaymentStatus,
} from "@prisma/client";
import {
  type ConflictDetail,
  EventType,
  ValidationResult,
  ConsultantAllocationData,
  EventConfig,
} from "./types";
import { ScheduleCalculationService } from "./ScheduleCalculationService";
import { SubscriptionValidationService } from "../subscriptionValidation";
import {
  buildCohostCommitmentFilter,
  buildConsultantOccupancyWhere,
  buildOccupiedAppointmentFilter,
  LIVE_OCCUPANCY_READ,
  OCCUPYING_OCCURRENCE_WHERE,
  requestHoldCutoff,
  timeHoldingParticipant,
} from "./occupancyPolicy";
import {
  MAX_CLASS_SESSIONS_PER_DAY,
  MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
} from "./sessionCaps";
import {
  createWeeklyCoverage,
  partitionWeeklyRows,
} from "@/utils/schedule/weekly-projection";
import { reportIncompleteWeeklyRows } from "@/lib/scheduling/incomplete-weekly-rows";

// AE-5/RV-6 — every slot is uniformly 30 minutes. The old slotDurationMinutes
// param invited callers to pass arbitrary values that silently mismatch the
// rest of the booking math; inline the one true duration instead.

/**
 * What decides whether an overlapping appointment still holds its time. The
 * validator and the allocator read occupancy through
 * {@link isOccupiedByLiveAppointment}, so `/validate` and `findAvailableSlots`
 * cannot disagree on a dead hold.
 */
type RequestOccupancy = {
  status?: AppointmentStatus | null;
  bookingSource?: BookingSource | null;
  requestedAt?: Date | null;
};
export interface LiveAppointmentOccupancy {
  consultation?: RequestOccupancy | null;
  subscription?: RequestOccupancy | null;
  payment?: Array<{
    expiresAt?: Date | null;
    paymentStatus?: PaymentStatus | null;
  }> | null;
  /** `BEING_MOVED_COUNTS`; a booking read without them never lapses by the request clock. */
  _count?: { rescheduleRequests: number; occurrences: number } | null;
}

/**
 * An overlapping appointment holds its time unless it is a dead hold: an
 * APPROVED_PENDING_PAYMENT or direct-checkout PENDING request whose every
 * payment is dead, or an unanswered request past its hold window that is not
 * being moved. The SQL twin is `buildDeadHoldFilter`.
 *
 * @param now - injectable clock so callers share a single transaction timestamp.
 */
export function isOccupiedByLiveAppointment(
  appointment: LiveAppointmentOccupancy,
  now: Date = new Date(),
): boolean {
  const request = appointment.consultation ?? appointment.subscription;
  const pendingStatus = request?.status;
  // A row is dead when the sweep marked it EXPIRED, the gateway FAILED it, or
  // it is still PENDING past its window. Never by the clock alone: a
  // SUCCEEDED row keeps its expiresAt, and its request can sit in PENDING
  // until the confirmation write lands. Every row must be dead: a later retry
  // row can still be live.
  const payments = appointment.payment ?? [];
  const allPaymentsDead =
    payments.length > 0 &&
    payments.every(
      (p) =>
        p.paymentStatus === PaymentStatus.EXPIRED ||
        p.paymentStatus === PaymentStatus.FAILED ||
        (p.paymentStatus === PaymentStatus.PENDING &&
          !!p.expiresAt &&
          new Date(p.expiresAt) < now),
    );

  if (pendingStatus === AppointmentStatus.APPROVED_PENDING_PAYMENT) {
    if (allPaymentsDead) return false;
  }
  if (pendingStatus !== AppointmentStatus.PENDING) return true;
  // A direct-checkout hold waits on a payment; a submitted request waits on
  // the expert, for as long as the request caps count it.
  if (request?.bookingSource === BookingSource.DIRECT_CHECKOUT) {
    return !allPaymentsDead;
  }
  const moves = appointment._count;
  if (
    request?.bookingSource === BookingSource.REQUEST_SUBMITTED &&
    request.requestedAt &&
    moves &&
    moves.rescheduleRequests === 0 &&
    moves.occurrences === 0
  ) {
    const kind = appointment.consultation ? "CONSULTATION" : "SUBSCRIPTION";
    return new Date(request.requestedAt) >= requestHoldCutoff(kind, now);
  }
  return true;
}

/**
 * The structured twin of a `[CONFLICT]` string: which booking, and whether it
 * sits on the consultant's own calendar (otherwise the consultee is the busy
 * party). Never whose booking it is: a conflict names a time, not a person.
 * Slot is seconds-precision ISO, the shape the validate routes report.
 */
function conflictDetailOf(
  slot: Date,
  appointment: {
    id: string;
    consultation: unknown;
    subscription: unknown;
    webinar: unknown;
    class: unknown;
  },
  onConsultantCalendar: boolean,
): ConflictDetail {
  let type: ConflictDetail["type"] = "Booking";
  if (appointment.consultation) type = "Consultation";
  else if (appointment.subscription) type = "Subscription";
  else if (appointment.webinar) type = "Webinar";
  else if (appointment.class) type = "Class";
  return {
    slot: slot.toISOString().slice(0, 19),
    appointmentId: appointment.id,
    type,
    onConsultantCalendar,
  };
}

export class ScheduleValidationService {
  constructor(private readonly prismaClient: PrismaLike = prisma) {}

  /**
   * Simple slot availability check (used for lock validation)
   * Only checks for conflicts - no schedule or future validation
   *
   * USE CASE: Re-validation inside distributed lock after acquisition
   * This ensures the slot is still available before creating the booking.
   */
  async checkSlotAvailability(
    slots: Date[],
    consultantUserId: string,
    consultantProfileId?: string,
    // #1583 B-P1-06 — the requesting consultee, so their own overlap on
    // another consultant is a conflict here as it is in revalidateConflicts.
    consulteeUserId?: string,
  ): Promise<ValidationResult> {
    return await this.validateNoConflicts(
      slots,
      consultantUserId,
      undefined,
      consulteeUserId,
      undefined,
      consultantProfileId,
    );
  }

  /**
   * #908 — conflict-only re-check run INSIDE the short write transaction after
   * the heavy read/validate was hoisted out (and run under the distributed
   * locks). Converts the common race (a slot taken between the out-of-txn read
   * and the write) into a clean typed conflict instead of a raw #440 GiST
   * constraint throw. Unlike {@link checkSlotAvailability}, it forwards the
   * exclude set and the consultee so the in-txn check matches the out-of-txn one.
   */
  async revalidateConflicts(
    slots: Date[],
    consultantUserId: string,
    excludeAppointmentIds?: string[],
    consulteeUserId?: string,
    excludeOccurrenceIds?: string[],
    consultantProfileId?: string,
  ): Promise<ValidationResult> {
    return await this.validateNoConflicts(
      slots,
      consultantUserId,
      excludeAppointmentIds,
      consulteeUserId,
      excludeOccurrenceIds,
      consultantProfileId,
    );
  }

  /**
   * Main validation entry point
   * Routes to appropriate validator based on event type
   *
   * @param excludeAppointmentIds - Appointment IDs to exclude from conflict checks.
   *   Used in "use requested slots" flow so an event's own tentative appointments
   *   are not flagged as conflicts with themselves.
   */
  async validate(
    eventType: EventType,
    eventId: string,
    slots: Date[],
    consultant: ConsultantAllocationData,
    config: EventConfig,
    excludeAppointmentIds?: string[],
    /**
     * Who and what this validation is for, beyond the slots themselves. An
     * object rather than more positional parameters: the signature was at the
     * limit, and a bare trailing boolean at the ninth position reads as nothing
     * at the call site.
     */
    options?: {
      /**
       * #676 AE-1 — when set, the consultee's calendar is checked too, so a
       * consultee can't be double-booked across event types at the same instant.
       */
      consulteeUserId?: string;
      /**
       * The consultant explicitly accepting times outside their own published
       * availability. Skips ONLY the availability-window check — conflicts,
       * caps, scheduling period and future-time all still apply, because those
       * protect other people's bookings rather than the consultant's
       * preference. Callers must have established that the requester is the
       * consultant or a privileged user before setting this.
       */
      overrideAvailabilityWindow?: boolean;
      /**
       * Interval starts the booking already holds. A held time was checked
       * against published hours when it was taken, so the window check skips it.
       */
      heldSlotStarts?: readonly Date[];
      /**
       * #1554 — occurrence rows to leave out of conflicts, weekly and daily
       * counts: a reschedule replaces rows on a wrapper it keeps, so the
       * wrapper's other calls must still count while the released ones do not.
       */
      excludeOccurrenceIds?: string[];
      /**
       * Consultant's profile id for the co-host arm of the conflict check.
       * An ACCEPTED webinar/class seat commits real time but is not a slot
       * participation, so without this the roster clause below never sees it
       * and the grid (which counts it via buildConsultantOccupancyWhere)
       * disagrees with validation. Optional so callers without a profile in
       * scope keep the old participant-only behavior.
       */
      consultantProfileId?: string;
      /**
       * The event's own appointment IDs for co-host conflict exclusions
       * (mirrors assertCollaboratorsFree's ownAppointmentIds).
       */
      ownAppointmentIds?: string[];
      /** How far ahead every slot must start (`leadMsFor`); 15 min by default. */
      leadTimeMs?: number;
    },
  ): Promise<ValidationResult> {
    // Universal validations (apply to all event types)
    const futureCheck = this.validateSlotsInFuture(
      slots,
      options?.leadTimeMs ?? MINIMUM_BOOKING_LEAD_TIME_MS,
    );
    // Too soon never hides a conflict or an availability gap: the rest runs
    // regardless and both sets of findings come back.
    const rest = await this.validateBeyondLeadTime(
      eventType,
      eventId,
      slots,
      consultant,
      config,
      excludeAppointmentIds,
      options,
    );
    const edgeFindings = [
      ...futureCheck.errors,
      ...this.beyondHorizonFindings(eventType, slots),
    ];
    if (edgeFindings.length === 0) return rest;
    return {
      ...rest,
      isValid: false,
      errors: [...edgeFindings, ...rest.errors],
    };
  }

  /**
   * A consultation starts inside the booking horizon, a moved one included.
   * Plan weeks, webinars and classes follow their own period rules.
   */
  private beyondHorizonFindings(eventType: EventType, slots: Date[]): string[] {
    if (eventType !== "consultation") return [];
    if (slots.length === 0) return [];
    // One session: its start is its earliest atom, as the booking doors check.
    const start = new Date(Math.min(...slots.map((slot) => slot.getTime())));
    const tooFar = isBeyondBookingHorizon(start.getTime(), Date.now())
      ? [start]
      : [];
    return tooFar.length === 0
      ? []
      : [
          `[TOO_FAR] ${tooFar.length} time(s) start more than ${MAX_BOOKING_HORIZON_DAYS} days ahead: ${tooFar.map((slot) => slot.toISOString()).join(", ")}`,
        ];
  }

  /** Every check of `validate` but the lead time. */
  private async validateBeyondLeadTime(
    eventType: EventType,
    eventId: string,
    slots: Date[],
    consultant: ConsultantAllocationData,
    config: EventConfig,
    excludeAppointmentIds: string[] | undefined,
    options: Parameters<ScheduleValidationService["validate"]>[6],
  ): Promise<ValidationResult> {
    if (!options?.overrideAvailabilityWindow) {
      const held = new Set(options?.heldSlotStarts?.map((d) => d.getTime()));
      const unheld = slots.filter((slot) => !held.has(slot.getTime()));
      const scheduleCheck = this.validateMatchesSchedule(unheld, consultant);
      if (!scheduleCheck.isValid) return scheduleCheck;
    }

    const conflictCheck = await this.validateNoConflicts(
      slots,
      consultant.userId,
      excludeAppointmentIds,
      options?.consulteeUserId,
      options?.excludeOccurrenceIds,
      options?.consultantProfileId,
    );
    if (!conflictCheck.isValid) return conflictCheck;
    let conflicts = conflictCheck.conflicts;

    // #1689 — For webinars and classes, validate ACCEPTED co-hosts' schedules
    // and existing appointments/commitments so `/validate` agrees with the
    // commit-time collaborator guard.
    if (eventType === "webinar" || eventType === "class") {
      const collabCheck = await this.validateCollaboratorSchedulesAndConflicts({
        eventType,
        eventId,
        slots,
        excludeAppointmentIds,
        options,
        initialConflicts: conflicts,
      });
      if (!collabCheck.isValid) return collabCheck;
      conflicts = collabCheck.conflicts;
    }

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
    const typed = await this.validateByType(
      eventType,
      eventId,
      slots,
      config,
      excludeAppointmentIds,
      options?.excludeOccurrenceIds,
    );
    return { ...typed, conflicts };
  }

  private async validateCollaboratorSchedulesAndConflicts(params: {
    eventType: EventType;
    eventId: string;
    slots: Date[];
    excludeAppointmentIds?: string[];
    options?: {
      overrideAvailabilityWindow?: boolean;
      excludeOccurrenceIds?: string[];
      ownAppointmentIds?: string[];
    };
    initialConflicts?: NonNullable<ValidationResult["conflicts"]>;
  }): Promise<ValidationResult> {
    const {
      eventType,
      eventId,
      slots,
      excludeAppointmentIds,
      options,
      initialConflicts,
    } = params;
    const { collaborators, ownAppointmentIds } =
      await this.loadEventCollaborators(eventType, eventId);

    if (!options?.overrideAvailabilityWindow) {
      const scheduleResult = this.validateCollaboratorSchedules(
        slots,
        collaborators,
      );
      if (scheduleResult) return scheduleResult;
    }

    // Exclude the event's own appointment(s) from the co-host check (same
    // rule as assertCollaboratorsFree) while preserving excludeOccurrenceIds
    // for released occurrences during rescheduling.
    const collabExcludeAppointmentIds = Array.from(
      new Set([
        ...(excludeAppointmentIds ?? []),
        ...(options?.ownAppointmentIds ?? []),
        ...ownAppointmentIds,
      ]),
    );

    let conflicts = initialConflicts;
    for (const collab of collaborators) {
      const collabConflictCheck = await this.validateNoConflicts(
        slots,
        collab.consultantData.userId,
        collabExcludeAppointmentIds,
        undefined,
        options?.excludeOccurrenceIds,
        collab.consultantProfileId,
      );
      if (!collabConflictCheck.isValid) {
        return {
          isValid: false,
          errors: collabConflictCheck.errors.map(
            (err) => `[COLLABORATOR_CONFLICT] Co-host ${collab.name}: ${err}`,
          ),
          warnings: collabConflictCheck.warnings,
          conflicts: [
            ...(conflicts ?? []),
            ...(collabConflictCheck.conflicts ?? []),
          ],
        };
      }
      if (collabConflictCheck.conflicts?.length) {
        conflicts = [...(conflicts ?? []), ...collabConflictCheck.conflicts];
      }
    }

    return {
      isValid: true,
      errors: [],
      warnings: [],
      conflicts,
    };
  }

  private validateCollaboratorSchedules(
    slots: Date[],
    collaborators: Array<{
      name: string;
      hasScheduleData: boolean;
      consultantData: ConsultantAllocationData;
    }>,
  ): ValidationResult | null {
    for (const collab of collaborators) {
      if (!collab.hasScheduleData) continue;
      const collabScheduleCheck = this.validateMatchesSchedule(
        slots,
        collab.consultantData,
      );
      if (!collabScheduleCheck.isValid) {
        return {
          isValid: false,
          errors: collabScheduleCheck.errors.map(
            (err) => `[COLLABORATOR_SCHEDULE] Co-host ${collab.name}: ${err}`,
          ),
          warnings: collabScheduleCheck.warnings,
        };
      }
    }
    return null;
  }

  /**
   * #1689 — Load ACCEPTED co-hosts for a webinar or class event so pre-submit
   * validation enforces both their availability windows and their conflict-free
   * calendar. Guarded with optional chaining for partial Prisma mocks in tests.
   */
  private async loadEventCollaborators(
    eventType: EventType,
    eventId: string,
  ): Promise<{
    collaborators: Array<{
      consultantProfileId: string;
      name: string;
      hasScheduleData: boolean;
      consultantData: ConsultantAllocationData;
    }>;
    ownAppointmentIds: string[];
  }> {
    if (eventType !== "webinar" && eventType !== "class") {
      return { collaborators: [], ownAppointmentIds: [] };
    }

    const { rawCollabs, ownAppointmentIds } =
      await this.fetchRawEventCollaborators(eventType, eventId);
    if (!Array.isArray(rawCollabs)) {
      return { collaborators: [], ownAppointmentIds };
    }

    const collaborators = rawCollabs
      .map((c) => this.mapRawCollaboratorRow(c))
      .filter((row): row is NonNullable<typeof row> => row !== null);

    return { collaborators, ownAppointmentIds };
  }

  private async fetchRawEventCollaborators(
    eventType: "webinar" | "class",
    eventId: string,
  ): Promise<{
    rawCollabs:
      | Array<{
          consultantProfileId: string;
          consultantProfile?: {
            id?: string;
            scheduleType?: ScheduleType;
            availabilityWindowsWeekly?: ConsultantAllocationData["availabilityWindowsWeekly"];
            availabilityWindowsCustom?: ConsultantAllocationData["availabilityWindowsCustom"];
            user?: {
              id?: string;
              name?: string | null;
              timezone?: string | null;
            } | null;
          } | null;
        }>
      | undefined;
    ownAppointmentIds: string[];
  }> {
    const collaboratorSelect = {
      where: { status: "ACCEPTED" as const },
      select: {
        consultantProfileId: true,
        consultantProfile: {
          select: {
            id: true,
            scheduleType: true,
            availabilityWindowsWeekly: true,
            availabilityWindowsCustom: true,
            user: { select: { id: true, name: true, timezone: true } },
          },
        },
      },
    };

    const eventRecord =
      eventType === "webinar"
        ? await this.prismaClient.webinar?.findUnique?.({
            where: { id: eventId },
            select: {
              webinarPlanId: true,
              appointment: { select: { id: true } },
              webinarPlan: {
                select: { id: true, collaborators: collaboratorSelect },
              },
            },
          })
        : await this.prismaClient.class?.findUnique?.({
            where: { id: eventId },
            select: {
              classPlanId: true,
              appointment: { select: { id: true } },
              classPlan: {
                select: { id: true, collaborators: collaboratorSelect },
              },
            },
          });

    const ownAppointmentIds = eventRecord?.appointment?.id
      ? [eventRecord.appointment.id]
      : [];
    const plan =
      eventRecord && "webinarPlan" in eventRecord
        ? eventRecord.webinarPlan
        : eventRecord?.classPlan;
    const planId =
      eventRecord && "webinarPlanId" in eventRecord
        ? (eventRecord.webinarPlanId ?? plan?.id)
        : (eventRecord?.classPlanId ?? plan?.id);

    let rawCollabs = plan?.collaborators;
    if (!rawCollabs && planId && this.prismaClient.collaborator?.findMany) {
      const planWhere =
        eventType === "webinar"
          ? { webinarPlanId: planId }
          : { classPlanId: planId };
      rawCollabs = await this.prismaClient.collaborator.findMany({
        where: { status: "ACCEPTED", ...planWhere },
        select: collaboratorSelect.select,
      });
    }

    return { rawCollabs, ownAppointmentIds };
  }

  private mapRawCollaboratorRow(c?: {
    consultantProfileId?: string;
    consultantProfile?: {
      id?: string;
      scheduleType?: ScheduleType;
      availabilityWindowsWeekly?: ConsultantAllocationData["availabilityWindowsWeekly"];
      availabilityWindowsCustom?: ConsultantAllocationData["availabilityWindowsCustom"];
      user?: {
        id?: string;
        name?: string | null;
        timezone?: string | null;
      } | null;
    } | null;
  }): {
    consultantProfileId: string;
    name: string;
    hasScheduleData: boolean;
    consultantData: ConsultantAllocationData;
  } | null {
    if (!c?.consultantProfileId) return null;
    const profile = c.consultantProfile;
    const hasScheduleData = Boolean(
      profile?.scheduleType &&
      (Array.isArray(profile.availabilityWindowsWeekly) ||
        Array.isArray(profile.availabilityWindowsCustom)),
    );
    return {
      consultantProfileId: c.consultantProfileId,
      name: profile?.user?.name || c.consultantProfileId,
      hasScheduleData,
      consultantData: {
        userId: profile?.user?.id || c.consultantProfileId,
        scheduleType: profile?.scheduleType ?? ScheduleType.WEEKLY,
        availabilityWindowsWeekly: profile?.availabilityWindowsWeekly ?? [],
        availabilityWindowsCustom: profile?.availabilityWindowsCustom ?? [],
        timezone: profile?.user?.timezone || "UTC",
      },
    };
  }

  private async validateByType(
    eventType: EventType,
    eventId: string,
    slots: Date[],
    config: EventConfig,
    excludeAppointmentIds?: string[],
    excludeOccurrenceIds?: string[],
  ): Promise<ValidationResult> {
    switch (eventType) {
      case "consultation":
        return this.validateConsultation(slots, config);

      case "subscription":
        return this.validateSubscription(
          eventId,
          slots,
          config,
          excludeAppointmentIds,
          excludeOccurrenceIds,
        );

      case "webinar":
        return this.validateWebinar(slots, config);

      case "class":
        // RV-5 — pass eventId + caller exclusions so the weekly-limit check can
        // seed from this class's existing confirmed slots, matching the allocator.
        return this.validateClass(
          eventId,
          slots,
          config,
          excludeAppointmentIds,
          excludeOccurrenceIds,
        );

      default:
        return {
          isValid: false,
          errors: [`[VALIDATION] Invalid event type: ${eventType}`],
          warnings: [],
        };
    }
  }

  /**
   * UNIVERSAL VALIDATOR: every slot starts at least `leadTimeMs` from now (15
   * minutes for a settled booking, 2 hours while the client still has to pay;
   * see `leadMsFor`). One cutoff for the whole batch.
   */
  private validateSlotsInFuture(
    slots: Date[],
    leadTimeMs: number,
  ): ValidationResult {
    const cutoff = Date.now() + leadTimeMs;
    const tooSoon = slots.filter((slot) => slot.getTime() <= cutoff);
    return {
      isValid: tooSoon.length === 0,
      errors:
        tooSoon.length === 0
          ? []
          : [
              `[TOO_SOON] ${tooSoon.length} time(s) start within ${Math.round(leadTimeMs / 60_000)} min: ${tooSoon.map((slot) => slot.toISOString()).join(", ")}`,
            ],
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
   * - startsAt < slotEnd: Existing slot starts before proposed ends
   * - endsAt > slot: Existing slot ends after proposed starts
   * - Together: Detects ANY time period overlap
   */
  private async validateNoConflicts(
    slots: Date[],
    consultantUserId: string,
    excludeAppointmentIds?: string[],
    // #676 AE-1 — the consultee is a participant too; an overlapping slot
    // sharing either party is a real conflict.
    consulteeUserId?: string,
    excludeOccurrenceIds?: string[],
    // Co-host arm (AE-2 #784) — see the validate() options field of the same
    // name. Absent keeps the old participant-only behavior.
    consultantProfileId?: string,
  ): Promise<ValidationResult> {
    const occurrenceExclusion =
      excludeOccurrenceIds && excludeOccurrenceIds.length > 0
        ? [{ id: { notIn: excludeOccurrenceIds } }]
        : [];
    const errors: string[] = [];
    // One clock for every liveness read below.
    const now = new Date();

    if (slots.length === 0) {
      return { isValid: true, errors: [], warnings: [] };
    }

    // FIX Issue #464: Replace N+1 per-slot queries with a single batch query.
    // Previously each slot triggered its own findFirst, causing transaction
    // timeouts (>120s) for subscriptions with thousands of slots.

    // Step 1: Compute time envelope across ALL proposed slots.
    // Slots may not be sorted (checkSlotAvailability doesn't sort),
    // so compute min/max explicitly.
    let earliestStart = slots[0].getTime();
    let latestEnd = slots[0].getTime() + SCHEDULING_INTERVAL_MS;

    for (const slot of slots) {
      const startMs = slot.getTime();
      const endMs = startMs + SCHEDULING_INTERVAL_MS;
      if (startMs < earliestStart) earliestStart = startMs;
      if (endMs > latestEnd) latestEnd = endMs;
    }

    // #676 AE-1 — a slot is a conflict if EITHER the consultant or (when
    // present) the consultee already holds an overlapping slot. One query.
    const participantIds = consulteeUserId
      ? [consultantUserId, consulteeUserId]
      : [consultantUserId];
    // A buyer who is an expert too is busy with what they host and co-host,
    // as checkout and the grid read them; their seats are in the arm above.
    const consulteeProfile = consulteeUserId
      ? await this.prismaClient.consultantProfile.findUnique({
          where: { userId: consulteeUserId },
          select: { id: true },
        })
      : null;

    // Step 2: Single query — find ALL occupied appointments overlapping the envelope
    const conflictingAppointments =
      await this.prismaClient.appointment.findMany({
        where: {
          AND: [
            // FIX Bug #15: Use centralized occupancy policy for consistent conflict detection
            { OR: buildOccupiedAppointmentFilter() },
            // Exclude the event's own appointments from conflict detection.
            // Required for "use requested slots" flow: the event's tentative
            // appointments must not be flagged as conflicts with themselves.
            ...(excludeAppointmentIds && excludeAppointmentIds.length > 0
              ? [{ NOT: { id: { in: excludeAppointmentIds } } }]
              : []),
            // #1554 / #2010 — the roster is AppointmentParticipant; the
            // occurrence window is a separate predicate on the same
            // appointment. However, hosted webinars and classes (and legacy
            // rows) are owned via plan consultantProfileId or occurrence
            // consultantProfileId without always minting a CONSULTANT
            // AppointmentParticipant row, and accepted co-host commitments
            // ride Collaborator (AE-2 #784). Include all three arms so
            // validateNoConflicts matches buildConsultantOccupancyWhere.
            {
              OR: [
                {
                  participants: {
                    some: {
                      userId: { in: participantIds },
                      ...timeHoldingParticipant(now),
                    },
                  },
                },
                ...(consultantProfileId
                  ? [
                      {
                        OR: buildOccupiedAppointmentFilter(consultantProfileId),
                      },
                      {
                        OR: buildCohostCommitmentFilter(consultantProfileId),
                      },
                      {
                        occurrences: {
                          some: {
                            consultantProfileId,
                            ...OCCUPYING_OCCURRENCE_WHERE,
                          },
                        },
                      },
                    ]
                  : []),
                ...(consulteeUserId && consulteeProfile
                  ? [
                      buildConsultantOccupancyWhere(
                        consulteeProfile.id,
                        consulteeUserId,
                        now,
                      ),
                    ]
                  : []),
              ],
            },
            {
              occurrences: {
                some: {
                  AND: [
                    { startsAt: { lt: new Date(latestEnd) } },
                    { endsAt: { gt: new Date(earliestStart) } },
                    OCCUPYING_OCCURRENCE_WHERE,
                    ...occurrenceExclusion,
                  ],
                },
              },
            },
          ],
        },
        select: {
          id: true,
          occurrences: {
            // This relation read carries the SAME predicate as the `some` filter
            // above: the JS matcher below treats every returned child as a
            // candidate conflict, so an unfiltered collection would let a
            // tombstoned slot of a qualifying appointment produce a
            // [CONFLICT] the parent-level filter just excluded.
            where: {
              AND: [
                { startsAt: { lt: new Date(latestEnd) } },
                { endsAt: { gt: new Date(earliestStart) } },
                OCCUPYING_OCCURRENCE_WHERE,
                ...occurrenceExclusion,
              ],
            },
            select: {
              startsAt: true,
              endsAt: true,
              consultantProfileId: true,
            },
          },
          // Only what the occupancy rule and the conflict detail read.
          ...LIVE_OCCUPANCY_READ,
          webinar: { select: { id: true } },
          class: { select: { id: true } },
          // Whether the booking is on the consultant's own calendar.
          participants: {
            where: timeHoldingParticipant(now, consultantUserId),
            select: { userId: true },
            take: 1,
          },
        },
      });

    // Step 3: Match conflicts back to specific proposed slots in JS. A dead
    // hold leaves its time free, and never hides a live booking on the same time.
    const liveAppointments = conflictingAppointments.filter((appt) =>
      isOccupiedByLiveAppointment(appt, now),
    );
    const conflicts: ConflictDetail[] = [];
    for (const slot of slots) {
      const slotEnd = new Date(slot.getTime() + SCHEDULING_INTERVAL_MS);

      const existingAppointment = liveAppointments.find((appt) =>
        appt.occurrences.some(
          (existingSlot) =>
            new Date(existingSlot.startsAt) < slotEnd &&
            new Date(existingSlot.endsAt) > slot,
        ),
      );

      if (existingAppointment) {
        // Time only, never whose booking: the other booking may be the
        // consultee's own with another expert. The ISO start is what the
        // validate routes extract; `conflicts` carries the structured detail.
        errors.push(`[CONFLICT] Slot already booked: ${slot.toISOString()}`);
        const onConsultantCalendar =
          existingAppointment.participants.length > 0 ||
          (consultantProfileId !== undefined &&
            existingAppointment.occurrences.some(
              (o) => o.consultantProfileId === consultantProfileId,
            ));
        conflicts.push(
          conflictDetailOf(slot, existingAppointment, onConsultantCalendar),
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
      conflicts,
    };
  }

  /**
   * UNIVERSAL VALIDATOR: every 30-minute slot sits inside one occurrence of a
   * published row, each weekly row projected through its own zone.
   */
  private validateMatchesSchedule(
    slots: Date[],
    consultant: ConsultantAllocationData,
  ): ValidationResult {
    const errors: string[] = [];

    if (consultant.scheduleType === ScheduleType.WEEKLY) {
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

      const { usable, refused } = partitionWeeklyRows(
        consultant.availabilityWindowsWeekly,
      );
      reportIncompleteWeeklyRows(refused, { op: "validate-matches-schedule" });
      const weekly = createWeeklyCoverage(usable);

      for (const slot of slots) {
        const slotDay = slot.getUTCDay();
        const slotHours = slot.getUTCHours();
        const slotMinutes = slot.getUTCMinutes();
        const matchesAvailability = weekly.covers(
          slot.getTime(),
          slot.getTime() + 30 * 60 * 1000,
        );

        if (!matchesAvailability) {
          const timeStr = `${slotHours.toString().padStart(2, "0")}:${slotMinutes.toString().padStart(2, "0")}`;
          invalidSlots.push(`${dayNames[slotDay]} at ${timeStr} UTC`);
        }
      }

      if (invalidSlots.length > 0) {
        const slotWord = invalidSlots.length === 1 ? "slot" : "slots";
        const verbTense = invalidSlots.length === 1 ? "does" : "do";
        errors.push(
          `[OUTSIDE_AVAILABILITY] The selected ${slotWord} ${verbTense} not match the consultant's available days and times. ` +
            `Please choose from the green "Available" slots shown in the calendar.`,
        );
      }
    } else {
      // Custom schedule — CONTAINMENT, the same rule the weekly arm above
      // applies. #1320: this used to test overlap
      // (`slot < availableEnd && availableStart < slotEnd`), so a 30-minute
      // atom hanging half outside a custom row passed manual allocation and
      // was then rejected by checkout, which has always required the whole
      // window to sit inside published availability. Containment still accepts
      // the case the overlap test was introduced for — an atom the calendar
      // broke out of a larger row — because such an atom is inside the row.

      let hasInvalidSlots = false;
      const invalidSlotsList: string[] = [];
      for (const slot of slots) {
        // Calculate the end time of the requested slot (30-minute slots)
        const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000);

        // Check if this slot sits wholly inside ANY available custom slot
        const isContained = consultant.availabilityWindowsCustom.some(
          (availableSlot) => {
            const availableStart = new Date(availableSlot.startsAt);
            const availableEnd = new Date(availableSlot.endsAt);
            return slot >= availableStart && slotEnd <= availableEnd;
          },
        );

        if (!isContained) {
          hasInvalidSlots = true;
          invalidSlotsList.push(slot.toISOString());
        }
      }

      if (hasInvalidSlots) {
        console.warn("[ScheduleValidationService] Invalid slots found:", {
          invalidSlots: invalidSlotsList,
        });

        const slotWord = slots.length === 1 ? "slot" : "slots";
        const verbTense = slots.length === 1 ? "is" : "are";

        // Check if this looks like a consecutive slot issue (some slots valid, some not)
        const validSlotCount = slots.filter((slot) => {
          const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000);
          return consultant.availabilityWindowsCustom.some((availableSlot) => {
            const availableStart = new Date(availableSlot.startsAt);
            const availableEnd = new Date(availableSlot.endsAt);
            return slot >= availableStart && slotEnd <= availableEnd;
          });
        }).length;
        const isConsecutiveIssue =
          validSlotCount > 0 && validSlotCount < slots.length;

        if (isConsecutiveIssue) {
          errors.push(
            `[OUTSIDE_AVAILABILITY] The consultant doesn't have enough consecutive availability for this ${slots.length === 2 ? "1-hour" : `${slots.length * 0.5}-hour`} event. ` +
              `Only ${validSlotCount} of ${slots.length} required time slots ${verbTense} available. ` +
              `The consultant needs to add more consecutive time slots to their schedule.`,
          );
        } else {
          errors.push(
            `[OUTSIDE_AVAILABILITY] The selected ${slotWord} ${verbTense} not available in the consultant's schedule. ` +
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
      const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000);
      if (slot < startDate || slotEnd > endDate) {
        errors.push(
          `[OUTSIDE_AVAILABILITY] Slot ${slot.toLocaleString()} is outside the scheduling period ` +
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
          `[VALIDATION] Slots must be consecutive. Gap detected between ${prevSlot.toLocaleString()} and ${currentSlot.toLocaleString()}`,
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
   * Rules: one consecutive block (it may cross midnight) of the required length
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
      ScheduleCalculationService.validateDuration(
        duration,
        "Consultation duration",
      );
    } catch (error) {
      // A misconfigured duration failing validation is a modelled answer
      // (bad plan config), not a fault — reported at info for visibility.
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "schedule-validation",
        expected: true,
        extra: { phase: "consultation-duration" },
      });
      return {
        isValid: false,
        errors: [
          `[VALIDATION] ${error instanceof Error ? error.message : "Invalid consultation duration"}`,
        ],
        warnings: [],
      };
    }

    // After validation, duration is guaranteed to be a valid number
    const requiredSlots = ScheduleCalculationService.getSlotsPerCall(duration!);

    // Check slot count
    if (slots.length !== requiredSlots) {
      errors.push(
        `[VALIDATION] Consultation requires exactly ${requiredSlots} slot${requiredSlots !== 1 ? "s" : ""} (${duration!} hour${duration! > 1 ? "s" : ""}) but ${slots.length} provided`,
      );
    }

    // Contiguity, not the calendar day, keeps the session one block.
    const consecutiveCheck = this.validateConsecutiveSlots(slots);
    if (!consecutiveCheck.isValid) {
      errors.push(
        "[VALIDATION] Consultation slots must be consecutive (no gaps allowed)",
      );
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
    excludeAppointmentIds?: string[],
    excludeOccurrenceIds?: string[],
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate per-session consecutiveness (matches validateClass behavior)
    // Without this, non-adjacent slots (e.g., 09:00 and 11:00) could be
    // grouped into a single session, creating appointments with time gaps
    const sessionDuration = config.sessionDurationInHours || 1;
    const slotsPerSession =
      ScheduleCalculationService.getSlotsPerCall(sessionDuration);

    if (slotsPerSession > 1) {
      const sortedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());

      for (let i = 0; i < sortedSlots.length; i += slotsPerSession) {
        const sessionSlots = sortedSlots.slice(i, i + slotsPerSession);
        const consecutiveCheck = this.validateConsecutiveSlots(sessionSlots);
        if (!consecutiveCheck.isValid) {
          const sessionNum = Math.floor(i / slotsPerSession) + 1;
          errors.push(
            `[VALIDATION] Session ${sessionNum} slots must be consecutive (no gaps allowed)`,
          );
        }
      }

      if (errors.length > 0) {
        return { isValid: false, errors, warnings };
      }
    }

    // Reject incomplete sessions (matches validateClass behavior)
    if (slotsPerSession > 1 && slots.length % slotsPerSession !== 0) {
      errors.push(
        `[VALIDATION] Subscription requires slot count to be a multiple of ${slotsPerSession} ` +
          `(${sessionDuration}-hour sessions), but ${slots.length} slots were provided`,
      );
      return { isValid: false, errors, warnings };
    }

    const validationService = new SubscriptionValidationService(
      this.prismaClient as PrismaLike,
    );

    // #1554 — one wrapper, N occurrences: the cycle and daily counts are
    // over the wrapper's live rows. The tentative rows still exist in the DB
    // during a re-allocation after a reschedule and would otherwise count as
    // "existing calls", causing a false cycle-cap violation when the
    // consultant proposes the same number of new slots.
    const subscriptionOccurrences =
      await this.prismaClient.appointmentOccurrence.findMany({
        where: { appointment: { subscriptionId }, deletedAt: null },
        select: {
          id: true,
          appointmentId: true,
          startsAt: true,
          isTentative: true,
          completionStatus: true,
        },
      });
    const excludedAppointments = new Set(excludeAppointmentIds || []);
    const excludedOccurrences = new Set([
      ...(excludeOccurrenceIds || []),
      ...subscriptionOccurrences.filter((o) => o.isTentative).map((o) => o.id),
    ]);

    const result = await validationService.validateSubscriptionSlots(
      subscriptionId,
      slots.map((s) => s.toISOString()),
      [...excludedAppointments],
      [...excludedOccurrences],
    );

    // #898 follow-up — server-side per-DAY cap (subscription ≤1/day). The
    // SubscriptionValidationService enforces the rolling cycle cap; the per-day
    // cap previously lived only in allocation selection + the client guard.
    // Constant shared with the allocator (utils/scheduling-engine/sessionCaps.ts)
    // so selection and validation can never disagree.
    const perDayErrors = this.validatePerDaySessionCap(
      subscriptionOccurrences,
      excludedAppointments,
      excludedOccurrences,
      slots,
      slotsPerSession,
      MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
      config.schedulingTimezone,
    );
    return {
      isValid: result.isValid && perDayErrors.length === 0,
      errors: [...errors, ...result.errors, ...perDayErrors],
      warnings: [...warnings, ...result.warnings],
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
      ScheduleCalculationService.validateDuration(duration, "Webinar duration");
    } catch (error) {
      // Same reasoning as validateConsultation's duration guard: a modelled
      // config-validation answer, reported at info.
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "schedule-validation",
        expected: true,
        extra: { phase: "webinar-duration" },
      });
      return {
        isValid: false,
        errors: [
          `[VALIDATION] ${error instanceof Error ? error.message : "Invalid webinar duration"}`,
        ],
        warnings: [],
      };
    }

    // After validation, duration is guaranteed to be a valid number
    const requiredSlots = ScheduleCalculationService.getSlotsPerCall(duration!);

    // Check slot count
    if (slots.length !== requiredSlots) {
      const durationText = duration! === 1 ? "1 hour" : `${duration!} hours`;
      errors.push(
        `[VALIDATION] Webinar (${durationText}) requires exactly ${requiredSlots} consecutive slot${requiredSlots > 1 ? "s" : ""}, but ${slots.length} provided`,
      );
    }

    // Check consecutive
    if (requiredSlots > 1) {
      const consecutiveCheck = this.validateConsecutiveSlots(slots);
      if (!consecutiveCheck.isValid) {
        errors.push("[VALIDATION] Webinar slots must be consecutive");
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
   *
   * RV-5 — the weekly-limit check seeds each week from this class's already
   * confirmed (non-tentative) sessions, mirroring the allocator's
   * `existingCallsPerWeek`. Without this seed a partial reschedule that proposes
   * a full week of new sessions passes validate but exceeds the real limit once
   * the surviving confirmed sessions are counted.
   *
   * @param excludeAppointmentIds - caller exclusions (e.g. the "use requested
   *   slots" flow). Merged with this class's own tentative appointments so a
   *   tentative session being replaced is never counted toward the seed.
   */
  private async validateClass(
    classId: string,
    slots: Date[],
    config: EventConfig,
    excludeAppointmentIds?: string[],
    excludeOccurrenceIds?: string[],
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate configuration
    if (!config.sessionsPerWeek) {
      return {
        isValid: false,
        errors: [
          "[VALIDATION] Classes per week is required for class validation",
        ],
        warnings: [],
      };
    }

    if (!config.sessionDurationInHours) {
      return {
        isValid: false,
        errors: [
          "[VALIDATION] Session duration is required for class validation",
        ],
        warnings: [],
      };
    }

    // FIX: Validate duration before use
    try {
      ScheduleCalculationService.validateDuration(
        config.sessionDurationInHours,
        "Session duration",
      );
    } catch (error) {
      // Same reasoning as the consultation/webinar duration guards.
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "schedule-validation",
        expected: true,
        extra: { phase: "class-session-duration" },
      });
      return {
        isValid: false,
        errors: [
          `[VALIDATION] ${error instanceof Error ? error.message : "Invalid session duration"}`,
        ],
        warnings: [],
      };
    }

    const slotsPerSession = ScheduleCalculationService.getSlotsPerCall(
      config.sessionDurationInHours,
    );

    // Validate slot count is a multiple of slotsPerSession (incomplete session check)
    if (slots.length % slotsPerSession !== 0) {
      errors.push(
        `[VALIDATION] ${slots.length} slots provided but needs multiples of ${slotsPerSession} (incomplete session)`,
      );
    }

    // Validate per-session consecutiveness (matches subscription validation).
    // Grouping by UTC day is incorrect because cross-midnight sessions split
    // slots across two UTC dates, causing false "non-consecutive" errors.
    if (slotsPerSession > 1) {
      errors.push(
        ...this.validateClassSessionConsecutiveness(slots, slotsPerSession),
      );
    }

    // Seed each day with this class's surviving confirmed sessions.
    // #1554 — one wrapper, N occurrences: fetch the class's live rows and
    // exclude the tentative ones (and any caller exclusions) that are about
    // to be replaced, so the seed reflects exactly the calls the allocator
    // would also count.
    const classOccurrences =
      await this.prismaClient.appointmentOccurrence.findMany({
        where: { appointment: { classId }, deletedAt: null },
        select: {
          id: true,
          appointmentId: true,
          startsAt: true,
          isTentative: true,
          completionStatus: true,
        },
      });
    const excludedAppointments = new Set(excludeAppointmentIds || []);
    const excludedOccurrences = new Set([
      ...(excludeOccurrenceIds || []),
      ...classOccurrences.filter((o) => o.isTentative).map((o) => o.id),
    ]);

    // A class may meet more often than its plan's weekly count; the per-day
    // cap, shared with the allocator (sessionCaps.ts), still applies.
    errors.push(
      ...this.validatePerDaySessionCap(
        classOccurrences,
        excludedAppointments,
        excludedOccurrences,
        slots,
        slotsPerSession,
        MAX_CLASS_SESSIONS_PER_DAY,
        config.schedulingTimezone,
      ),
    );

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private validateClassSessionConsecutiveness(
    slots: Date[],
    slotsPerSession: number,
  ): string[] {
    const errors: string[] = [];
    const sortedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());

    for (let i = 0; i < sortedSlots.length; i += slotsPerSession) {
      const sessionSlots = sortedSlots.slice(i, i + slotsPerSession);
      const consecutiveCheck = this.validateConsecutiveSlots(sessionSlots);
      if (!consecutiveCheck.isValid) {
        const sessionNum = Math.floor(i / slotsPerSession) + 1;
        errors.push(
          `[VALIDATION] Session ${sessionNum} slots must be consecutive (no gaps allowed)`,
        );
      }
    }
    return errors;
  }

  /**
   * Whether a stored row still counts as an existing session for the daily
   * cap: live, not tentative, and not one of the rows the caller is replacing.
   */
  private countsAsExistingSession(
    row: ExistingOccurrenceRow,
    excludedAppointments: Set<string>,
    excludedOccurrences: Set<string>,
  ): boolean {
    if (excludedAppointments.has(row.appointmentId)) return false;
    if (excludedOccurrences.has(row.id)) return false;
    if (row.isTentative) return false;
    return !isDeadOccurrence(row);
  }

  /**
   * #898 follow-up — server-side per-DAY session cap (subscription 1/day,
   * class 2/day). Keyed by the event's scheduling-timezone day via
   * ScheduleCalculationService.dayKey (ADR B9) — the same key the client guards
   * and auto-allocate use. The old toDateString() key depended on the
   * server's local timezone, so verdicts could differ between environments
   * and from the client. One occurrence = one session (#1554), keyed by its
   * day; tentative, dead and excluded rows are skipped.
   */
  private validatePerDaySessionCap(
    existingOccurrences: ExistingOccurrenceRow[],
    excludedAppointments: Set<string>,
    excludedOccurrences: Set<string>,
    slots: Date[],
    slotsPerSession: number,
    maxPerDay: number,
    schedulingTimezone?: string,
  ): string[] {
    const errors: string[] = [];
    const existingPerDay = new Map<string, number>();
    for (const row of existingOccurrences) {
      if (
        !this.countsAsExistingSession(
          row,
          excludedAppointments,
          excludedOccurrences,
        )
      )
        continue;
      const dayKey = ScheduleCalculationService.dayKey(
        new Date(row.startsAt),
        schedulingTimezone,
      );
      existingPerDay.set(dayKey, (existingPerDay.get(dayKey) || 0) + 1);
    }
    // Sort a copy first — stepping by slotsPerSession assumes session-ordered
    // input, and requested-mode slots come from the DB unordered.
    const orderedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());
    const proposedPerDay = new Map<string, number>();
    for (let i = 0; i < orderedSlots.length; i += slotsPerSession) {
      const dayKey = ScheduleCalculationService.dayKey(
        orderedSlots[i],
        schedulingTimezone,
      );
      proposedPerDay.set(dayKey, (proposedPerDay.get(dayKey) || 0) + 1);
    }
    proposedPerDay.forEach((count, dayKey) => {
      const total = count + (existingPerDay.get(dayKey) || 0);
      if (total > maxPerDay) {
        errors.push(
          `[DAILY_LIMIT] ${dayKey} has ${total} session(s) but the max is ${maxPerDay} per day`,
        );
      }
    });
    return errors;
  }
}
