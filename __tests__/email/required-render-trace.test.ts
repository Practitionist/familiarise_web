/**
 * @jest-environment node
 */

/**
 * A required booking email whose template throws leaves a `review:render_failed`
 * trace row in the staging transaction, like the other required notices.
 */
const mockStage = jest.fn();
const mockStageRenderFailure = jest.fn();
const mockLoadEmailRecipients = jest.fn();
jest.mock("../../lib/email/deliver", () => ({
  deliver: jest.fn(),
  stage: (...args: unknown[]) => mockStage(...args),
  attempt: jest.fn(),
  stageRenderFailure: (...args: unknown[]) => mockStageRenderFailure(...args),
}));
jest.mock("../../lib/email/preferences", () => ({
  loadEmailRecipients: (...args: unknown[]) => mockLoadEmailRecipients(...args),
}));
jest.mock("../../lib/email/render", () => ({
  renderEmail: jest.fn().mockRejectedValue(new Error("template threw")),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  stageAppointmentCancelledEmail,
  stageAppointmentRescheduledEmail,
  stageTrialLifecycleEmail,
} from "@/lib/email/senders/booking";

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadEmailRecipients.mockResolvedValue([
    {
      userId: "u-1",
      category: null,
      email: "one@example.test",
      name: "One",
      zone: "Asia/Kolkata",
      allowed: true,
      unsubscribeUrl: null,
    },
  ]);
});

it.each([
  [
    "cancelled",
    () =>
      stageAppointmentCancelledEmail({
        appointmentId: "a-1",
        userIds: ["u-1"],
        requiredFor: ["u-1"],
        cancelledBy: "Asha",
        dashboardUrl: "/d",
      }),
  ],
  [
    "rescheduled",
    () =>
      stageAppointmentRescheduledEmail({
        appointmentId: "a-1",
        userIds: ["u-1"],
        requiredFor: ["u-1"],
        outcome: "PROPOSED",
        appointmentType: "CONSULTATION",
        dashboardUrl: "/d",
      }),
  ],
  [
    "trial cancelled",
    () =>
      stageTrialLifecycleEmail({
        trialId: "t-1",
        userIds: ["u-1"],
        requiredFor: ["u-1"],
        kind: "TRIAL_CANCELLED",
        planTitle: "Plan",
        dashboardUrl: "/d",
      }),
  ],
])("%s: a render failure stages its trace row", async (_label, stage) => {
  await stage();
  expect(mockStage).not.toHaveBeenCalled();
  expect(mockStageRenderFailure).toHaveBeenCalledTimes(1);
});
