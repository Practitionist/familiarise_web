/**
 * @jest-environment node
 */

/**
 * #1653 — the account notices are never gated: `sendAccountSuspendedEmail`
 * loads recipients with a `null` category and reaches `deliver` even when
 * the mocked preference row has email off. A gated sender with an
 * `allowed: false` recipient never reaches `deliver`.
 */

const mockDeliver = jest.fn();
const mockFindMany = jest.fn();

jest.mock("../../lib/email/deliver", () => ({
  deliver: (...args: unknown[]) => mockDeliver(...args),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));
jest.mock("../../lib/email/render", () => ({
  renderEmail: jest.fn().mockResolvedValue({ html: "<p>hi</p>", text: "hi" }),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
// The real gate runs against the mocked user read; the wrapper only records
// the category it was called with.
jest.mock("../../lib/email/preferences", () => {
  const actual = jest.requireActual("../../lib/email/preferences");
  return {
    ...actual,
    loadEmailRecipients: jest.fn(actual.loadEmailRecipients),
  };
});

import { loadEmailRecipients } from "@/lib/email/preferences";
import {
  sendAccountSuspendedEmail,
  sendSupportTicketUpdateEmail,
} from "@/lib/email/senders/people";

// Every switch off: a gated category would skip this user.
const emailOff = {
  allNotifications: true,
  emailEnabled: false,
  appointmentReminders: true,
  paymentNotifications: true,
  subscriptionAlerts: true,
  trialNotifications: true,
  supportUpdates: false,
  feedbackAlerts: true,
  orgBillingAlerts: true,
  orgMembershipAlerts: true,
  orgProgramAlerts: true,
};

const user = {
  id: "user_1",
  email: "one@example.com",
  name: "One",
  timezone: "Asia/Kolkata",
  notificationPreferences: emailOff,
};

beforeEach(() => {
  jest.spyOn(console, "info").mockImplementation(() => {});
  mockFindMany.mockResolvedValue([user]);
  mockDeliver.mockResolvedValue({ success: true, data: {} });
});

it("suspended: null category, delivered although email is switched off", async () => {
  const result = await sendAccountSuspendedEmail(
    {
      userId: "user_1",
      reason: "Repeated no-shows",
      suspendedUntil: new Date("2026-09-22T11:00:00Z"),
      appointmentsCancelled: 2,
    },
    5_000,
  );

  expect(loadEmailRecipients).toHaveBeenCalledWith(["user_1"], null);
  expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
  expect(mockDeliver).toHaveBeenCalledTimes(1);
  expect(mockDeliver).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "one@example.com",
      subject: "Your Familiarise account is suspended",
      headers: undefined,
    }),
    "ACCOUNT_SUSPENDED",
    { entityRef: "user:user_1", budgetMs: 5_000 },
  );
});

it("support update: a recipient who turned support mail off is skipped", async () => {
  const result = await sendSupportTicketUpdateEmail(
    {
      ticketId: "t_1",
      ownerUserId: "user_1",
      reference: "ST-1",
      title: "Refund",
      statusCode: "RESOLVED",
      statusLabel: "resolved",
      ticketUrl: "/dashboard",
    },
    5_000,
  );

  expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
  expect(mockDeliver).not.toHaveBeenCalled();
});
