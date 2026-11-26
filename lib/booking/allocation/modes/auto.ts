// AUTO mode. Owns its whole envelope: consultant then consultee lock, reads
// and search outside the write transaction, the short write, then release.

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  AllocationResult,
  type AllocationTxOptions,
  EventType,
  isRecurringEventType,
} from "@/utils/scheduling-engine/types";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import {
  lockAutoAllocate,
  unlockAutoAllocate,
  ALLOCATOR_LOCK_RETRY_CONFIG,
  lockConsulteeBooking,
  renewConsulteeBooking,
  unlockConsulteeBooking,
  tryLockSlotBatch,
  unlockSlotInterval,
  type ApprovalLock,
  type SlotBatchGrant,
} from "@/utils/appointmentlock";
import {
  ALLOCATION_SLOT_BATCH_TTL_MS,
  AllocationRaceError,
  MAX_ALLOCATION_RESEARCHES,
  allocationBatchEntries,
  allocationBatchProfiles,
  heldSlotStartsOf,
  lockAllocationTimesInTx,
  renewAllocationBatch,
} from "@/lib/booking/allocation/slot-batch";
import type { FreedWindow } from "@/lib/booking/class-series";
import {
  AllocationValidationError,
  AllocationNotFoundError,
  AllocationConflictError,
  SlotShortageError,
} from "@/utils/scheduling-engine/errors";
import { stageAllocationNotices } from "@/lib/booking/allocation/notify";
import { checkoutInProgressError } from "@/lib/booking/request-cohort";
import {
  slotTakenRefusal,
  validationRefusal,
} from "@/lib/booking/allocation/refusal-copy";
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
  tentativeSlotCountOf,
} from "@/lib/booking/allocation/counts";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";
import {
  assertHeldSessionCountInTx,
  assertExpectedTentativeSlotCount,
  assertExpectedTentativeSlotCountInTx,
  assertNoConfirmedSlots,
  guardAllocationInTx,
  mustBeUnscheduled,
  assertGroupEventUnsoldInTx,
} from "@/lib/booking/allocation/guards";
import {
  resolveConsumedPreferenceRequests,
  findAllocationPreference,
} from "@/lib/booking/allocation/preference";
import { replacementLeadMs } from "@/lib/booking/reschedule-proposals";
import { findIdempotentAllocation } from "@/lib/booking/allocation/idempotency";
import {
  assertCollaboratorsFree,
  lockPlanForAllocation,
} from "@/lib/booking/allocation/collaborators";
import { findAvailableSlots } from "@/lib/booking/allocation/search/find-available-slots";
import { assertSlotsStillPublished } from "@/lib/booking/allocation/coverage";
import { ALLOCATOR_SEARCH_TIME_BUDGET_MS } from "@/lib/booking/allocation/search/constants";
import { createSearchBudget } from "@/utils/scheduling-engine/availability-search";
import { createAppointments } from "@/lib/booking/allocation/commit/create-appointments";
import { deleteExistingAppointments } from "@/lib/booking/allocation/commit/release-tentative";
import {
  reconnectEnrolledUsers,
  collectEventParticipantIds,
} from "@/lib/booking/allocation/commit/reconnect-enrolled";
import { bookingTransaction } from "@/lib/db/booking-transaction";

export async function autoAllocate(
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
  const consultantProfileId = await getConsultantProfileId(eventType, eventId);
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
  // Lock order: consultant → consultee → slot batch. The consultee key (one
  // person is never booked with two experts at once) is held only from the
  // batch to the write, so the buyer's own checkout is never refused while a
  // search (first or re-search) runs.
  let consulteeLock: ApprovalLock | null = null;
  let slotGrant: SlotBatchGrant | null = null;
  try {
    const consulteeLockUserId = await getConsulteeUserId(eventType, eventId);

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
    if (mustBeUnscheduled(eventType, initialAllocation)) {
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

    const {
      consultant,
      config,
      consulteeUserId,
      organizationId,
      planId,
      settled,
    } = eventData;
    if (eventData.checkoutInProgress) throw checkoutInProgressError();

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
    const leadTimeMs = replacementLeadMs(
      isReschedule,
      excludeRescheduleRequestId,
      settled,
    );

    // ADR B10, derived rather than trusted. The client set initialAllocation
    // only when tentativeSlotCount === 0, but EVERY pending request already
    // carries tentative slots (request-for-approval and unpaid checkout both
    // create them that way), so the flag was never true for a consultation
    // and the multi-tab guard never ran. Having no CONFIRMED slot is the real
    // "not allocated yet" condition; the in-txn advisory lock this gates
    // serialises two tabs of the same event.
    const isFreshAllocation =
      mustBeUnscheduled(eventType, initialAllocation) ||
      initialAllocation === true ||
      existingNonTentativeSlotCount === 0;

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
          ScheduleCalculationService.calculateRequiredSlots(eventType, config);
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
    const releasedOccurrenceIds = releasedOccurrenceIdsOf(existingAppointments);
    const preference = await findAllocationPreference(releasedOccurrenceIds);

    // Every profile these times make busy (host, ACCEPTED co-hosts, an expert
    // consultee's own calendar), locked as one atomic batch after the search.
    const batchProfiles = await allocationBatchProfiles({
      eventType,
      planId,
      consultantProfileId,
      consulteeUserId,
    });
    const heldSlotStarts: string[] = [];
    // One search budget for the first search and every re-search, so the
    // whole request stays inside the edge limit however often it re-searches.
    const searchBudget = createSearchBudget(ALLOCATOR_SEARCH_TIME_BUDGET_MS);
    let selectedSlots: Date[];
    let validation: Awaited<ReturnType<ScheduleValidationService["validate"]>>;
    for (let research = 0; ; research++) {
      // Find available slots (read-only; runs out-of-txn under the locks)
      // Pass appointmentIdsToExclude so their slots are excluded from bookedSlots
      // Pass existingAppointments so sessionsPerWeek is scoped to this event only
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
          heldSlotStarts,
          searchBudget,
          leadTimeMs,
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
        // A shortage only after excluding held times is a race, not a full calendar.
        if (research > 0 && error instanceof SlotShortageError) {
          throw new AllocationRaceError();
        }
        throw error;
      }

      // Validate (read-only; runs out-of-txn under the locks)
      // Pass the exclusions so the rows being replaced don't trigger false conflicts
      validation = await new ScheduleValidationService(prisma).validate(
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
          leadTimeMs,
        },
      );

      if (!validation.isValid) {
        throw validationRefusal(validation.errors);
      }

      if (consulteeLockUserId) {
        consulteeLock = await lockConsulteeBooking(
          consulteeLockUserId,
          undefined,
          ALLOCATOR_LOCK_RETRY_CONFIG,
        );
      }
      // Never waits: a held time is excluded and searched around instead.
      const batch = await tryLockSlotBatch(
        allocationBatchEntries(selectedSlots, batchProfiles),
        ALLOCATION_SLOT_BATCH_TTL_MS,
      );
      if (batch.ok) {
        slotGrant = batch.grant;
        break;
      }
      if (consulteeLock) {
        await unlockConsulteeBooking(consulteeLock);
        consulteeLock = null;
      }
      if (research >= MAX_ALLOCATION_RESEARCHES || searchBudget.exhausted())
        throw new AllocationRaceError();
      heldSlotStarts.push(...heldSlotStartsOf(batch.heldKeys));
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
    return await bookingTransaction(
      async (tx) => {
        await lockAllocationTimesInTx(
          tx,
          selectedSlots,
          batchProfiles,
          () => new AllocationRaceError(),
        );
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
        // The plan row is the first row lock, after the event's advisory lock
        // and before any read of the team, so a co-host accept and this write
        // queue on one plan.
        await lockPlanForAllocation(tx, eventType, planId, batchProfiles);
        // A sold webinar or class is re-timed, never re-planned.
        if (!isTopUp) await assertGroupEventUnsoldInTx(tx, eventType, eventId);
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
          throw slotTakenRefusal(recheck.errors);
        }
        await assertSlotsStillPublished(tx, consultantProfileId, selectedSlots);

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
        const { appointments, overageNotice } = await createAppointments(
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
          txOptions.historyReason,
          txOptions.actorUserId,
        );
        await holdUntilPaid(tx, appointments, outcome);

        // #1065 — these times ARE the answer to the preference, so close it
        // here rather than leaving it open for the expiry sweep to mislabel.
        await resolveConsumedPreferenceRequests(
          tx,
          releasedOccurrenceIds,
          excludeRescheduleRequestId,
        );
        await txOptions.inTx?.(tx, {
          consultantProfileId,
          freedWindows: isReschedule ? freedWindows : [],
          placed: appointments.flatMap((a) => a.occurrences ?? []),
        });

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
          appointments.flatMap((a) => (a.occurrences ?? []).map((o) => o.id)),
        );

        return {
          success: true,
          outcome,
          appointments,
          overageNotice,
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
        // Outside the transaction, ahead of every attempt: a lost grant writes nothing.
        beforeAttempt: async () => {
          await renewConsulteeBooking(consulteeLock);
          await renewAllocationBatch(slotGrant);
        },
      },
    );
  } finally {
    if (slotGrant) await unlockSlotInterval(slotGrant);
    if (consulteeLock) await unlockConsulteeBooking(consulteeLock);
    await unlockAutoAllocate(lock);
  }
}
