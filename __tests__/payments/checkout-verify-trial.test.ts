/**
 * @jest-environment node
 */

// A paid trial returns through the success page: verify names its state only once the held time is booked.

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "buyer" } },
  })),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  checkoutLimiter: { limit: jest.fn() },
}));
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: jest.fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  getRazorpayClient: () => ({}),
  withRazorpaySdkTimeout: jest.fn(),
}));
const paymentFindUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: (...a: unknown[]) => paymentFindUnique(...a) },
    refund: { findMany: jest.fn(async () => []) },
    appointmentParticipant: { findFirst: jest.fn(async () => ({ id: "s" })) },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/checkout/verify/route";

const startsAt = new Date(Date.now() + 2 * 24 * 3600_000);

/** The verify read's shape for a trial: no request row, one held occurrence. */
function trialPayment(paymentStatus: string, isTentative: boolean) {
  return {
    id: "pay-1",
    userId: "buyer",
    paymentIntent: "order_1",
    paymentStatus,
    paymentMethod: "netbanking",
    paymentGateway: "RAZORPAY",
    receiptUrl: null,
    amount: 11_300,
    taxAmount: 1_724,
    currency: "INR",
    createdAt: new Date(Date.now() - 600_000),
    expiresAt: new Date(Date.now() + 23 * 3600_000),
    appointment: {
      id: "appt-trial",
      appointmentType: "TRIAL",
      consultation: null,
      subscription: null,
      webinar: null,
      class: null,
      occurrences: [
        {
          id: "occ-1",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 1800_000),
          isTentative,
          deletedAt: null,
          completionStatus: "SCHEDULED",
        },
      ],
    },
  };
}

const verify = async () => {
  const res = await GET(
    new NextRequest(
      "https://x.test/api/checkout/verify?payment_intent=order_1",
    ),
  );
  return { status: res.status, body: await res.json() };
};

it("keeps the poll waiting while the trial's capture has not landed", async () => {
  paymentFindUnique.mockResolvedValue(trialPayment("PENDING", true));
  expect(await verify()).toMatchObject({
    status: 400,
    body: { status: "PENDING" },
  });
});

it("names no state while the paid trial's time is still a hold", async () => {
  paymentFindUnique.mockResolvedValue(trialPayment("SUCCEEDED", true));
  const { body } = await verify();
  expect(body.status).toBe("SUCCEEDED");
  expect(body.bookingState).toBeUndefined();
});

it("answers CONFIRMED and PAID once the capture booked the trial's time", async () => {
  paymentFindUnique.mockResolvedValue(trialPayment("SUCCEEDED", false));
  const { body } = await verify();
  expect(body).toMatchObject({
    appointmentType: "TRIAL",
    bookingState: "CONFIRMED",
    moneyState: "PAID",
  });
});
