/** @jest-environment node */

// A maintenance freeze of a webinar or class tells its seat holders and host
// as a required notice, and rings the plan's current team as an optional bell
// with no email.

const mockNotify = jest.fn(async (..._args: unknown[]) => []);
const mockEmail = jest.fn(async (..._args: unknown[]) => []);
const mockTeam = jest.fn(async (..._args: unknown[]): Promise<string[]> => []);
jest.mock("@/lib/novu/service", () => ({
  notifyAppointmentCancelled: (...args: unknown[]) => mockNotify(...args),
}));
jest.mock("@/lib/email/senders/booking", () => ({
  stageAppointmentCancelledEmail: (...args: unknown[]) => mockEmail(...args),
}));
jest.mock("@/lib/collaborators/recipients", () => ({
  collaboratorUserIds: (...args: unknown[]) => mockTeam(...args),
}));
jest.mock("@/lib/booking/transitions", () => ({
  SLOT_RESCHEDULABLE_FROM: ["SCHEDULED"],
  transitionConsultationRequest: jest.fn(),
  transitionSubscriptionRequest: jest.fn(),
  transitionWebinarEvent: jest.fn(),
  transitionClassEvent: jest.fn(),
  transitionOccurrenceCompletion: jest.fn(),
  transitionTrial: jest.fn(),
}));
jest.mock("@/lib/booking/reschedule-decline", () => ({
  declineOpenReschedules: jest.fn(),
}));
jest.mock("@/lib/booking/participants", () => ({
  liveParticipant: () => ({}),
  NOT_COLLABORATOR_ROW: {},
}));
jest.mock("@/lib/payments/operations/refund-owed", () => ({
  stampRefundsOwed: jest.fn(async () => 0),
  heldInsteadOf: jest.fn(async () => []),
}));
jest.mock("@/lib/trials/cancellation", () => ({
  softCancelTrialAppointmentInTx: jest.fn(),
}));

const host = { id: "u-host", name: "Host" };
let appointment: Record<string, unknown>;
const tx = {
  appointmentOccurrence: {
    findFirst: jest.fn(async () => ({ id: "occ-1" })),
    findMany: jest.fn(async () => [
      { id: "occ-1", startsAt: new Date("2026-12-01T10:00:00Z"), appointment },
    ]),
  },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  ALLOCATION_TX_MAX_WAIT_MS: 1,
  ALLOCATION_TX_TIMEOUT_MS: 1,
  default: {
    $transaction: (run: (db: unknown) => unknown) => run(tx),
  },
}));

import { freezeAppointments } from "@/actions/maintenance/freeze-appointments";

const START = new Date("2026-12-01T09:00:00Z");
const END = new Date("2026-12-01T12:00:00Z");
const group = (event: Record<string, unknown>) => ({
  id: "apt-1",
  organizationId: null,
  participants: [{ userId: "u-seat" }],
  payment: [],
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
  ...event,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockTeam.mockResolvedValue([]);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

it.each([
  [
    "webinar",
    "wp-1",
    group({
      webinar: {
        id: "w-1",
        webinarPlanId: "wp-1",
        webinarPlan: { title: "Systems", consultantProfile: { user: host } },
      },
    }),
  ],
  [
    "class",
    "cp-1",
    group({
      class: {
        id: "c-1",
        classPlanId: "cp-1",
        classPlan: { title: "Systems", consultantProfile: { user: host } },
      },
    }),
  ],
] as const)(
  "a frozen %s rings the plan's team once, as an optional bell with no email",
  async (planType, planId, frozen) => {
    appointment = frozen;
    // A team member the required notice already reaches is not rung twice.
    mockTeam.mockResolvedValue(["u-cohost", "u-host"]);

    await freezeAppointments(START, END, "apt-1");

    expect(mockTeam).toHaveBeenCalledWith(planType, planId, tx);
    expect(mockNotify).toHaveBeenCalledTimes(2);
    const [toSeats, toTeam] = mockNotify.mock.calls;
    expect(toSeats[0]).toEqual(["u-seat", "u-host"]);
    expect(toSeats[2]).toMatchObject({
      required: {
        kind: "CANCELLED_BY_STAFF",
        recipients: ["u-seat", "u-host"],
      },
    });
    expect(toTeam[0]).toEqual(["u-cohost"]);
    expect(toTeam[2]).toEqual({
      tx,
      deferAttempt: true,
      dedupeKey: "maintenance-cancel:apt-1:team",
    });
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(mockEmail.mock.calls[0][1]).toMatchObject({
      userIds: ["u-seat", "u-host"],
    });
  },
);

it("a plan with no team gets no second bell", async () => {
  appointment = group({
    webinar: {
      id: "w-1",
      webinarPlanId: "wp-1",
      webinarPlan: { title: "Systems", consultantProfile: { user: host } },
    },
  });
  await freezeAppointments(START, END, "apt-1");
  expect(mockNotify).toHaveBeenCalledTimes(1);
});
