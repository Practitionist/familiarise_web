import prisma from "@/lib/prisma";
import { transitionRescheduleRequest } from "@/lib/booking/transitions";
import {
  isRestoreMiss,
  restoreRescheduledBooking,
} from "@/lib/booking/reschedule-restore";
import { notifyRescheduleRestored } from "@/lib/booking/reschedule-outcome-notice";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";

const LAPSE_REASON = "Proposal lapsed without an answer";

/**
 * A proposal past its deadline is over: the join gate and the detail read end
 * it and restore the booking here, under the appointment lock, so the original
 * opens exactly as it would have. A taken original time or a busy lock is left
 * to the expiry job. Returns whether the booking was restored.
 */
export async function settleLapsedProposal(
  appointmentId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await prisma.rescheduleRequest.findFirst({
    where: { openForAppointmentId: appointmentId, expiresAt: { lte: now } },
    select: {
      id: true,
      appointmentId: true,
      createdAt: true,
      originStatus: true,
      releasedOccurrenceIds: true,
      appointment: { select: { consultationId: true, subscriptionId: true } },
    },
  });
  if (!row) return false;
  let restored = 0;
  try {
    restored = await withAppointmentLock(appointmentId, () =>
      prisma.$transaction(async (tx) => {
        await transitionRescheduleRequest(tx, {
          where: { id: row.id },
          to: "EXPIRED",
          whereAnd: { expiresAt: { lte: now } },
          reason: LAPSE_REASON,
        });
        return restoreRescheduledBooking(tx, row, {
          actorUserId: null,
          reason: LAPSE_REASON,
          op: "reschedule-lapse",
        });
      }),
    );
  } catch (error) {
    if (
      error instanceof IllegalTransitionError ||
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError ||
      isRestoreMiss(error)
    ) {
      return false;
    }
    throw error;
  }
  if (restored > 0) {
    await notifyRescheduleRestored(row.id, "EXPIRED", EMAIL_BUDGET_MS.REQUEST);
  }
  return restored > 0;
}
