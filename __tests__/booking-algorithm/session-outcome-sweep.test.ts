/**
 * @jest-environment node
 */

// #1569 D2 — the webhooks only close the room (meeting-window-early-end pins
// that); the end + 1 h sweep is what writes the outcome.
const transition = jest.fn().mockResolvedValue(1);
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: (...a: unknown[]) => transition(...a),
}));
jest.mock("../../lib/stream/call-presence", () => ({
  getCallPresenceEvidence: jest.fn(async () => ({ unique: 2 })),
}));
const stageBell = jest.fn();
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (...a: unknown[]) => stageBell(...a),
}));
const captureThrottled = jest.fn();
jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: (...a: unknown[]) => captureThrottled(...a),
}));
const recording = { current: null as { id: string } | null };
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
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

import {
  alertStaleNeedsHuman,
  decideSlotOutcome,
  type OutcomeSlot,
} from "../../lib/booking/session-outcome-sweep";

const at = (m: number) => new Date(Date.UTC(2026, 8, 25, 10, 0) + m * 60_000);
const slot = (hostLeaves: number): OutcomeSlot =>
  ({
    id: "occ-1",
    appointmentId: "apt-1",
    startsAt: at(0),
    endsAt: at(60),
    meeting: { streamCallId: "c", endedAt: at(60), endedReason: "call_ended" },
    presences: [
      { userId: "host", joinedAt: at(0), leftAt: at(hostLeaves) },
      { userId: "learner", joinedAt: at(0), leftAt: at(60) },
    ],
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
    await decideSlotOutcome(group, { now: at(120), outages: [] });
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

it("owner decision — a needs-human item older than 72 h raises one throttled warning", async () => {
  const db = { appointmentOccurrence: { count: jest.fn(async () => 2) } };
  await alertStaleNeedsHuman(db as never, at(0));
  expect(captureThrottled).toHaveBeenCalledWith(
    "needs-human-age",
    expect.any(Error),
    expect.objectContaining({ level: "warning", extra: { stale: 2 } }),
    15 * 60_000,
  );
});
