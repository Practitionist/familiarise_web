/**
 * Stream's settled participant record on real Postgres: one compare-and-set
 * stores it with every call id and session the occurrence used, an answer
 * short of final stores nothing, and the sweep, the 72-hour park, the ops
 * re-read and the host's attendance view all read the stored rows.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  decideSlotOutcome,
  OUTCOME_SLOT_SELECT,
} from "../../../lib/booking/session-outcome-sweep";
import { readSessionAttendance } from "../../../lib/booking/session-attendance";
import { rereadSessionAttendance } from "../../../lib/backoffice/session-outcomes";
import {
  SETTLE_MEETING_SELECT,
  settleOccurrenceAttendance,
} from "../../../lib/meetings/settle-attendance";
import { seedConsultee, seedHost, seedOneToOne } from "../booking/harness";
import { seedWebinar } from "../booking/harness-seats";
import { fakeStream, type FakeStay } from "./harness-stream";

jest.mock(
  "../../../lib/stream-client",
  () => jest.requireActual("./harness-stream").fakeStreamClient,
);

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** A booked hour that ended `endedHoursAgo` hours ago, on the hour. */
function pastHour(endedHoursAgo: number) {
  const endsAt = new Date(Date.now() - endedHoursAgo * HOUR);
  endsAt.setUTCMinutes(0, 0, 0);
  return { startsAt: new Date(endsAt.getTime() - HOUR), endsAt };
}

async function seedConsultationRoom(endedHoursAgo = 3) {
  const host = await seedHost();
  const learner = await seedConsultee();
  const window = pastHour(endedHoursAgo);
  const booking = await seedOneToOne("consultation", host, learner, window, {
    status: "APPROVED",
    isTentative: false,
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
    ...window,
    occurrenceId: booking.occurrenceId,
    appointmentId: booking.appointmentId,
    meetingId: meeting.id,
    streamCallId,
    hostId: host.userId,
    learnerId: learner.userId,
  };
}

type Room = Awaited<ReturnType<typeof seedConsultationRoom>>;

const stay = (
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

const loadSlot = (occurrenceId: string) =>
  prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: occurrenceId },
    select: OUTCOME_SLOT_SELECT,
  });

async function settleTarget(room: Room) {
  const meeting = await prisma.meeting.findUniqueOrThrow({
    where: { id: room.meetingId },
    select: SETTLE_MEETING_SELECT,
  });
  return { occurrenceId: room.occurrenceId, endsAt: room.endsAt, meeting };
}

const stored = (meetingId: string) =>
  prisma.meetingPresence.findMany({
    where: { meetingId },
    orderBy: { joinedAt: "asc" },
    select: { userId: true, streamCallId: true, leftAt: true },
  });

const settledAt = async (meetingId: string) =>
  (
    await prisma.meeting.findUniqueOrThrow({
      where: { id: meetingId },
      select: { attendanceSettledAt: true },
    })
  ).attendanceSettledAt;

beforeEach(() => fakeStream.reset());

it("the record's worked example: Hannah 2 min late, Priya's 3-minute drop merged, is HELD with 58 delivered and Priya ATTENDED", async () => {
  const room = await seedConsultationRoom();
  const s = room.startsAt;
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "session-1",
        live: false,
        stays: [
          stay(room.learnerId, s, -(117 * SEC), 20 * MIN + 10 * SEC),
          stay(room.hostId, s, 2 * MIN + 10 * SEC, 59 * MIN + 40 * SEC),
          stay(room.learnerId, s, 23 * MIN + 12 * SEC, 59 * MIN + 50 * SEC),
        ],
      },
    ],
  });
  const now = new Date(room.endsAt.getTime() + 75 * MIN);

  const decision = await decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now,
    outages: [],
  });

  expect(decision).toMatchObject({
    kind: "written",
    to: "COMPLETED",
    moved: true,
    verdict: { outcome: "HELD", deliveredMinutes: 58, lostMinutes: 2 },
  });
  expect(await settledAt(room.meetingId)).toEqual(now);
  expect(await stored(room.meetingId)).toHaveLength(3);
  const seat = await prisma.appointmentParticipant.findFirstOrThrow({
    where: { appointmentId: room.appointmentId, userId: room.learnerId },
    select: { status: true },
  });
  expect(seat.status).toBe("ATTENDED");
});

it("a rotated room is read under every call id: the current one plus the earlier one Stream lists for the occurrence", async () => {
  const room = await seedConsultationRoom();
  const rotated = `${room.streamCallId}-r1`;
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamCallId: rotated },
  });
  const s = room.startsAt;
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "a",
        live: false,
        stays: [stay(room.learnerId, s, 0, 60 * MIN)],
      },
    ],
  });
  fakeStream.calls.set(rotated, {
    occurrenceId: room.occurrenceId,
    sessions: [
      { id: "b", live: false, stays: [stay(room.hostId, s, 0, 60 * MIN)] },
    ],
  });

  const settled = await settleOccurrenceAttendance(await settleTarget(room), {
    now: new Date(room.endsAt.getTime() + 75 * MIN),
  });

  expect(settled.kind).toBe("settled");
  expect(
    (await stored(room.meetingId)).map((r) => r.streamCallId).sort(),
  ).toEqual([room.streamCallId, rotated].sort());
});

it("a webinar whose first session's joins no webhook ever saw, and whose second session began on the same call, settles both and is HELD", async () => {
  const webinar = await seedWebinar({ capacity: 20, ...pastHour(3) });
  const occurrence = await prisma.appointmentOccurrence.findFirstOrThrow({
    where: { appointmentId: webinar.appointmentId },
    select: { id: true },
  });
  const learner = await seedConsultee();
  const streamCallId = `occurrence-${occurrence.id}`;
  // Session A's end was stamped after session B had begun; no presence row exists.
  await prisma.meeting.create({
    data: {
      streamCallId,
      appointmentOccurrenceId: occurrence.id,
      endedAt: new Date(webinar.startsAt.getTime() + 20 * MIN),
      endedReason: "session_timeout",
    },
  });
  const s = webinar.startsAt;
  fakeStream.calls.set(streamCallId, {
    occurrenceId: occurrence.id,
    sessions: [
      {
        id: "A",
        live: false,
        stays: [
          stay(webinar.host.userId, s, 0, 20 * MIN),
          stay(learner.userId, s, 0, 20 * MIN),
        ],
      },
      {
        id: "B",
        live: false,
        stays: [
          stay(webinar.host.userId, s, 22 * MIN, 60 * MIN),
          stay(learner.userId, s, 22 * MIN, 60 * MIN),
        ],
      },
    ],
  });

  const decision = await decideSlotOutcome(await loadSlot(occurrence.id), {
    now: new Date(webinar.endsAt.getTime() + 75 * MIN),
    outages: [],
  });

  expect(decision).toMatchObject({
    kind: "written",
    verdict: { outcome: "HELD", deliveredMinutes: 60, lostMinutes: 0 },
  });
  expect(
    await prisma.meetingPresence.count({
      where: { appointmentOccurrenceId: occurrence.id },
    }),
  ).toBe(4);
});

it("a live session stores nothing; once it ends a retry stores Stream's rows in place of any earlier row", async () => {
  const room = await seedConsultationRoom();
  const s = room.startsAt;
  // A row a webhook wrote before this design: not Stream's settled record.
  await prisma.meetingPresence.create({
    data: {
      meetingId: room.meetingId,
      appointmentOccurrenceId: room.occurrenceId,
      userId: room.hostId,
      userSessionId: "legacy-device",
      streamCallId: room.streamCallId,
      joinedAt: s,
      leftAt: null,
    },
  });
  const session = {
    id: "session-1",
    live: true,
    stays: [
      stay(room.hostId, s, 0, 40 * MIN),
      stay(room.learnerId, s, 0, null),
    ],
  };
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [session],
  });
  const now = new Date(room.endsAt.getTime() + 75 * MIN);

  expect(
    await settleOccurrenceAttendance(await settleTarget(room), { now }),
  ).toEqual({ kind: "not-final" });
  expect(await settledAt(room.meetingId)).toBeNull();
  expect(await stored(room.meetingId)).toEqual([
    expect.objectContaining({ userId: room.hostId, leftAt: null }),
  ]);

  session.live = false;
  session.stays[1] = stay(room.learnerId, s, 0, 60 * MIN);
  const settled = await settleOccurrenceAttendance(await settleTarget(room), {
    now,
  });
  expect(settled.kind).toBe("settled");
  expect(await settledAt(room.meetingId)).toEqual(now);
  expect(await stored(room.meetingId)).toEqual([
    expect.objectContaining({ userId: room.hostId, leftAt: expect.any(Date) }),
    expect.objectContaining({
      userId: room.learnerId,
      leftAt: expect.any(Date),
    }),
  ]);
});

it("two settlers racing store one snapshot, and a settled room is answered without asking Stream again", async () => {
  const room = await seedConsultationRoom();
  const s = room.startsAt;
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "session-1",
        live: false,
        stays: [
          stay(room.hostId, s, 0, 60 * MIN),
          stay(room.learnerId, s, 0, 60 * MIN),
        ],
      },
    ],
  });
  const now = new Date(room.endsAt.getTime() + 75 * MIN);
  const target = await settleTarget(room);

  const [first, second] = await Promise.all([
    settleOccurrenceAttendance(target, { now }),
    settleOccurrenceAttendance(target, { now }),
  ]);
  expect(first).toEqual(second);
  expect(await stored(room.meetingId)).toHaveLength(2);

  const asked = fakeStream.requests;
  const again = await settleOccurrenceAttendance(await settleTarget(room), {
    now,
  });
  expect(again).toEqual(first);
  expect(fakeStream.requests).toBe(asked);
});

it("a call no one joined settles with zero rows only an hour past the booked end, then reads NOBODY_JOINED", async () => {
  const room = await seedConsultationRoom();
  // The call exists at Stream and never had a session.
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [],
  });
  const target = await settleTarget(room);

  expect(
    await settleOccurrenceAttendance(target, {
      now: new Date(room.endsAt.getTime() + 45 * MIN),
    }),
  ).toEqual({ kind: "too-early" });
  expect(await settledAt(room.meetingId)).toBeNull();

  const decision = await decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now: new Date(room.endsAt.getTime() + 65 * MIN),
    outages: [],
  });
  expect(decision).toMatchObject({
    kind: "written",
    verdict: { outcome: "NOBODY_JOINED" },
  });
  expect(await settledAt(room.meetingId)).not.toBeNull();
});

it("Stream unreachable defers for 72 hours, then parks INCONCLUSIVE; the ops re-read later stores the record and names its verdict without applying it", async () => {
  const room = await seedConsultationRoom(80);
  fakeStream.failStatus = 503;

  const early = await decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now: new Date(room.endsAt.getTime() + 71 * HOUR),
    outages: [],
  });
  expect(early).toEqual({ kind: "deferred", reason: "attendance-unsettled" });

  const onUnreadable = jest.fn();
  const parked = await decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now: new Date(room.endsAt.getTime() + 73 * HOUR),
    outages: [],
    onUnreadable,
  });
  expect(parked).toMatchObject({
    kind: "written",
    to: "UNVERIFIED",
    verdict: { outcome: "INCONCLUSIVE", hostAttributed: false },
  });
  expect(onUnreadable).toHaveBeenCalledWith(room.occurrenceId);
  expect(await settledAt(room.meetingId)).toBeNull();

  fakeStream.failStatus = null;
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "session-1",
        live: false,
        stays: [
          stay(room.hostId, room.startsAt, 0, 60 * MIN),
          stay(room.learnerId, room.startsAt, 0, 60 * MIN),
        ],
      },
    ],
  });
  const reread = await rereadSessionAttendance({
    occurrenceId: room.occurrenceId,
  });
  expect(reread).toEqual({
    result: "settled",
    verdict: { outcome: "HELD", deliveredMinutes: 60, lostMinutes: 0 },
  });
  expect(await settledAt(room.meetingId)).not.toBeNull();
  // The verdict is ops' to apply; the parked row is unchanged.
  expect(
    await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: room.occurrenceId },
      select: { completionStatus: true, outcome: true },
    }),
  ).toEqual({ completionStatus: "UNVERIFIED", outcome: "INCONCLUSIVE" });

  await expect(
    rereadSessionAttendance({
      occurrenceId: room.occurrenceId,
      now: new Date(room.endsAt.getTime() + 81 * 24 * HOUR),
    }),
  ).rejects.toMatchObject({ code: "STREAM_RECORD_GONE" });
});

it("a learner who left in one session and rejoined in a newer one still open is never shown as departed", async () => {
  const room = await seedConsultationRoom();
  const s = room.startsAt;
  const sessionB = {
    id: "B",
    live: true,
    stays: [stay(room.learnerId, s, 30 * MIN, null)],
  };
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "A",
        live: false,
        stays: [
          stay(room.hostId, s, 0, 25 * MIN),
          stay(room.learnerId, s, 0, 25 * MIN),
        ],
      },
      sessionB,
    ],
  });
  const now = new Date(room.endsAt.getTime() + 75 * MIN);
  const view = () =>
    readSessionAttendance({
      appointmentId: room.appointmentId,
      occurrenceId: room.occurrenceId,
      viewerUserId: room.hostId,
      privileged: false,
    });

  expect(
    await settleOccurrenceAttendance(await settleTarget(room), { now }),
  ).toEqual({ kind: "not-final" });
  expect(await view()).toMatchObject({
    settled: false,
    seats: [{ userId: room.learnerId, presentMinutes: 0 }],
  });

  sessionB.live = false;
  sessionB.stays[0] = stay(room.learnerId, s, 30 * MIN, 60 * MIN);
  await settleOccurrenceAttendance(await settleTarget(room), { now });
  expect(await view()).toMatchObject({
    settled: true,
    seats: [{ userId: room.learnerId, presentMinutes: 55 }],
  });
});

it("a read that runs past its deadline stores nothing, so the sweep settles it later", async () => {
  const room = await seedConsultationRoom();
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "session-1",
        live: false,
        stays: [stay(room.hostId, room.startsAt, 0, 60 * MIN)],
      },
    ],
  });
  fakeStream.stall = true;

  const settled = await settleOccurrenceAttendance(await settleTarget(room), {
    now: new Date(room.endsAt.getTime() + 75 * MIN),
    deadlineAt: Date.now() + 100,
  });

  expect(settled).toEqual({ kind: "unavailable" });
  expect(await settledAt(room.meetingId)).toBeNull();
  expect(await stored(room.meetingId)).toEqual([]);
});

it("a call whose current session is not yet in session stats is not final; once it is, the sweep reads both sessions and the session is HELD", async () => {
  const room = await seedConsultationRoom();
  const s = room.startsAt;
  // Session A: the host's device test before the start. Session B: the real hour.
  const sessionB = {
    id: "B",
    live: false,
    hiddenFromStats: true,
    stays: [
      stay(room.hostId, s, 0, 60 * MIN),
      stay(room.learnerId, s, 0, 60 * MIN),
    ],
  };
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    currentSessionId: "B",
    sessions: [
      {
        id: "A",
        live: false,
        stays: [stay(room.hostId, s, -12 * MIN, -10 * MIN)],
      },
      sessionB,
    ],
  });
  const now = new Date(room.endsAt.getTime() + 75 * MIN);

  expect(
    await settleOccurrenceAttendance(await settleTarget(room), { now }),
  ).toEqual({ kind: "not-final" });
  expect(await settledAt(room.meetingId)).toBeNull();

  sessionB.hiddenFromStats = false;
  const decision = await decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now,
    outages: [],
  });
  expect(decision).toMatchObject({
    kind: "written",
    to: "COMPLETED",
    verdict: { outcome: "HELD" },
  });
});

it("detail with fewer stays than session stats counts is not final: the sweep defers, nothing is stamped, and both stays later give HELD", async () => {
  const room = await seedConsultationRoom();
  const s = room.startsAt;
  const host = stay(room.hostId, s, 0, 60 * MIN);
  const learner = stay(room.learnerId, s, 0, 60 * MIN);
  const session = {
    id: "session-1",
    live: false,
    counts: { participants: 2, sessions: 2 },
    stays: [host],
  };
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [session],
  });
  const now = new Date(room.endsAt.getTime() + 75 * MIN);

  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now,
      outages: [],
    }),
  ).toEqual({ kind: "deferred", reason: "attendance-unsettled" });
  expect(await settledAt(room.meetingId)).toBeNull();
  expect(
    await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: room.occurrenceId },
      select: { completionStatus: true, outcome: true },
    }),
  ).toEqual({ completionStatus: "SCHEDULED", outcome: null });

  // A repeated row cannot stand in for the missing one.
  session.stays = [host, { ...host }];
  expect(
    await settleOccurrenceAttendance(await settleTarget(room), { now }),
  ).toEqual({ kind: "not-final" });

  session.stays = [host, learner];
  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now,
      outages: [],
    }),
  ).toMatchObject({ kind: "written", verdict: { outcome: "HELD" } });
});

it("a settler holding a stale room never stamps once the room was extended past the time it read", async () => {
  const room = await seedConsultationRoom();
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "session-1",
        live: false,
        stays: [stay(room.hostId, room.startsAt, 0, 60 * MIN)],
      },
    ],
  });
  const stale = await settleTarget(room);
  // Extend committed after the settler read the room: the rejoin window now runs to the end + 45 minutes.
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { extendedSeconds: 900 },
  });

  const settled = await settleOccurrenceAttendance(stale, {
    now: new Date(room.endsAt.getTime() + 31 * MIN),
  });

  expect(settled).toEqual({ kind: "too-early" });
  expect(await settledAt(room.meetingId)).toBeNull();
  expect(await stored(room.meetingId)).toEqual([]);
});
