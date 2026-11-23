import type { Prisma } from "@prisma/client";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";

// The SQL side of `withLapsedMoveRestored` (./lapsed-move), kept apart so that
// client-imported module stays free of server code; change the two together.

/** The appointment's open move is past its deadline (optionally from one origin status). */
export function lapsedMoveWhere(
  now: Date,
  originStatus?: string,
): Prisma.AppointmentWhereInput {
  return {
    rescheduleRequests: {
      some: {
        status: { in: RESCHEDULE_OPEN_STATUSES },
        expiresAt: { lte: now },
        ...(originStatus && { originStatus }),
      },
    },
  };
}

/** A session released by a lapsed move, which reads back as SCHEDULED. */
export function lapsedReleaseWhere(
  now: Date,
): Prisma.AppointmentOccurrenceWhereInput {
  return {
    isTentative: true,
    completionStatus: "RESCHEDULED",
    deletedAt: null,
    appointment: lapsedMoveWhere(now),
  };
}
