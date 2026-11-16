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
  stageAppointmentCancelledEmail: (...a: unknown[]) => mockCancelledEmail(...a),
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

import { notifySeatRemoved } from "@/lib/booking/seat-removed-notice";
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

  await notifySeatRemoved({ appointmentId: "a1", attendeeUserId: "u1" });

  expect(mockCancelledBell.mock.calls[0][2]).toEqual({
    required: { kind: "SEAT_RELEASED", recipients: ["u1"] },
  });
  // A removal, not a cancellation: the event goes ahead without this seat.
  expect(mockCancelledBell.mock.calls[0][1]).toMatchObject({
    seatRemoved: true,
  });
  expect(mockCancelledEmail.mock.calls[0][1]).toMatchObject({
    requiredFor: ["u1"],
    removedFrom: { eventLabel: "webinar", planTitle: "Talk" },
  });
});

it("a conduct removal tells the attendee the host's reason, the case and the 72 hours, and links the case", async () => {
  mockAppointmentFind.mockResolvedValue({
    appointmentType: "CLASS",
    organizationId: null,
    occurrences: [],
    webinar: null,
    class: {
      classPlan: { title: "Beginner Class", consultantProfile: party("h") },
    },
  });
  mockUserFind.mockResolvedValue({ name: "Isabella" });
  const removal = {
    note: "Reason: Disrupting the session (talked over the host). Support case FAM-2026-000011 decides within 72 hours; reply there with your side.",
    href: "/dashboard/support/c_case-1",
  };

  await notifySeatRemoved({
    appointmentId: "a1",
    attendeeUserId: "u1",
    removal,
  });

  expect(mockCancelledBell.mock.calls[0][1]).toMatchObject({
    seatRemoved: true,
    removalNote: removal.note,
    dashboardUrl: removal.href,
  });
  expect(mockCancelledEmail.mock.calls[0][1]).toMatchObject({
    reason: removal.note,
    dashboardUrl: removal.href,
  });
});

it("the removed-seat bell template prints the removal note", () => {
  const template = JSON.stringify(
    jest.requireActual("@/lib/novu/templates/b2c"),
  );
  expect(template).toContain("payload.removalNote");
});

it.each([
  ["EXPIRED", { kind: "PROPOSAL_LAPSED", recipients: ["c", "e"] }],
  ["WITHDRAWN", { kind: "PROPOSAL_WITHDRAWN", recipients: ["e"] }],
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

    expect(mockRescheduledBell.mock.calls[0][2]).toEqual({ required });
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
    dashboardUrl: expect.stringContaining(
      "/checkout/plans/subscription/plan-1",
    ),
  });
  expect(expert[0]).toEqual(["e"]);
  expect(expert[1]).not.toHaveProperty("continueWith");
  expect(mockTrialEmail).toHaveBeenCalledTimes(1);
  expect(mockTrialEmail.mock.calls[0][1]).toMatchObject({
    userIds: ["c"],
    kind: "TRIAL_COMPLETED",
    dashboardUrl: expect.stringContaining(
      "/checkout/plans/subscription/plan-1",
    ),
  });
  expect(staged.bells).toHaveLength(2);
});

it("a seat-removal email says the learner was removed, never that the class was cancelled", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { default: AppointmentCancelledEmail } =
    await import("@/emails/booking/AppointmentCancelledEmail");
  const html = renderToStaticMarkup(
    React.createElement(AppointmentCancelledEmail, {
      recipientName: "Ravi",
      cancelledBy: "Asha",
      removedFrom: { eventLabel: "class", planTitle: "Advanced Class" },
      dashboardUrl: "https://example.test/d",
    }),
  );
  expect(html).toContain("removed you from the class");
  expect(html).not.toMatch(/cancel/i);
});

it("a staging failure is logged as a scrubbed summary, never the error object", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  mockTrialEmail.mockRejectedValueOnce(
    new Error("insert failed for ravi@example.test"),
  );

  await stageTrialCompletedNotices({
    trialId: "t1",
    consultantUserId: "e",
    consulteeUserId: "c",
    consultantName: "Asha",
    consulteeName: "Ravi",
    planTitle: "Coaching",
    subscriptionPlanId: "plan-1",
    dashboardUrl: "/d",
  });

  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]).toHaveLength(1);
  expect(String(log.mock.calls[0][0])).not.toContain("ravi@example.test");
  log.mockRestore();
});

it("a conduct removal's note names the reason, the host's words, the case and the 72 hours", () => {
  expect(
    jest
      .requireActual("@/lib/booking/conduct-removal")
      .removalNote("Disrupting the session", "talked over the host", "FAM-1"),
  ).toBe(
    "Reason: Disrupting the session (talked over the host). Support case FAM-1 decides within 72 hours; reply there with your side.",
  );
});
