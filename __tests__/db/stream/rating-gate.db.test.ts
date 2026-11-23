/**
 * The rating gate on real Postgres: a learner rates a call Stream's settled
 * record shows them in, or one held before that record existed with their
 * MeetingAttendance row; a completed call with neither stays closed to them.
 */
import prisma from "../../../lib/prisma";
import { heldOccurrence } from "../../../lib/reviews";
import { seedConsultee, seedHost, seedOneToOne } from "../booking/harness";

const HOUR = 3_600_000;

async function seedPastRoom(
  settled: boolean,
  completionStatus: "COMPLETED" | "SCHEDULED" = "COMPLETED",
) {
  const host = await seedHost();
  const learner = await seedConsultee();
  const endsAt = new Date(Date.now() - 3 * HOUR);
  endsAt.setUTCMinutes(0, 0, 0);
  const startsAt = new Date(endsAt.getTime() - HOUR);
  const booking = await seedOneToOne(
    "consultation",
    host,
    learner,
    { startsAt, endsAt },
    { status: "APPROVED", isTentative: false, completionStatus },
  );
  const meeting = await prisma.meeting.create({
    data: {
      streamCallId: `occurrence-${booking.occurrenceId}`,
      appointmentOccurrenceId: booking.occurrenceId,
      endedAt: endsAt,
      endedReason: "session_timeout",
      attendanceSettledAt: settled ? new Date() : null,
    },
  });
  return {
    ...booking,
    meetingId: meeting.id,
    learnerId: learner.userId,
    startsAt,
    endsAt,
  };
}

const rateable = async (occurrenceId: string, userId: string) =>
  (await prisma.appointmentOccurrence.count({
    where: { id: occurrenceId, ...heldOccurrence(userId) },
  })) === 1;

it("a call Stream's settled record shows the learner in is rateable", async () => {
  const room = await seedPastRoom(true);
  await prisma.meetingPresence.create({
    data: {
      meetingId: room.meetingId,
      appointmentOccurrenceId: room.occurrenceId,
      userId: room.learnerId,
      userSessionId: "device-1",
      streamCallId: `occurrence-${room.occurrenceId}`,
      joinedAt: room.startsAt,
      leftAt: room.endsAt,
    },
  });
  expect(await rateable(room.occurrenceId, room.learnerId)).toBe(true);
});

it("a call held before the settled record, with the learner's attendance row, stays rateable", async () => {
  const room = await seedPastRoom(false);
  await prisma.meetingAttendance.create({
    data: {
      meetingId: room.meetingId,
      appointmentOccurrenceId: room.occurrenceId,
      userId: room.learnerId,
      firstJoinedAt: room.startsAt,
      lastLeftAt: room.endsAt,
    },
  });
  expect(await rateable(room.occurrenceId, room.learnerId)).toBe(true);
});

it("a completed call with neither a settled stay nor an attendance row is not rateable", async () => {
  const room = await seedPastRoom(false);
  // A row left by the retired mirror is not Stream's settled record.
  await prisma.meetingPresence.create({
    data: {
      meetingId: room.meetingId,
      appointmentOccurrenceId: room.occurrenceId,
      userId: room.learnerId,
      userSessionId: "legacy-device",
      streamCallId: `occurrence-${room.occurrenceId}`,
      joinedAt: room.startsAt,
      leftAt: null,
    },
  });
  expect(await rateable(room.occurrenceId, room.learnerId)).toBe(false);
});
