/**
 * Slot Allocation Service
 *
 * Unified allocation algorithms for all event types.
 * Handles auto, manual, and requested slot allocation.
 */

import { reportSentryError } from "@/lib/observability/report";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import {
  liveParticipant,
  recordParticipants,
} from "@/lib/booking/participants";
import prisma, {
  type Tx,
  type PrismaLike,
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { Prisma, ScheduleType } from "@prisma/client";
import { addMonths } from "date-fns";
import {
  AllocationRequest,
  AllocationResult,
  type AllocationTxOptions,
  EventType,
  ConsultantAllocationData,
  EventConfig,
  isRecurringEventType,
  isReleasedForReschedule,
} from "./types";
import { ScheduleCalculationService } from "./ScheduleCalculationService";
import {
  intervalCountOf,
  intervalStartsOf,
  isDeadOccurrence,
  nextOrdinal,
  SCHEDULING_INTERVAL_MS,
} from "@/lib/appointments/occurrences";
import { recomputeEarningsHold } from "@/lib/payments/payouts/earnings-hold";
import {
  matchesPreferredDays,
  maxPreferenceScore,
  type AllocationPreference,
} from "./preferenceScoring";
import {
  ScheduleValidationService,
  isOccupiedByLiveAppointment,
} from "./ScheduleValidationService";
import {
  buildConsultantOccupancyWhere,
  buildOccupiedAppointmentFilter,
  OCCUPYING_OCCURRENCE_WHERE,
} from "./occupancyPolicy";
import {
  MAX_CLASS_SESSIONS_PER_DAY,
  MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
} from "./sessionCaps";
import {
  lockAutoAllocate,
  unlockAutoAllocate,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  type ApprovalLock,
} from "@/utils/appointmentlock";
import { isExclusionViolation, isUniqueViolation } from "@/lib/db/pg-errors";
import { isHostMove, type FreedWindow } from "@/lib/booking/class-series";
import { TWENTY_FOUR_HOURS_IN_MS } from "./slotTimeUtils";
import { createSearchBudget } from "./availability-search";
import {
  partitionWeeklyRows,
  weeklyRowIntervalsInRange,
} from "@/utils/schedule/weekly-projection";
import { reportIncompleteWeeklyRows } from "@/lib/scheduling/incomplete-weekly-rows";
import {
  AllocationValidationError,
  AllocationNotFoundError,
  AllocationConflictError,
  SlotShortageError,
} from "./errors";
import {
  recordBookingUtilization,
  reverseBookingUtilization,
} from "@/lib/api/organizations/program-helpers";
import { attemptTrigger } from "@/lib/novu";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  matchCustomSlotToDay,
  sortWeeklyByNextOccurrence,
} from "@/lib/booking/allocation/search/recurrence";
import {
  DAY_MS,
  ALLOCATOR_SEARCH_TIME_BUDGET_MS,
  type AllocationWalkContext,
} from "@/lib/booking/allocation/search/constants";
import {
  projectableWeeklyRows,
  reportSearchBudgetSpent,
} from "@/lib/booking/allocation/search/window-walk";
import {
  bestFittingBlockInRow,
  bestBlockForSingleSession,
} from "@/lib/booking/allocation/search/blocks";
import {
  classifyError,
  isModeledOutcome,
} from "@/lib/booking/allocation/classify";
import { stageAllocationNotices } from "@/lib/booking/allocation/notify";
import {
  getConsulteeUserId,
  getEventRelationField,
  getConsultantProfileId,
  getAppointmentType,
} from "@/lib/booking/allocation/identity";
import {
  updateEventStatus,
  fetchEventData,
  holdUntilPaid,
} from "@/lib/booking/allocation/event-data";
import {
  confirmedIntervalsOf,
  releasedSessionCountOf,
  releasedOccurrenceIdsOf,
  topUpTargetSessions,
  resolveAllocationModeAndPastSlots,
  isCarriedTentativeOccurrence,
  tentativeSlotCountOf,
} from "@/lib/booking/allocation/counts";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";
import {
  assertHeldSessionCountInTx,
  assertExpectedTentativeSlotCount,
  assertExpectedTentativeSlotCountInTx,
  assertNoConfirmedSlots,
  guardAllocationInTx,
  probeConfirmedOverlap,
} from "@/lib/booking/allocation/guards";
import {
  resolveConsumedPreferenceRequests,
  findAllocationPreference,
} from "@/lib/booking/allocation/preference";
import { findIdempotentAllocation } from "@/lib/booking/allocation/idempotency";
import { assertCollaboratorsFree } from "@/lib/booking/allocation/collaborators";

/**
 * Main service for slot allocation operations
 */
export class SchedulingService {
  /**
   * Main entry point for slot allocation
   * Routes to appropriate allocation method based on mode
   */
  static async allocate(request: AllocationRequest): Promise<AllocationResult> {
    try {
      const { stagedNotices, ...result } = await this.dispatch(request);
      // PR 2c — the allocation-time notification (audit G1 / B9's promised
      // completion): APPOINTMENT_BOOKED was deliberately skipped at payment
      // when no slots existed; THIS is where the times finally exist, so both
      // parties hear about them from every caller path (routes, auto-confirm,
      // accept-proposal).
      // #1697 item 5 — the outbox rows were STAGED inside the write
      // transaction (ADR 27), so a rollback takes them and an instance freeze
      // after the response cannot lose them: the relay delivers what this
      // attempt does not. Only the attempt is post-commit and best-effort.
      // #1206 — a top-up that placed nothing stages nothing (see the
      // suppressor at the staging site), so nothing is attempted here.
      if (stagedNotices && stagedNotices.length > 0) {
        scheduleAfter(async () => {
          for (const staged of stagedNotices) await attemptTrigger(staged);
        }, "scheduling.allocate.post-commit");
      }
      return result;
    } catch (error) {
      const { errorCode, httpStatus } = classifyError(error);
      // Full-coverage policy: every error reaching here is reported, modelled
      // outcome or not, so volume/pattern of ordinary answers (slot taken,
      // limit reached, lost CAS race) is visible in Sentry too — but at
      // info + expected:true so a dashboard scan can't mistake "no slots
      // available" for a database failure. Real faults keep the default
      // error level with no expected tag.
      // #1721 QA — every 4xx classification is an answer, including the
      // untyped legacy throws classifyError maps by message; only a 5xx is a fault.
      const modeled = isModeledOutcome(error) || httpStatus < 500;
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "scheduling",
        expected: modeled,
        extra: {
          mode: request.mode,
          eventType: request.eventType,
          eventId: request.eventId,
          errorCode,
        },
      });
      return {
        success: false,
        // 5xx answers never carry raw error text: pool timeouts, Prisma
        // validation dumps, and constraint internals are operator detail
        // (already in Sentry above), not user copy. Indeterminate wording —
        // a 500 can fire on either side of the commit.
        error:
          httpStatus >= 500
            ? "Couldn't save these times — check whether they appear, then retry."
            : error instanceof Error
              ? error.message
              : "Allocation failed",
        errorCode,
        httpStatus,
        // #1206 — a shortage refusal carries the count the client needs to
        // offer "allocate N now, the rest when availability opens".
        ...(error instanceof SlotShortageError
          ? {
              placeableSessions: error.placeableSessions,
              requiredSessions: error.requiredSessions,
            }
          : {}),
      };
    }
  }

  /**
   * Mode router extracted so allocate() can post-process success uniformly
   * (PR 2c notification) without each mode knowing about it.
   */
  private static async dispatch(
    request: AllocationRequest,
  ): Promise<AllocationResult> {
    const txOptions: AllocationTxOptions = {
      approvableFrom: request.approvableFrom,
      inTx: request.inTx,
    };
    switch (request.mode) {
      case "auto":
        return await this.autoAllocate(
          request.eventType,
          request.eventId,
          request.idempotencyKey,
          request.initialAllocation,
          request.expectedTentativeSlotCount,
          request.allowPartial,
          request.topUp,
          request.excludeRescheduleRequestId,
          txOptions,
        );

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
          request.idempotencyKey,
          request.initialAllocation,
          request.wideLock,
          request.expectedTentativeSlotCount,
          request.excludeRescheduleRequestId,
          // The consultant explicitly accepting these times as-is. Gated to
          // the event consultant by the route (canOverride) before dispatch.
          request.override,
          request.allowPartial,
          request.topUp,
          txOptions,
        );

      case "requested":
        return await this.useRequestedSlots(
          request.eventType,
          request.eventId,
          request.initialAllocation,
          request.idempotencyKey,
          request.override,
          request.expectedTentativeSlotCount,
          txOptions,
        );

      default:
        return {
          success: false,
          error: `Invalid allocation mode: ${request.mode}`,
          errorCode: "INVALID_MODE",
          httpStatus: 400,
        };
    }
  }

  private static async autoAllocate(
    eventType: EventType,
    eventId: string,
    idempotencyKey?: string,
    initialAllocation?: boolean,
    expectedTentativeSlotCount?: number,
    /**
     * #1206 — place every session that fits and leave the rest for the hourly
     * retry sweep. Only recurring events can be partial; a consultation or
     * webinar is one session, so `findAvailableSlots` reports 0 placeable and
     * the flag changes nothing.
     */
    allowPartial = false,
    /**
     * #1206 — top up an event a partial allocation left short: place only the
     * missing sessions and treat every confirmed appointment as fixed. See
     * `AllocationRequest.topUp` for why this is not the default.
     */
    topUp = false,
    /**
     * #1340 — see `AllocationRequest.excludeRescheduleRequestId`: the proposal
     * this run is confirming must not be declined as superseded by its own
     * times.
     */
    excludeRescheduleRequestId?: string,
    txOptions: AllocationTxOptions = {},
  ): Promise<AllocationResult> {
    // #837 — return the prior batch on a double-submit before doing any work.
    const replay = await findIdempotentAllocation(
      eventType,
      eventId,
      idempotencyKey,
    );
    if (replay) return replay;

    // Pre-fetch consultantProfileId for lock key (lightweight, outside transaction)
    const consultantProfileId = await getConsultantProfileId(
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
    // #898 follow-up — also serialize on the consultee so one person can't be
    // booked across two consultants concurrently (the GiST overlap guard is
    // consultant-keyed). Lock order: consultant → consultee.
    let consulteeLock: ApprovalLock | null = null;
    try {
      const consulteeLockUserId = await getConsulteeUserId(eventType, eventId);
      if (consulteeLockUserId) {
        consulteeLock = await lockConsulteeBooking(consulteeLockUserId);
      }

      // #837 TOCTOU — the pre-lock replay check can miss a concurrent first
      // submit that stamped its key while we waited on the lock. Re-check now
      // that we hold the locks so the loser replays the winner's batch instead
      // of racing into the unique-constraint 409.
      const lockedReplay = await findIdempotentAllocation(
        eventType,
        eventId,
        idempotencyKey,
      );
      if (lockedReplay) return lockedReplay;

      // Multi-tab guard: a fresh dialog allocation must 409 if another
      // session already allocated this event (re-checked in-txn below).
      // #1766 — a subscription decides after its rows are read: with held
      // sessions the next cycle appends, so the flag is ignored there.
      if (initialAllocation && eventType !== "subscription") {
        await assertNoConfirmedSlots(prisma, eventType, eventId);
      }

      // #908 — read/search/validate run OUTSIDE the write transaction, but still
      // UNDER the locks acquired above. An interactive txn pins its pooled
      // connection for its whole duration (incl. the JS between queries); doing
      // the heavy O(window) availability work here instead frees the pool so the
      // short write txn below can actually start (the old single-txn shape 500'd
      // on "Unable to start a transaction in the given time").
      const eventData = await fetchEventData(prisma, eventType, eventId);
      if (!eventData) {
        throw new AllocationNotFoundError(`${eventType} not found`);
      }

      const { consultant, config, consulteeUserId, organizationId, planId } =
        eventData;

      // CRITICAL FIX: Check for existing appointments to detect reschedule scenario
      // If tentative slots exist, this is a reschedule and we should preserve the original slot count
      const relationField = getEventRelationField(eventType);
      const existingAppointments: AppointmentWithSlots[] =
        await prisma.appointment.findMany({
          where: {
            [`${relationField}Id`]: eventId,
          } as Prisma.AppointmentWhereInput,
          include: { occurrences: true },
        });

      // Confirmed coverage in 30-minute INTERVALS: the guards below compare
      // it with calculateRequiredSlots, which counts intervals, while a row is
      // one whole call since #1554. The tentative count stays in rows — that
      // is what the page's expectedTentativeSlotCount is measured in.
      const existingNonTentativeSlotCount =
        confirmedIntervalsOf(existingAppointments);
      // #1012 — before any delete+recreate, confirm the page's view of the
      // tentative set still matches the database. Same predicate as the in-txn
      // re-read (see tentativeSlotCountOf).
      assertExpectedTentativeSlotCount(
        tentativeSlotCountOf(existingAppointments),
        expectedTentativeSlotCount,
      );
      // A reschedule is a live RELEASE (tentative + RESCHEDULED), not mere
      // tentativeness: fresh requests already carry tentative holds.
      const isReschedule = releasedSessionCountOf(existingAppointments) > 0;

      // ADR B10, derived rather than trusted. The client set initialAllocation
      // only when tentativeSlotCount === 0, but EVERY pending request already
      // carries tentative slots (request-for-approval and unpaid checkout both
      // create them that way), so the flag was never true for a consultation
      // and the multi-tab guard never ran. Having no CONFIRMED slot is the real
      // "not allocated yet" condition. This matters most across modes: auto
      // takes a consultant-wide lock and a cap-less manual one a day-sharded
      // key (#860, narrowed by #1319), so two tabs are only serialized by the
      // in-txn advisory lock this gates.
      const isFreshAllocation =
        initialAllocation === true || existingNonTentativeSlotCount === 0;

      const slotsPerCall = ScheduleCalculationService.getSlotsPerCall(
        config.sessionDurationInHours || config.durationInHours || 1,
      );

      const {
        existingConfirmedSessionCount,
        isTopUp,
        pastConfirmedSlotCount,
        isInProgressReallocation,
      } = resolveAllocationModeAndPastSlots(
        eventType,
        existingAppointments,
        existingNonTentativeSlotCount,
        isReschedule,
        topUp,
      );

      const topUpPlanSessions = isTopUp
        ? topUpTargetSessions(
            eventType,
            config,
            existingConfirmedSessionCount,
            slotsPerCall,
          )
        : 0;
      if (initialAllocation && eventType === "subscription" && !isTopUp) {
        await assertNoConfirmedSlots(prisma, eventType, eventId);
      }
      /**
       * The answer a top-up gives when it writes nothing — the plan is already
       * whole, or the consultant's availability still has no room for the rest.
       * `placedSessions` is this run's placements, hence 0; the notification
       * suppressor fires on `noChange` before any template can read it.
       */
      const topUpNoChange = (): AllocationResult => {
        const unplacedSessions = Math.max(
          topUpPlanSessions - existingConfirmedSessionCount,
          0,
        );
        return {
          success: true,
          appointments: [],
          // Derived from the shortfall, so a whole plan never reads as partial.
          partial: unplacedSessions > 0,
          noChange: true,
          placedSessions: 0,
          requiredSessions: topUpPlanSessions,
          unplacedSessions,
        };
      };

      // Guard: reject re-allocation when event is already fully scheduled.
      // Applies to all event types (webinar, class, subscription) to prevent
      // concurrent auto-allocate calls from creating duplicate session sets.
      // For in-progress reallocation (recurring only), only count FUTURE confirmed slots.
      if (!isReschedule && existingNonTentativeSlotCount > 0) {
        if (isTopUp) {
          // A top-up neither deletes nor re-plans, so a complete event is an
          // answer rather than a conflict: the hourly sweep must be able to
          // pass over one without raising an error.
          if (existingConfirmedSessionCount >= topUpPlanSessions) {
            return topUpNoChange();
          }
        } else {
          const requiredForGuard =
            ScheduleCalculationService.calculateRequiredSlots(
              eventType,
              config,
            );
          const futureNonTentativeSlotCount =
            existingNonTentativeSlotCount - pastConfirmedSlotCount;
          if (
            !isInProgressReallocation &&
            existingNonTentativeSlotCount >= requiredForGuard
          ) {
            throw new AllocationConflictError(
              `Event is already fully allocated with ${existingNonTentativeSlotCount} confirmed slot(s).`,
              "ALREADY_ALLOCATED",
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
              "ALREADY_ALLOCATED",
            );
          }
        }
      }

      // What to leave out of conflict detection and the weekly/daily limits.
      // #1554 — the wrapper survives a reschedule, so a reschedule excludes
      // the TENTATIVE OCCURRENCES being replaced (its confirmed calls still
      // block and still count); initial/in-progress allocation excludes the
      // whole wrapper (deleted or rebuilt); #1206 top-up excludes NOTHING —
      // every confirmed session survives this run, so its interval must keep
      // blocking candidates and its week and day must keep counting.
      const appointmentIdsToExclude =
        isReschedule || isTopUp ? [] : existingAppointments.map((a) => a.id);
      const occurrenceIdsToExclude = isReschedule
        ? releasedOccurrenceIdsOf(existingAppointments)
        : [];
      // The event's own wrapper never clashes with itself for a co-host.
      const ownAppointmentIds = existingAppointments.map((a) => a.id);

      // Calculate required slots
      let requiredSlots: number;
      if (isReschedule) {
        // Expected count = (live RELEASED sessions) × slotsPerCall = the number
        // of SESSIONS being rescheduled (1 Appointment = 1 session). Equals
        // calculateRequiredSlots for a FULL reschedule — preserving the class
        // crud-with-plan case (commit 2b6be4c1, 1 full-duration tentative row per
        // session) — but correctly smaller for a PARTIAL reschedule (e.g. 2 of 10),
        // which calculateRequiredSlots (the full total) would over-allocate.
        const rescheduleSessions = releasedSessionCountOf(existingAppointments);
        requiredSlots = rescheduleSessions * slotsPerCall;
      } else {
        const fullRequired = ScheduleCalculationService.calculateRequiredSlots(
          eventType,
          config,
        );
        // #1206 — a top-up owes the plan's total minus every session already
        // confirmed, past ones included: a delivered session is not owed twice,
        // and a future one is preserved rather than replanned.
        if (isTopUp) {
          requiredSlots =
            (topUpPlanSessions - existingConfirmedSessionCount) * slotsPerCall;
        } else {
          // For in-progress reallocation, only allocate future slots
          requiredSlots = isInProgressReallocation
            ? fullRequired - pastConfirmedSlotCount
            : fullRequired;
        }
      }

      // #939 review — the in-progress guard above already rejects the
      // fully-confirmed case, but assert locally so requiredSlots can never
      // reach findAvailableSlots as <= 0 (which would leave selectedSlots[0]
      // undefined in updateEventStatus).
      if (requiredSlots <= 0) {
        throw new AllocationValidationError(
          "No new slots need to be allocated; all required sessions are already confirmed.",
        );
      }

      // #1065 — captured BEFORE the write txn deletes these rows. Empty for a
      // fresh allocation, which is exactly when a preference must not apply.
      const releasedOccurrenceIds =
        releasedOccurrenceIdsOf(existingAppointments);
      const preference = await findAllocationPreference(releasedOccurrenceIds);

      // Find available slots (read-only; runs out-of-txn under the locks)
      // Pass appointmentIdsToExclude so their slots are excluded from bookedSlots
      // Pass existingAppointments so sessionsPerWeek is scoped to this event only
      let selectedSlots: Date[];
      try {
        selectedSlots = await this.findAvailableSlots(
          prisma,
          consultant,
          requiredSlots,
          slotsPerCall,
          eventType,
          config,
          appointmentIdsToExclude,
          existingAppointments,
          consulteeUserId, // #898 — pick slots free for the consultee too
          consultantProfileId,
          preference,
          eventId, // #1194 — names the event in the row-truncation warning
          // #1206 — never on a reschedule: its tentative rows ARE the sessions
          // being moved, and placing fewer would delete the remainder outright
          // instead of leaving it pending.
          allowPartial && isRecurringEventType(eventType) && !isReschedule,
          occurrenceIdsToExclude,
        );
      } catch (error) {
        // #1206 — with `allowPartial` on, a shortage is only raised when the
        // search could place NOTHING. For the hourly top-up sweep that is the
        // ordinary answer ("still no room"), not a refusal worth reporting; a
        // top-up WITHOUT allowPartial keeps the typed SLOT_SHORTAGE so the
        // consultant's dialog can still offer to place what fits.
        if (isTopUp && allowPartial && error instanceof SlotShortageError) {
          return topUpNoChange();
        }
        throw error;
      }

      // Validate (read-only; runs out-of-txn under the locks)
      // Pass the exclusions so the rows being replaced don't trigger false conflicts
      const validation = await new ScheduleValidationService(prisma).validate(
        eventType,
        eventId,
        selectedSlots,
        consultant,
        config,
        appointmentIdsToExclude,
        // #676 AE-1 — also check the consultee's calendar
        {
          consulteeUserId,
          excludeOccurrenceIds: occurrenceIdsToExclude,
          // Co-host arm: the consultant's own ACCEPTED seats occupy too.
          consultantProfileId,
        },
      );

      if (!validation.isValid) {
        throw new AllocationValidationError(
          `Validation failed: ${validation.errors.join("; ")}`,
        );
      }

      // #1206 — whole sessions, the unit the consultant and the consultee both
      // read. `findAvailableSlots` only ever emits complete sessions, so both
      // divisions are exact. A partial run leaves the request APPROVED with
      // fewer sessions than the plan; the shortfall is derived here and at
      // read time, never stored.
      //
      // A top-up reports against the PLAN rather than against this run,
      // because that is what the consultee's notice has to say: the sessions
      // already on their calendar count as scheduled, and the shortfall is
      // what is left after this run adds to them.
      const alreadyScheduledSessions = isTopUp
        ? existingConfirmedSessionCount
        : 0;
      const placedSessions =
        alreadyScheduledSessions +
        Math.floor(selectedSlots.length / slotsPerCall);
      const requestedSessions = isTopUp
        ? topUpPlanSessions
        : Math.ceil(requiredSlots / slotsPerCall);
      const partialPlacement = placedSessions < requestedSessions;

      // SHORT write-only transaction. The heavy reads above no longer hold a
      // connection, so this can start promptly; an explicit maxWait still
      // absorbs transient pool spikes (concurrency is bounded by the locks +
      // the route's eventMutationLimiter).
      return await prisma.$transaction(
        async (tx) => {
          // #1692 — per-event serialisation first, so every re-check below
          // reads what the previous writer committed; a same-key double
          // submit replays instead of 409ing (see guardAllocationInTx).
          const lockedReplay = await guardAllocationInTx(
            tx,
            eventType,
            eventId,
            idempotencyKey,
            // #1766 — a next-cycle append is not a fresh allocation.
            isFreshAllocation && !isTopUp,
          );
          if (lockedReplay) return lockedReplay;
          // #1766 — a stale tab must not append a second cycle: re-count the
          // held sessions under the advisory lock before writing.
          if (isTopUp) {
            await assertHeldSessionCountInTx(
              tx,
              eventType,
              eventId,
              existingConfirmedSessionCount,
            );
          }

          // Defense-in-depth: re-check conflicts INSIDE the txn (envelope-scoped,
          // indexed, cheap). The reads ran out-of-txn under the locks, so for
          // allocate() flows no slot can shift; this catches a concurrent
          // non-allocate insert (e.g. checkout) and turns the common race into a
          // clean typed conflict before the #440 GiST constraint would raise.
          const recheck = await new ScheduleValidationService(
            tx,
          ).revalidateConflicts(
            selectedSlots,
            consultant.userId,
            appointmentIdsToExclude,
            consulteeUserId,
            occurrenceIdsToExclude,
            consultantProfileId,
          );
          if (!recheck.isValid) {
            throw new AllocationConflictError(
              `Slot taken during allocation: ${recheck.errors.join("; ")}`,
              "SLOT_TAKEN",
            );
          }

          // AE-2 (#784) — a webinar/class co-host is not a slot participant, so
          // nothing else here can see their clash. Checked in-txn, next to the
          // conflict recheck, so the read matches the write that follows.
          await assertCollaboratorsFree(
            tx,
            eventType,
            planId,
            selectedSlots,
            ownAppointmentIds,
          );

          // #1012 — re-assert tentative count under the write txn before
          // delete (the advisory lock above makes this read post-winner).
          await assertExpectedTentativeSlotCountInTx(
            tx,
            eventType,
            eventId,
            expectedTentativeSlotCount,
          );

          // CRITICAL FIX: Delete existing appointments before creating new ones
          // For reschedules: only delete appointments with tentative slots (preserve confirmed ones)
          // For in-progress: only delete future slots (preserve past confirmed ones)
          // For initial allocation: delete all (shouldn't be any, but safety measure)
          // #1206 top-up: nothing is deleted at all, which is the whole point —
          // the confirmed sessions and the Payment rows hanging off them are
          // exactly what the delete-and-replan path was destroying.
          let enrolledUserIds: string[] = [];
          let deletedAppointmentIds: string[] = [];
          let freedOrdinals: number[] = [];
          let freedWindows: FreedWindow[] = [];
          let reusableAppointmentId: string | undefined;
          if (isTopUp) {
            // A group event's learners live ONLY on the slot↔user M2M, and the
            // ids normally come out of the rows the delete freed. With nothing
            // freed, read them off the surviving sessions instead, or the new
            // ones would have no attendees. A subscription's consultee is
            // connected by createAppointments, so it needs no such read.
            if (eventType === "class") {
              enrolledUserIds =
                await SchedulingService.collectEventParticipantIds(
                  tx,
                  eventType,
                  eventId,
                );
            }
          } else {
            ({
              enrolledUserIds,
              deletedAppointmentIds,
              freedOrdinals,
              freedWindows,
              reusableAppointmentId,
            } = await this.deleteExistingAppointments(
              tx,
              eventType,
              eventId,
              isReschedule,
              isInProgressReallocation,
            ));
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
            organizationId,
            reusableAppointmentId, // #898 — REUSE preserved 1:1 appointment
            idempotencyKey, // #837
            freedOrdinals, // #1554 — replacements keep their position
            { isReschedule, freedWindows }, // #1780 decision 9 — moves
          );

          // Reconnect enrolled users to new slots (for group events like classes)
          if (enrolledUserIds.length > 0) {
            await this.reconnectEnrolledUsers(
              tx,
              appointments,
              enrolledUserIds,
              consultant.userId,
              organizationId,
            );
          }

          // Update event status
          const outcome = await updateEventStatus(
            tx,
            eventType,
            eventId,
            selectedSlots[0],
            config,
            txOptions.approvableFrom,
          );
          await holdUntilPaid(tx, appointments, outcome);

          // #1065 — these times ARE the answer to the preference, so close it
          // here rather than leaving it open for the expiry sweep to mislabel.
          await resolveConsumedPreferenceRequests(
            tx,
            releasedOccurrenceIds,
            excludeRescheduleRequestId,
          );
          await txOptions.inTx?.(tx);

          // #1697 item 5 — staged in THIS transaction; attempted after commit.
          const stagedNotices = await stageAllocationNotices(
            tx,
            eventType,
            eventId,
            partialPlacement
              ? {
                  partial: true,
                  placedSessions,
                  requiredSessions: requestedSessions,
                  unplacedSessions: requestedSessions - placedSessions,
                }
              : undefined,
            outcome,
          );

          return {
            success: true,
            outcome,
            appointments,
            warnings: validation.warnings,
            deletedAppointmentIds, // AE-4
            stagedNotices,
            // #1206 — the counts the toast, the consultee notice and the
            // hourly retry sweep all read.
            ...(partialPlacement
              ? {
                  partial: true,
                  placedSessions,
                  requiredSessions: requestedSessions,
                  unplacedSessions: requestedSessions - placedSessions,
                }
              : {}),
          };
        },
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
    } finally {
      if (consulteeLock) await unlockConsulteeBooking(consulteeLock);
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
    idempotencyKey?: string,
    initialAllocation?: boolean,
    wideLock?: boolean,
    expectedTentativeSlotCount?: number,
    /**
     * #1340 — see `AllocationRequest.excludeRescheduleRequestId`. Both
     * reschedule confirmation paths reach the allocator in manual mode.
     */
    excludeRescheduleRequestId?: string,
    /**
     * The consultant explicitly accepting the selected times as-is: skips
     * ONLY the availability-window check. Conflicts, caps, scheduling period
     * and future-time all still apply.
     */
    override?: boolean,
    /**
     * #1692 Item 4 — allow manual placement of fewer than the full required
     * sessions on recurring events (matching autoAllocate's #1206 behavior).
     */
    allowPartial = false,
    /**
     * #1206 / #1766 — additive top-up on recurring events (preserves existing
     * confirmed sessions and places only the remaining sessions).
     */
    topUp = false,
    txOptions: AllocationTxOptions = {},
  ): Promise<AllocationResult> {
    // #837 — return the prior batch on a double-submit before doing any work.
    // A same-key submit with different slots is a client bug, not a retry:
    // reject with 422 rather than replaying another payload's batch.
    const replay = await findIdempotentAllocation(
      eventType,
      eventId,
      idempotencyKey,
      slotStrings,
    );
    if (replay) return replay;

    // Pre-fetch consultantProfileId for lock key (lightweight, outside transaction)
    const consultantProfileId = await getConsultantProfileId(
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
    // #860 — shard the lock by the earliest target day so allocations for
    // different days don't serialize; same-day (the actual duplicate risk)
    // still shares the key.
    //
    // #440's `occurrence_no_confirmed_overlap` GiST constraint backstops only what it
    // is keyed on: two confirmed slots of one consultant covering the same
    // instant. It cannot see a COUNT, so it is no backstop for a weekly cap —
    // and the sessions that race that cap sit on different days, so they never
    // overlap and the constraint stays silent.
    //
    // #1319 — the shard is therefore only safe for a cap-less placement. The
    // recurring types are exactly the ones whose validator enforces
    // sessionsPerWeek (subscription via SubscriptionValidationService, class via
    // the [WEEKLY_LIMIT] check), and a week spans days: two manual allocations
    // on different days of one week would take different keys and each clear the
    // cap on a count the other has not committed yet. They take the
    // consultant-wide key whatever wideLock says; wideLock stays the explicit
    // opt-out for callers placing times nobody picked per-day.
    const hasWeeklyCap = isRecurringEventType(eventType);
    const lockScope =
      wideLock || hasWeeklyCap
        ? undefined
        : slotStrings
            .map((s) => new Date(s))
            .filter((d) => !Number.isNaN(d.getTime()))
            .sort((a, b) => a.getTime() - b.getTime())[0]
            ?.toISOString()
            .slice(0, 10);
    // #1697 item 3 — the loser's fast exit. Mirrors checkout's EventFullError
    // gate: one indexed probe against what the GiST constraint would refuse,
    // BEFORE the lock wait and the full validation, so the 499 losers of a
    // last-seat race pay one read for their 409 instead of a lock, a
    // validation and a transaction. Advisory only: a clean answer proves
    // nothing (the in-txn re-check and the constraint stay authoritative).
    await probeConfirmedOverlap(
      consultantProfileId,
      eventType,
      eventId,
      slotStrings,
    );

    const lock = await lockAutoAllocate(consultantProfileId, lockScope);
    // #898 follow-up — serialize on the consultee too (consultant → consultee
    // lock order) so one person can't be booked with two consultants at once.
    let consulteeLock: ApprovalLock | null = null;
    try {
      const consulteeLockUserId = await getConsulteeUserId(eventType, eventId);
      if (consulteeLockUserId) {
        consulteeLock = await lockConsulteeBooking(consulteeLockUserId);
      }

      // #837 TOCTOU — the pre-lock replay check can miss a concurrent first
      // submit that stamped its key while we waited on the lock. Re-check now
      // that we hold the locks so the loser replays the winner's batch instead
      // of racing into the unique-constraint 409. Same-key/different-slots
      // still rejects with 422 here.
      const lockedReplay = await findIdempotentAllocation(
        eventType,
        eventId,
        idempotencyKey,
        slotStrings,
      );
      if (lockedReplay) return lockedReplay;

      // Multi-tab guard: a fresh dialog allocation must 409 if another
      // session already allocated this event (re-checked in-txn below).
      // #1766 — a subscription decides after its rows are read (see below).
      if (initialAllocation && eventType !== "subscription") {
        await assertNoConfirmedSlots(prisma, eventType, eventId);
      }

      // #908 — slot parsing, count checks and validation run OUTSIDE the write
      // transaction (but under the locks above), so the heavy conflict read no
      // longer pins a pooled connection while the txn waits to start.
      const eventData = await fetchEventData(prisma, eventType, eventId);
      if (!eventData) {
        throw new AllocationNotFoundError(`${eventType} not found`);
      }

      const { consultant, config, consulteeUserId, organizationId, planId } =
        eventData;

      // Convert to Date objects with validation
      const slots = slotStrings.map((s, i) => {
        const date = new Date(s);
        if (Number.isNaN(date.getTime())) {
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
      const slotsPerCall = ScheduleCalculationService.getSlotsPerCall(
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
      const relationField = getEventRelationField(eventType);
      const existingAppointments: AppointmentWithSlots[] =
        await prisma.appointment.findMany({
          where: {
            [`${relationField}Id`]: eventId,
          } as Prisma.AppointmentWhereInput,
          include: { occurrences: true },
        });

      const tentativeSlotCount = tentativeSlotCountOf(existingAppointments);
      // #1012 — before any delete+recreate, confirm the page's view of the
      // tentative set still matches the database.
      assertExpectedTentativeSlotCount(
        tentativeSlotCount,
        expectedTentativeSlotCount,
      );
      // A reschedule is a live RELEASE (tentative + RESCHEDULED), not mere
      // tentativeness: fresh requests already carry tentative holds.
      const isReschedule = releasedSessionCountOf(existingAppointments) > 0;

      // Intervals, not rows — see autoAllocate.
      const existingNonTentativeSlotCount =
        confirmedIntervalsOf(existingAppointments);

      const {
        existingConfirmedSessionCount,
        isTopUp,
        pastConfirmedSlotCount,
        isInProgressReallocation,
      } = resolveAllocationModeAndPastSlots(
        eventType,
        existingAppointments,
        existingNonTentativeSlotCount,
        isReschedule,
        topUp,
      );
      if (initialAllocation && eventType === "subscription" && !isTopUp) {
        await assertNoConfirmedSlots(prisma, eventType, eventId);
      }

      // ADR B10, derived rather than trusted. The client set initialAllocation
      // only when tentativeSlotCount === 0, but EVERY pending request already
      // carries tentative slots (request-for-approval and unpaid checkout both
      // create them that way), so the flag was never true for a consultation
      // and the multi-tab guard never ran. Having no CONFIRMED slot is the real
      // "not allocated yet" condition. This matters most across modes: auto
      // takes a consultant-wide lock and a cap-less manual one a day-sharded
      // key (#860, narrowed by #1319), so two tabs are only serialized by the
      // in-txn advisory lock this gates.
      const isFreshAllocation =
        !isTopUp &&
        (initialAllocation === true || existingNonTentativeSlotCount === 0);

      // What to leave out of conflict detection and the weekly/daily limits
      // (#1554 — see autoAllocate: a reschedule excludes the tentative
      // occurrences being replaced, a top-up nothing, anything else the
      // whole wrapper).
      const appointmentIdsToExclude =
        isReschedule || isTopUp ? [] : existingAppointments.map((a) => a.id);
      const occurrenceIdsToExclude = isReschedule
        ? releasedOccurrenceIdsOf(existingAppointments)
        : [];
      const ownAppointmentIds = existingAppointments.map((a) => a.id);

      // #1065 — a hand-placed allocation answers a stated preference just as an
      // auto one does (it does not READ the preference — the consultant chose
      // the times — but it consumes the request all the same). Captured before
      // the write txn deletes these rows.
      const releasedOccurrenceIds =
        releasedOccurrenceIdsOf(existingAppointments);

      // Validate total slot count for recurring event types
      let manualPartialInfo:
        | {
            partial: boolean;
            placedSessions: number;
            requiredSessions: number;
            unplacedSessions: number;
          }
        | undefined;
      if (isRecurringEventType(eventType)) {
        if (isReschedule) {
          // Expected count = (live RELEASED sessions) × slotsPerCall, i.e. the
          // number of SESSIONS actually being rescheduled (1 Appointment = 1
          // session). This equals calculateRequiredSlots for a FULL reschedule
          // (all sessions released) — preserving the class crud-with-plan case
          // (commit 2b6be4c1, where each session has 1 full-duration tentative
          // row) — but is correctly smaller for a PARTIAL reschedule (e.g. 2 of
          // 10). calculateRequiredSlots (the full total) wrongly rejected partials.
          const rescheduleSessions =
            releasedSessionCountOf(existingAppointments);
          const rescheduleRequired = rescheduleSessions * slotsPerCall;
          if (slots.length !== rescheduleRequired) {
            throw new AllocationValidationError(
              `This reschedule requires exactly ${rescheduleRequired} slots ` +
                `(replacing ${rescheduleSessions} session(s)), ` +
                `but ${slots.length} were provided.`,
            );
          }
        } else if (isTopUp) {
          // #1766 & #1692 Item 4 — this cycle's batch; the held sessions stay put.
          const topUpTotalSessions = topUpTargetSessions(
            eventType,
            config,
            existingConfirmedSessionCount,
            slotsPerCall,
          );
          const cycleTarget =
            topUpTotalSessions - existingConfirmedSessionCount;
          const requiredTopUpSlots = cycleTarget * slotsPerCall;
          if (slots.length > requiredTopUpSlots) {
            throw new AllocationValidationError(
              `This cycle takes exactly ${cycleTarget} session(s) ` +
                `(${requiredTopUpSlots} slots), but ${slots.length} were provided.`,
            );
          }
          if (slots.length < requiredTopUpSlots) {
            if (!allowPartial) {
              throw new SlotShortageError(
                `This cycle takes exactly ${cycleTarget} session(s) ` +
                  `(${requiredTopUpSlots} slots), but ${slots.length} were provided.`,
                Math.floor(slots.length / slotsPerCall),
                cycleTarget,
              );
            }
            const placedSessions =
              existingConfirmedSessionCount +
              Math.floor(slots.length / slotsPerCall);
            manualPartialInfo = {
              partial: placedSessions < topUpTotalSessions,
              placedSessions,
              requiredSessions: topUpTotalSessions,
              unplacedSessions: Math.max(
                0,
                topUpTotalSessions - placedSessions,
              ),
            };
          }
        } else if (isInProgressReallocation) {
          // In-progress: only future slots expected, past ones are preserved
          const fullRequired =
            ScheduleCalculationService.calculateRequiredSlots(
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
            ScheduleCalculationService.calculateRequiredSlots(
              eventType,
              config,
            );
          if (slots.length > requiredSlots) {
            throw new AllocationValidationError(
              `This ${eventType} requires exactly ${requiredSlots} slots ` +
                `(based on the scheduling period and session configuration), ` +
                `but ${slots.length} were provided.`,
            );
          }
          if (slots.length < requiredSlots) {
            const placedSessions = Math.floor(slots.length / slotsPerCall);
            const requiredSessions = Math.ceil(requiredSlots / slotsPerCall);
            if (!allowPartial) {
              throw new SlotShortageError(
                `This ${eventType} requires exactly ${requiredSlots} slots ` +
                  `(based on the scheduling period and session configuration), ` +
                  `but ${slots.length} were provided.`,
                placedSessions,
                requiredSessions,
              );
            }
            manualPartialInfo = {
              partial: placedSessions < requiredSessions,
              placedSessions,
              requiredSessions,
              unplacedSessions: Math.max(0, requiredSessions - placedSessions),
            };
          }
        }
      }

      // Validate (read-only; runs out-of-txn under the locks)
      // Pass the exclusions so the rows being replaced don't trigger false conflicts
      const validation = await new ScheduleValidationService(prisma).validate(
        eventType,
        eventId,
        slots,
        consultant,
        config,
        appointmentIdsToExclude,
        // #676 AE-1 — also check the consultee's calendar
        {
          consulteeUserId,
          excludeOccurrenceIds: occurrenceIdsToExclude,
          // Co-host arm: the consultant's own ACCEPTED seats occupy too.
          consultantProfileId,
          // The consultant explicitly accepting these times as-is.
          overrideAvailabilityWindow: override,
        },
      );

      if (!validation.isValid) {
        throw new AllocationValidationError(
          `Validation failed: ${validation.errors.join("; ")}`,
        );
      }

      // SHORT write-only transaction (see autoAllocate for the rationale).
      return await prisma.$transaction(
        async (tx) => {
          // #1692 — per-event serialisation first (see autoAllocate).
          const lockedReplay = await guardAllocationInTx(
            tx,
            eventType,
            eventId,
            idempotencyKey,
            isFreshAllocation,
            slotStrings,
          );
          if (lockedReplay) return lockedReplay;
          // #1766 — see autoAllocate: a stale tab must not append twice.
          if (isTopUp) {
            await assertHeldSessionCountInTx(
              tx,
              eventType,
              eventId,
              existingConfirmedSessionCount,
            );
          }

          // Defense-in-depth conflict re-check inside the txn (see autoAllocate).
          const recheck = await new ScheduleValidationService(
            tx,
          ).revalidateConflicts(
            slots,
            consultant.userId,
            appointmentIdsToExclude,
            consulteeUserId,
            occurrenceIdsToExclude,
            consultantProfileId,
          );
          if (!recheck.isValid) {
            throw new AllocationConflictError(
              `Slot taken during allocation: ${recheck.errors.join("; ")}`,
              "SLOT_TAKEN",
            );
          }

          // AE-2 (#784) — a webinar/class co-host is not a slot participant, so
          // nothing else here can see their clash. Checked in-txn, next to the
          // conflict recheck, so the read matches the write that follows.
          await assertCollaboratorsFree(
            tx,
            eventType,
            planId,
            slots,
            ownAppointmentIds,
          );

          // #1012 — re-assert tentative count under the write txn before
          // delete (the advisory lock above makes this read post-winner).
          await assertExpectedTentativeSlotCountInTx(
            tx,
            eventType,
            eventId,
            expectedTentativeSlotCount,
          );

          // Delete existing appointments
          // For reschedules: only delete tentative slots (preserve confirmed ones)
          // For in-progress: only delete future slots (preserve past confirmed ones)
          // For initial allocation: delete all
          // #1766 / #1206 top-up: nothing — the next cycle appends to the wrapper.
          let enrolledUserIds: string[] = [];
          let deletedAppointmentIds: string[] = [];
          let freedOrdinals: number[] = [];
          let freedWindows: FreedWindow[] = [];
          let reusableAppointmentId: string | undefined;
          if (isTopUp) {
            if (eventType === "class") {
              enrolledUserIds =
                await SchedulingService.collectEventParticipantIds(
                  tx,
                  eventType,
                  eventId,
                );
            }
          } else {
            ({
              enrolledUserIds,
              deletedAppointmentIds,
              freedOrdinals,
              freedWindows,
              reusableAppointmentId,
            } = await this.deleteExistingAppointments(
              tx,
              eventType,
              eventId,
              isReschedule,
              isInProgressReallocation,
            ));
          }

          // Create appointments
          const appointments = await this.createAppointments(
            tx,
            eventType,
            eventId,
            slots,
            consultant.userId,
            consulteeUserId,
            config,
            organizationId,
            reusableAppointmentId, // #898 — REUSE preserved 1:1 appointment
            idempotencyKey, // #837
            freedOrdinals, // #1554 — replacements keep their position
            { isReschedule, freedWindows }, // #1780 decision 9 — moves
          );

          // Reconnect enrolled users to new slots (for group events like classes)
          if (enrolledUserIds.length > 0) {
            await this.reconnectEnrolledUsers(
              tx,
              appointments,
              enrolledUserIds,
              consultant.userId,
              organizationId,
            );
          }

          // Update event status
          const outcome = await updateEventStatus(
            tx,
            eventType,
            eventId,
            slots[0],
            config,
            txOptions.approvableFrom,
          );
          await holdUntilPaid(tx, appointments, outcome);

          // #1065 — see autoAllocate: placing the replacement answers the ask.
          await resolveConsumedPreferenceRequests(
            tx,
            releasedOccurrenceIds,
            excludeRescheduleRequestId,
          );
          await txOptions.inTx?.(tx);

          return {
            success: true,
            outcome,
            appointments,
            warnings: validation.warnings,
            deletedAppointmentIds, // AE-4
            ...manualPartialInfo,
            stagedNotices: await stageAllocationNotices(
              tx,
              eventType,
              eventId,
              manualPartialInfo,
              outcome,
            ),
          };
        },
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
    } finally {
      if (consulteeLock) await unlockConsulteeBooking(consulteeLock);
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
    // The caller's initialAllocation hint is ignored: the guard is always armed
    // here, because approving stored times is only valid for an unallocated event.
    _initialAllocation: boolean | undefined,
    idempotencyKey?: string,
    /** Consultant accepting times outside their own published availability. */
    overrideAvailabilityWindow?: boolean,
    expectedTentativeSlotCount?: number,
    txOptions: AllocationTxOptions = {},
  ): Promise<AllocationResult> {
    // #1692 Item 7 — group events (webinar, class) never have consultee-requested
    // slots; reject upfront before touching idempotency or locks.
    if (eventType === "webinar" || eventType === "class") {
      throw new AllocationValidationError(
        `Requested-slot allocation is not supported for ${eventType} events; only consultations and subscriptions have consultee-requested slots.`,
        "INVALID_MODE",
      );
    }
    // #837 — a retry whose first response was lost must replay the approved
    // batch, not trip the initial-allocation guard with a 409.
    const replay = await findIdempotentAllocation(
      eventType,
      eventId,
      idempotencyKey,
    );
    if (replay) return replay;

    // This path used to enter the transaction with no Redis lock at all, so an
    // approval could run concurrently with an auto/manual allocation of the same
    // event and rely entirely on the GiST exclusion constraint to notice.
    const consultantProfileId = await getConsultantProfileId(
      eventType,
      eventId,
    );
    if (!consultantProfileId) {
      // Same shape the auto/manual paths report, so a missing event reads the
      // same however it was reached.
      throw new AllocationNotFoundError(`${eventType} not found`);
    }
    const lock = await lockAutoAllocate(consultantProfileId);
    if (!lock) {
      throw new AllocationConflictError(
        "Another allocation is in progress for this consultant. Please try again.",
      );
    }

    // #898 follow-up — serialize on the consultee too. The GiST overlap guard
    // is consultant-keyed, so it cannot see a cross-consultant double-booking,
    // and this path confirms the consultee's slots. Without it an approval here
    // and an auto/manual allocation for the same consultee under a DIFFERENT
    // consultant both pass their conflict validation under Read Committed and
    // both commit. Lock order matches the other two paths: consultant → consultee.
    let consulteeLock: ApprovalLock | null = null;

    try {
      const consulteeLockUserId = await getConsulteeUserId(eventType, eventId);
      if (consulteeLockUserId) {
        consulteeLock = await lockConsulteeBooking(consulteeLockUserId);
      }

      // #837 TOCTOU — same re-check the auto/manual paths do: the pre-lock
      // replay check can miss a concurrent first submit that stamped its key
      // while we waited on the locks. Re-check now that we hold them so the
      // loser replays the winner's batch instead of paying for a full write
      // transaction that only rediscovers the replay in-txn.
      const lockedReplay = await findIdempotentAllocation(
        eventType,
        eventId,
        idempotencyKey,
      );
      if (lockedReplay) return lockedReplay;

      // #1692 item 3 — the #908 shape the auto/manual paths already have:
      // every read and pure check runs HERE, on the base client under the
      // Redis locks, so the write transaction below opens only for the
      // advisory-locked guard, the conflict re-check and the flips.
      const eventData = await fetchEventData(prisma, eventType, eventId);
      if (!eventData) {
        throw new AllocationNotFoundError(`${eventType} not found`);
      }

      const { consultant, config, requestedSlots, consulteeUserId, planId } =
        eventData;

      if (!requestedSlots || requestedSlots.length === 0) {
        throw new AllocationValidationError("No requested slots found");
      }

      // CRITICAL FIX: Verify appointments actually exist before approving
      // This prevents approving requests with no actual bookings
      const relationField = getEventRelationField(eventType);
      const existingAppointments: AppointmentWithSlots[] =
        await prisma.appointment.findMany({
          where: {
            [`${relationField}Id`]: eventId,
          } as Prisma.AppointmentWhereInput,
          include: { occurrences: true },
        });

      const tentativeSlotCount = tentativeSlotCountOf(existingAppointments);
      // #1012 — stale-tab reschedule / approval precondition.
      assertExpectedTentativeSlotCount(
        tentativeSlotCount,
        expectedTentativeSlotCount,
      );

      if (existingAppointments.length === 0) {
        throw new AllocationValidationError(
          "Cannot approve requested slots: No appointments found. " +
            "The consultee may not have created appointments yet, or they were deleted. " +
            "Please ask the consultee to resubmit their request.",
        );
      }

      // A rescheduled slot's startsAt is still the ORIGINAL time — the
      // reschedule route only flips isTentative/completionStatus, it never
      // writes a new one. fetchEventData derives requestedSlots from those
      // same rows, so "use the requested times" here would silently re-confirm
      // exactly the times the consultee asked to move. Refuse; the consultant
      // must allocate (auto or manual) instead.
      const rescheduledSlots = existingAppointments.flatMap((appointment) =>
        appointment.occurrences.filter(isReleasedForReschedule),
      );

      if (rescheduledSlots.length > 0) {
        throw new AllocationValidationError(
          `Cannot reuse requested times: ${rescheduledSlots.length} slot(s) are awaiting reschedule, ` +
            `so the stored times are the ones being moved away from. ` +
            `Allocate new times instead.`,
        );
      }

      // Verify the appointments COVER exactly the requested half-hour atoms.
      //
      // #1319 — this compared row count to atom count, which are the same
      // number only for an appointment already stored the canonical way
      // (#1071). 76 of 87 production consultations are a single 60-minute
      // row, so a one-hour booking offered two atoms and answered "1", and
      // approving it was impossible: the message read "Found 1 slots but 2
      // requested" and the consultant had no action that could fix it.
      //
      // Both sides are atom COVERAGE now: `fetchEventData` expands each
      // stored row into the atom starts it covers, so normalising only the
      // left side would have swapped one mismatch for its mirror image.
      const existingAtomCount = existingAppointments.reduce(
        (sum, appointment) =>
          sum +
          appointment.occurrences.reduce(
            (atoms, slot) => atoms + intervalCountOf(slot),
            0,
          ),
        0,
      );

      if (existingAtomCount !== requestedSlots.length) {
        throw new AllocationValidationError(
          `Appointment mismatch: the existing appointments cover ${existingAtomCount} ` +
            `half-hour atoms but ${requestedSlots.length} were requested. ` +
            `The appointments may have been modified. Please review and try again.`,
        );
      }

      // Validate requested slots still meet all requirements.
      // Pass existing appointment IDs so the event's own tentative slots
      // are not flagged as conflicts during self-validation.
      const existingAppointmentIds = existingAppointments.map((a) => a.id);
      const validation = await new ScheduleValidationService(prisma).validate(
        eventType,
        eventId,
        requestedSlots,
        consultant,
        config,
        existingAppointmentIds,
        {
          consulteeUserId,
          overrideAvailabilityWindow,
          // Co-host arm: the consultant's own ACCEPTED seats occupy too.
          consultantProfileId,
        },
      );

      if (!validation.isValid) {
        throw new AllocationValidationError(
          `Validation failed: ${validation.errors.join("; ")}`,
        );
      }

      // The rows the flip below targets, fingerprinted so the in-txn re-read
      // can prove they are the rows that were validated.
      const validatedOccurrenceIds = existingAppointments
        .flatMap((appointment) => appointment.occurrences.map((o) => o.id))
        .sort((a, b) => a.localeCompare(b));

      return await prisma.$transaction(
        async (tx) => {
          // Multi-tab guard: another tab already confirmed slots for this
          // event → typed 409 instead of re-approving over it. Advisory-locked
          // in-txn so it can't race the manual/auto write transactions; a
          // same-key retry that lost the pre-txn race replays the winner.
          // Always fresh here: approving stored times is only ever valid for an
          // event that has not been allocated yet.
          const lockedReplay = await guardAllocationInTx(
            tx,
            eventType,
            eventId,
            idempotencyKey,
            true,
          );
          if (lockedReplay) return lockedReplay;

          // #1692 — the reads above ran before the advisory lock, so re-read
          // the rows behind it: a writer that replaced or flipped them in the
          // gap makes this a stale tab, not an approval.
          const liveRows = await tx.appointment.findMany({
            where: {
              [`${relationField}Id`]: eventId,
            } as Prisma.AppointmentWhereInput,
            select: {
              id: true,
              occurrences: {
                select: {
                  id: true,
                  isTentative: true,
                  deletedAt: true,
                  completionStatus: true,
                },
              },
            },
          });
          const liveOccurrenceIds = liveRows
            .flatMap((appointment) => appointment.occurrences.map((o) => o.id))
            .sort((a, b) => a.localeCompare(b));
          const liveTentativeCount = liveRows.reduce(
            (count, appointment) =>
              count +
              appointment.occurrences.filter(isCarriedTentativeOccurrence)
                .length,
            0,
          );
          if (
            liveTentativeCount !== tentativeSlotCount ||
            liveOccurrenceIds.join(",") !== validatedOccurrenceIds.join(",")
          ) {
            throw new AllocationConflictError(
              "Reschedule state changed in another session. Reload and try again.",
              "RESCHEDULE_STATE_CHANGED",
            );
          }
          // The flip below only touches live, non-terminal rows (deletedAt
          // null + SCHEDULED/UNVERIFIED) — the same set it must clear. A
          // concurrent tombstone or cancel lands exactly here: the id-set
          // above still matches, so without this gate the approval would
          // succeed while the guarded flip silently skipped the dead row.
          const flippableCount = liveRows.reduce(
            (count, appointment) =>
              count +
              appointment.occurrences.filter(
                (o) =>
                  o.deletedAt === null &&
                  (o.completionStatus === "SCHEDULED" ||
                    o.completionStatus === "UNVERIFIED"),
              ).length,
            0,
          );
          const totalCount = liveRows.reduce(
            (count, appointment) => count + appointment.occurrences.length,
            0,
          );
          if (flippableCount !== totalCount) {
            throw new AllocationConflictError(
              "Reschedule state changed in another session. Reload and try again.",
              "RESCHEDULE_STATE_CHANGED",
            );
          }

          // Defense-in-depth conflict re-check inside the txn (see autoAllocate).
          const recheck = await new ScheduleValidationService(
            tx,
          ).revalidateConflicts(
            requestedSlots,
            consultant.userId,
            existingAppointmentIds,
            consulteeUserId,
            undefined,
            consultantProfileId,
          );
          if (!recheck.isValid) {
            throw new AllocationConflictError(
              `Slot taken during allocation: ${recheck.errors.join("; ")}`,
              "SLOT_TAKEN",
            );
          }

          // AE-2 (#784) — confirming the consultee's stored times is a time
          // commit like any other, so the co-host guard applies here too. This
          // path has no createAppointments; the isTentative flip below is the
          // write it protects.
          await assertCollaboratorsFree(
            tx,
            eventType,
            planId,
            requestedSlots,
            existingAppointmentIds,
          );

          // Update event status to approved (appointments already exist and verified)
          const outcome = await updateEventStatus(
            tx,
            eventType,
            eventId,
            requestedSlots[0],
            config,
            txOptions.approvableFrom,
          );

          // CRITICAL FIX: Clear isTentative flag on all slots after approval
          // This ensures slots are no longer marked as pending reschedule.
          // #1775 B-9 — only once the money is settled: an unpaid approval
          // keeps its rows as the hold the pay order is for (the capture
          // webhook confirms them; a lapse or withdraw releases them).
          const appointmentIds = existingAppointments.map(
            (appointment) => appointment.id,
          );
          if (outcome !== "awaiting_payment") {
            const cleared = await tx.appointmentOccurrence.updateMany({
              where: {
                appointmentId: { in: appointmentIds },
                // Never clear tentative on dead rows: without these guards a
                // CANCELLED/RESCHEDULED/tombstoned hold is resurrected as a live
                // non-tentative row occupying the calendar. Deliberately NOT
                // liveOccurrenceWhere: that admits COMPLETED, and an approval
                // must never rewrite terminal history rows.
                deletedAt: null,
                completionStatus: { in: ["SCHEDULED", "UNVERIFIED"] },
              },
              data: { isTentative: false },
            });
            // Defense in depth for a tombstone racing the select above: the
            // gate already proved every row flippable, so a short count means
            // a concurrent writer moved one mid-flight — stale tab, not approval.
            if (cleared.count !== flippableCount) {
              throw new AllocationConflictError(
                "Reschedule state changed in another session. Reload and try again.",
                "RESCHEDULE_STATE_CHANGED",
              );
            }
          }

          // #837 — stamp the batch's key on the FIRST appointment so a retry
          // replays this approval instead of re-running it (mirrors
          // createAppointments). The @unique index turns a concurrent
          // duplicate submit into a typed 409.
          if (idempotencyKey) {
            try {
              await tx.appointment.update({
                where: { id: appointmentIds[0] },
                data: { allocationIdempotencyKey: idempotencyKey },
              });
            } catch (err) {
              // Not captured here — useRequestedSlots only ever runs inside
              // allocate()'s try, whose catch reports every error reaching it
              // (including this one, same instance) with the correct modeled
              // classification. A second capture here would be a pure dupe.
              if (isUniqueViolation(err)) {
                // A same-key retry losing this race is the ordinary replay
                // case (#837).
                throw new AllocationConflictError(
                  "This allocation was already submitted; the original result applies.",
                );
              }
              throw err;
            }
          }
          await txOptions.inTx?.(tx);

          return {
            success: true,
            outcome,
            appointments: existingAppointments,
            warnings: validation.warnings,
            stagedNotices: await stageAllocationNotices(
              tx,
              eventType,
              eventId,
              undefined,
              outcome,
            ),
          };
        },
        {
          // Shared with the auto/manual paths rather than a local literal, so
          // all three allocation transactions age out the same way.
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
    } finally {
      if (consulteeLock) await unlockConsulteeBooking(consulteeLock);
      await unlockAutoAllocate(lock);
    }
  }

  /**
   * Find available consecutive slots for auto-allocation.
   *
   * #1065 — `preference` orders the candidates that are already valid. Every
   * hard constraint (availability, both parties' bookings, per-day and per-week
   * caps, the scheduling period) is evaluated exactly as before and no
   * preference can relax or tighten one. An unsatisfiable preference therefore
   * changes nothing except which of the equally-legal placements is chosen.
   *
   * The search runs under `ALLOCATOR_SEARCH_TIME_BUDGET_MS`. Spending it ends
   * the walk and falls through to the ordinary "not enough" tail, so the caller
   * sees SLOT_SHORTAGE with a real placeable count — or, with `allowPartial`,
   * the sessions that did fit.
   */
  private static async findAvailableSlots(
    // #908 — accepts the base client so slot discovery can run OUTSIDE the write
    // transaction (under the locks). Reads only — no writes happen here.
    db: PrismaLike,
    consultant: ConsultantAllocationData,
    totalSlotsNeeded: number,
    slotsPerCall: number,
    eventType: EventType,
    config: EventConfig,
    excludeAppointmentIds: string[] = [],
    eventOwnAppointments: AppointmentWithSlots[] = [],
    // #898 follow-up — when set, the CONSULTEE's existing bookings (across ANY
    // consultant) are also treated as occupied, so auto-allocate picks
    // mutually-free slots instead of consultant-free ones that then fail the
    // consultee-conflict validation.
    consulteeUserId?: string,
    // Lets the occupancy predicate include appointments delivered under this
    // consultant's own plans, matching what the availability grid counts.
    consultantProfileId?: string,
    // #1065 — how the consultee would like the replacement placed. Scores
    // candidates; absent (or all-null) leaves selection exactly as it was.
    preference?: AllocationPreference,
    // #1194 — identifies the walk in the truncation warning below.
    eventId?: string,
    // #1206 — return what fits instead of throwing SLOT_SHORTAGE. Only the
    // consultant, having been shown the shortfall, can turn this on.
    allowPartial = false,
    // #1554 — the tentative occurrences a reschedule replaces: left out of
    // bookedSlots and of the weekly/daily seeds while their wrapper stays.
    excludeOccurrenceIds: string[] = [],
  ): Promise<Date[]> {
    const walk: AllocationWalkContext = {
      eventType,
      eventId,
      consultantProfileId,
      reportedTruncations: new Set(),
    };
    if (consultant.scheduleType === ScheduleType.WEEKLY) {
      reportIncompleteWeeklyRows(
        partitionWeeklyRows(consultant.availabilityWindowsWeekly).refused,
        { op: "auto-allocate", consultantProfileId },
      );
    }
    // Only FUTURE occupancy can collide with a candidate: buildConsecutiveBlock
    // rejects any candidate start before `now`, so a slot that has already
    // ended can never block a placement. Bounding the read to live intervals
    // keeps this query O(upcoming bookings) instead of O(entire consultant
    // history) — the pool-starvation shape documented in
    // docs/performance/05-allocation-500-investigation.md.
    const occupancyClock = new Date();

    // Get all existing booked slots for this consultant
    // FIX Bug #15: Use centralized occupancy policy for consistent conflict detection
    // Shared with the availability grid so the two cannot disagree about who
    // is busy — see buildConsultantOccupancyWhere.
    const appointmentFilter: Prisma.AppointmentWhereInput[] = [
      buildConsultantOccupancyWhere(consultantProfileId, consultant.userId),
      // Bounded read — see occupancyClock above.
      {
        occurrences: {
          some: {
            endsAt: { gt: occupancyClock },
            ...OCCUPYING_OCCURRENCE_WHERE,
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

    const existingAppointments = await db.appointment.findMany({
      where: {
        AND: appointmentFilter,
      },
      include: {
        // Tombstoned children of a qualifying appointment must not enter
        // bookedSlots — the parent-level filter above only qualifies the
        // appointment, not every row this include returns.
        // endsAt bound keeps bookedSlots O(upcoming): past children can never
        // match a candidate (buildConsecutiveBlock rejects < now), so
        // materializing them only re-creates pool pressure on long-lived
        // appointments (CodeRabbit triage).
        occurrences: {
          where: {
            ...OCCUPYING_OCCURRENCE_WHERE,
            endsAt: { gt: occupancyClock },
            ...(excludeOccurrenceIds.length > 0
              ? { id: { notIn: excludeOccurrenceIds } }
              : {}),
          },
        },
        // RV-2 — status + payment let isOccupiedByLiveAppointment drop expired
        // APPROVED_PENDING_PAYMENT holds, matching what the validator skips.
        consultation: { select: { status: true, bookingSource: true } },
        subscription: { select: { status: true, bookingSource: true } },
        payment: { select: { expiresAt: true, paymentStatus: true } },
      },
    });

    // RV-2 — an expired pending-payment hold is not a live blocker, so its slots
    // must not enter bookedSlots; otherwise the allocator avoids a slot the
    // validator would happily accept and the two disagree.
    // #1554 — a row is a whole call, so every 30-minute interval it covers is
    // booked, not just its start; a 09:30 candidate must see a 09:00–10:00
    // call, or selection proposes what the validator then rejects.
    const bookedSlots = new Set(
      existingAppointments
        .filter((appointment) =>
          isOccupiedByLiveAppointment(appointment, occupancyClock),
        )
        .flatMap((appointment) =>
          appointment.occurrences.flatMap((slot) =>
            intervalStartsOf(slot).map((start) => start.toISOString()),
          ),
        ),
    );

    // #898 follow-up — also fold the CONSULTEE's existing bookings into
    // bookedSlots so auto-allocate avoids slots where the consultee is already
    // busy with ANOTHER consultant. Without this, selection picks
    // consultant-free slots that then fail validateNoConflicts' consultee check
    // (a graceful 400, but no placement and no retry). Mirrors the consultant
    // query above, scoped to the consultee's seats (#1554) — bounded to
    // live intervals for the same reason.
    if (consulteeUserId) {
      const consulteeAppointments = await db.appointment.findMany({
        where: {
          AND: [
            { OR: buildOccupiedAppointmentFilter() },
            { participants: { some: liveParticipant(consulteeUserId) } },
            {
              occurrences: {
                some: {
                  endsAt: { gt: occupancyClock },
                  ...OCCUPYING_OCCURRENCE_WHERE,
                  ...(excludeOccurrenceIds.length > 0
                    ? { id: { notIn: excludeOccurrenceIds } }
                    : {}),
                },
              },
            },
            ...(excludeAppointmentIds.length > 0
              ? [{ NOT: { id: { in: excludeAppointmentIds } } }]
              : []),
          ],
        },
        include: {
          // Same tombstone exclusion as the consultant query above.
          // endsAt bound keeps bookedSlots O(upcoming): past children can never
          // match a candidate (buildConsecutiveBlock rejects < now), so
          // materializing them only re-creates pool pressure on long-lived
          // appointments (CodeRabbit triage).
          occurrences: {
            where: {
              ...OCCUPYING_OCCURRENCE_WHERE,
              endsAt: { gt: occupancyClock },
              ...(excludeOccurrenceIds.length > 0
                ? { id: { notIn: excludeOccurrenceIds } }
                : {}),
            },
          },
          consultation: { select: { status: true, bookingSource: true } },
          subscription: { select: { status: true, bookingSource: true } },
          payment: { select: { expiresAt: true, paymentStatus: true } },
        },
      });
      consulteeAppointments
        .filter((appointment) =>
          isOccupiedByLiveAppointment(appointment, occupancyClock),
        )
        .flatMap((appointment) =>
          appointment.occurrences.flatMap((slot) =>
            intervalStartsOf(slot).map((start) => start.toISOString()),
          ),
        )
        .forEach((iso) => bookedSlots.add(iso));
    }

    // Validate availability exists
    const projectableWeekly = projectableWeeklyRows(consultant);
    const hasWeeklySlots = projectableWeekly.length > 0;
    const hasCustomSlots = consultant.availabilityWindowsCustom.length > 0;
    if (
      (consultant.scheduleType === ScheduleType.WEEKLY && !hasWeeklySlots) ||
      (consultant.scheduleType === ScheduleType.CUSTOM && !hasCustomSlots)
    ) {
      throw new AllocationValidationError(
        "No availability slots configured for consultant",
        "NO_AVAILABILITY",
      );
    }

    const now = occupancyClock;
    const selectedSlots: Date[] = [];
    // Opened once the reads are done, so the ceiling bounds the SEARCH (the only
    // O(window) work in this request) and not the queries that feed it. A
    // truncated search answers through the same shortage tail below, so
    // `allowPartial` keeps working exactly as it does for a full calendar.
    const searchBudget = createSearchBudget(ALLOCATOR_SEARCH_TIME_BUDGET_MS);

    // Sort weekly slots by next calendar occurrence (not raw clock time)
    // so auto-allocation picks the chronologically earliest slot first.
    // Without this, Tue 08:00 (480min) would sort before Mon 09:00 (540min).
    const sortedWeekly =
      consultant.scheduleType === ScheduleType.WEEKLY
        ? sortWeeklyByNextOccurrence(projectableWeekly, now)
        : [];
    const sortedCustom =
      consultant.scheduleType === ScheduleType.CUSTOM
        ? [...consultant.availabilityWindowsCustom].sort(
            (a, b) =>
              new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
          )
        : [];

    // #1065 — the preference's ceiling. Zero when nothing was asked for, which
    // makes every "is this candidate perfect?" test below true on the first
    // placeable candidate and preserves first-fit verbatim.
    const maxScore = maxPreferenceScore(preference);

    // For consultations/webinars: find one consecutive block, searching multiple weeks
    if (eventType === "consultation" || eventType === "webinar") {
      const singleSession = bestBlockForSingleSession(
        eventType,
        consultant,
        slotsPerCall,
        bookedSlots,
        now,
        sortedWeekly,
        sortedCustom,
        config.schedulingTimezone,
        preference,
        walk,
        searchBudget,
      );
      if (singleSession) return singleSession;

      // One session, so nothing is placeable short of the whole thing —
      // placeableSessions 0 tells the client not to offer a partial schedule.
      // A budget-truncated walk lands here too: it found nothing, and the
      // shortage is the same answer a full calendar gets.
      throw new SlotShortageError(
        `No ${slotsPerCall} consecutive slots available for ${eventType}`,
        0,
        1,
      );
    }

    // For subscriptions/classes: find distributed slots across weeks
    const startDate = config.schedulingPeriodStartsAt || new Date();
    const endDate =
      config.schedulingPeriodEndsAt ||
      addMonths(startDate, config.durationInMonths || 1);
    const sessionsPerWeek = config.sessionsPerWeek || 1;

    // Build a map of existing confirmed calls per week.
    // During partial reschedule, weeks with confirmed appointments already
    // have calls that must count toward the weekly limit.
    // IMPORTANT: Only count THIS event's own appointments (not consultations or
    // other event types), and exclude the tentative ones being replaced.
    const excludeSet = new Set(excludeAppointmentIds);
    const excludedOccurrences = new Set(excludeOccurrenceIds);
    const existingSessionsPerWeek = new Map<string, number>();
    // Sessions per day already spoken for by surviving calls — the seed of
    // the per-day cap counter. Seeded for the same reason as the week map:
    // validatePerDaySessionCap counts existing calls, so a partial reschedule
    // that only looked at this run's placements could put a replacement on a
    // day that is already at its cap and be rejected downstream.
    // #1554 — one live occurrence = one session.
    const existingSessionsPerDay = new Map<string, number>();
    const survivingOccurrences = eventOwnAppointments
      .filter((apt) => !excludeSet.has(apt.id))
      .flatMap((apt) => apt.occurrences)
      .filter(
        (s) =>
          !excludedOccurrences.has(s.id) &&
          !s.isTentative &&
          !isDeadOccurrence(s),
      );
    for (const firstSlot of survivingOccurrences) {
      // ADR B9 — weekly buckets in the event's scheduling timezone
      const weekKey = ScheduleCalculationService.weekKey(
        new Date(firstSlot.startsAt),
        config.schedulingTimezone,
      );
      existingSessionsPerWeek.set(
        weekKey,
        (existingSessionsPerWeek.get(weekKey) || 0) + 1,
      );
      const dayKey = ScheduleCalculationService.dayKey(
        new Date(firstSlot.startsAt),
        config.schedulingTimezone,
      );
      existingSessionsPerDay.set(
        dayKey,
        (existingSessionsPerDay.get(dayKey) || 0) + 1,
      );
    }

    // The cursor advances in UTC days and each weekly occurrence is filed under
    // the UTC day its start falls on, so every occurrence is offered exactly once.
    //
    // Caps are counted in the event's scheduling timezone (ADR B9), keyed off
    // the placed slot rather than the cursor, so the two bucketings cannot drift.
    const sessionsPlacedPerWeek = new Map(existingSessionsPerWeek);
    // Per-day cap counter, seeded from the surviving sessions. The cap is the
    // SAME constant validatePerDaySessionCap enforces (sessionCaps.ts) — it
    // used to be a hard one-session-per-day set, which made auto-allocate
    // unable to fill a class whose sessionsPerWeek exceeds its available
    // days per week even though the validator (and manual allocation) allow
    // two sessions on one day.
    const placedPerDay = new Map(existingSessionsPerDay);
    const maxPerDay =
      eventType === "class"
        ? MAX_CLASS_SESSIONS_PER_DAY
        : MAX_SUBSCRIPTION_SESSIONS_PER_DAY;

    // Weekly occurrences over the whole period, projected once and filed by the
    // UTC day they start on, in `sortedWeekly` order.
    const weeklyStartsByUtcDay = new Map<
      number,
      { start: Date; endMs: number }[]
    >();
    if (consultant.scheduleType === ScheduleType.WEEKLY) {
      const periodStart = new Date(
        Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
        ),
      );
      const periodEnd = new Date(endDate.getTime() + DAY_MS);
      for (const slot of sortedWeekly) {
        for (const occurrence of weeklyRowIntervalsInRange(
          slot,
          periodStart,
          periodEnd,
        )) {
          const dayMs =
            Math.floor(occurrence.start.getTime() / DAY_MS) * DAY_MS;
          const starts = weeklyStartsByUtcDay.get(dayMs) ?? [];
          starts.push({
            start: occurrence.start,
            endMs: occurrence.end.getTime(),
          });
          weeklyStartsByUtcDay.set(dayMs, starts);
        }
      }
    }

    /**
     * Availability rows that start on this UTC day, as {start, endMs} pairs.
     * #1194 — the end lets candidateStartsInRow bound its walk to the row's
     * own time range instead of a blind 48-step cap that adjacent rows can
     * trick into walking past.
     */
    const rowStartsForDay = (
      currentDay: Date,
    ): { start: Date; endMs: number }[] =>
      consultant.scheduleType === ScheduleType.WEEKLY
        ? (weeklyStartsByUtcDay.get(currentDay.getTime()) ?? [])
        : sortedCustom
            .map((slot) => {
              const start = matchCustomSlotToDay(slot.startsAt, currentDay);
              if (!start) return null;
              return { start, endMs: new Date(slot.endsAt).getTime() };
            })
            .filter((r): r is { start: Date; endMs: number } => r !== null);

    /** Whether the per-day and per-week caps still have room for a call starting here. */
    const hasRoomOn = (candidateStart: Date): boolean =>
      (placedPerDay.get(
        ScheduleCalculationService.dayKey(
          candidateStart,
          config.schedulingTimezone,
        ),
      ) ?? 0) < maxPerDay &&
      (sessionsPlacedPerWeek.get(
        ScheduleCalculationService.weekKey(
          candidateStart,
          config.schedulingTimezone,
        ),
      ) ?? 0) < sessionsPerWeek;

    /**
     * Place at most `maxPerDay` calls on this day, honouring the
     * timezone-bucketed per-day and per-week caps the validator will
     * re-check.
     *
     * `perfectOnly` is the day-preference half of #1065. A day of the week is a
     * property of the whole day, so unlike the time band it cannot be chosen
     * between candidates inside one row — the sweep has to be run twice
     * instead. The first pass accepts only fully-preferred placements; the
     * second accepts anything and is byte-for-byte the sweep that shipped
     * before. Passing over a day in the first sweep never loses it, because the
     * second sweep walks the same window with the same cap counters.
     */
    const tryPlaceOnDay = (currentDay: Date, perfectOnly: boolean): boolean => {
      let best: { block: Date[]; score: number } | null = null;

      for (const { start: rowStart, endMs: rowEndMs } of rowStartsForDay(
        currentDay,
      )) {
        // A row inside one scheduling-timezone day shares that day's caps and
        // weekday, so it can be ruled out before its walk; an overnight row's
        // tail lands on the next day and is judged per candidate instead.
        const lastRowAtom = new Date(rowEndMs - SCHEDULING_INTERVAL_MS);
        const withinOneDay =
          ScheduleCalculationService.dayKey(
            rowStart,
            config.schedulingTimezone,
          ) ===
          ScheduleCalculationService.dayKey(
            lastRowAtom,
            config.schedulingTimezone,
          );
        if (withinOneDay && !hasRoomOn(rowStart)) continue;
        if (
          withinOneDay &&
          perfectOnly &&
          !matchesPreferredDays(rowStart, preference, config.schedulingTimezone)
        ) {
          continue;
        }

        const candidate = bestFittingBlockInRow(
          rowStart,
          slotsPerCall,
          consultant,
          bookedSlots,
          {
            now,
            startDate,
            endDate,
            schedulingTimezone: config.schedulingTimezone,
            hasRoomOn: perfectOnly
              ? (start) =>
                  hasRoomOn(start) &&
                  matchesPreferredDays(
                    start,
                    preference,
                    config.schedulingTimezone,
                  )
              : hasRoomOn,
          },
          rowEndMs,
          preference,
          walk,
        );
        if (!candidate) continue;
        // LOAD-BEARING: discarding a placeable block here is only safe because
        // sweepPeriod(false) below is UNCONDITIONAL. Any early return inserted
        // between the two sweeps turns this line into a filter and
        // reintroduces #1065 — the preference would start costing allocations.
        if (perfectOnly && candidate.score < maxScore) continue;

        // A full match ends the row walk for the same reason it ends the
        // candidate walk — and with no preference maxScore is 0, so the first
        // row that yields anything wins, exactly as before.
        if (candidate.score >= maxScore) {
          best = candidate;
          break;
        }
        if (!best || candidate.score > best.score) best = candidate;
      }

      if (!best) return false;

      const sessionSlots = best.block;
      selectedSlots.push(...sessionSlots);
      sessionSlots.forEach((s) => bookedSlots.add(s.toISOString()));

      // Re-key on the slot actually placed rather than on the row it came
      // from, so the counters record where the session really landed.
      const placedDayKey = ScheduleCalculationService.dayKey(
        sessionSlots[0],
        config.schedulingTimezone,
      );
      const placedWeekKey = ScheduleCalculationService.weekKey(
        sessionSlots[0],
        config.schedulingTimezone,
      );
      placedPerDay.set(placedDayKey, (placedPerDay.get(placedDayKey) ?? 0) + 1);
      sessionsPlacedPerWeek.set(
        placedWeekKey,
        (sessionsPlacedPerWeek.get(placedWeekKey) ?? 0) + 1,
      );

      return true;
    };

    /**
     * One walk of the scheduling period, day by day, until the need is met.
     *
     * Each day hosts as many sessions as its per-day cap (sessionCaps.ts)
     * allows, not just one: a class whose sessionsPerWeek exceeds the
     * consultant's available days per week can only be satisfied by stacking
     * sessions on a day, which is exactly what validatePerDaySessionCap
     * permits (≤2/day) and what the old one-placement-per-day cursor
     * made impossible. The while loop terminates because every successful
     * placement strictly advances a bounded counter (per-day cap, weekly cap,
     * totalSlotsNeeded).
     *
     * The budget stops the DAY walk, which is the coarsest unit that still
     * bounds the overrun: one day is one pass over that day's rows. It leaves
     * the search through the ordinary shortage tail below rather than a new
     * error, so a truncated walk is answered as "no more room" and still
     * honours `allowPartial` — the partial answer is what the consultant
     * actually gets, and a 504 would have given them nothing.
     */
    const sweepPeriod = (perfectOnly: boolean): void => {
      const cursor = new Date(
        Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
        ),
      );

      for (
        ;
        cursor <= endDate && selectedSlots.length < totalSlotsNeeded;
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      ) {
        if (searchBudget.exhausted()) {
          reportSearchBudgetSpent(searchBudget, consultant, walk);
          return;
        }
        while (
          selectedSlots.length < totalSlotsNeeded &&
          tryPlaceOnDay(new Date(cursor), perfectOnly)
        ) {
          // Placed; re-attempt the same day under the updated counters.
        }
      }
    };

    // Skipped entirely when nothing was asked for, so the single sweep below is
    // the only one that runs and today's placements are reproduced exactly.
    if (maxScore > 0) sweepPeriod(true);
    // MUST stay unconditional and MUST stay over the whole window. This is the
    // only thing making the preferred-only sweep above a preference rather than
    // a filter: everything it declined is reconsidered here.
    sweepPeriod(false);

    if (selectedSlots.length < totalSlotsNeeded) {
      // PR 2c resilience (audit gap #6) — a consultant staring at "Could only
      // find 0 of 12" deserves to know WHY: the scheduling period is over
      // (add availability or extend the period), vs everything is booked
      // (wait for cancellations), vs caps are unsatisfiable. The period check
      // runs first because it's the most actionable answer.
      if (
        config.schedulingPeriodEndsAt &&
        config.schedulingPeriodEndsAt < now
      ) {
        throw new AllocationValidationError(
          `The scheduling period ended on ${config.schedulingPeriodEndsAt.toLocaleDateString()}. ` +
            `Found ${selectedSlots.length} of ${totalSlotsNeeded} required slots. ` +
            `Extend the period on the plan to allocate more sessions.`,
          "PERIOD_ENDED",
        );
      }
      // #1206 — whole SESSIONS, which is the unit the consultant reasons in
      // and the only unit a partial schedule can be measured in. The sweep
      // only ever places complete sessions, so this division is exact.
      const placeableSessions = Math.floor(selectedSlots.length / slotsPerCall);
      const requiredSessions = Math.ceil(totalSlotsNeeded / slotsPerCall);

      // The consultant said "place what fits and follow up with the rest".
      // A paid subscription whose window cannot hold every session used to be
      // simply unallocatable — nothing was scheduled at all.
      if (allowPartial && placeableSessions > 0) {
        return selectedSlots
          .slice(0, placeableSessions * slotsPerCall)
          .sort((a, b) => a.getTime() - b.getTime());
      }

      throw new SlotShortageError(
        `Could only find ${selectedSlots.length} of ${totalSlotsNeeded} required slots`,
        placeableSessions,
        requiredSessions,
      );
    }

    return selectedSlots.sort((a, b) => a.getTime() - b.getTime());
  }

  /**
   * Create the occurrence rows for allocated slots (#1554).
   *
   * ARCHITECTURE:
   * - One Appointment = one PURCHASE (the wrapper checkout or the planner
   *   created); a subscription or class is one wrapper with N occurrences.
   * - One AppointmentOccurrence = one call, carrying its real endsAt and a
   *   1-based ordinal inside the wrapper.
   * - The 30-minute interval is the unit of arithmetic only.
   *
   * The wrapper is REUSED whenever it exists (the payment-bearing row for a
   * subscription, the class row the planner minted, a preserved 1:1 row); a
   * fresh wrapper is created only when the event has none. Returns the one
   * wrapper in a single-element array, which is what every caller reads.
   *
   * DEFENSIVE VALIDATION:
   * This is a defensive check - slot count should already be validated
   * by the caller, but we verify again to prevent data corruption.
   */
  private static async createAppointments(
    tx: Tx,
    eventType: EventType,
    eventId: string,
    slots: Date[],
    consultantUserId: string,
    consulteeUserId?: string,
    config?: EventConfig,
    // #768 Comment 5 — slots created here inherit the org context
    // resolved by fetchEventData. SUBSCRIPTION pulls from the placeholder
    // Appointment's Payment.organizationId; CLASS pulls from
    // classPlan.organizationId (host wins per #768 design decision);
    // CONSULTATION/WEBINAR re-read the existing Appointment's tag.
    organizationId?: string | null,
    // #898 — when set (a 1:1 consultation/webinar whose payment-bearing
    // appointment was preserved by the delete guard), REUSE that appointment
    // instead of creating a second row on the @unique event FK (P2002). Only
    // ever set for single-call event types.
    reuseAppointmentId?: string,
    // #837 — stamp this batch's dedupe key on the FIRST appointment only, so a
    // replay trips the @unique (P2002 → typed 409 below) if it slips past the
    // pre-check. Nullable by design: only real keys dedupe.
    idempotencyKey?: string,
    // #1554 — ordinals of the rows this allocation replaces, in call order;
    // call i inherits position i and only surplus calls take a new number.
    inheritedOrdinals: number[] = [],
    // #1780 decision 9 — a reschedule's replacements are moves; a re-plan's
    // row is a move only when its times differ from the freed row's.
    moves?: { isReschedule: boolean; freedWindows: FreedWindow[] },
  ): Promise<any[]> {
    const hostMoves = moves ?? { isReschedule: false, freedWindows: [] };
    const slotsPerCall = ScheduleCalculationService.getSlotsPerCall(
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

    // #440 — denormalize the consultant onto each slot for the DB-level
    // overlap guard. The column is nullable for LEGACY rows only — an active
    // allocation without a resolvable profile would silently disable the
    // guard, so it throws instead (review catch on #843).
    const consultantProfileRow = await tx.consultantProfile.findFirst({
      where: { user: { id: consultantUserId } },
      select: { id: true },
    });
    if (!consultantProfileRow) {
      throw new Error(
        `Consultant profile not found for user ${consultantUserId} — refusing to create slots without the #440 overlap-guard column`,
      );
    }

    // #1499 — sessions allocated later inherit the terms the booking was SOLD
    // under, read off the row checkout created (the oldest appointment of this
    // event). Resolving fresh here would hand a buyer whatever ladder the org
    // published since, which is precisely what versioning exists to prevent. A
    // reused appointment already carries its own FK, so it is skipped.
    let inheritedPolicyId: string | null = null;
    if (!reuseAppointmentId) {
      const relationField = getEventRelationField(eventType);
      const originating = await tx.appointment.findFirst({
        where: {
          [`${relationField}Id`]: eventId,
        } as Prisma.AppointmentWhereInput,
        orderBy: { createdAt: "asc" },
        select: { cancellationPolicyId: true },
      });
      inheritedPolicyId = originating?.cancellationPolicyId ?? null;
    }

    // One wrapper, N occurrences. A concurrent booking that overlaps an
    // existing confirmed occurrence trips the #440 exclusion constraint (or the
    // unique guard); convert it to a typed 409 here at the source so
    // classifyError can stay typed-only rather than sniffing Postgres error
    // strings (#837).
    // #873 — kept as any[]: tx.appointment.create's include-payload type does
    // not narrow to AppointmentWithSlots through Promise.all+map here (tsc rejects).
    let appointments: any[];
    // The rows THIS batch wrote, by ordinal: a reused wrapper's include also
    // returns the occurrences it already had (#1554).
    let newOccurrenceIds: string[] = [];
    try {
      const relationField = getEventRelationField(eventType);
      // #1554 — the purchase wrapper already exists for every subscription
      // (checkout minted it) and for a class the planner scheduled; attach to
      // it. The event FKs are @unique, so a second create would be a P2002.
      const wrapperId =
        reuseAppointmentId ??
        (
          await tx.appointment.findFirst({
            where: {
              [`${relationField}Id`]: eventId,
            } as Prisma.AppointmentWhereInput,
            select: { id: true },
          })
        )?.id;
      // A genuinely new call continues the wrapper's numbering past both the
      // surviving rows and the positions being inherited.
      let nextFreshOrdinal = Math.max(
        wrapperId ? await nextOrdinal(tx, wrapperId) : 1,
        ...inheritedOrdinals.map((ordinal) => ordinal + 1),
      );
      // #837 — the batch's dedupe key rides on the wrapper.
      const idempotencyData = idempotencyKey
        ? { allocationIdempotencyKey: idempotencyKey }
        : {};
      // One occurrence per call with the real end; the 30-minute intervals
      // stay the unit of arithmetic, not the persisted shape.
      const movedAt = new Date();
      const occurrencesToCreate = calls.map((sessionSlots, callIndex) => {
        const row = {
          ordinal: inheritedOrdinals[callIndex] ?? nextFreshOrdinal++,
          startsAt: sessionSlots[0],
          endsAt: new Date(
            sessionSlots[sessionSlots.length - 1].getTime() +
              SCHEDULING_INTERVAL_MS,
          ),
          isTentative: false,
          consultantProfileId: consultantProfileRow.id,
        };
        const inherited = inheritedOrdinals[callIndex] !== undefined;
        return inherited && isHostMove(row, hostMoves)
          ? { ...row, movedAt }
          : row;
      });

      const wrapper = wrapperId
        ? await tx.appointment.update({
            where: { id: wrapperId },
            data: {
              ...idempotencyData,
              occurrences: { create: occurrencesToCreate },
            },
            include: { occurrences: true },
          })
        : await tx.appointment.create({
            // Unchecked (scalar-FK) shape throughout, as checkout writes it.
            // A relation-style `connect` next to any scalar FK makes Prisma
            // validate against the checked input, which has no *Id fields —
            // "Unknown argument cancellationPolicyId" (FAMILIARISE_WEB-4F).
            data: {
              appointmentType: getAppointmentType(eventType),
              [`${relationField}Id`]: eventId,
              ...idempotencyData,
              organizationId: organizationId ?? null,
              // B1/#1499 — inherit the terms the booking was sold under;
              // NULL is the platform ladder.
              cancellationPolicyId: inheritedPolicyId,
              occurrences: { create: occurrencesToCreate },
            },
            include: { occurrences: true },
          });
      appointments = [wrapper];
      // #1569 — the hold anchors on the last live call, and this write just
      // changed the live set (first allocation, top-up or reschedule alike).
      await recomputeEarningsHold(tx, wrapper.id);
      const written = new Set(occurrencesToCreate.map((row) => row.ordinal));
      newOccurrenceIds = (
        wrapper.occurrences as { id: string; ordinal: number }[]
      )
        .filter((row) => written.has(row.ordinal))
        .map((row) => row.id);
      // #1319 A9 — allocation writes confirmed occurrences, so the participants
      // are CONFIRMED from the start; a reused wrapper already has its rows
      // (createMany skips duplicates). Once per purchase (#1554).
      await recordParticipants(
        tx,
        wrapper.id,
        consulteeUserId
          ? [
              { userId: consultantUserId, role: "CONSULTANT" },
              { userId: consulteeUserId, role: "CONSULTEE" },
            ]
          : [{ userId: consultantUserId, role: "CONSULTANT" }],
        { organizationId: organizationId ?? null, status: "CONFIRMED" },
      );
    } catch (error) {
      // Not captured here — createAppointments only runs inside
      // autoAllocate/manualAllocate, both under allocate()'s try, whose catch
      // reports every error reaching it (this one included). A second
      // capture here would be a pure dupe of the same instance.
      if (isExclusionViolation(error) || isUniqueViolation(error)) {
        // A concurrent booking winning the #440 overlap guard is the ordinary
        // "someone else got there first" race, not a fault.
        throw new AllocationConflictError(
          "This time slot was just booked by someone else. Please pick another time.",
          "SLOT_TAKEN",
        );
      }
      throw error;
    }

    // Issue #710: per-allocation cap debit for SUBSCRIPTION.
    //
    // CONSULTATION/WEBINAR debit at checkout (1 engagement, slots known
    // synchronously). CLASS debits at enrolment (N engagements, all
    // occurrences pre-allocated by the consultant). SUBSCRIPTION is the
    // only event type with truly lazy allocation — the consultant adds calls
    // one-at-a-time via the Requests tab — so the cap debit must happen
    // here, once per occurrence created (#1554: the engagement is the call).
    //
    // The original Payment carries the org tag; we re-resolve the
    // ProgramAssignment fresh because cycles may have rolled since
    // signup and we want today's cap, not signup-time's cap. If the
    // booking wasn't org-sponsored (no organizationId on the original
    // Payment) we skip silently.
    if (
      eventType === "subscription" &&
      consulteeUserId &&
      newOccurrenceIds.length > 0
    ) {
      await this.recordSubscriptionAllocationCap(
        tx,
        eventId,
        consulteeUserId,
        newOccurrenceIds,
      );
    }

    return appointments;
  }

  /**
   * For SUBSCRIPTION: debit `engagementsConsumed` per occurrence created in
   * this allocation batch against the consultee's active org program
   * assignment. No-op when the booking isn't org-sponsored. #1554 —
   * `BookingUtilization.appointmentIds` holds the OCCURRENCE ids here: the
   * engagement is the call, and the wrapper is one row for the whole plan.
   *
   * Throws `ProgramAssignmentLimitError` if the cap is BLOCK and would
   * be exceeded — the surrounding transaction rolls back the new slots.
   */
  private static async recordSubscriptionAllocationCap(
    tx: Tx,
    subscriptionId: string,
    consulteeUserId: string,
    newOccurrenceIds: string[],
  ): Promise<void> {
    // Find the original signup Payment via the purchase wrapper (#1554).
    const subscription = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: { select: { totalSessions: true, price: true } },
        appointment: {
          include: {
            payment: true,
            occurrences: { where: { deletedAt: null }, select: { id: true } },
          },
        },
      },
    });

    // Schema declares Appointment.payment as Payment[] (one Appointment
    // can carry multiple Payments historically — refunds/retries chain
    // off the original). Pick the EARLIEST org-tagged one: an unordered
    // .find() over a retry chain debits whichever row the DB happened to
    // return first, landing utilization on the wrong ProgramAssignment cycle
    // (#1169 PR 1).
    const orgPayment = (subscription?.appointment?.payment ?? [])
      .filter((p) => !!p.organizationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

    if (!orgPayment || !orgPayment.organizationId) {
      // PERSONAL-funded subscription — no org cap to debit.
      return;
    }

    const membership = await tx.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: consulteeUserId,
          organizationId: orgPayment.organizationId,
        },
      },
    });
    if (!membership || membership.status !== "ACTIVE") return;

    // Re-resolve the active ProgramAssignment at allocation time.
    // Mirrors the resolver in lib/payments/operations/checkout.ts so the
    // same coverage filters apply (assignment ACTIVE, program ACTIVE,
    // contract ACTIVE, covers SUBSCRIPTION).
    const now = new Date();
    const assignment = await tx.programAssignment.findFirst({
      where: {
        membershipId: membership.id,
        // #1132 follow-up — checkout filters on status too; without it the
        // period window alone matched ROLLED / CLOSED / CANCELLED rows, so a
        // dead assignment inside its old window could still be debited by a
        // lazily-allocated subscription session.
        status: "ACTIVE",
        periodStart: { lte: now },
        periodEnd: { gte: now },
        program: {
          status: "ACTIVE",
          OR: [
            { coveredPlanTypes: { isEmpty: true } },
            { coveredPlanTypes: { has: "SUBSCRIPTION" } },
          ],
          contract: {
            organizationId: orgPayment.organizationId,
            status: "ACTIVE",
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
          },
        },
      },
      orderBy: { periodEnd: "desc" },
      select: {
        id: true,
        program: {
          select: {
            type: true,
            licensedSeatConfig: {
              select: { priceCapPerEngagementPaise: true },
            },
          },
        },
      },
    });
    if (!assignment) return;

    // priceAtBookingPaise: full upfront sub price on the very first
    // allocation (so the BookingUtilization row carries it for
    // analytics); 0 on subsequent allocations (no new money). The
    // helper's upsert preserves the first-create priceAtBookingPaise.
    const existingUtil = await tx.bookingUtilization.findUnique({
      where: { paymentId: orgPayment.id },
      select: { id: true, appointmentIds: true },
    });
    const priceAtBookingPaise = existingUtil ? 0 : orgPayment.amount;

    // Re-allocation deletes counted occurrences and recreates them with
    // fresh ids, so an id-set diff alone re-debits every replaced session.
    // Substitute stale tracked ids (no longer live on this subscription)
    // with incoming ids 1:1 WITHOUT debiting; only ids beyond the
    // substitution budget are genuinely additional sessions.
    let idsToDebit = newOccurrenceIds;
    if (existingUtil) {
      const liveIds = new Set(
        (subscription!.appointment?.occurrences ?? []).map((o) => o.id),
      );
      const trackedLive = existingUtil.appointmentIds.filter((id) =>
        liveIds.has(id),
      );
      const staleCount =
        existingUtil.appointmentIds.length - trackedLive.length;
      if (staleCount > 0) {
        const alreadyTracked = new Set(trackedLive);
        const incomingNew = newOccurrenceIds.filter(
          (id) => !alreadyTracked.has(id),
        );
        const substituted = incomingNew.slice(0, staleCount);
        idsToDebit = incomingNew.slice(staleCount);
        await tx.bookingUtilization.update({
          where: { id: existingUtil.id },
          data: { appointmentIds: [...trackedLive, ...substituted] },
        });

        // The substitution above only cancels out the sessions that were
        // REPLACED. Sessions removed and not re-created in this allocation
        // (a partial reschedule that drops 3 and re-places 1, an in-progress
        // reallocation that shrinks the remaining plan) were left debited
        // forever: the org kept paying for engagements the consultee will
        // never take, and the seat never came back. Give the difference back
        // through the ledger-derived reversal, which is idempotent and clamps
        // itself to what is still reversible.
        const netRemoved = staleCount - substituted.length;
        if (netRemoved > 0) {
          await reverseBookingUtilization(tx, {
            paymentId: orgPayment.id,
            engagementsToReverse: netRemoved,
            reason: "Subscription sessions removed during re-allocation",
          });
        }

        if (idsToDebit.length === 0) return;
      }
    }

    // Not captured here — this only runs from createAppointments, itself only
    // reachable via allocate()'s try, whose catch reports every error
    // reaching it (a ProgramAssignmentLimitError cap-exceeded included,
    // correctly classified as one of its modelled outcomes). A capture here
    // too would be a dupe, so this no longer needs its own try/catch.
    const utilResult = await recordBookingUtilization(tx, {
      programAssignmentId: assignment.id,
      paymentId: orgPayment.id,
      engagementsConsumed: idsToDebit.length,
      priceAtBookingPaise,
      // PR-1e (G3): pass the occurrence ids so re-allocation
      // (delete+recreate of the same call) can't double-debit. The
      // helper computes the set diff against
      // BookingUtilization.appointmentIds and increments only by the
      // genuinely-new ids.
      appointmentIds: idsToDebit,
    });

    // #1895 — Trigger overage billing when a lazily allocated subscription
    // session exceeds the program cap.
    if (utilResult?.wasOverage) {
      await this.settleSubscriptionAllocationOverage({
        tx,
        subscriptionId,
        subscription,
        orgPayment,
        assignment,
        existingUtil,
        idsToDebit,
        utilResult,
        consulteeUserId,
      });
    }
  }

  private static async settleSubscriptionAllocationOverage(params: {
    tx: Tx;
    subscriptionId: string;
    subscription: {
      subscriptionPlanId?: string;
      sessionsTotal?: number | null;
      subscriptionPlan?: {
        totalSessions?: number | null;
        price?: number | null;
      } | null;
    } | null;
    orgPayment: {
      id: string;
      amount: number;
      originalAmount?: number | null;
      currency?: Prisma.PaymentCreateInput["currency"] | null;
      organizationId: string | null;
      paymentGateway?: Prisma.PaymentCreateInput["paymentGateway"] | null;
    };
    assignment: {
      id: string;
      program?: {
        type?: "LICENSED_SEAT" | "CREDIT_POOL" | null;
        licensedSeatConfig?: {
          priceCapPerEngagementPaise?: number | null;
        } | null;
      } | null;
    };
    existingUtil: { id: string } | null;
    idsToDebit: string[];
    utilResult: Awaited<ReturnType<typeof recordBookingUtilization>>;
    consulteeUserId: string;
  }): Promise<void> {
    const {
      tx,
      subscriptionId,
      subscription,
      orgPayment,
      assignment,
      existingUtil,
      idsToDebit,
      utilResult,
      consulteeUserId,
    } = params;
    if (!orgPayment.organizationId) return;

    const totalPlanSessions = Math.max(
      1,
      subscription?.sessionsTotal ??
        subscription?.subscriptionPlan?.totalSessions ??
        1,
    );
    const basePaymentAmount = orgPayment.originalAmount ?? orgPayment.amount;
    let unitSessionPricePaise = Math.round(
      basePaymentAmount / totalPlanSessions,
    );
    if (unitSessionPricePaise <= 0) {
      const planPricePaise =
        subscription?.subscriptionPlan?.price ??
        (subscription?.subscriptionPlanId
          ? (
              await tx.subscriptionPlan?.findUnique?.({
                where: { id: subscription.subscriptionPlanId },
                select: { price: true },
              })
            )?.price
          : undefined);
      if (typeof planPricePaise === "number" && planPricePaise > 0) {
        unitSessionPricePaise = Math.round(planPricePaise / totalPlanSessions);
      }
    }

    const programPriceCapPaise =
      assignment.program?.licensedSeatConfig?.priceCapPerEngagementPaise;
    if (unitSessionPricePaise <= 0 && (programPriceCapPaise ?? 0) <= 0) {
      await recordSystemErrorSafe({
        organizationId: orgPayment.organizationId,
        category: "OVERAGE_SUBSCRIPTION_NO_UNIT_PRICE",
        summary:
          "Subscription overage allocation resolved zero unit session price with no program price cap",
        err: new Error(
          `OVERAGE_SUBSCRIPTION_NO_UNIT_PRICE for subscription=${subscriptionId} payment=${orgPayment.id}`,
        ),
        db: tx,
        context: {
          subscriptionId,
          paymentId: orgPayment.id,
          programAssignmentId: assignment.id,
          basePaymentAmount,
          totalPlanSessions,
        },
      });
      return;
    }

    const overageBookingPricePaise = idsToDebit.length * unitSessionPricePaise;
    const { recordOverageAtCheckout, notifyOverageDueAfterCommit } =
      await import("@/lib/payments/billing/overage-settlement");
    const resolvedProgramType =
      assignment.program?.type ?? utilResult.programType ?? "LICENSED_SEAT";
    const lazyCreditDelta = existingUtil ? overageBookingPricePaise : 0;
    const effectiveConsumedPaiseAfter =
      resolvedProgramType === "CREDIT_POOL"
        ? utilResult.consumedPaiseAfter + lazyCreditDelta
        : utilResult.consumedPaiseAfter;
    const pendingNotify = await recordOverageAtCheckout({
      tx,
      programAssignmentId: assignment.id,
      utilization: {
        programType: resolvedProgramType,
        engagementsConsumedDelta: utilResult.engagementsConsumedDelta,
        engagementsUsedAfter: utilResult.engagementsUsedAfter,
        consumedPaiseAfter: effectiveConsumedPaiseAfter,
        creditBudgetPaise: utilResult.creditBudgetPaise,
      },
      bookingPricePaise: overageBookingPricePaise,
      currency: orgPayment.currency ?? "INR",
      paymentId: orgPayment.id,
      userId: consulteeUserId,
      organizationId: orgPayment.organizationId,
      paymentGateway: orgPayment.paymentGateway ?? "RAZORPAY",
      isLazyAllocation: existingUtil !== null,
    });
    if (pendingNotify) {
      notifyOverageDueAfterCommit(pendingNotify);
    }
  }

  /**
   * Re-seat enrolled users on newly created appointments.
   * Used during in-progress reallocation of group events (classes): when
   * future sessions are deleted and recreated, the learners' participant rows
   * go with the deleted appointments (#1554). This restores them.
   */
  private static async reconnectEnrolledUsers(
    tx: Tx,
    appointments: AppointmentWithSlots[],
    enrolledUserIds: string[],
    consultantUserId: string,
    organizationId: string | null | undefined,
  ): Promise<void> {
    // Filter out the consultant (already seated via createAppointments)
    const userIdsToConnect = enrolledUserIds.filter(
      (id) => id !== consultantUserId,
    );
    if (userIdsToConnect.length === 0) return;

    for (const appointment of appointments) {
      // #1319 A9 — re-linked learners keep their seat; idempotent on retry.
      await recordParticipants(
        tx,
        appointment.id,
        userIdsToConnect.map((userId) => ({
          userId,
          role: "CONSULTEE" as const,
        })),
        // Same org tag as the consultant row createAppointments wrote, so an
        // org-scoped read of the participants never sees a half-tagged seat.
        { status: "CONFIRMED", organizationId },
      );
    }
  }

  /**
   * #1206 — the people already seated on an event's confirmed sessions.
   *
   * Every delete branch harvests these ids from the rows it frees, so that
   * `reconnectEnrolledUsers` can re-seat them on the replacements. A top-up
   * frees nothing, so it reads them off the surviving appointments instead.
   * Without this a class topped up with two more sessions would create them
   * empty: enrolment for a group event lives ONLY on AppointmentParticipant.
   */
  private static async collectEventParticipantIds(
    tx: Tx,
    eventType: EventType,
    eventId: string,
  ): Promise<string[]> {
    const relationField = getEventRelationField(eventType);
    const seats = await tx.appointmentParticipant.findMany({
      where: {
        // A released seat stays as history; only live seats are carried
        // onto the new sessions.
        ...liveParticipant(),
        appointment: {
          [`${relationField}Id`]: eventId,
          occurrences: { some: { isTentative: false, deletedAt: null } },
        } as Prisma.AppointmentWhereInput,
      },
      select: { userId: true },
    });
    return Array.from(new Set(seats.map((seat) => seat.userId)));
  }

  /**
   * Delete existing appointments for an event
   *
   * @param onlyTentative - If true, only delete RELEASED AppointmentOccurrence records
   *                        (tentative + RESCHEDULED + live), preserving confirmed slots,
   *                        fresh tentative holds and their parent appointments.
   *                        Appointments are only deleted if they have zero remaining slots
   *                        after released-slot removal. This is used for partial reschedules.
   * @param preservePastSlots - If true (and onlyTentative is false), only delete future slots,
   *                            preserving past confirmed slots and their Meeting records.
   *                            Used for in-progress reallocation of classes/subscriptions.
   * @returns preservedSlotCount - Number of past slots that were preserved.
   * @returns enrolledUserIds - User IDs connected to deleted future slots (for reconnection).
   * @returns deletedAppointmentIds - AE-4: appointment ids whose tentative slots
   *   were freed (partial reschedule path), so callers can refresh those slots.
   * @returns freedOrdinals - #1554: the ordinals of the occurrence rows this
   *   call deleted, in start order, so their replacements inherit them.
   */
  /** #1766 — the delete step's shape when a top-up deletes nothing. */
  private static nothingDeleted(): {
    enrolledUserIds: string[];
    deletedAppointmentIds: string[];
    freedOrdinals: number[];
    freedWindows: FreedWindow[];
    reusableAppointmentId?: string;
  } {
    return {
      enrolledUserIds: [],
      deletedAppointmentIds: [],
      freedOrdinals: [],
      freedWindows: [],
    };
  }

  private static async deleteExistingAppointments(
    tx: Tx,
    eventType: EventType,
    eventId: string,
    onlyTentative: boolean = false,
    preservePastSlots: boolean = false,
  ): Promise<{
    preservedSlotCount: number;
    enrolledUserIds: string[];
    deletedAppointmentIds: string[];
    freedOrdinals: number[];
    freedWindows: FreedWindow[];
    // #898 — id of a preserved 1:1 (consultation/webinar) payment-bearing
    // appointment the caller must REUSE: its @unique event FK is still taken,
    // so a fresh create would throw P2002. At most one per 1:1 event.
    reusableAppointmentId?: string;
  }> {
    const relationField = getEventRelationField(eventType);
    const whereClause = {
      [`${relationField}Id`]: eventId,
    } as Prisma.AppointmentWhereInput;
    // #898 — set in the onlyTentative / full-delete branches when a 1:1
    // payment-bearing appointment is kept rather than deleted.
    let reusableAppointmentId: string | undefined;

    if (onlyTentative) {
      // Find appointments with tentative slots for this event
      const appointments = await tx.appointment.findMany({
        where: whereClause,
        include: {
          // #1554 — live seat holders, so enrolled learners on a group event
          // can be re-seated on the replacement appointments.
          participants: { where: liveParticipant(), select: { userId: true } },
          occurrences: true,
          // B8 — Payment has onDelete: Cascade on Appointment; deleting an
          // appointment with payment rows destroys the payment/refund audit
          // trail. The refusal now rides in the delete's own WHERE clause
          // (B-P1-05) rather than this read, which can go stale mid-txn.
        },
      });

      // AE-4 — record which appointments had tentative slots freed here (ids
      // captured from the pre-fetched rows, before the deleteMany runs).
      const deletedAppointmentIds: string[] = [];
      // Capture the seat holders of the appointments being emptied. For a
      // group event (class) the enrolled learners live ONLY on
      // AppointmentParticipant — createAppointments seats just the
      // consultant, so without this they'd be orphaned when the class is
      // scheduled (tentative crud-with-plan slots → onlyTentative path).
      // reconnectEnrolledUsers re-seats them; it filters the consultant itself.
      const enrolledUserIdSet = new Set<string>();
      const freed: { ordinal: number; startsAt: Date; endsAt: Date }[] = [];
      for (const appointment of appointments) {
        // Released rows only: a reschedule frees what it released, never a
        // fresh request's tentative holds or crud-with-plan placeholders that
        // happen to coexist on the same event.
        const released = appointment.occurrences.filter(
          isReleasedForReschedule,
        );
        const hasTentative = released.length > 0;

        if (hasTentative) {
          deletedAppointmentIds.push(appointment.id);
          for (const slot of released) {
            freed.push(slot);
          }
          // Collect the seat holders before the appointment may be deleted
          // (their participant rows cascade with it).
          for (const seat of appointment.participants) {
            enrolledUserIdSet.add(seat.userId);
          }
          // Delete only released slots using a direct query (not stale IDs).
          // The WHERE mirrors isReleasedForReschedule: tentative +
          // RESCHEDULED + live.
          await tx.appointmentOccurrence.deleteMany({
            where: {
              appointmentId: appointment.id,
              isTentative: true,
              completionStatus: "RESCHEDULED",
              deletedAt: null,
            },
          });

          // If no occurrences remain after the released ones are removed,
          // delete the now-empty appointment — unless payments reference it
          // (B8): the empty shell is cheaper than a destroyed audit trail;
          // the orphan sweep reports it. A surviving fresh hold or confirmed
          // slot keeps the wrapper: deleting it would cascade-destroy rows
          // this reschedule did not release.
          //
          // B-P1-05 (#1189 audit) — the payment guard rides IN the delete's
          // WHERE clause rather than trusting `_count.payment` above. That
          // count was read earlier in this transaction; a checkout's Payment
          // insert can COMMIT between the read and the delete, and
          // Payment.appointment is onDelete: Cascade, so an unconditional
          // delete would cascade-destroy a payment that did not exist when we
          // looked. Zero rows deleted means a payment appeared: keep the
          // appointment exactly like the payment-bearing path.
          const hasRemaining = appointment.occurrences.some(
            (slot) => !isReleasedForReschedule(slot),
          );
          const deletedAppointment = !hasRemaining
            ? await tx.appointment.deleteMany({
                where: { id: appointment.id, payment: { none: {} } },
              })
            : null;
          if (
            (hasRemaining || deletedAppointment?.count === 0) &&
            (eventType === "consultation" || eventType === "webinar")
          ) {
            // #898 — the appointment is kept (unreleased slots remain, or the
            // payment guard fired). For a 1:1 event it still holds the @unique
            // event FK, so the allocator must REUSE it; a fresh create P2002s.
            reusableAppointmentId = appointment.id;
          }
        }
      }
      return {
        preservedSlotCount: 0,
        enrolledUserIds: Array.from(enrolledUserIdSet),
        deletedAppointmentIds,
        freedOrdinals: this.ordinalsInStartOrder(freed),
        freedWindows: this.windowsOf(freed),
        reusableAppointmentId,
      };
    } else if (preservePastSlots) {
      // In-progress reallocation: only delete future slots, preserve past ones
      const now = new Date();
      const appointments = await tx.appointment.findMany({
        where: whereClause,
        include: {
          // #1554 — live seat holders, so enrolled learners on a group event
          // can be re-seated on the replacement appointments.
          participants: { where: liveParticipant(), select: { userId: true } },
          occurrences: {
            include: {
              meeting: { select: { id: true, endedAt: true } },
            },
          },
          // The payment guard on the empty-appointment delete below rides in
          // that delete's WHERE clause (B-P1-05), not in a pre-read count.
        },
      });

      let preservedSlotCount = 0;
      const enrolledUserIdSet = new Set<string>();
      const freed: { ordinal: number; startsAt: Date; endsAt: Date }[] = [];
      const imminentCutoff = new Date(now.getTime() + TWENTY_FOUR_HOURS_IN_MS);

      for (const appointment of appointments) {
        const pastSlots = appointment.occurrences.filter(
          (slot) => new Date(slot.endsAt) <= now,
        );
        const futureSlots = appointment.occurrences.filter(
          (slot) => new Date(slot.endsAt) > now,
        );

        // Guard: preserve slots that are imminent (<24h) or have active sessions
        const protectedFutureSlots = futureSlots.filter(
          (slot) =>
            new Date(slot.startsAt) < imminentCutoff ||
            (slot.meeting && !slot.meeting.endedAt),
        );
        const deletableFutureSlots = futureSlots.filter(
          (slot) =>
            new Date(slot.startsAt) >= imminentCutoff &&
            (!slot.meeting || slot.meeting.endedAt !== null),
        );

        preservedSlotCount += pastSlots.length + protectedFutureSlots.length;

        // Capture the seat holders before the appointment may be deleted
        if (deletableFutureSlots.length > 0) {
          for (const seat of appointment.participants) {
            enrolledUserIdSet.add(seat.userId);
          }
        }

        if (deletableFutureSlots.length > 0) {
          freed.push(...deletableFutureSlots);
          await tx.appointmentOccurrence.deleteMany({
            where: {
              appointmentId: appointment.id,
              id: { in: deletableFutureSlots.map((s) => s.id) },
            },
          });
        }

        // Only delete the appointment if no slots remain at all — and never
        // when it carries payments (#898 defense-in-depth: the Payment cascade
        // is Restrict-blocked by ConsultantEarnings and rolls back the tx).
        // Latent today (the subscription placeholder can't reach this branch),
        // but mirrors the onlyTentative / full-delete guards. The payment
        // guard rides in the delete's WHERE (B-P1-05) — same race as the
        // onlyTentative branch.
        if (pastSlots.length === 0 && protectedFutureSlots.length === 0) {
          await tx.appointment.deleteMany({
            where: { id: appointment.id, payment: { none: {} } },
          });
        }
      }

      return {
        preservedSlotCount,
        enrolledUserIds: Array.from(enrolledUserIdSet),
        // AE-4 — in-progress path frees future slots, not tentative ones; the
        // freed-id contract is scoped to the partial-reschedule case.
        deletedAppointmentIds: [],
        freedOrdinals: this.ordinalsInStartOrder(freed),
        freedWindows: this.windowsOf(freed),
        // #898 — only class/subscription (1:N) reach this branch; no 1:1 reuse.
        reusableAppointmentId,
      };
    } else {
      // Full delete: remove all appointments for this event.
      // B8 — an appointment that carries Payment rows must NOT be deleted: the
      // delete cascades to Payment (onDelete: Cascade), which is Restrict-
      // referenced by ConsultantEarnings, so the cascade trips the
      // ConsultantEarnings_paymentId_fkey constraint and the whole allocation
      // rolls back. This is exactly the SUBSCRIPTION case — checkout leaves a
      // zero-slot placeholder Appointment carrying the signup Payment+earnings,
      // and initial allocation reaches this branch. Mirror the onlyTentative
      // guard: preserve payment-bearing appointments, just free their slots so
      // they no longer block availability; delete the rest as before.
      const existingAppointments = await tx.appointment.findMany({
        where: whereClause,
        include: {
          // #1554 — live seat holders, so enrolled learners on a group event
          // can be re-seated on the replacement appointments.
          participants: { where: liveParticipant(), select: { userId: true } },
          // meeting rides along so held-session slots can be preserved
          // (#1169 PR 1 — deleting them cascades Meeting → Recording).
          occurrences: {
            include: {
              meeting: { select: { id: true } },
            },
          },
          _count: { select: { payment: true } },
        },
      });

      // Capture every seat holder before the appointment is deleted or
      // stripped; reconnectEnrolledUsers (called by the allocator on a non-empty
      // result) re-seats them on the new appointments and filters the consultant.
      const enrolledUserIdSet = new Set<string>();
      for (const appointment of existingAppointments) {
        for (const seat of appointment.participants) {
          enrolledUserIdSet.add(seat.userId);
        }
      }
      // Every replaceable sessionless row below is deleted whichever arm runs;
      // a held-session or completed/past history row survives and keeps its ordinal.
      const now = new Date();
      const isProtectedSessionlessSlot = (
        slot: (typeof existingAppointments)[number]["occurrences"][number],
      ): boolean =>
        slot.completionStatus === "COMPLETED" ||
        (slot.completionStatus !== undefined &&
          !slot.isTentative &&
          new Date(slot.endsAt) <= now);
      const freed = existingAppointments.flatMap((appointment) =>
        appointment.occurrences.filter(
          (slot) => slot.meeting === null && !isProtectedSessionlessSlot(slot),
        ),
      );

      await Promise.all(
        existingAppointments.map(async (appointment) => {
          // #1169 PR 1 & #1692 Item 6 — a slot whose Meeting already happened
          // or that is already COMPLETED / in the past is history, not
          // availability: deleting it cascades Meeting → Recording or destroys
          // completed occurrence history. Preserve the appointment and every
          // held/completed/past slot; only replaceable future sessionless slots
          // are freed.
          const hasHeldSession = appointment.occurrences.some(
            (slot) => slot.meeting !== null,
          );
          const hasProtectedSessionless = appointment.occurrences.some(
            isProtectedSessionlessSlot,
          );
          const occurrenceDeleteWhere: Prisma.AppointmentOccurrenceWhereInput =
            hasProtectedSessionless
              ? {
                  appointmentId: appointment.id,
                  meeting: { is: null },
                  endsAt: { gt: now },
                  completionStatus: { not: "COMPLETED" },
                }
              : {
                  appointmentId: appointment.id,
                  meeting: { is: null },
                };
          if (
            (appointment._count?.payment ?? 0) > 0 ||
            hasHeldSession ||
            hasProtectedSessionless
          ) {
            // Keep the Appointment (and its Payment + ConsultantEarnings audit
            // trail); strip its slots. No-op for the slot-less subscription
            // placeholder, but frees slots for any other payment-bearing case.
            if (eventType === "consultation" || eventType === "webinar") {
              // #898 — 1:1 event: the kept appointment still holds the @unique
              // event FK, so the allocator must REUSE it (a fresh create P2002s).
              // At most one such appointment exists per 1:1 event.
              reusableAppointmentId = appointment.id;
            }
            return tx.appointmentOccurrence.deleteMany({
              where: occurrenceDeleteWhere,
            });
          }
          // B-P1-05 (#1189 audit) — atomic payment guard, same as the
          // onlyTentative branch: a checkout's Payment can commit between the
          // `_count` read above and this delete; the WHERE clause re-checks at
          // write time so the cascade can never consume it. Zero rows deleted
          // means a payment appeared — keep the appointment and strip only its
          // sessionless slots, exactly like the payment-bearing path above.
          const deletedAppointment = await tx.appointment.deleteMany({
            where: { id: appointment.id, payment: { none: {} } },
          });
          if (deletedAppointment.count === 0) {
            if (eventType === "consultation" || eventType === "webinar") {
              reusableAppointmentId = appointment.id;
            }
            return tx.appointmentOccurrence.deleteMany({
              where: occurrenceDeleteWhere,
            });
          }
          return deletedAppointment;
        }),
      );
      return {
        preservedSlotCount: 0,
        enrolledUserIds: Array.from(enrolledUserIdSet),
        deletedAppointmentIds: [],
        freedOrdinals: this.ordinalsInStartOrder(freed),
        freedWindows: this.windowsOf(freed),
        reusableAppointmentId,
      };
    }
  }

  /** #1780 decision 9 — the times each freed ordinal held before the re-plan. */
  private static windowsOf(
    rows: { ordinal: number; startsAt: Date; endsAt: Date }[],
  ): FreedWindow[] {
    return rows.map((row) => ({
      ordinal: row.ordinal,
      startsAt: new Date(row.startsAt),
      endsAt: new Date(row.endsAt),
    }));
  }

  /** #1554 — freed ordinals in call order, so call i inherits position i. */
  private static ordinalsInStartOrder(
    rows: { ordinal: number; startsAt: Date }[],
  ): number[] {
    return [...rows]
      .sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      )
      .map((row) => row.ordinal);
  }
}
