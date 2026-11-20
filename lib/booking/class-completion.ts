import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";

/**
 * A session of the class that is on the calendar or already answered for: a
 * placed session, or one the host cancelled (its make-up or refund is the
 * miss machine's, not a session still to place).
 */
export const ACCOUNTED_SESSION = {
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

/**
 * A cheap answer from the cohort read's own row. Rows are counted, not
 * ordinals, so it can say yes for a class that is not finished and never no
 * for one that is: only a yes goes on to the exact check in the transaction.
 */
export function classMayBeFinished(
  row: {
    schedulingPeriodEndsAt: Date | null;
    totalSessions: number;
    accountedRows: number;
  },
  now: Date,
): boolean {
  return (
    !row.schedulingPeriodEndsAt ||
    row.schedulingPeriodEndsAt <= now ||
    row.accountedRows >= row.totalSessions
  );
}

/** Thrown inside the completing transaction to roll back a class that is not over. */
export class ClassNotFinishedError extends Error {
  constructor(classId: string) {
    super(`Class ${classId} is not finished`);
    this.name = "ClassNotFinishedError";
  }
}
