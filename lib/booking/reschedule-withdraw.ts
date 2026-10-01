import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { withAppointmentLock } from "@/utils/appointmentlock";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionRescheduleRequest,
} from "@/lib/booking/transitions";
import {
  reportPartialRestore,
  restoreRescheduledBooking,
} from "@/lib/booking/reschedule-restore";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import { notifyRescheduleRestored } from "@/lib/booking/reschedule-outcome-notice";

/**
 * The initiator takes their own reschedule back, and the booking returns to
 * exactly what it was. The restore itself is shared with expiry
 * (`lib/booking/reschedule-restore.ts`, #1846); a decline is the one ending
 * that leaves the slots released.
 */
export async function withdrawRescheduleRequest(args: {
  rescheduleRequestId: string;
  /** Must be the initiator. The caller is responsible for proving that. */
  withdrawnById: string;
}): Promise<{ withdrawn: boolean; reason?: string }> {
  const { rescheduleRequestId, withdrawnById } = args;

  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: {
      id: true,
      status: true,
      initiatedById: true,
      releasedOccurrenceIds: true,
      appointmentId: true,
      createdAt: true,
      appointment: {
        select: {
          consultationId: true,
          subscriptionId: true,
        },
      },
    },
  });

  if (!request) return { withdrawn: false, reason: "PROPOSAL_NOT_FOUND" };

  // Withdrawal is the initiator's alone. The other side already has Decline,
  // which ends the same request with a different meaning and a different
  // outcome for the slots — giving them this too would just be a second
  // Decline wearing a friendlier word.
  if (request.initiatedById !== withdrawnById) {
    return { withdrawn: false, reason: "NOT_INITIATOR" };
  }
  if (!RESCHEDULE_OPEN_STATUSES.includes(request.status)) {
    return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
  }

  let restored = 0;
  try {
    // #1583 A-P0-04 — the withdraw is a lifecycle mutation like accept and
    // cancel; it serialises on the appointment atom, and the tx opens inside.
    await withAppointmentLock(request.appointmentId, () =>
      prisma.$transaction(async (tx) => {
        // The CAS is the guard: if the other party answered while we were
        // deciding, this matches zero rows and throws rather than un-releasing
        // slots that a concurrent accept has already re-confirmed.
        await transitionRescheduleRequest(tx, {
          actorUserId: withdrawnById,
          appointmentId: request.appointmentId,
          where: { id: request.id },
          to: "WITHDRAWN",
          data: { resolvedById: withdrawnById },
        });

        restored = await restoreRescheduledBooking(tx, request, {
          actorUserId: withdrawnById,
          reason: "reschedule withdrawn",
          op: "reschedule-withdraw",
        });
      }),
    );
  } catch (err) {
    // A lost CAS is a MODELLED outcome, not a fault: the other party accepted
    // or declined while this withdrawal was in flight. Reporting it as an error
    // would page on ordinary two-party contention, and the route would answer
    // 500 instead of the 409 this actually is.
    if (err instanceof IllegalTransitionError) {
      return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
    }
    // #1846 SM-B15 — the original time was booked while the proposal was open,
    // so flipping the released rows back to confirmed hits the overlap
    // constraint. The transaction rolled back whole, so the proposal is still
    // open and nothing moved; that is an answer (409), not a fault (500).
    if (isExclusionViolation(err)) {
      return { withdrawn: false, reason: "ORIGINAL_TIME_TAKEN" };
    }
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-withdraw",
      extra: {
        rescheduleRequestId,
        releasedOccurrenceIds: request.releasedOccurrenceIds,
      },
    });
    throw err;
  }

  reportPartialRestore(request, restored, "reschedule-withdraw");

  // PR 2e — the initiator withdrew their own proposal; both parties learn
  // the booking stays at its original times.
  await notifyRescheduleRestored(
    rescheduleRequestId,
    "WITHDRAWN",
    EMAIL_BUDGET_MS.REQUEST,
  );

  return { withdrawn: true };
}
