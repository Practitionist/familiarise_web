import prisma from "@/lib/prisma";
import { transitionRescheduleRequest } from "@/lib/booking/transitions";
import {
  isRestoreMiss,
  restoreRescheduledBooking,
} from "@/lib/booking/reschedule-restore";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
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
    // Loaded on use: the booking readers import this module and must not load the notifier.
    const [{ notifyRescheduleRestored }, { EMAIL_BUDGET_MS }] =
      await Promise.all([
        import("@/lib/booking/reschedule-outcome-notice"),
        import("@/lib/email"),
      ]);
    await notifyRescheduleRestored(row.id, "EXPIRED", EMAIL_BUDGET_MS.REQUEST);
  }
  return restored > 0;
}

/** The same, for the booking that holds this session (the meeting paths know only the session). */
export async function settleLapsedProposalForOccurrence(
  occurrenceId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const occurrence = await prisma.appointmentOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { appointmentId: true },
  });
  return occurrence
    ? settleLapsedProposal(occurrence.appointmentId, now)
    : false;
}
