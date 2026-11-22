/** A late session end on real Postgres: a newer session keeps the room live and its stays open, whichever webhook commits first. */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import {
  handleSessionEnded,
  handleSessionParticipantJoined,
  handleSessionParticipantLeft,
} from "../../../lib/stream/session-handlers";
import {
  futureAt,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "../booking/harness";

const MIN = 60_000;

async function seedRoom() {
  const startsAt = futureAt(2, 10);
  const learner = await seedConsultee();
  const booking = await seedOneToOne(
    "consultation",
    await seedHost(),
    learner,
    { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
    { status: "APPROVED", isTentative: false },
  );
  const streamCallId = `occurrence-${booking.occurrenceId}`;
  const meeting = await prisma.meeting.create({
    data: { streamCallId, appointmentOccurrenceId: booking.occurrenceId },
  });
  const at = (m: number) => new Date(startsAt.getTime() + m * MIN);
  const cid = `default:${streamCallId}`;
  const join = (userSessionId: string, m: number) =>
    handleSessionParticipantJoined({
      call_cid: cid,
      type: "call.session_participant_joined",
      created_at: at(m).toISOString(),
      session_id: `s-${m}`,
      participant: {
        user: { id: learner.userId },
        user_session_id: userSessionId,
      },
    });
  const leave = (userSessionId: string, joinedM: number, m: number) =>
    handleSessionParticipantLeft({
      call_cid: cid,
      type: "call.session_participant_left",
      created_at: at(m).toISOString(),
      session_id: `s-${joinedM}`,
      duration_seconds: (m - joinedM) * 60,
      participant: {
        user: { id: learner.userId },
        user_session_id: userSessionId,
      },
    });
  const sessionEnded = (m: number) =>
    handleSessionEnded({
      call_cid: cid,
      type: "call.session_ended",
      created_at: at(m).toISOString(),
    });
  const state = async () => ({
    meeting: await prisma.meeting.findUniqueOrThrow({
      where: { id: meeting.id },
      select: { endedAt: true, endedReason: true },
    }),
    stays: await prisma.meetingPresence.findMany({
      where: { meetingId: meeting.id },
      orderBy: { joinedAt: "asc" },
      select: { userSessionId: true, leftAt: true, closedByEnd: true },
    }),
    attendance: await prisma.meetingAttendance.findUniqueOrThrow({
      where: {
        meetingId_userId: { meetingId: meeting.id, userId: learner.userId },
      },
      select: { id: true, lastLeftAt: true },
    }),
  });
  return {
    meetingId: meeting.id,
    streamCallId,
    at,
    join,
    leave,
    sessionEnded,
    state,
  };
}

async function waitFor(done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > deadline)
      throw new Error("The race never reached its step");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Backends of this database parked on a lock. */
const lockWaiters = async () => {
  const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>(
    Prisma.sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return waiting;
};

it("a session end after every join still ends the room and closes its stays as assumed", async () => {
  const room = await seedRoom();
  await room.join(`dev-${randomUUID()}`, 0);
  await room.sessionEnded(30);

  const { meeting, stays, attendance } = await room.state();
  expect(meeting).toEqual({
    endedAt: room.at(30),
    endedReason: "session_timeout",
  });
  expect(stays).toEqual([
    expect.objectContaining({ leftAt: room.at(30), closedByEnd: true }),
  ]);
  expect(attendance.lastLeftAt).toEqual(room.at(30));
});

it("a late session end older than a committed rejoin leaves the room live and the rejoin open", async () => {
  const room = await seedRoom();
  const first = `dev-${randomUUID()}`;
  const second = `dev-${randomUUID()}`;
  await room.join(first, 0);
  await room.leave(first, 0, 10);
  await room.join(second, 12);
  await room.sessionEnded(11);

  const { meeting, stays, attendance } = await room.state();
  expect(meeting).toEqual({ endedAt: null, endedReason: null });
  expect(stays).toEqual([
    { userSessionId: first, leftAt: room.at(10), closedByEnd: false },
    { userSessionId: second, leftAt: null, closedByEnd: false },
  ]);
  expect(attendance.lastLeftAt).toBeNull();
});

it("a late session end that commits while a rejoin is mid-transaction still leaves the room live", async () => {
  const room = await seedRoom();
  const first = `dev-${randomUUID()}`;
  const second = `dev-${randomUUID()}`;
  await room.join(first, 0);
  await room.leave(first, 0, 10);
  const { attendance } = await room.state();

  let rejoin: Promise<void> | undefined;
  let lateEnd: Promise<void> | undefined;
  let endSettled = false;
  // Parks the rejoin at its attendance write, after its presence insert, while the late end runs.
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "MeetingAttendance" WHERE id = ${attendance.id} FOR UPDATE`;
      rejoin = room.join(second, 12);
      await waitFor(async () => (await lockWaiters()) >= 1);
      lateEnd = room.sessionEnded(11).finally(() => {
        endSettled = true;
      });
      await waitFor(async () => endSettled || (await lockWaiters()) >= 2);
    },
    { timeout: 20_000 },
  );
  await Promise.all([rejoin, lateEnd]);

  const { meeting, stays } = await room.state();
  expect(meeting.endedAt).toBeNull();
  expect(stays).toEqual([
    expect.objectContaining({ userSessionId: first, leftAt: room.at(10) }),
    { userSessionId: second, leftAt: null, closedByEnd: false },
  ]);
  expect((await room.state()).attendance.lastLeftAt).toBeNull();
});

it("a rejoin that read the room before a late end took it reopens the room once the end commits", async () => {
  const room = await seedRoom();
  const first = `dev-${randomUUID()}`;
  const second = `dev-${randomUUID()}`;
  await room.join(first, 0);
  await room.leave(first, 0, 10);

  let rejoin: Promise<void> | undefined;
  let lateEnd: Promise<void> | undefined;
  // The late end queues on the room first, so it stamps first; the rejoin queues behind it.
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Meeting" WHERE id = ${room.meetingId} FOR UPDATE`;
      lateEnd = room.sessionEnded(11);
      await waitFor(async () => (await lockWaiters()) >= 1);
      rejoin = room.join(second, 12);
      await waitFor(async () => (await lockWaiters()) >= 2);
    },
    { timeout: 20_000 },
  );
  await Promise.all([lateEnd, rejoin]);

  const { meeting, stays, attendance } = await room.state();
  expect(meeting).toEqual({ endedAt: null, endedReason: null });
  expect(stays).toEqual([
    expect.objectContaining({ userSessionId: first, leftAt: room.at(10) }),
    { userSessionId: second, leftAt: null, closedByEnd: false },
  ]);
  expect(attendance.lastLeftAt).toBeNull();
});

it("a join to a call the room rotated away from before its lock leaves the current room's attendance alone", async () => {
  const room = await seedRoom();
  const first = `dev-${randomUUID()}`;
  const second = `dev-${randomUUID()}`;
  await room.join(first, 0);
  await room.leave(first, 0, 10);
  await room.sessionEnded(11);

  let rejoin: Promise<void> | undefined;
  // The rejoin resolves the old call id, then waits on the room while the host reopens it on a new id.
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Meeting" WHERE id = ${room.meetingId} FOR UPDATE`;
      rejoin = room.join(second, 12);
      await waitFor(async () => (await lockWaiters()) >= 1);
      await tx.meeting.update({
        where: { id: room.meetingId },
        data: {
          streamCallId: `${room.streamCallId}-r1`,
          endedAt: null,
          endedReason: null,
        },
      });
    },
    { timeout: 20_000 },
  );
  await rejoin;

  const { meeting, stays, attendance } = await room.state();
  expect(meeting).toEqual({ endedAt: null, endedReason: null });
  expect(stays).toEqual([
    expect.objectContaining({ userSessionId: first, leftAt: room.at(10) }),
    { userSessionId: second, leftAt: null, closedByEnd: false },
  ]);
  expect(attendance.lastLeftAt).toEqual(room.at(10));
});
