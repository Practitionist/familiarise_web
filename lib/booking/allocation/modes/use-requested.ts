// REQUESTED mode: confirms the consultee's stored times under the same lock
// envelope as AUTO and MANUAL.

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  AllocationResult,
  type AllocationTxOptions,
  EventType,
  isReleasedForReschedule,
} from "@/utils/scheduling-engine/types";
import { intervalCountOf } from "@/lib/appointments/occurrences";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import {
  lockAutoAllocate,
  unlockAutoAllocate,
  ALLOCATOR_LOCK_RETRY_CONFIG,
  lockConsulteeBooking,
  renewConsulteeBooking,
  unlockConsulteeBooking,
  unlockSlotInterval,
  type SlotBatchGrant,
  type ApprovalLock,
} from "@/utils/appointmentlock";
import {
  allocationBatchProfiles,
  lockAllocationTimesInTx,
  lockPickedSlots,
  renewAllocationBatch,
} from "@/lib/booking/allocation/slot-batch";
import {
  AllocationValidationError,
  AllocationNotFoundError,
  AllocationConflictError,
} from "@/utils/scheduling-engine/errors";
import { stageAllocationNotices } from "@/lib/booking/allocation/notify";
import { leadMsFor } from "@/lib/booking/lead-time";
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
} from "@/lib/booking/allocation/event-data";
import {
  isCarriedTentativeOccurrence,
  tentativeSlotCountOf,
  isVoidRequestRow,
} from "@/lib/booking/allocation/counts";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";
import {
  assertExpectedTentativeSlotCount,
  guardAllocationInTx,
} from "@/lib/booking/allocation/guards";
import { findIdempotentAllocation } from "@/lib/booking/allocation/idempotency";
import {
  assertCollaboratorsFree,
  lockPlanForAllocation,
} from "@/lib/booking/allocation/collaborators";
import { bookingTransaction } from "@/lib/db/booking-transaction";

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
export async function useRequestedSlots(
  eventType: EventType,
  eventId: string,
  // The caller's initialAllocation hint is ignored: the guard is always armed
  // here, because approving stored times is only valid for an unallocated event.
  _initialAllocation: boolean | undefined,
  idempotencyKey?: string,
  expectedTentativeSlotCount?: number,
  txOptions: AllocationTxOptions = {},
): Promise<AllocationResult> {
  // #1692 Item 7 — group events (webinar, class) never have consultee-requested
  // slots; reject upfront before touching idempotency or locks.
  if (eventType === "webinar" || eventType === "class") {
    throw new AllocationValidationError(
      "Only consultations and plans have times requested by the client. Pick the times instead.",
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
  const consultantProfileId = await getConsultantProfileId(eventType, eventId);
  if (!consultantProfileId) {
    // Same shape the auto/manual paths report, so a missing event reads the
    // same however it was reached.
    throw new AllocationNotFoundError(`${eventType} not found`);
  }
  const lock = await lockAutoAllocate(consultantProfileId);

  // Serialize on the consultee too: the GiST overlap guard is consultant-keyed,
  // so it cannot see a cross-consultant double-booking. The key is held from
  // the batch to the commit, and the in-transaction recheck reads the
  // consultee's calendar under it, so two allocations for one consultee under
  // different consultants never both commit; the reads and validation before
  // it do not hold the buyer's own checkout up. Order: consultant → consultee → batch.
  let consulteeLock: ApprovalLock | null = null;
  let slotGrant: SlotBatchGrant | null = null;

  try {
    const consulteeLockUserId = await getConsulteeUserId(eventType, eventId);

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

    const {
      consultant,
      config,
      requestedSlots,
      consulteeUserId,
      planId,
      settled,
    } = eventData;
    if (eventData.checkoutInProgress) throw checkoutInProgressError();
    const leadTimeMs = leadMsFor("allocate", { settled });

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
        "This request has no requested times left. Ask the client to send the request again, or pick the times yourself.",
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
        "Some of these sessions are being moved, so their stored times are the ones being given up. Pick new times instead.",
        "VALIDATION_ERROR",
        { releasedRows: rescheduledSlots.length },
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
        appointment.occurrences
          .filter((slot) => !isVoidRequestRow(slot))
          .reduce((atoms, slot) => atoms + intervalCountOf(slot), 0),
      0,
    );

    if (existingAtomCount !== requestedSlots.length) {
      throw new AllocationValidationError(
        "The requested times changed since this page loaded. Reload and try again.",
        "VALIDATION_ERROR",
        { heldAtoms: existingAtomCount, requestedAtoms: requestedSlots.length },
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
        // Requested times are held times: checked against published hours
        // when requested, and kept for every approver.
        heldSlotStarts: requestedSlots,
        // Co-host arm: the consultant's own ACCEPTED seats occupy too.
        consultantProfileId,
        leadTimeMs,
      },
    );

    if (!validation.isValid) {
      throw validationRefusal(validation.errors);
    }

    // The rows the flip below targets, fingerprinted so the in-txn re-read
    // can prove they are the rows that were validated.
    const validatedOccurrenceIds = existingAppointments
      .flatMap((appointment) =>
        appointment.occurrences
          .filter((o) => !isVoidRequestRow(o))
          .map((o) => o.id),
      )
      .sort((a, b) => a.localeCompare(b));

    if (consulteeLockUserId) {
      consulteeLock = await lockConsulteeBooking(
        consulteeLockUserId,
        undefined,
        ALLOCATOR_LOCK_RETRY_CONFIG,
      );
    }
    // Lock order: consultant → consultee → slot batch over every busy profile.
    const batchProfiles = await allocationBatchProfiles({
      eventType,
      planId,
      consultantProfileId,
      consulteeUserId,
    });
    slotGrant = await lockPickedSlots(requestedSlots, batchProfiles);

    return await bookingTransaction(
      async (tx) => {
        await lockAllocationTimesInTx(
          tx,
          requestedSlots,
          batchProfiles,
          consulteeUserId,
        );
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
        // The plan row, before any read of the team (see autoAllocate).
        await lockPlanForAllocation(tx, eventType, planId, batchProfiles);

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
        // Tombstoned and cancelled rows hold no time and are never flipped.
        const heldRows = liveRows.map((appointment) => ({
          ...appointment,
          occurrences: appointment.occurrences.filter(
            (o) => !isVoidRequestRow(o),
          ),
        }));
        const liveOccurrenceIds = heldRows
          .flatMap((appointment) => appointment.occurrences.map((o) => o.id))
          .sort((a, b) => a.localeCompare(b));
        const liveTentativeCount = liveRows.reduce(
          (count, appointment) =>
            count +
            appointment.occurrences.filter(isCarriedTentativeOccurrence).length,
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
        const flippableCount = heldRows.reduce(
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
        const totalCount = heldRows.reduce(
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
          throw slotTakenRefusal(recheck.errors);
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
          txOptions.historyReason,
          txOptions.actorUserId,
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
        // createAppointments). A concurrent same-key submit meets the @unique
        // index; allocate() replays the winner's committed batch.
        if (idempotencyKey) {
          await tx.appointment.update({
            where: { id: appointmentIds[0] },
            data: { allocationIdempotencyKey: idempotencyKey },
          });
        }
        await txOptions.inTx?.(tx, {
          consultantProfileId,
          freedWindows: [],
          placed: [],
        });

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
