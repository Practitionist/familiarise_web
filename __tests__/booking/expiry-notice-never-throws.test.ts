/**
 * @jest-environment node
 */

/**
 * The expiry notice resolves when its bell or its email cannot be sent, so
 * the sweep that awaits it goes on to drive the refund in the same run.
 */
const notifyAppointmentCancelled = jest.fn(async (..._a: unknown[]) => []);
const sendAppointmentCancelledEmail = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/novu/service", () => ({
  notifyAppointmentCancelled: (...a: unknown[]) =>
    notifyAppointmentCancelled(...a),
}));
jest.mock("@/lib/novu/outbox", () => ({ attemptTrigger: jest.fn() }));
jest.mock("@/lib/email", () => ({
  EMAIL_BUDGET_MS: { JOB: 1 },
  sendAppointmentCancelledEmail: (...a: unknown[]) =>
    sendAppointmentCancelledEmail(...a),
}));
jest.mock("@/lib/email/senders/booking", () => ({
  stageAppointmentCancelledEmail: jest.fn(),
}));
jest.mock("@/lib/email/send-to-recipients", () => ({
  attemptStaged: jest.fn(),
}));

import {
  notifyConsulteeRequestExpired,
  UNANSWERED_REQUEST_REASON,
} from "@/lib/booking/expiry-notices";

const notice = {
  appointmentId: "apt-1",
  organizationId: null,
  consulteeUserId: "user-1",
  consultantName: "Expert",
  consulteeName: "Learner",
  planTitle: "Plan",
  appointmentType: "CONSULTATION" as const,
  startsAt: null,
  reason: UNANSWERED_REQUEST_REASON,
};

it.each([
  ["the bell", notifyAppointmentCancelled],
  ["the email", sendAppointmentCancelledEmail],
])("resolves when %s cannot be sent", async (_label, send) => {
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  send.mockRejectedValueOnce(new Error("provider down"));
  await expect(notifyConsulteeRequestExpired(notice)).resolves.toBeUndefined();
});
