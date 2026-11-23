/** @jest-environment node */

// The payment-failed email names the gateway's reason in words, never the
// plan's own description.

const mockRender = jest.fn(async (_args: { failureReason?: string }) => ({
  subject: "s",
  html: "h",
  text: "t",
}));

jest.mock("@/lib/email", () => ({
  renderPaymentFailedEmail: (args: { failureReason?: string }) =>
    mockRender(args),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/novu", () => ({}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { preparePaymentFailedEmail } from "@/lib/payments/webhooks/staged-emails";

const db = {
  appointment: {
    findUnique: jest.fn(async () => ({
      consultation: {
        id: "c1",
        consultationPlan: {
          consultantProfile: { user: { name: "Asha Rao" } },
        },
      },
      subscription: null,
    })),
  },
} as unknown as Parameters<typeof preparePaymentFailedEmail>[1];

const payment = {
  id: "pay_1",
  appointmentId: "appt_1",
  amount: 150_000,
  currency: "INR",
  user: { email: "learner@example.com", name: "Learner" },
  description: "Career mentorship – 4 sessions",
};

async function reasonFor(failureReason?: string | null): Promise<string> {
  mockRender.mockClear();
  await preparePaymentFailedEmail({ ...payment, failureReason }, db);
  expect(mockRender).toHaveBeenCalledTimes(1);
  return mockRender.mock.calls[0][0].failureReason ?? "";
}

describe("payment-failed email reason", () => {
  it("names a gateway code in words", async () => {
    await expect(reasonFor("card_declined")).resolves.toBe(
      "Your card was declined",
    );
  });

  it("passes the gateway's own sentence through", async () => {
    await expect(
      reasonFor("Payment was declined by the issuing bank."),
    ).resolves.toBe("Payment was declined by the issuing bank.");
  });

  it("falls back to a plain sentence and never prints the plan description", async () => {
    const reason = await reasonFor(undefined);
    expect(reason).toBe("The payment could not be processed");
    expect(reason).not.toContain("mentorship");
  });
});
