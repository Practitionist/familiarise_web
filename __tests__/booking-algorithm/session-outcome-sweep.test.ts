/**
 * @jest-environment node
 */

// The webhooks only close the room (meeting-window-early-end pins that); the
// end + 1 h sweep settles Stream's record and writes the outcome.
const transition = jest.fn().mockResolvedValue(1);
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: (...a: unknown[]) => transition(...a),
}));
type Settlement = Awaited<
  ReturnType<
    typeof import("../../lib/meetings/settle-attendance").settleOccurrenceAttendance
  >
>;
const settle = jest.fn<Promise<Settlement>, unknown[]>();
jest.mock("../../lib/meetings/settle-attendance", () => ({
  ...jest.requireActual("../../lib/meetings/settle-attendance"),
  settleOccurrenceAttendance: (...a: unknown[]) => settle(...a),
}));
const stageBell = jest.fn();
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (...a: unknown[]) => stageBell(...a),
}));
const reportStandingFinding = jest.fn(
  async (_args: unknown, report?: () => void) => {
    report?.();
    return true;
  },
);
jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: (a: unknown, r?: () => void) =>
    reportStandingFinding(a, r),
}));
const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => reportSentryError(...a),
}));
const recording = { current: null as { id: string } | null };
const seatUpdate = jest.fn().mockResolvedValue({ count: 1 });
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    // A class whose plan records, with one present and one absent seat.
    appointment: {
      findUnique: async () => ({
        class: { classPlan: { title: "Python", recordingEnabled: true } },
        participants: ["learner", "absent"].map((userId) => ({
          userId,
          user: { consulteeProfileId: `cp-${userId}` },
        })),
      }),
    },
    recording: { findFirst: async () => recording.current },
    // The end fields the sweep re-reads after settling: the room as the fixture ended it.
    meeting: {
      findUnique: async () => ({
        endedAt: new Date(Date.UTC(2026, 8, 25, 11, 0)),
        endedReason: "call_ended",
        attendanceSettledAt: null,
      }),
    },
    appointmentParticipant: {
      updateMany: (...a: unknown[]) => seatUpdate(...a),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    failedEmail: { create: jest.fn().mockResolvedValue({ id: "fe-1" }) },
    emailSuppression: { findMany: jest.fn().mockResolvedValue([]) },
  };
  // The unreadable park locks the rows and re-reads the stamp: still unsettled here.
  client.$executeRaw = jest.fn().mockResolvedValue(1);
  client.$queryRaw = jest.fn().mockResolvedValue([{ settled: null }]);
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

import {
  alertStaleNeedsHuman,
  decideSlotOutcome,
  type OutcomeSlot,
} from "../../lib/booking/session-outcome-sweep";

const at = (m: number) => new Date(Date.UTC(2026, 8, 25, 10, 0) + m * 60_000);
const stays = (hostLeaves: number) => [
  { userId: "host", joinedAt: at(0), leftAt: at(hostLeaves) },
  { userId: "learner", joinedAt: at(0), leftAt: at(60) },
];
const slot = (hostLeaves: number): OutcomeSlot => {
  settle.mockResolvedValue({ kind: "settled", intervals: stays(hostLeaves) });
  return {
    id: "occ-1",
    appointmentId: "apt-1",
    startsAt: at(0),
    endsAt: at(60),
    meeting: {
      id: "m-1",
      streamCallId: "c",
      extendedSeconds: 0,
      attendanceSettledAt: null,
      endedAt: at(60),
      endedReason: "call_ended",
    },
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
  } as unknown as OutcomeSlot;
};

beforeEach(() => jest.clearAllMocks());

it.each([
  [60, "COMPLETED", { outcome: "HELD", completedAt: at(120) }],
  [30, "VOIDED", { outcome: "CUT_SHORT", voidedAt: at(120), lostMinutes: 30 }],
])(
  "host leaves at %i → %s with the outcome in one SCHEDULED-only CAS",
  async (hostLeaves, to, data) => {
    const d = await decideSlotOutcome(slot(hostLeaves), {
      now: at(120),
      outages: [],
    });
    expect(d).toMatchObject({ kind: "written", to, moved: true });
    expect(transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to,
        fromIn: ["SCHEDULED"],
        where: expect.objectContaining({ id: "occ-1", voidedAt: null }),
        data: expect.objectContaining(data),
      }),
    );
  },
);

it.each([
  [60, 1],
  [30, 0],
])(
  "host leaves at %i → %i seat write: present learners move CONFIRMED → ATTENDED only on COMPLETED",
  async (hostLeaves, writes) => {
    await decideSlotOutcome(slot(hostLeaves), {
      now: at(120),
      outages: [],
    });
    expect(seatUpdate.mock.calls).toEqual(
      Array.from({ length: writes }, () => [
        {
          where: {
            AND: [
              {
                appointmentId: "apt-1",
                role: "CONSULTEE",
                userId: { in: ["host", "learner"] },
              },
              { status: { in: ["CONFIRMED"] } },
            ],
          },
          data: { status: "ATTENDED" },
        },
      ]),
    );
  },
);

it.each([
  [{ id: "rec-1" }, 1],
  [null, 0],
])(
  "owner decision — a group seat absent from a HELD session: recording %p → %i bell",
  async (rec, bells) => {
    recording.current = rec;
    const group = slot(60);
    group.appointment = {
      ...group.appointment,
      subscriptionId: null,
      classId: "cls-1",
    } as OutcomeSlot["appointment"];
    await decideSlotOutcome(group, {
      now: at(120),
      outages: [],
    });
    // Only the absent seat, keyed like the 1:1 no-show bell.
    expect(stageBell.mock.calls.map((c) => c[1])).toEqual(
      Array.from({ length: bells }, () =>
        expect.objectContaining({
          workflowId: "session-missed-recording",
          recipients: ["absent"],
          dedupeKey: "no-show:occ-1:absent",
        }),
      ),
    );
  },
);

it.each([
  ["not-final", 71],
  ["unavailable", 71],
] as const)(
  "Stream answers %s %i h past the end: deferred, nothing written",
  async (kind, hours) => {
    const target = slot(60);
    settle.mockResolvedValue({ kind });
    const d = await decideSlotOutcome(target, {
      now: new Date(at(60).getTime() + hours * 3_600_000),
      outages: [],
    });
    expect(d).toEqual({ kind: "deferred", reason: "attendance-unsettled" });
    expect(transition).not.toHaveBeenCalled();
  },
);

it.each([
  ["unavailable", 73],
  ["expired", 2],
] as const)(
  "Stream answers %s %i h past the end: parked UNVERIFIED as INCONCLUSIVE, no host attribution",
  async (kind, hours) => {
    const target = slot(60);
    settle.mockResolvedValue({ kind });
    const onUnreadable = jest.fn();
    const d = await decideSlotOutcome(target, {
      now: new Date(at(60).getTime() + hours * 3_600_000),
      outages: [],
      onUnreadable,
    });
    expect(d).toMatchObject({
      kind: "written",
      to: "UNVERIFIED",
      verdict: { outcome: "INCONCLUSIVE", hostAttributed: false },
    });
    expect(onUnreadable).toHaveBeenCalledWith("occ-1");
  },
);

it("a declared incident voids before any Stream read, so a Stream outage never blocks it", async () => {
  const target = slot(60);
  const d = await decideSlotOutcome(target, {
    now: at(120),
    outages: [{ startsAt: at(10), endsAt: at(20), source: "incident" }],
  });
  expect(settle).not.toHaveBeenCalled();
  expect(d).toMatchObject({
    kind: "written",
    to: "VOIDED",
    verdict: { outcome: "PLATFORM_OUTAGE" },
  });
});

it("a needs-human item older than 72 h records one finding keyed on the queued ids, not a Sentry event", async () => {
  const db = {
    appointmentOccurrence: {
      count: jest.fn(async () => 2),
      findMany: jest.fn(async () => [{ id: "o1" }, { id: "o2" }]),
    },
  };
  await alertStaleNeedsHuman(db as never, at(0));
  expect(reportStandingFinding).toHaveBeenCalledWith(
    expect.objectContaining({ ids: ["o1", "o2", "count:2"] }),
    undefined,
  );
  expect(reportSentryError).not.toHaveBeenCalled();
});
