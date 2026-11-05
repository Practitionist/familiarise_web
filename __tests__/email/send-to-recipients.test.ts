/**
 * @jest-environment node
 */

/**
 * #1653 — the fan-out honours the gate and attaches the RFC 8058 headers:
 * a recipient with `allowed: false` is skipped, an allowed one is delivered
 * with List-Unsubscribe, and the counts say which was which.
 */

const mockDeliver = jest.fn();

jest.mock("../../lib/email/deliver", () => ({
  deliver: (...args: unknown[]) => mockDeliver(...args),
  stage: jest.fn(),
  attempt: jest.fn(),
}));

jest.mock("../../lib/email/render", () => ({
  renderEmail: jest.fn().mockResolvedValue({ html: "<p>hi</p>", text: "hi" }),
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import * as React from "react";
import type { EmailRecipient } from "@/lib/email/preferences";
import { renderEmail } from "@/lib/email/render";
import * as Sentry from "@sentry/nextjs";
import {
  sendToRecipients,
  prepareRecipientEmails,
} from "@/lib/email/send-to-recipients";

const allowed: EmailRecipient = {
  category: "appointments",
  userId: "user_1",
  email: "one@example.com",
  name: "One",
  zone: "Asia/Kolkata",
  allowed: true,
  unsubscribeUrl: "https://app.test/api/notifications/unsubscribe?u=user_1&t=x",
};
const blocked: EmailRecipient = {
  ...allowed,
  userId: "user_2",
  email: "two@example.com",
  allowed: false,
};

it("delivers to allowed recipients with one-click headers and skips the rest", async () => {
  mockDeliver.mockResolvedValue({ success: true, data: {} });
  jest.spyOn(console, "info").mockImplementation(() => {});

  const result = await sendToRecipients({
    recipients: [allowed, blocked],
    emailType: "TEST_EMAIL",
    from: "Familiarise <notifications@mail.test>",
    subject: (r) => `Hello ${r.name}`,
    render: () => React.createElement("p", null, "hi"),
    entityRef: "test:1",
    budgetMs: 1000,
  });

  expect(result).toEqual({ sent: 1, skipped: 1, failed: 0 });
  expect(mockDeliver).toHaveBeenCalledTimes(1);
  expect(mockDeliver).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "one@example.com",
      subject: "Hello One",
      headers: {
        "List-Unsubscribe": `<${allowed.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
    "TEST_EMAIL",
    { entityRef: "test:1", budgetMs: 1000 },
  );
});

it("reports render failures once for the whole fanout", async () => {
  jest.clearAllMocks();
  jest.mocked(renderEmail).mockRejectedValue(new Error("broken template"));
  const result = await prepareRecipientEmails({
    recipients: [
      allowed,
      { ...allowed, userId: "user_3", email: "three@example.com" },
    ],
    emailType: "TEST_EMAIL",
    from: "a@example.com",
    subject: () => "Hi",
    render: () => React.createElement("p"),
    entityRef: "test:render",
  });
  expect(result.failed).toBe(2);
  expect(result.messages).toEqual([]);
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  expect(Sentry.captureException).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({ extra: { failedRecipients: 2 } }),
  );
});

it("carries the explicit recipient category into prepared and staged messages", async () => {
  jest.mocked(renderEmail).mockResolvedValue({ html: "<p>hi</p>", text: "hi" });
  const result = await prepareRecipientEmails({
    recipients: [{ ...allowed, category: "appointments" }],
    emailType: "APPOINTMENT_BOOKED",
    from: "sender@example.com",
    subject: () => "Booked",
    render: () => React.createElement("p"),
    entityRef: "appointment:1",
  });
  expect(result.messages[0].deliveryPolicy).toEqual({
    userId: "user_1",
    category: "appointments",
  });
});
