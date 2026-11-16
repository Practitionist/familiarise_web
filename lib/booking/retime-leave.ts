/**
 * The attendee side of a host moving a webinar or class session: attendees
 * who already hold another booking at the new time are flagged (never a
 * reason to refuse the move), and every seat bought before the move may leave
 * with a full refund of what is undelivered until the event's `retimeBy`.
 */
import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import {
  buildCohostCommitmentFilter,
  buildDeadHoldFilter,
  buildOccupiedAppointmentFilter,
  OCCUPYING_OCCURRENCE_WHERE,
  timeHoldingParticipant,
} from "@/utils/scheduling-engine/occupancyPolicy";

/** The free leave after a move lasts at most this long, and never past the moved session's start. */
export const RETIME_FREE_LEAVE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** A move stages one notice per seat in its transaction, so it gets more than the default 5 s. */
export const RETIME_TX_OPTIONS = { timeout: 20_000 } as const;

/** Splits a move's recipients into those who clash at the new time and the rest; empty groups are dropped. */
export function splitByClash(
  userIds: readonly string[],
  clashing: ReadonlySet<string>,
): Array<{ userIds: string[]; clash: boolean }> {
  return [
    { userIds: userIds.filter((id) => clashing.has(id)), clash: true },
    { userIds: userIds.filter((id) => !clashing.has(id)), clash: false },
  ].filter((group) => group.userIds.length > 0);
}

/** When the free leave a move opens ends. */
export function retimeLeaveUntil(now: Date, movedStart: Date): Date {
  return new Date(
    Math.min(now.getTime() + RETIME_FREE_LEAVE_MAX_MS, movedStart.getTime()),
  );
}

/**
 * Opens (or lengthens, never shortens) an event's free leave in the mover's
 * transaction, and returns the leave end the event now stores.
 */
export async function extendRetimeLeave(
  tx: Tx,
  kind: "webinar" | "class",
  eventId: string,
  until: Date,
): Promise<Date> {
  const where = {
    id: eventId,
    OR: [{ retimeBy: null }, { retimeBy: { lt: until } }],
  };
  const stored = { where: { id: eventId }, select: { retimeBy: true } };
  if (kind === "webinar") {
    await tx.webinar.updateMany({ where, data: { retimeBy: until } });
    return (await tx.webinar.findUnique(stored))?.retimeBy ?? until;
  }
  await tx.class.updateMany({ where, data: { retimeBy: until } });
  return (await tx.class.findUnique(stored))?.retimeBy ?? until;
}

/**
 * The attendees whose calendar already holds the new window elsewhere, in a
 * fixed number of queries: one over every seat, one per attendee who also hosts.
 */
export async function attendeeClashes(
  db: Pick<Tx, "appointment" | "appointmentParticipant" | "consultantProfile">,
  appointmentId: string,
  userIds: readonly string[],
  window: { startsAt: Date; endsAt: Date },
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const now = new Date();
  const elsewhereInWindow: Prisma.AppointmentWhereInput[] = [
    { OR: buildOccupiedAppointmentFilter() },
    { NOT: buildDeadHoldFilter(now) },
    { NOT: { id: appointmentId } },
    {
      occurrences: {
        some: {
          AND: [
            { startsAt: { lt: window.endsAt } },
            { endsAt: { gt: window.startsAt } },
            OCCUPYING_OCCURRENCE_WHERE,
          ],
        },
      },
    },
  ];
  const [seated, hosts] = await Promise.all([
    db.appointmentParticipant.findMany({
      where: {
        userId: { in: [...userIds] },
        ...timeHoldingParticipant(now),
        appointment: { AND: elsewhereInWindow },
      },
      select: { userId: true },
      distinct: ["userId"],
    }),
    db.consultantProfile.findMany({
      where: { userId: { in: [...userIds] } },
      select: { id: true, userId: true },
    }),
  ]);
  const clashing = new Set(seated.map((row) => row.userId));
  const hostsToCheck = hosts.filter((h) => !clashing.has(h.userId));
  const hosting = await Promise.all(
    hostsToCheck.map((host) =>
      db.appointment.findFirst({
        where: {
          AND: [
            ...elsewhereInWindow,
            {
              OR: [
                { OR: buildOccupiedAppointmentFilter(host.id) },
                { OR: buildCohostCommitmentFilter(host.id) },
              ],
            },
          ],
        },
        select: { id: true },
      }),
    ),
  );
  hostsToCheck.forEach((host, i) => {
    if (hosting[i]) clashing.add(host.userId);
  });
  return userIds.filter((id) => clashing.has(id));
}

/**
 * Whether a seat bought at `joinedAt` is inside a move's free leave: the event
 * was moved after the purchase and its `retimeBy` has not passed.
 */
export async function inRetimeFreeLeave(
  tx: Tx,
  kind: "webinar" | "class",
  eventId: string,
  joinedAt: Date,
  now: Date,
): Promise<boolean> {
  const event =
    kind === "webinar"
      ? await tx.webinar.findUnique({
          where: { id: eventId },
          select: { retimeBy: true, appointment: { select: { id: true } } },
        })
      : await tx.class.findUnique({
          where: { id: eventId },
          select: { retimeBy: true, appointment: { select: { id: true } } },
        });
  if (!event?.retimeBy || event.retimeBy <= now || !event.appointment) {
    return false;
  }
  const moved = await tx.appointmentOccurrence.count({
    where: {
      appointmentId: event.appointment.id,
      deletedAt: null,
      completionStatus: "SCHEDULED",
      startsAt: { gt: now },
      movedAt: { gt: joinedAt },
    },
  });
  return moved > 0;
}
