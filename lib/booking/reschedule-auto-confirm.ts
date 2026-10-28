/**
 * Auto-confirmation of a consultee's reschedule proposal.
 *
 * This is the piece that makes rescheduling feel immediate rather than
 * bureaucratic: when a consultee picks a time inside the consultant's published
 * availability and both calendars are free, there is nothing for the consultant
 * to decide, so nothing is asked of them. Publishing availability IS the
 * consent. A consultant-initiated proposal never takes this path — being free
 * at a time is not consent to be moved to it.
 *
 * Rather than re-deriving the consultant profile, plan config, weekly caps and
 * both parties' calendars, this writes the proposed times onto the released slot
 * rows and then runs the ordinary `requested` allocation, which already performs
 * the full validation under the correct locks. If that rejects the times, the
 * rows are restored and the proposal simply stays PENDING_REVIEW for the
 * consultant to answer — a proposal failing to auto-confirm is an ordinary
 * outcome, not an error.
 */

import prisma from "@/lib/prisma";
import type { EventType } from "@/utils/scheduling-engine/types";
import { allocate } from "@/lib/booking/allocation";
import { closeConfirmedProposal } from "@/lib/booking/reschedule-confirm";
import { mayAutoConfirm } from "@/lib/booking/reschedule-proposals";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";

export type AutoConfirmOutcome =
  { confirmed: true } | { confirmed: false; reason: string };

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
      status: true,
      releasedOccurrenceIds: true,
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
        // AUTO_ACCEPTED commits with the move or not at all.
        inTx: (tx) =>
          closeConfirmedProposal(tx, {
            where: { id: request.id },
            to: "AUTO_ACCEPTED",
          }),
      });

      if (!result.success) {
        // Nothing was written, so there is nothing to undo. The released slots are
        // untouched and still carry their original times; the request stays open
        // for the consultant to answer unless it was closed under us.
        return {
          confirmed: false,
          reason: result.errorCode ?? "VALIDATION_FAILED",
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
