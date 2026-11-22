/**
 * @jest-environment node
 */

// Every order the pay page opens returns through the success page: verify names its state only once the capture booked it.

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
const requestedAt = new Date(Date.now() - 24 * 3600_000);

type Kind = "TRIAL" | "CONSULTATION" | "SUBSCRIPTION";

/** The verify read's shape for each booking the pay page serves; a trial has no request row. */
function payPageOrder(kind: Kind, paymentStatus: string, captured: boolean) {
  const request = {
    status: captured ? "APPROVED" : "APPROVED_PENDING_PAYMENT",
    requestedAt,
  };
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
      id: "appt-1",
      appointmentType: kind,
      consultation:
        kind === "CONSULTATION"
          ? { ...request, consultationPlan: { title: "Career call" } }
          : null,
      subscription:
        kind === "SUBSCRIPTION"
          ? { ...request, subscriptionPlan: { title: "Six weeks" } }
          : null,
      webinar: null,
      class: null,
      occurrences: [
        {
          id: "occ-1",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 1800_000),
          isTentative: !captured,
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

const KINDS: Kind[] = ["TRIAL", "CONSULTATION", "SUBSCRIPTION"];

it.each(KINDS)(
  "%s: keeps the poll waiting while the capture has not landed",
  async (kind) => {
    paymentFindUnique.mockResolvedValue(payPageOrder(kind, "PENDING", false));
    expect(await verify()).toMatchObject({
      status: 400,
      body: { status: "PENDING" },
    });
  },
);

it("TRIAL: names no state while the paid time is still a hold", async () => {
  paymentFindUnique.mockResolvedValue(
    payPageOrder("TRIAL", "SUCCEEDED", false),
  );
  const { body } = await verify();
  expect(body.status).toBe("SUCCEEDED");
  expect(body.bookingState).toBeUndefined();
});

it.each(KINDS)(
  "%s: answers CONFIRMED and PAID once the capture booked it",
  async (kind) => {
    paymentFindUnique.mockResolvedValue(payPageOrder(kind, "SUCCEEDED", true));
    const { body } = await verify();
    expect(body).toMatchObject({
      appointmentType: kind,
      bookingState: "CONFIRMED",
      moneyState: "PAID",
    });
  },
);
