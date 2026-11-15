/**
 * @jest-environment node
 */

/**
 * The producers pass the required override for the party the other side's
 * change reached, from the shapes their own reads return; and a completed
 * trial tells the learner "Continue with {expert}" by bell and email and the
 * expert by bell only.
 */
const mockAppointmentFind = jest.fn();
const mockUserFind = jest.fn();
const mockRescheduleFind = jest.fn();
const mockOccurrenceFind = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: (...a: unknown[]) => mockAppointmentFind(...a) },
    user: { findUnique: (...a: unknown[]) => mockUserFind(...a) },
    rescheduleRequest: {
      findUnique: (...a: unknown[]) => mockRescheduleFind(...a),
    },
    appointmentOccurrence: {
      findFirst: (...a: unknown[]) => mockOccurrenceFind(...a),
    },
  },
}));
const mockCancelledBell = jest.fn(async (..._a: unknown[]) => [
  { success: true },
]);
const mockRescheduledBell = jest.fn(async (..._a: unknown[]) => [
  { success: true },
]);
const mockTrialBell = jest.fn(async (ids: string[], _payload: unknown) =>
  ids.map((id) => ({ success: true, staged: { id } })),
);
jest.mock("../../lib/novu", () => ({
  notifyAppointmentCancelled: (...a: unknown[]) => mockCancelledBell(...a),
  notifyAppointmentRescheduled: (...a: unknown[]) => mockRescheduledBell(...a),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyTrialCompleted: (ids: string[], payload: unknown) =>
    mockTrialBell(ids, payload),
}));
const mockCancelledEmail = jest.fn(async (..._a: unknown[]) => []);
const mockTrialEmail = jest.fn(async (..._a: unknown[]) => [{ id: "email" }]);
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentCancelledEmail: (...a: unknown[]) =>
    mockCancelledEmail(...a),
  stageTrialLifecycleEmail: (...a: unknown[]) => mockTrialEmail(...a),
}));
const mockRescheduledEmail = jest.fn(async (..._a: unknown[]) => ({
  sent: 1,
  skipped: 0,
  failed: 0,
}));
jest.mock("../../lib/email", () => ({
  sendAppointmentRescheduledEmail: (...a: unknown[]) =>
    mockRescheduledEmail(...a),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

import { notifyFreeSeatRemoved } from "@/lib/booking/seat-removed-notice";
import { notifyRescheduleRestored } from "@/lib/booking/reschedule-outcome-notice";
import { stageTrialCompletedNotices } from "@/lib/booking/trial-completed-notice";

const party = (id: string) => ({ user: { id, name: id } });

beforeEach(() => jest.clearAllMocks());

it("a host removing a free seat reaches the attendee whatever their switches say", async () => {
  mockAppointmentFind.mockResolvedValue({
    appointmentType: "WEBINAR",
    organizationId: null,
    occurrences: [],
    webinar: { webinarPlan: { title: "Talk", consultantProfile: party("h") } },
    class: null,
  });
  mockUserFind.mockResolvedValue({ name: "Attendee" });

  await notifyFreeSeatRemoved({ appointmentId: "a1", attendeeUserId: "u1" });

  expect(mockCancelledBell.mock.calls[0][2]).toEqual({
    required: { kind: "SEAT_RELEASED", recipients: ["u1"] },
  });
  expect(mockCancelledEmail.mock.calls[0][1]).toMatchObject({
    requiredFor: ["u1"],
  });
});

it.each([
  ["EXPIRED", { kind: "PROPOSAL_LAPSED", recipients: ["c", "e"] }],
  ["WITHDRAWN", undefined],
] as const)(
  "a %s proposal's restored notice: required %p",
  async (outcome, required) => {
    mockRescheduleFind.mockResolvedValue({
      initiatedById: "c",
      releasedOccurrenceIds: ["o1"],
      appointment: {
        id: "a1",
        organizationId: null,
        appointmentType: "CONSULTATION",
        consultation: {
          requestedBy: party("c"),
          consultationPlan: { title: "Plan", consultantProfile: party("e") },
        },
        subscription: null,
        trial: null,
      },
    });
    mockOccurrenceFind.mockResolvedValue({
      startsAt: new Date("2026-12-01T04:30:00Z"),
    });

    await notifyRescheduleRestored("r1", outcome, 1);

    expect(mockRescheduledBell.mock.calls[0][2]).toEqual(
      required ? { required } : undefined,
    );
    const email = mockRescheduledEmail.mock.calls[0][0] as {
      requiredFor?: string[];
    };
    expect(email.requiredFor).toEqual(required?.recipients);
  },
);

it("a completed trial: the learner's bell and email open the plan, the expert gets a bell only", async () => {
  const staged = await stageTrialCompletedNotices({
    trialId: "t1",
    consultantUserId: "e",
    consulteeUserId: "c",
    consultantName: "Asha",
    consulteeName: "Ravi",
    planTitle: "Coaching",
    subscriptionPlanId: "plan-1",
    dashboardUrl: "/dashboard/go/auto/appointments",
  });

  const [learner, expert] = mockTrialBell.mock.calls;
  expect(learner[0]).toEqual(["c"]);
  expect(learner[1]).toMatchObject({
    continueWith: "Asha",
    dashboardUrl: expect.stringContaining("/checkout/plans/subscription/plan-1"),
  });
  expect(expert[0]).toEqual(["e"]);
  expect(expert[1]).not.toHaveProperty("continueWith");
  expect(mockTrialEmail).toHaveBeenCalledTimes(1);
  expect(mockTrialEmail.mock.calls[0][1]).toMatchObject({
    userIds: ["c"],
    kind: "TRIAL_COMPLETED",
    dashboardUrl: expect.stringContaining("/checkout/plans/subscription/plan-1"),
  });
  expect(staged.bells).toHaveLength(2);
});
