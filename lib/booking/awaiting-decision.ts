import type { Prisma } from "@prisma/client";
import type { PrismaLike } from "@/lib/prisma";
import { AWAITING_HUMAN } from "@/lib/booking/misses";

/** An appointment `_count.select` entry: its sessions parked for ops, counted in the same statement. */
export const PARKED_SESSIONS_COUNT = {
  occurrences: { where: AWAITING_HUMAN },
} satisfies Prisma.AppointmentCountOutputTypeSelect;

/** Moves a read's parked count onto the row as `awaitingDecision`. */
export function withAwaitingDecision<
  T extends { _count: { occurrences: number } },
>(row: T): Omit<T, "_count"> & { awaitingDecision: boolean } {
  const { _count, ...rest } = row;
  return { ...rest, awaitingDecision: _count.occurrences > 0 };
}

/**
 * The appointments among `ids` holding a session parked for ops
 * ({@link AWAITING_HUMAN}); the status function reads them "Waiting on a decision".
 */
export async function appointmentsAwaitingDecision(
  db: Pick<PrismaLike, "appointmentOccurrence">,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.appointmentOccurrence.findMany({
    where: {
      AND: [{ appointmentId: { in: [...new Set(ids)] } }, AWAITING_HUMAN],
    },
    select: { appointmentId: true },
    distinct: ["appointmentId"],
  });
  return new Set(rows.map((row) => row.appointmentId));
}
