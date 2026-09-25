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
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {};
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

import {
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

beforeEach(() => transition.mockClear());

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
