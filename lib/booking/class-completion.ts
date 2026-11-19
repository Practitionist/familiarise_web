import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";

/**
 * A session of the class that is on the calendar or already answered for: a
 * placed session, or one the host cancelled (its make-up or refund is the
 * miss machine's, not a session still to place).
 */
const ACCOUNTED_SESSION = {
  isTentative: false,
  deletedAt: null,
  OR: [
    { completionStatus: liveOccurrenceWhere.completionStatus },
    { hostCancelledAt: { not: null } },
  ],
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/**
 * A class between batches is not over. It is finished once every sold session
 * is placed, or once its scheduling period has ended. A session and its
 * make-up share an ordinal, so sessions are counted by ordinal.
 */
export async function classIsFinished(
  db: Pick<Tx, "class" | "appointmentOccurrence">,
  classId: string,
  now: Date,
): Promise<boolean> {
  const cls = await db.class.findUnique({
    where: { id: classId },
    select: {
      schedulingPeriodEndsAt: true,
      classPlan: { select: { totalSessions: true } },
    },
  });
  if (!cls) return false;
  if (!cls.schedulingPeriodEndsAt || cls.schedulingPeriodEndsAt <= now) {
    return true;
  }
  const placed = await db.appointmentOccurrence.findMany({
    where: { ...ACCOUNTED_SESSION, appointment: { classId, deletedAt: null } },
    distinct: ["ordinal"],
    select: { ordinal: true },
  });
  return placed.length >= cls.classPlan.totalSessions;
}

/** Thrown inside the completing transaction to roll back a class that is between batches. */
export class ClassBetweenBatchesError extends Error {
  constructor(classId: string) {
    super(`Class ${classId} still has sessions to place`);
    this.name = "ClassBetweenBatchesError";
  }
}
