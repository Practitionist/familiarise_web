/**
 * @jest-environment node
 */

/**
 * #1653 — the booking senders honour the gate and the transaction contract:
 * a cancelled email to two ids where one is not allowed reaches `deliver`
 * once, and the booked email's staging twin stages through the caller's
 * `tx` under `appointment:<id>` without attempting.
 */

const mockDeliver = jest.fn();
const mockStage = jest.fn();
const mockAttempt = jest.fn();
const mockLoadEmailRecipients = jest.fn();

jest.mock("../../lib/email/deliver", () => ({
  deliver: (...args: unknown[]) => mockDeliver(...args),
  stage: (...args: unknown[]) => mockStage(...args),
  attempt: (...args: unknown[]) => mockAttempt(...args),
}));
jest.mock("../../lib/email/preferences", () => ({
  loadEmailRecipients: (...args: unknown[]) => mockLoadEmailRecipients(...args),
}));
jest.mock("../../lib/email/render", () => ({
  renderEmail: jest.fn().mockResolvedValue({ html: "<p>hi</p>", text: "hi" }),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import type { EmailRecipient } from "@/lib/email/preferences";
import {
  sendAppointmentCancelledEmail,
  stageAppointmentBookedEmail,
} from "@/lib/email/senders/booking";

const allowed: EmailRecipient = {
  userId: "user_1",
  email: "one@example.com",
  name: "One",
  zone: "Asia/Kolkata",
  allowed: true,
  unsubscribeUrl: "https://app.test/u?u=user_1",
};
const blocked: EmailRecipient = {
  ...allowed,
  userId: "user_2",
  email: "two@example.com",
  allowed: false,
};

beforeEach(() => {
  jest.spyOn(console, "info").mockImplementation(() => {});
});

it("cancelled: delivers once when one of two recipients opted out", async () => {
  mockLoadEmailRecipients.mockResolvedValue([allowed, blocked]);
  mockDeliver.mockResolvedValue({ success: true, data: {} });

  const result = await sendAppointmentCancelledEmail(
    {
      appointmentId: "apt_1",
      userIds: ["user_1", "user_2"],
      startsAt: new Date("2026-09-15T11:00:00Z"),
      cancelledBy: "Ravi",
      dashboardUrl: "/dashboard",
    },
    5_000,
  );

  expect(mockLoadEmailRecipients).toHaveBeenCalledWith(
    ["user_1", "user_2"],
    "appointments",
  );
  expect(result).toEqual({ sent: 1, skipped: 1, failed: 0 });
  expect(mockDeliver).toHaveBeenCalledTimes(1);
  expect(mockDeliver).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "one@example.com",
      subject: "Your session on Tue, 15 Sep 2026 at 4:30 PM IST was cancelled",
    }),
    "APPOINTMENT_CANCELLED",
    { entityRef: "appointment:apt_1", budgetMs: 5_000 },
  );
});

it("booked (staged): reads recipients and stages through tx, never attempts", async () => {
  const tx = { failedEmail: {}, user: {} };
  mockLoadEmailRecipients.mockResolvedValue([allowed]);
  mockStage.mockResolvedValue({ id: "fe_1", idempotencyKey: "k" });

  const staged = await stageAppointmentBookedEmail(tx as never, {
    appointmentId: "apt_1",
    consulteeUserId: "user_1",
    consultantUserId: "user_9",
    consulteeName: "One",
    consultantName: "Ravi",
    planTitle: "Interview prep",
    appointmentType: "CONSULTATION",
    startsAt: new Date("2026-09-15T11:00:00Z"),
    dashboardUrl: "https://app.test/dashboard",
  });

  expect(mockLoadEmailRecipients).toHaveBeenCalledWith(
    ["user_1", "user_9"],
    "appointments",
    tx,
  );
  expect(mockStage).toHaveBeenCalledTimes(1);
  expect(mockStage).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "one@example.com",
      subject: "Your consultation with Ravi is confirmed",
    }),
    "APPOINTMENT_BOOKED",
    { tx, entityRef: "appointment:apt_1" },
  );
  expect(mockAttempt).not.toHaveBeenCalled();
  expect(mockDeliver).not.toHaveBeenCalled();
  expect(staged).toHaveLength(1);
});
