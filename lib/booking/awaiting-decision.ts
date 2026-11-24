import type { Prisma } from "@prisma/client";
import type { PrismaLike } from "@/lib/prisma";
import { AWAITING_HUMAN } from "@/lib/booking/misses";

/** An appointment `_count.select` entry: its sessions parked for ops, counted in the same statement. */
export const PARKED_SESSIONS_COUNT = {
  occurrences: { where: AWAITING_HUMAN },
} satisfies Prisma.AppointmentCountOutputTypeSelect;

/** Moves a read's parked count onto the row as `parkedSessions`. */
export function withParkedSessions<
  T extends { _count: { occurrences: number } },
>(row: T): Omit<T, "_count"> & { parkedSessions: number } {
  const { _count, ...rest } = row;
  return { ...rest, parkedSessions: _count.occurrences };
}

/**
 * Sessions parked for ops ({@link AWAITING_HUMAN}) per appointment among `ids`,
 * in one statement; an appointment with none is absent.
 */
export async function parkedSessionCounts(
  db: Pick<PrismaLike, "appointmentOccurrence">,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.appointmentOccurrence.groupBy({
    by: ["appointmentId"],
    where: {
      AND: [{ appointmentId: { in: [...new Set(ids)] } }, AWAITING_HUMAN],
    },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.appointmentId, row._count._all]));
}

/**
 * The ids of the sessions parked for ops among these appointments' sessions, in
 * one statement; callers pass only appointments whose parked count is above zero.
 */
export async function parkedSessionIds(
  db: Pick<PrismaLike, "appointmentOccurrence">,
  appointmentIds: readonly string[],
): Promise<Set<string>> {
  if (appointmentIds.length === 0) return new Set();
  const rows = await db.appointmentOccurrence.findMany({
    where: {
      AND: [
        { appointmentId: { in: [...new Set(appointmentIds)] } },
        AWAITING_HUMAN,
      ],
    },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/** The session row, marked `parked` when its id is one of `ids`. */
export function markParked<T extends { id: string }>(
  row: T,
  ids: ReadonlySet<string>,
): T & { parked?: boolean } {
  return ids.has(row.id) ? { ...row, parked: true } : row;
}
