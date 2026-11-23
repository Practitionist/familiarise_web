/**
 * Auto-confirmation of a consultee's reschedule proposal: when the picked time
 * is inside the consultant's published availability and both calendars are
 * free, publishing availability is the consent, so nothing is asked of them.
 * The proposed times go to the allocator (`manual`), which validates them
 * under the booking's locks and writes nothing unless it commits. A
 * consultant-initiated proposal never takes this path.
 */

import prisma from "@/lib/prisma";
import type { EventType } from "@/utils/scheduling-engine/types";
import { allocate } from "@/lib/booking/allocation";
import { closeConfirmedProposal } from "@/lib/booking/reschedule-confirm";
import { stageNoticesForFreedWindows } from "@/lib/booking/backup-interest";
import { restoreEarningsHold } from "@/lib/payments/payouts/earnings-hold";
import {
  mayAutoConfirm,
  needsOtherSideAcceptance,
} from "@/lib/booking/reschedule-proposals";
import { ReleasedSessionsSchema } from "@/lib/booking/released-sessions";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";

export type AutoConfirmOutcome =
  | { confirmed: true }
  | { confirmed: false; reason: string; takenSlotStarts?: string[] };

/**
 * @param rescheduleRequestId the proposal to try
 * @param eventType which allocation flow owns the appointment
 * @param eventId the consultation/subscription id, not the appointment id
 */
export async function tryAutoConfirmProposal(
  rescheduleRequestId: string,
  eventType: EventType,
  eventId: string,
): Promise<AutoConfirmOutcome> {
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: {
      id: true,
      appointmentId: true,
      initiatorRole: true,
      initiatedById: true,
      status: true,
      releasedOccurrenceIds: true,
      releasedSessions: true,
      proposedTimes: {
        orderBy: { startsAt: "asc" },
        select: { startsAt: true, endsAt: true },
      },
    },
  });

  if (!request) return { confirmed: false, reason: "PROPOSAL_NOT_FOUND" };
  if (request.status !== "PENDING_REVIEW") {
    return { confirmed: false, reason: "PROPOSAL_NOT_OPEN" };
  }
  if (!mayAutoConfirm(request.initiatorRole)) {
    return { confirmed: false, reason: "CONSULTANT_INITIATED" };
  }
  // A move from or to a time under 24 hours away waits for the other side.
  const released = ReleasedSessionsSchema.safeParse(request.releasedSessions);
  if (
    !released.success ||
    needsOtherSideAcceptance(
      released.data.map((s) => s.startsAt),
      request.proposedTimes.map((p) => p.startsAt),
    )
  ) {
    return { confirmed: false, reason: "NEEDS_ACCEPTANCE" };
  }
  // Deliberately NOT comparing proposed count to released count. The allocator
  // is handed the times as a set and validates them as one; pairing them
  // one-to-one only ever made sense while we were writing each proposed time
  // onto a specific released row, which we no longer do.

  // #1340 — hold the appointment atom across the allocation AND the
  // AUTO_ACCEPTED write. Cancel and reschedule already serialise on it; the
  // allocator's own locks are keyed by consultant and consultee, so without
  // this an auto-confirm could interleave with a concurrent cancel of the same
  // booking. The route calls this helper after releasing its own grant, so
  // this is the only holder — no nesting, same lock order as accept.
  try {
    return await withAppointmentLock(request.appointmentId, async (lock) => {
      const result = await allocate({
        eventType,
        eventId,
        heldAppointmentLock: lock,
        // The proposed times go straight to the allocator, and nothing is written
        // unless it commits. On a reschedule, deleteExistingAppointments removes
        // only the tentative (released) slots, so confirmed sessions survive.
        mode: "manual",
        slots: request.proposedTimes.map((p) => p.startsAt.toISOString()),
        // #1340 — the allocator closes every open proposal on these released slots
        // as DECLINED, because placing times supersedes them. THIS proposal is the
        // one being confirmed, not superseded, so it is excluded.
        excludeRescheduleRequestId: request.id,
        actorUserId: request.initiatedById,
        // AUTO_ACCEPTED commits with the move or not at all.
        inTx: async (tx, moved) => {
          // Re-decided here, on this transaction's clock: a lock wait must not
          // carry a move inside 24 hours without the other side's acceptance.
          if (
            needsOtherSideAcceptance(
              released.data.map((s) => s.startsAt),
              request.proposedTimes.map((p) => p.startsAt),
            )
          ) {
            throw new AllocationConflictError(
              "This move now needs the other person's acceptance.",
              "NEEDS_ACCEPTANCE",
            );
          }
          await closeConfirmedProposal(tx, {
            where: { id: request.id },
            to: "AUTO_ACCEPTED",
          });
          // The reallocation buffer lasts only while the proposal is open.
          await restoreEarningsHold(tx, request.appointmentId);
          await stageNoticesForFreedWindows(
            tx,
            moved.consultantProfileId,
            moved.freedWindows,
            moved.placed,
          );
        },
      });

      if (!result.success) {
        // Nothing was written, so there is nothing to undo. The released slots are
        // untouched and still carry their original times; the request stays open
        // for the consultant to answer unless it was closed under us.
        return {
          confirmed: false,
          reason: result.errorCode ?? "VALIDATION_FAILED",
          ...(result.takenSlotStarts
            ? { takenSlotStarts: result.takenSlotStarts }
            : {}),
        };
      }

      return { confirmed: true };
    });
  } catch (err) {
    // Auto-confirm is best effort: a busy appointment or an unreachable lock
    // service leaves the proposal PENDING_REVIEW for the consultant, exactly
    // like a validation refusal, rather than failing the reschedule request.
    if (err instanceof AppointmentBusyError) {
      return { confirmed: false, reason: "APPOINTMENT_BUSY" };
    }
    if (err instanceof BookingLockUnavailableError) {
      return { confirmed: false, reason: "BOOKING_LOCK_UNAVAILABLE" };
    }
    throw err;
  }
}

/**
 * Whether the counterparty's Accept would place this proposal's times: the
 * allocator's own checks (plan week, published hours, calendars), nothing written.
 */
export async function checkProposalPlaceable(
  rescheduleRequestId: string,
  eventType: EventType,
  eventId: string,
): Promise<
  | { placeable: true }
  | {
      placeable: false;
      reason: string;
      message: string;
      takenSlotStarts?: string[];
    }
> {
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: {
      id: true,
      proposedTimes: {
        orderBy: { startsAt: "asc" },
        select: { startsAt: true },
      },
    },
  });
  if (!request || request.proposedTimes.length === 0) {
    return { placeable: true };
  }
  const result = await allocate({
    eventType,
    eventId,
    mode: "manual",
    slots: request.proposedTimes.map((p) => p.startsAt.toISOString()),
    excludeRescheduleRequestId: request.id,
    checkOnly: true,
  });
  if (result.success) return { placeable: true };
  return {
    placeable: false,
    reason: result.errorCode ?? "VALIDATION_FAILED",
    message: result.error ?? "That time can't be booked.",
    ...(result.takenSlotStarts
      ? { takenSlotStarts: result.takenSlotStarts }
      : {}),
  };
}

/**
 * Drop the times of a proposal whose auto-confirm was refused for the times
 * themselves: Accept would repeat the same refusal, so the request stays open
 * as preference-only and the consultant places the session. A request answered
 * meanwhile keeps its times.
 */
export async function dropRefusedProposalTimes(
  rescheduleRequestId: string,
): Promise<void> {
  await prisma.rescheduleProposedTime.deleteMany({
    where: {
      rescheduleRequestId,
      rescheduleRequest: { status: "PENDING_REVIEW" },
    },
  });
}
