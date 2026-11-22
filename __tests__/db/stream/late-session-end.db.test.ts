/** A late session end on real Postgres: a newer session keeps the room live and its stays open, whichever webhook commits first. */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "../../../lib/prisma";
import {
  handleCallEnded,
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
  const hostEnded = (m: number, seconds = 0) =>
    handleCallEnded({
      call_cid: cid,
      type: "call.ended",
      created_at: new Date(at(m).getTime() + seconds * 1000).toISOString(),
      user: { id: learner.userId },
    });
  const meetingRow = () =>
    prisma.meeting.findUniqueOrThrow({
      where: { id: meeting.id },
      select: { endedAt: true, endedReason: true, streamCallId: true },
    });
  const state = async () => ({
    meeting: await prisma.meeting.findUniqueOrThrow({
      where: { id: meeting.id },
      select: { endedAt: true, endedReason: true, streamCallId: true },
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
    hostEnded,
    meetingRow,
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
  expect(meeting).toMatchObject({
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
  expect(meeting).toMatchObject({ endedAt: null, endedReason: null });
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
  expect(meeting).toMatchObject({ endedAt: null, endedReason: null });
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
  expect(meeting).toMatchObject({ endedAt: null, endedReason: null });
  expect(stays).toEqual([
    expect.objectContaining({ userSessionId: first, leftAt: room.at(10) }),
    { userSessionId: second, leftAt: null, closedByEnd: false },
  ]);
  expect(attendance.lastLeftAt).toEqual(room.at(10));
});

/** Holds the room row, starts each racer once the previous one waits on a lock, then lets them run. */
async function raceOnRoom(
  meetingId: string,
  racers: (() => Promise<unknown>)[],
  whileHeld?: (tx: Tx) => Promise<unknown>,
) {
  const started: Promise<unknown>[] = [];
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Meeting" WHERE id = ${meetingId} FOR UPDATE`;
      for (const racer of racers) {
        const before = await lockWaiters();
        started.push(racer());
        await waitFor(async () => (await lockWaiters()) > before);
      }
      await whileHeld?.(tx);
    },
    { timeout: 20_000 },
  );
  return Promise.allSettled(started);
}

it("a join and a leave for the same device, racing on the room, both complete", async () => {
  const room = await seedRoom();
  const device = `dev-${randomUUID()}`;
  // The join queues on the room lock; the leave inserts the stay and queues on its key lock.
  const results = await raceOnRoom(room.meetingId, [
    () => room.join(device, 12),
    () => room.leave(device, 12, 20),
  ]);

  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  expect((await room.state()).stays).toEqual([
    { userSessionId: device, leftAt: room.at(20), closedByEnd: false },
  ]);
});

it("an end of the old call never stamps a room that rotated to a new call id before the end took it", async () => {
  const room = await seedRoom();
  const rotated = `${room.streamCallId}-r1`;
  const results = await raceOnRoom(
    room.meetingId,
    [() => room.sessionEnded(53)],
    (tx) =>
      tx.meeting.update({
        where: { id: room.meetingId },
        data: { streamCallId: rotated },
      }),
  );

  expect(results.map((r) => r.status)).toEqual(["fulfilled"]);
  expect(await room.meetingRow()).toEqual({
    streamCallId: rotated,
    endedAt: null,
    endedReason: null,
  });
});

it("a host end that loses the room to an earlier timeout still records the host's end", async () => {
  const room = await seedRoom();
  const results = await raceOnRoom(
    room.meetingId,
    [() => room.hostEnded(10, 5)],
    (tx) =>
      tx.meeting.update({
        where: { id: room.meetingId },
        data: { endedAt: room.at(10), endedReason: "session_timeout" },
      }),
  );

  expect(results.map((r) => r.status)).toEqual(["fulfilled"]);
  expect(await room.meetingRow()).toMatchObject({
    endedAt: new Date(room.at(10).getTime() + 5000),
    endedReason: "call_ended",
  });
});
