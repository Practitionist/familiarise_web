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

import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import type { EventType } from "@/utils/slotAllocation/types";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import { transitionRescheduleRequest } from "@/lib/booking/transitions";
import { mayAutoConfirm } from "@/lib/booking/reschedule-proposals";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

export type AutoConfirmOutcome =
  | { confirmed: true }
  | { confirmed: false; reason: string };

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
      initiatorRole: true,
      status: true,
      releasedSlotIds: true,
      proposedSlots: {
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
  if (request.proposedSlots.length !== request.releasedSlotIds.length) {
    return { confirmed: false, reason: "COUNT_MISMATCH" };
  }

  // Snapshot the originals in memory so a rejected proposal can be put back
  // exactly as it was. A reschedule never rewrites startsAt, so these rows still
  // hold the times the consultee is trying to move away from.
  const originals = await prisma.slotOfAppointment.findMany({
    where: { id: { in: request.releasedSlotIds } },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      isTentative: true,
      completionStatus: true,
    },
  });

  if (originals.length !== request.proposedSlots.length) {
    return { confirmed: false, reason: "SLOTS_MISSING" };
  }

  // Pair by chronological order: the Nth-earliest released session takes the
  // Nth-earliest proposed time.
  const pairs = originals.map((slot, i) => ({
    slot,
    proposed: request.proposedSlots[i],
  }));

  try {
    await prisma.$transaction(async (tx) => {
      for (const { slot, proposed } of pairs) {
        await tx.slotOfAppointment.update({
          where: { id: slot.id },
          data: {
            startsAt: proposed.startsAt,
            endsAt: proposed.endsAt,
            // Back to SCHEDULED so the requested-mode guard (which refuses to
            // reuse times that are still awaiting reschedule) does not block the
            // very times we just wrote. Still tentative — allocation confirms.
            completionStatus: "SCHEDULED",
          },
        });
      }
    });
  } catch (err) {
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-auto-confirm",
      extra: {
        phase: "stamp",
        rescheduleRequestId,
        releasedSlotIds: request.releasedSlotIds,
      },
    });
    throw err;
  }

  const result = await SlotAllocationService.allocate({
    eventType,
    eventId,
    mode: "requested",
  });

  if (!result.success) {
    // Put the booking back the way the consultee left it and let the consultant
    // decide. Nothing was confirmed, so there is no half-applied state — unless
    // this restore itself fails, in which case the slots are stuck holding the
    // rejected proposed times with no pending allocation to justify them. That
    // is a corrupted booking with no other trace, so it always reports.
    try {
      await prisma.$transaction(async (tx) => {
        for (const { slot } of pairs) {
          await tx.slotOfAppointment.update({
            where: { id: slot.id },
            data: {
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              isTentative: slot.isTentative,
              completionStatus: slot.completionStatus,
            },
          });
        }
      });
    } catch (err) {
      reportSentryError(err, {
        subsystem: "bookings",
        op: "reschedule-auto-confirm",
        level: "fatal",
        extra: {
          phase: "restore",
          rescheduleRequestId,
          releasedSlotIds: request.releasedSlotIds,
          originalSlotIds: pairs.map((p) => p.slot.id),
        },
      });
      throw err;
    }
    return {
      confirmed: false,
      reason: result.errorCode ?? "VALIDATION_FAILED",
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await transitionRescheduleRequest(tx, {
        where: { id: request.id },
        to: "AUTO_ACCEPTED",
        // AUTO_ACCEPTED has no allowed-from in the map: it is normally only ever
        // written at creation. This is that write, arriving one step late because
        // validation had to run outside the creating transaction.
        fromIn: ["PENDING_REVIEW"],
      });
    });
  } catch (err) {
    // A lost race (the proposal was answered or expired concurrently) is the
    // ordinary outcome this CAS guard models by throwing — not an error, but
    // still reported at info/expected so its rate is visible (full-coverage
    // policy). Anything else means the reallocation above already succeeded
    // but the proposal's own bookkeeping never caught up, which is worth
    // knowing at the default fault level.
    const isLostRace = err instanceof IllegalTransitionError;
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-auto-confirm",
      expected: isLostRace,
      extra: { phase: "finalize", rescheduleRequestId, eventType, eventId },
    });
    throw err;
  }

  return { confirmed: true };
}
