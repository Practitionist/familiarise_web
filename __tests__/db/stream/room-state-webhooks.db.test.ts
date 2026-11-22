/**
 * The webhooks keep room state only, on real Postgres: an end stamps the room
 * by compare-and-set on its call id and the end it read, a deliberate end
 * replaces a timeout on the same call, and a join after a non-deliberate end
 * reopens the room Stream resumed. No webhook writes attendance.
 */
import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "../../../lib/prisma";
import {
  handleCallEnded,
  handleSessionEnded,
  handleSessionParticipantJoined,
} from "../../../lib/stream/session-handlers";
import {
  futureAt,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "../booking/harness";
import { fakeStream } from "./harness-stream";

jest.mock(
  "../../../lib/stream-client",
  () => jest.requireActual("./harness-stream").fakeStreamClient,
);

beforeEach(() => fakeStream.reset());

const MIN = 60_000;

async function seedRoom() {
  const startsAt = futureAt(2, 10);
  const host = await seedHost();
  const learner = await seedConsultee();
  const booking = await seedOneToOne(
    "consultation",
    host,
    learner,
    { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
    { status: "APPROVED", isTentative: false },
  );
  const streamCallId = `occurrence-${booking.occurrenceId}`;
  const meeting = await prisma.meeting.create({
    data: { streamCallId, appointmentOccurrenceId: booking.occurrenceId },
  });
  const at = (m: number, seconds = 0) =>
    new Date(startsAt.getTime() + m * MIN + seconds * 1000);
  const cid = (callId = streamCallId) => `default:${callId}`;
  return {
    meetingId: meeting.id,
    streamCallId,
    at,
    join: (m: number, callId?: string, sessionId?: string) =>
      handleSessionParticipantJoined({
        call_cid: cid(callId),
        type: "call.session_participant_joined",
        created_at: at(m).toISOString(),
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    sessionEnded: (m: number, sessionId?: string) =>
      handleSessionEnded({
        call_cid: cid(),
        type: "call.session_ended",
        created_at: at(m).toISOString(),
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    hostEnded: (m: number, seconds = 0) =>
      handleCallEnded({
        call_cid: cid(),
        type: "call.ended",
        created_at: at(m, seconds).toISOString(),
        user: { id: host.userId },
      }),
    room: () =>
      prisma.meeting.findUniqueOrThrow({
        where: { id: meeting.id },
        select: { endedAt: true, endedReason: true, streamCallId: true },
      }),
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

const lockWaiters = async () => {
  const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>(
    Prisma.sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return waiting;
};

/** Holds the room row, starts each racer once the previous one waits on it, then lets them run. */
async function raceOnRoom(
  meetingId: string,
  racers: (() => Promise<unknown>)[],
  whileHeld?: (tx: Tx) => Promise<unknown>,
) {
  const started: Promise<unknown>[] = [];
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Meeting" WHERE id = ${meetingId} FOR NO KEY UPDATE`;
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

it("a session end stamps the room and writes no attendance", async () => {
  const room = await seedRoom();
  await room.sessionEnded(30);

  expect(await room.room()).toMatchObject({
    endedAt: room.at(30),
    endedReason: "session_timeout",
  });
  expect(
    await prisma.meetingPresence.count({
      where: { meetingId: room.meetingId },
    }),
  ).toBe(0);
});

it("a join after a timeout reopens the room Stream resumed; a join after a host's end does not", async () => {
  const resumed = await seedRoom();
  await resumed.sessionEnded(20);
  await resumed.join(22);
  expect(await resumed.room()).toMatchObject({
    endedAt: null,
    endedReason: null,
  });

  const closed = await seedRoom();
  await closed.hostEnded(20);
  await closed.join(22);
  expect(await closed.room()).toMatchObject({
    endedAt: closed.at(20),
    endedReason: "call_ended",
  });
});

it("a join older than the end, or to a call the room rotated away from, leaves the end alone", async () => {
  const room = await seedRoom();
  await room.sessionEnded(20);
  await room.join(19);
  await room.join(25, `${room.streamCallId}-old`);
  expect(await room.room()).toMatchObject({
    endedAt: room.at(20),
    endedReason: "session_timeout",
  });
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
  expect(await room.room()).toEqual({
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
  expect(await room.room()).toMatchObject({
    endedAt: room.at(10, 5),
    endedReason: "call_ended",
  });
});

it("a host end that loses the room to a timeout with the same stamp still records the host's end", async () => {
  const room = await seedRoom();
  const results = await raceOnRoom(
    room.meetingId,
    [() => room.hostEnded(10)],
    (tx) =>
      tx.meeting.update({
        where: { id: room.meetingId },
        data: { endedAt: room.at(10), endedReason: "session_timeout" },
      }),
  );

  expect(results.map((r) => r.status)).toEqual(["fulfilled"]);
  expect(await room.room()).toMatchObject({
    endedAt: room.at(10),
    endedReason: "call_ended",
  });
});

it("a stale timeout never overwrites a host end that carries the same stamp as the timeout it read", async () => {
  const room = await seedRoom();
  await room.sessionEnded(10);
  // The late end read {10, session_timeout}; the host's end lands at the same stamp before it writes.
  const results = await raceOnRoom(
    room.meetingId,
    [() => room.sessionEnded(12)],
    (tx) =>
      tx.meeting.update({
        where: { id: room.meetingId },
        data: { endedReason: "call_ended" },
      }),
  );

  expect(results.map((r) => r.status)).toEqual(["fulfilled"]);
  expect(await room.room()).toMatchObject({
    endedAt: room.at(10),
    endedReason: "call_ended",
  });
});

it("a join never reopens a room Stream sealed, which no participant may rejoin", async () => {
  const room = await seedRoom();
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { endedAt: room.at(20), endedReason: "stream_ended" },
  });
  await room.join(22);
  expect(await room.room()).toMatchObject({
    endedAt: room.at(20),
    endedReason: "stream_ended",
  });
});

it("a host's end of the old call never stamps a room that rotated before the end took it", async () => {
  const room = await seedRoom();
  const rotated = `${room.streamCallId}-r1`;
  const results = await raceOnRoom(
    room.meetingId,
    [() => room.hostEnded(40)],
    (tx) =>
      tx.meeting.update({
        where: { id: room.meetingId },
        data: { streamCallId: rotated },
      }),
  );

  expect(results.map((r) => r.status)).toEqual(["fulfilled"]);
  expect(await room.room()).toEqual({
    streamCallId: rotated,
    endedAt: null,
    endedReason: null,
  });
});

it.each(["join first", "late end first"] as const)(
  "a late timeout of an earlier session never ends a room a newer session on the same call holds (%s)",
  async (order) => {
    const room = await seedRoom();
    // Session A timed out at 20; Stream already runs session B, which began at 22.
    fakeStream.calls.set(room.streamCallId, {
      occurrenceId: "unused",
      currentSessionId: "B",
      sessions: [
        { id: "A", live: false, stays: [] },
        { id: "B", live: true, stays: [], startedAt: room.at(22) },
      ],
    });
    if (order === "join first") {
      await room.join(22);
      await room.sessionEnded(20);
    } else {
      await room.sessionEnded(20);
      await room.join(22);
    }
    expect(await room.room()).toMatchObject({
      endedAt: null,
      endedReason: null,
    });
  },
);

it("a timeout with no newer session on the call still ends the room", async () => {
  const room = await seedRoom();
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: "unused",
    sessions: [{ id: "A", live: false, stays: [] }],
  });
  await room.sessionEnded(20);
  expect(await room.room()).toMatchObject({
    endedAt: room.at(20),
    endedReason: "session_timeout",
  });
});

it("a rejoin that commits while a timeout's Stream lookup is in flight keeps the room open", async () => {
  const room = await seedRoom();
  // Stream answers "idle call" for A's timeout lookup; B's join lands before that answer returns.
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: "unused",
    sessions: [{ id: "A", live: false, stays: [] }],
  });
  let release: () => void = () => undefined;
  fakeStream.getGate = new Promise((resolve) => {
    release = resolve;
  });
  const lateEnd = room.sessionEnded(20);
  await waitFor(async () => fakeStream.gets >= 1);
  await room.join(22);
  release();
  await lateEnd;

  expect(await room.room()).toMatchObject({
    endedAt: null,
    endedReason: null,
  });
});

it("an earlier session's late join never replaces the session a later end recorded; a join after that end does", async () => {
  const room = await seedRoom();
  const identity = async () =>
    (
      await prisma.meeting.findUniqueOrThrow({
        where: { id: room.meetingId },
        select: { lastStreamSessionId: true },
      })
    ).lastStreamSessionId;

  // B's end is recorded with no join webhook seen at all.
  await room.sessionEnded(40, "B");
  expect(await identity()).toBe("B");

  // A's join, from before B ended, arrives late.
  await room.join(10, undefined, "A");
  expect(await identity()).toBe("B");

  // C resumes the call after B's end.
  await room.join(45, undefined, "C");
  expect(await identity()).toBe("C");
});
