/**
 * @jest-environment node
 */

// The success page's calendar links follow the buyer's own paid seat, not the shared event's sessions.

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
const refundFindMany = jest.fn();
const seatFindFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: (...a: unknown[]) => paymentFindUnique(...a) },
    refund: { findMany: (...a: unknown[]) => refundFindMany(...a) },
    appointmentParticipant: {
      findFirst: (...a: unknown[]) => seatFindFirst(...a),
    },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/checkout/verify/route";
import { calendarSeatWhere } from "../../lib/appointments/calendar-links";

const startsAt = new Date(Date.now() + 3 * 24 * 3600_000);
const createdAt = new Date(Date.now() - 3600_000);

beforeEach(() => {
  jest.clearAllMocks();
  paymentFindUnique.mockResolvedValue({
    id: "pay-1",
    userId: "buyer",
    paymentIntent: "order_1",
    paymentStatus: "SUCCEEDED",
    paymentMethod: "card",
    paymentGateway: "RAZORPAY",
    receiptUrl: null,
    amount: 118_000,
    taxAmount: 18_000,
    currency: "INR",
    createdAt,
    expiresAt: null,
    appointment: {
      id: "appt-web",
      appointmentType: "WEBINAR",
      consultation: null,
      subscription: null,
      webinar: { webinarPlan: { title: "Deep work" } },
      class: null,
      occurrences: [
        {
          id: "occ-1",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600_000),
          isTentative: false,
          deletedAt: null,
          completionStatus: "SCHEDULED",
        },
      ],
    },
  });
  refundFindMany.mockResolvedValue([]);
  seatFindFirst.mockResolvedValue({ id: "seat-1" });
});

const verify = async () =>
  (
    await GET(
      new NextRequest(
        "https://x.test/api/checkout/verify?payment_intent=order_1",
      ),
    )
  ).json();

it("sends calendar links while the buyer's seat is paid", async () => {
  const body = await verify();
  expect(body.bookingState).toBe("CONFIRMED");
  expect(body.calendar?.icsUrl).toContain("/api/calendar/appt-web");
  expect(seatFindFirst.mock.calls[0][0].where).toEqual({
    appointmentId: "appt-web",
    ...calendarSeatWhere("buyer"),
  });
});

it("sends none once the buyer's own seat is no longer paid, though the event goes on", async () => {
  seatFindFirst.mockResolvedValue(null);
  const body = await verify();
  expect(body.bookingState).toBe("CONFIRMED");
  expect(body.calendar).toBeUndefined();
});

it("sends none while the buyer's money is coming back", async () => {
  refundFindMany.mockResolvedValue([
    { status: "PENDING", amountPaise: 118_000 },
  ]);
  const body = await verify();
  expect(body.moneyState).toBe("REFUND_PENDING");
  expect(body.calendar).toBeUndefined();
});
