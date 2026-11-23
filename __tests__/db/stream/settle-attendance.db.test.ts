/**
 * Stream's settled participant record on real Postgres: one compare-and-set
 * stores it with every call id and session the occurrence used, an answer
 * short of final stores nothing, and the sweep, the 72-hour park, the ops
 * re-read and the host's attendance view all read the stored rows.
 */
import prisma from "../../../lib/prisma";
import { decideSlotOutcome } from "../../../lib/booking/session-outcome-sweep";
import { readSessionAttendance } from "../../../lib/booking/session-attendance";
import { rereadSessionAttendance } from "../../../lib/backoffice/session-outcomes";
import { recordMeetingEndedSynchronously } from "../../../lib/stream/session-handlers";
import {
  ATTENDANCE_SETTLE_DELAY_MS,
  SETTLE_MEETING_SELECT,
  settleOccurrenceAttendance,
} from "../../../lib/meetings/settle-attendance";
import { seedConsultee } from "../booking/harness";
import { seedWebinar } from "../booking/harness-seats";
import { fakeStream, type FakeSession } from "./harness-stream";
import {
  HOUR,
  loadSlot,
  lockWaiters,
  MIN,
  pastHour,
  type Room,
  SEC,
  seedConsultationRoom,
  stay,
  waitFor,
} from "./harness-rooms";

jest.mock(
  "../../../lib/stream-client",
  () => jest.requireActual("./harness-stream").fakeStreamClient,
);

/** The first slot pass after Stream's record becomes readable. */
const READ_AT = ATTENDANCE_SETTLE_DELAY_MS + 15 * MIN;

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

/** Records Stream's `call.stats_report_ready` for every ended session the fake Stream holds for this occurrence. */
async function announceReports(occurrenceId: string) {
  const ids = [...fakeStream.calls.values()]
    .filter((call) => call.occurrenceId === occurrenceId)
    .flatMap((call) => call.sessions.filter((s) => !s.live).map((s) => s.id));
  await prisma.meeting.update({
    where: { appointmentOccurrenceId: occurrenceId },
    data: { streamReportReadySessionIds: ids },
  });
}

/** Another settler's complete snapshot: both sides present for the booked hour. */
const storeBothPresent = (room: Room) =>
  prisma.$transaction([
    prisma.meeting.update({
      where: { id: room.meetingId },
      data: { attendanceSettledAt: new Date() },
    }),
    prisma.meetingPresence.createMany({
      data: [room.hostId, room.learnerId].map((userId) => ({
        meetingId: room.meetingId,
        appointmentOccurrenceId: room.occurrenceId,
        userId,
        userSessionId: `${userId}-device`,
        streamCallId: room.streamCallId,
        joinedAt: room.startsAt,
        leftAt: room.endsAt,
      })),
    }),
  ]);

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
  const now = new Date(room.endsAt.getTime() + READ_AT);
  await announceReports(room.occurrenceId);

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
  await announceReports(room.occurrenceId);

  const settled = await settleOccurrenceAttendance(await settleTarget(room), {
    now: new Date(room.endsAt.getTime() + READ_AT),
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

  await announceReports(occurrence.id);
  const decision = await decideSlotOutcome(await loadSlot(occurrence.id), {
    now: new Date(webinar.endsAt.getTime() + READ_AT),
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
  const now = new Date(room.endsAt.getTime() + READ_AT);

  expect(
    await settleOccurrenceAttendance(await settleTarget(room), { now }),
  ).toEqual({ kind: "not-final" });
  expect(await settledAt(room.meetingId)).toBeNull();
  expect(await stored(room.meetingId)).toEqual([
    expect.objectContaining({ userId: room.hostId, leftAt: null }),
  ]);

  session.live = false;
  session.stays[1] = stay(room.learnerId, s, 0, 60 * MIN);
  await announceReports(room.occurrenceId);
  const settled = await settleOccurrenceAttendance(await settleTarget(room), {
    now,
  });
  expect(settled.kind).toBe("settled");
  expect(await settledAt(room.meetingId)).toEqual(now);
  // Both stays joined at the same instant, so their order is not part of the contract.
  const rows = await stored(room.meetingId);
  expect(rows).toHaveLength(2);
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        userId: room.hostId,
        leftAt: expect.any(Date),
      }),
      expect.objectContaining({
        userId: room.learnerId,
        leftAt: expect.any(Date),
      }),
    ]),
  );
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
  const now = new Date(room.endsAt.getTime() + READ_AT);
  await announceReports(room.occurrenceId);
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

it("a call no one joined is not read before six hours past the room end, then settles with zero rows as NOBODY_JOINED", async () => {
  const room = await seedConsultationRoom();
  // The call exists at Stream and never had a session.
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [],
  });
  const target = await settleTarget(room);

  expect(
    await settleOccurrenceAttendance(target, {
      now: new Date(room.endsAt.getTime() + 5 * HOUR),
    }),
  ).toEqual({ kind: "too-early" });
  expect(await settledAt(room.meetingId)).toBeNull();

  const decision = await decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now: new Date(room.endsAt.getTime() + READ_AT),
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
  await announceReports(room.occurrenceId);
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
  const now = new Date(room.endsAt.getTime() + READ_AT);
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
  await announceReports(room.occurrenceId);
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
    now: new Date(room.endsAt.getTime() + READ_AT),
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
  const now = new Date(room.endsAt.getTime() + READ_AT);

  expect(
    await settleOccurrenceAttendance(await settleTarget(room), { now }),
  ).toEqual({ kind: "not-final" });
  expect(await settledAt(room.meetingId)).toBeNull();

  sessionB.hiddenFromStats = false;
  await announceReports(room.occurrenceId);
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
  // The report is announced, so only the short detail can hold the record back.
  await announceReports(room.occurrenceId);
  const now = new Date(room.endsAt.getTime() + READ_AT);

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
  await announceReports(room.occurrenceId);
  const stale = await settleTarget(room);
  // Extend committed after the settler read the room: the room is now readable only from the end + 15 minutes + 6 hours.
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { extendedSeconds: 900 },
  });

  const settled = await settleOccurrenceAttendance(stale, {
    now: new Date(room.endsAt.getTime() + ATTENDANCE_SETTLE_DELAY_MS + MIN),
  });

  expect(settled).toEqual({ kind: "too-early" });
  expect(await settledAt(room.meetingId)).toBeNull();
  expect(await stored(room.meetingId)).toEqual([]);
});

it("a sweep whose Stream read fails never parks a room another settler stored meanwhile; it classifies the stored rows", async () => {
  const room = await seedConsultationRoom(80);
  const slot = await loadSlot(room.occurrenceId);
  // Ops stored Stream's record after the sweep loaded the room; Stream is now down for the sweep.
  await storeBothPresent(room);
  fakeStream.failStatus = 503;

  const decision = await decideSlotOutcome(slot, {
    now: new Date(room.endsAt.getTime() + 73 * HOUR),
    outages: [],
  });

  expect(decision).toMatchObject({
    kind: "written",
    to: "COMPLETED",
    verdict: { outcome: "HELD" },
  });
});

/**
 * A pre-start device test in A (`check`, minutes from the booked start), then
 * the real hour in B on the same reusable call, now idle with B not yet in stats.
 */
function stageIdleCallWithLaggingStats(
  room: Room,
  check: [number, number] = [-12, -10],
) {
  const s = room.startsAt;
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
    sessions: [
      {
        id: "A",
        live: false,
        stays: [stay(room.hostId, s, check[0] * MIN, check[1] * MIN)],
      },
      sessionB,
    ],
  });
  return sessionB;
}

/** B reaches session stats and its report is announced; the sweep then judges the session. */
async function revealAndJudge(room: Room, sessionB: FakeSession, now: Date) {
  sessionB.hiddenFromStats = false;
  await announceReports(room.occurrenceId);
  return decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now,
    outages: [],
  });
}

it("an idle call whose stats list only the device-test session and no report has arrived defers; once B's report arrives and stats list it, the sweep is HELD", async () => {
  const room = await seedConsultationRoom();
  const sessionB = stageIdleCallWithLaggingStats(room);
  const now = new Date(room.endsAt.getTime() + READ_AT);

  expect(
    await settleOccurrenceAttendance(await settleTarget(room), { now }),
  ).toEqual({ kind: "not-final" });
  expect(await settledAt(room.meetingId)).toBeNull();

  expect(await revealAndJudge(room, sessionB, now)).toMatchObject({
    kind: "written",
    verdict: { outcome: "HELD" },
  });
});

it("a ready report for the device test never stands in for a session our webhooks saw that stats do not list yet", async () => {
  const room = await seedConsultationRoom();
  stageIdleCallWithLaggingStats(room);
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamReportReadySessionIds: ["A"], lastStreamSessionId: "B" },
  });

  expect(
    await settleOccurrenceAttendance(await settleTarget(room), {
      now: new Date(room.endsAt.getTime() + READ_AT),
    }),
  ).toEqual({ kind: "not-final" });
  expect(await settledAt(room.meetingId)).toBeNull();
});

it("a device check that Stream ends after the booked start never settles the room before six hours; once B is listed and announced the session is HELD", async () => {
  const room = await seedConsultationRoom();
  // A: the host's camera check, 09:55 to 09:57; Stream's idle timeout ends it at 10:02, after the booked start.
  const sessionB = stageIdleCallWithLaggingStats(room, [-5, -3]);
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamReportReadySessionIds: ["A"], lastStreamSessionId: "A" },
  });

  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(room.endsAt.getTime() + 75 * MIN),
      outages: [],
    }),
  ).toEqual({ kind: "deferred", reason: "attendance-unsettled" });
  expect(await settledAt(room.meetingId)).toBeNull();

  expect(
    await revealAndJudge(
      room,
      sessionB,
      new Date(room.endsAt.getTime() + READ_AT),
    ),
  ).toMatchObject({ kind: "written", verdict: { outcome: "HELD" } });
});

it("a room whose only session is an announced device check is not read before six hours, then settles as NOBODY_JOINED", async () => {
  const room = await seedConsultationRoom(10);
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "A",
        live: false,
        stays: [stay(room.hostId, room.startsAt, -12 * MIN, -10 * MIN)],
      },
    ],
  });
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamReportReadySessionIds: ["A"], lastStreamSessionId: "A" },
  });

  expect(
    await settleOccurrenceAttendance(await settleTarget(room), {
      now: new Date(room.endsAt.getTime() + 5 * HOUR),
    }),
  ).toEqual({ kind: "too-early" });
  expect(await settledAt(room.meetingId)).toBeNull();

  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(room.endsAt.getTime() + 7 * HOUR),
      outages: [],
    }),
  ).toMatchObject({ kind: "written", verdict: { outcome: "NOBODY_JOINED" } });
});

it("a session with no report settles only when our webhooks corroborate the stats list", async () => {
  const room = await seedConsultationRoom(10);
  const sessionB = stageIdleCallWithLaggingStats(room);
  sessionB.hiddenFromStats = false;
  const late = new Date(room.endsAt.getTime() + 7 * HOUR);

  // Nothing but stats names a session: completeness cannot be shown.
  expect(
    await settleOccurrenceAttendance(await settleTarget(room), { now: late }),
  ).toEqual({ kind: "not-final" });

  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { lastStreamSessionId: "B" },
  });
  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: late,
      outages: [],
    }),
  ).toMatchObject({ kind: "written", verdict: { outcome: "HELD" } });
});

it("a pre-start end's reserved replacement call, never created at Stream, does not hide the original call: nobody returned, so the session is NOBODY_JOINED", async () => {
  const room = await seedConsultationRoom(80);
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { endedAt: null, endedReason: null },
  });
  // The original call exists and never had a session; the rotation reserves an id nothing created.
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [],
  });
  const ended = await recordMeetingEndedSynchronously(
    room.streamCallId,
    new Date(room.startsAt.getTime() - 5 * MIN),
  );
  expect(ended).toMatchObject({ kind: "recorded", endedReason: "ended_early" });

  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(room.endsAt.getTime() + 73 * HOUR),
      outages: [],
    }),
  ).toMatchObject({
    kind: "written",
    verdict: { outcome: "NOBODY_JOINED" },
  });
});

it("a complete snapshot that commits while the unreadable park waits on the session wins: the session stays SCHEDULED for the next pass", async () => {
  const room = await seedConsultationRoom(80);
  const slot = await loadSlot(room.occurrenceId);
  fakeStream.failStatus = 503;
  let park: Promise<unknown> | undefined;
  await prisma.$transaction(
    async (tx) => {
      // Something else holds the session row, as a concurrent writer would.
      await tx.$executeRaw`SELECT 1 FROM "AppointmentOccurrence" WHERE id = ${room.occurrenceId} FOR NO KEY UPDATE`;
      park = decideSlotOutcome(slot, {
        now: new Date(room.endsAt.getTime() + 80 * HOUR),
        outages: [],
      });
      await waitFor(async () => (await lockWaiters()) >= 1);
      // Ops stores a complete two-person record on another connection meanwhile.
      await storeBothPresent(room);
    },
    { timeout: 20_000 },
  );
  await park;

  expect(
    await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: room.occurrenceId },
      select: { completionStatus: true, outcome: true },
    }),
  ).toEqual({ completionStatus: "SCHEDULED", outcome: null });
});

it("a session our webhooks record after the settler loaded the room stops the stamp, and the next read waits for it", async () => {
  const room = await seedConsultationRoom();
  const s = room.startsAt;
  const sessionTwo = {
    id: "session-2",
    live: false,
    hiddenFromStats: true,
    stays: [stay(room.learnerId, s, 40 * MIN, 60 * MIN)],
  };
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "session-1",
        live: false,
        stays: [stay(room.hostId, s, 0, 60 * MIN)],
      },
      sessionTwo,
    ],
  });
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamReportReadySessionIds: ["session-1"] },
  });
  const stale = await settleTarget(room);
  // The join webhook records session-2 before the stale settler stamps.
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { lastStreamSessionId: "session-2" },
  });
  const now = new Date(room.endsAt.getTime() + READ_AT);

  expect((await settleOccurrenceAttendance(stale, { now })).kind).not.toBe(
    "settled",
  );
  expect(await settledAt(room.meetingId)).toBeNull();
  expect(
    await settleOccurrenceAttendance(await settleTarget(room), { now }),
  ).toEqual({ kind: "not-final" });

  sessionTwo.hiddenFromStats = false;
  await announceReports(room.occurrenceId);
  const settled = await settleOccurrenceAttendance(await settleTarget(room), {
    now,
  });
  expect(settled.kind).toBe("settled");
  expect(await stored(room.meetingId)).toHaveLength(2);
});

/** A room from before Stream's announcements and our room-state webhook fields existed. */
async function seedPreRolloutRoom(completionStatus: "COMPLETED" | "SCHEDULED") {
  const room = await seedConsultationRoom(80);
  if (completionStatus === "COMPLETED") {
    await prisma.appointmentOccurrence.update({
      where: { id: room.occurrenceId },
      data: {
        completionStatus: "COMPLETED",
        outcome: "HELD",
        completedAt: room.endsAt,
      },
    });
  }
  // Stream holds a complete, ended record, but no report id or session identity was ever stored for it.
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "old-session",
        live: false,
        stays: [
          stay(room.hostId, room.startsAt, 0, 60 * MIN),
          stay(room.learnerId, room.startsAt, 0, 60 * MIN),
        ],
      },
    ],
  });
  return room;
}

it("an occurrence decided before the rollout keeps its outcome: the sweep's write moves only SCHEDULED rows and stores no record", async () => {
  const room = await seedPreRolloutRoom("COMPLETED");

  const decision = await decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now: new Date(room.endsAt.getTime() + 80 * HOUR),
    outages: [],
  });

  expect(decision).toMatchObject({ kind: "written", moved: false });
  expect(
    await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: room.occurrenceId },
      select: { completionStatus: true, outcome: true },
    }),
  ).toEqual({ completionStatus: "COMPLETED", outcome: "HELD" });
  expect(await settledAt(room.meetingId)).toBeNull();
});

it("an occurrence still undecided at the rollout cannot be corroborated, so it defers and then parks INCONCLUSIVE for ops at 72 hours", async () => {
  const room = await seedPreRolloutRoom("SCHEDULED");
  const slot = await loadSlot(room.occurrenceId);

  expect(
    await decideSlotOutcome(slot, {
      now: new Date(room.endsAt.getTime() + 7 * HOUR),
      outages: [],
    }),
  ).toEqual({ kind: "deferred", reason: "attendance-unsettled" });

  expect(
    await decideSlotOutcome(slot, {
      now: new Date(room.endsAt.getTime() + 73 * HOUR),
      outages: [],
    }),
  ).toMatchObject({
    kind: "written",
    to: "UNVERIFIED",
    moved: true,
    verdict: { outcome: "INCONCLUSIVE", hostAttributed: false },
  });
  expect(await settledAt(room.meetingId)).toBeNull();
});
