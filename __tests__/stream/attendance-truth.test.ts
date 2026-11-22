/**
 * @jest-environment node
 */

// Attendance truth: an end-stamp close is an assumption the sweep resolves from
// Stream's participant sessions, and presence is scoped to its room segment.
const transition = jest.fn().mockResolvedValue(1);
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: (...a: unknown[]) => transition(...a),
}));
const report = jest.fn();
const sessions = jest.fn();
jest.mock("../../lib/stream/call-presence", () => ({
  getCallPresenceEvidence: (...a: unknown[]) => report(...a),
  getCallParticipantSessionsFromStream: (...a: unknown[]) => sessions(...a),
}));
jest.mock("../../lib/novu/stage-bell", () => ({ stageBell: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    meeting: { findUnique: jest.fn(), updateMany: jest.fn() },
    meetingPresence: {
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    meetingAttendance: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    appointmentParticipant: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

import prisma from "../../lib/prisma";
import {
  createStreamWitnessBudget,
  decideSlotOutcome,
  type OutcomeSlot,
} from "../../lib/booking/session-outcome-sweep";
import {
  handleCallEnded,
  handleSessionParticipantJoined,
  handleSessionParticipantLeft,
} from "../../lib/stream/session-handlers";

const db = prisma as unknown as {
  meeting: { findUnique: jest.Mock; updateMany: jest.Mock };
  meetingPresence: { createMany: jest.Mock; updateMany: jest.Mock };
  meetingAttendance: { upsert: jest.Mock; updateMany: jest.Mock };
};
const at = (m: number) => new Date(Date.UTC(2026, 9, 24, 10, 0) + m * 60_000);
const presence = (userId: string, leftAt: number, closedByEnd = false) => ({
  id: `p-${userId}`,
  userId,
  userSessionId: `dev-${userId}`,
  streamCallId: "c",
  joinedAt: at(0),
  leftAt: at(leftAt),
  closedByEnd,
});
type Stay = Omit<ReturnType<typeof presence>, "leftAt"> & {
  leftAt: Date | null;
};
const slot = (presences: Stay[], endedAt: Date | null = at(60)): OutcomeSlot =>
  ({
    id: "occ-1",
    appointmentId: "apt-1",
    startsAt: at(0),
    endsAt: at(60),
    meeting: {
      id: "m-1",
      streamCallId: "c",
      endedAt,
      endedReason: endedAt ? "session_timeout" : null,
      extendedSeconds: 0,
    },
    presences,
    appointment: {
      organizationId: null,
      subscriptionId: "sub-1",
      consultationId: null,
      classId: null,
      webinarId: null,
      subscription: {
        subscriptionPlan: { consultantProfile: { userId: "host" } },
      },
    },
  }) as unknown as OutcomeSlot;
const stream = (userId: string, leftAt: number) => ({
  userId,
  userSessionId: `dev-${userId}`,
  joinedAt: at(0),
  leftAt: at(leftAt),
});
const decide = (s: OutcomeSlot, witness = createStreamWitnessBudget()) =>
  decideSlotOutcome(s, { now: at(180), outages: [], witness });
// The host's leave was lost; the session-timeout stamp closed the row at 60.
const lostHostLeave = () =>
  slot([presence("host", 60, true), presence("learner", 60)]);

beforeEach(() => {
  jest.clearAllMocks();
  report.mockResolvedValue({ unique: 2, maxConcurrent: 2 });
});

it("(a) a lost host leave reads Stream's real leave: CUT_SHORT, not HELD", async () => {
  sessions.mockResolvedValue([stream("host", 20), stream("learner", 60)]);
  const d = await decide(lostHostLeave());
  expect(d).toMatchObject({
    kind: "written",
    to: "VOIDED",
    verdict: { outcome: "CUT_SHORT", lostMinutes: 40 },
  });
  expect(db.meetingPresence.updateMany).toHaveBeenCalledWith({
    where: { id: "p-host", OR: [{ leftAt: null }, { closedByEnd: true }] },
    data: { leftAt: at(20), closedByEnd: false },
  });
});

it("(b) a lost host leave with Stream unreachable stays open: INCONCLUSIVE", async () => {
  sessions.mockResolvedValue(null);
  const witness = createStreamWitnessBudget();
  const d = await decide(lostHostLeave(), witness);
  expect(d).toMatchObject({
    to: "UNVERIFIED",
    verdict: { outcome: "INCONCLUSIVE" },
  });
  expect(witness.failures).toBe(1);
});

it("(d) zero presences with Stream's record of attendance is not NOBODY_JOINED", async () => {
  report.mockResolvedValue(null);
  sessions.mockResolvedValue([stream("host", 60), stream("learner", 60)]);
  const d = await decide(slot([], null));
  expect(d).toMatchObject({ to: "COMPLETED", verdict: { outcome: "HELD" } });
  expect(db.meetingPresence.createMany.mock.calls[0][0].data).toEqual([
    expect.objectContaining({ userId: "host", streamCallId: "c" }),
    expect.objectContaining({ userId: "learner", streamCallId: "c" }),
  ]);
});

it("(c) a late join from the pre-reopen call keeps its own segment and never reopens the room", async () => {
  db.meeting.findUnique
    .mockResolvedValueOnce(null) // not the current call id
    .mockResolvedValueOnce({
      id: "m-1",
      endedAt: at(60),
      endedReason: "session_timeout",
      appointmentOccurrenceId: "occ-1",
    });
  await handleSessionParticipantJoined({
    call_cid: "default:occurrence-occ-1",
    type: "call.session_participant_joined",
    created_at: at(70).toISOString(),
    session_id: "s-old",
    participant: { user: { id: "learner" }, user_session_id: "dev-late" },
  });
  expect(db.meeting.updateMany).not.toHaveBeenCalled();
  const row = db.meetingPresence.createMany.mock.calls[0][0].data[0];
  expect(row).toMatchObject({ streamCallId: "occurrence-occ-1" });
  expect(row.leftAt).toBeUndefined();
});

it("an end stamp closes only its own segment's open rows that joined by the end, marked as assumed", async () => {
  db.meeting.findUnique.mockResolvedValue({
    id: "m-1",
    streamCallId: "occurrence-occ-1-r1",
    endedAt: null,
    endedReason: null,
    occurrence: { startsAt: at(0), endsAt: at(60), appointment: null },
  });
  db.meeting.updateMany.mockResolvedValue({ count: 1 });
  await handleCallEnded({
    call_cid: "default:occurrence-occ-1-r1",
    type: "call.ended",
    created_at: at(60).toISOString(),
  });
  expect(db.meetingPresence.updateMany).toHaveBeenCalledWith({
    where: {
      meetingId: "m-1",
      leftAt: null,
      joinedAt: { lte: at(60) },
      OR: [{ streamCallId: "occurrence-occ-1-r1" }, { streamCallId: null }],
    },
    data: { leftAt: at(60), closedByEnd: true },
  });
});

it("(e) a leave reported after the room ended is clamped to the end", async () => {
  db.meeting.findUnique.mockResolvedValue({
    id: "m-1",
    endedAt: at(60),
    endedReason: "call_ended",
    appointmentOccurrenceId: "occ-1",
  });
  await handleSessionParticipantLeft({
    call_cid: "default:c",
    type: "call.session_participant_left",
    created_at: at(61).toISOString(),
    session_id: "s",
    duration_seconds: 61 * 60,
    participant: { user: { id: "learner" }, user_session_id: "dev-learner" },
  });
  expect(
    db.meetingAttendance.upsert.mock.calls[0][0].create.lastLeftAt,
  ).toEqual(at(60));
  expect(db.meetingAttendance.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: { lastLeftAt: at(60) } }),
  );
});

it("(f) an exhausted Stream budget defers without any write", async () => {
  const d = await decide(lostHostLeave(), { remaining: 0, failures: 0 });
  expect(d).toEqual({ kind: "deferred", reason: "stream-budget" });
  expect(report).not.toHaveBeenCalled();
  expect(sessions).not.toHaveBeenCalled();
  expect(db.meetingPresence.updateMany).not.toHaveBeenCalled();
  expect(db.meetingPresence.createMany).not.toHaveBeenCalled();
  expect(transition).not.toHaveBeenCalled();
});

it("(h) one-sided rows with no word from Stream wait, then park UNVERIFIED instead of HOST_ABSENT", async () => {
  report.mockResolvedValue(null);
  sessions.mockResolvedValue(null);
  const learnerOnly = () => slot([presence("learner", 60)]);
  expect(await decide(learnerOnly())).toEqual({
    kind: "deferred",
    reason: "stream-evidence",
  });
  expect(transition).not.toHaveBeenCalled();
  const parked = await decideSlotOutcome(learnerOnly(), {
    now: at(60 + 25 * 60),
    outages: [],
    witness: createStreamWitnessBudget(),
  });
  expect(parked).toMatchObject({
    kind: "written",
    to: "UNVERIFIED",
    verdict: { outcome: "INCONCLUSIVE", hostAttributed: false },
  });
});

it("(g) a prior segment's late leave never stamps the current room's attendance as left", async () => {
  db.meeting.findUnique
    .mockResolvedValueOnce(null) // not the current call id
    .mockResolvedValueOnce({
      id: "m-1",
      endedAt: null,
      endedReason: null,
      appointmentOccurrenceId: "occ-1",
    });
  await handleSessionParticipantLeft({
    call_cid: "default:occurrence-occ-1",
    type: "call.session_participant_left",
    created_at: at(30).toISOString(),
    session_id: "s-old",
    duration_seconds: 30 * 60,
    participant: { user: { id: "learner" }, user_session_id: "dev-old" },
  });
  expect(db.meetingAttendance.updateMany).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: { lastLeftAt: expect.any(Date) } }),
  );
});

it("an unwitnessed stay that joined after a host end is capped at its own join, never before it", async () => {
  sessions.mockResolvedValue(null);
  const late = {
    ...presence("learner", 0),
    id: "p-late",
    joinedAt: at(11),
    leftAt: null,
  };
  const s = slot([presence("host", 10), late], at(10));
  (s.meeting as { endedReason: string }).endedReason = "call_ended";
  const d = await decide(s);
  expect(d).toMatchObject({ verdict: { outcome: "INCONCLUSIVE" } });
  expect(db.meetingPresence.updateMany).toHaveBeenCalledWith({
    where: {
      appointmentOccurrenceId: "occ-1",
      leftAt: null,
      joinedAt: { lte: at(10) },
    },
    data: { leftAt: at(10), closedByEnd: true },
  });
  expect(db.meetingPresence.updateMany).toHaveBeenCalledWith({
    where: { id: "p-late", leftAt: null },
    data: { leftAt: at(11), closedByEnd: true },
  });
});
