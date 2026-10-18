/**
 * Slot Allocation Service
 *
 * Unified allocation algorithms for all event types.
 * Handles auto, manual, and requested slot allocation.
 */

import { reportSentryError } from "@/lib/observability/report";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  AllocationRequest,
  AllocationResult,
  type AllocationTxOptions,
  EventType,
  isRecurringEventType,
  isReleasedForReschedule,
} from "./types";
import { ScheduleCalculationService } from "./ScheduleCalculationService";
import { intervalCountOf } from "@/lib/appointments/occurrences";
import { ScheduleValidationService } from "./ScheduleValidationService";
import {
  lockAutoAllocate,
  unlockAutoAllocate,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  type ApprovalLock,
} from "@/utils/appointmentlock";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import type { FreedWindow } from "@/lib/booking/class-series";
import {
  AllocationValidationError,
  AllocationNotFoundError,
  AllocationConflictError,
  SlotShortageError,
} from "./errors";
import { attemptTrigger } from "@/lib/novu";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  classifyError,
  isModeledOutcome,
} from "@/lib/booking/allocation/classify";
import { stageAllocationNotices } from "@/lib/booking/allocation/notify";
import {
  getConsulteeUserId,
  getEventRelationField,
  getConsultantProfileId,
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
import { findAvailableSlots } from "@/lib/booking/allocation/search/find-available-slots";
import { createAppointments } from "@/lib/booking/allocation/commit/create-appointments";
import { deleteExistingAppointments } from "@/lib/booking/allocation/commit/release-tentative";
import {
  reconnectEnrolledUsers,
  collectEventParticipantIds,
} from "@/lib/booking/allocation/commit/reconnect-enrolled";

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
        selectedSlots = await findAvailableSlots(
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
              enrolledUserIds = await collectEventParticipantIds(
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
            } = await deleteExistingAppointments(
              tx,
              eventType,
              eventId,
              isReschedule,
              isInProgressReallocation,
            ));
          }

          // Create appointments
          const appointments = await createAppointments(
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
            await reconnectEnrolledUsers(
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
              enrolledUserIds = await collectEventParticipantIds(
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
            } = await deleteExistingAppointments(
              tx,
              eventType,
              eventId,
              isReschedule,
              isInProgressReallocation,
            ));
          }

          // Create appointments
          const appointments = await createAppointments(
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
            await reconnectEnrolledUsers(
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
}
