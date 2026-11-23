/**
 * Rooms for the attendance suites on real Postgres: a past consultation with
 * its Meeting, device stays placed against the booked start, the sweep's read
 * of the slot, and the lock-wait steps the race cases walk through.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { OUTCOME_SLOT_SELECT } from "../../../lib/booking/session-outcome-sweep";
import { seedConsultee, seedHost, seedOneToOne } from "../booking/harness";
import type { FakeStay } from "./harness-stream";

export const SEC = 1_000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

/** A booked hour that ended `endedHoursAgo` hours ago, on the hour. */
export function pastHour(endedHoursAgo: number) {
  const endsAt = new Date(Date.now() - endedHoursAgo * HOUR);
  endsAt.setUTCMinutes(0, 0, 0);
  return { startsAt: new Date(endsAt.getTime() - HOUR), endsAt };
}

/** An approved consultation whose room Stream timed out at the booked end; `paid` adds a captured payment. */
export async function seedConsultationRoom(
  endedHoursAgo = 3,
  { paid = false }: { paid?: boolean } = {},
) {
  const host = await seedHost();
  const learner = await seedConsultee();
  const window = pastHour(endedHoursAgo);
  const booking = await seedOneToOne("consultation", host, learner, window, {
    status: "APPROVED",
    isTentative: false,
    ...(paid && { payment: { status: "SUCCEEDED" as const, expiresAt: null } }),
  });
  const streamCallId = `occurrence-${booking.occurrenceId}`;
  const meeting = await prisma.meeting.create({
    data: {
      streamCallId,
      appointmentOccurrenceId: booking.occurrenceId,
      endedAt: window.endsAt,
      endedReason: "session_timeout",
    },
  });
  return {
    ...booking,
    ...window,
    meetingId: meeting.id,
    streamCallId,
    hostId: host.userId,
    learnerId: learner.userId,
  };
}

export type Room = Awaited<ReturnType<typeof seedConsultationRoom>>;

/** One device stay, `fromMs` to `toMs` after the booked start; `null` is a stay still open. */
export const stay = (
  userId: string,
  startsAt: Date,
  fromMs: number,
  toMs: number | null,
): FakeStay => ({
  userId,
  userSessionId: `${userId}-${randomUUID()}`,
  joinedAt: new Date(startsAt.getTime() + fromMs),
  leftAt: toMs === null ? null : new Date(startsAt.getTime() + toMs),
});

export const loadSlot = (occurrenceId: string) =>
  prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: occurrenceId },
    select: OUTCOME_SLOT_SELECT,
  });

/** Backends of this database parked on a lock. */
export const lockWaiters = async () => {
  const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>(
    Prisma.sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return waiting;
};

export async function waitFor(done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > deadline)
      throw new Error("The race never reached its step");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
