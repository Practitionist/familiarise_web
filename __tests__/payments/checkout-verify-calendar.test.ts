/**
 * @jest-environment node
 */

// The success page's calendar links follow the buyer's own paid seat, not the shared event's sessions.
// Every order the pay page opens is named only once its capture booked it.

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
jest.mock("@sentry/nextjs", () => ({
  ...jest.requireActual("@sentry/nextjs"),
  captureException: jest.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
import { GET } from "../../app/api/checkout/verify/route";
import { routeCapturedPayment } from "../../app/api/webhooks/razorpay-dispatch";
import { withRazorpaySdkTimeout } from "../../lib/payments/core/razorpay";
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

const verifyWithStatus = async () => {
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
    expect(await verifyWithStatus()).toMatchObject({
      status: 400,
      body: { status: "PENDING" },
    });
  },
);

it("TRIAL: names no state while the paid time is still a hold", async () => {
  paymentFindUnique.mockResolvedValue(
    payPageOrder("TRIAL", "SUCCEEDED", false),
  );
  const { body } = await verifyWithStatus();
  expect(body.status).toBe("SUCCEEDED");
  expect(body.bookingState).toBeUndefined();
});

it.each(KINDS)(
  "%s: answers CONFIRMED and PAID once the capture booked it",
  async (kind) => {
    paymentFindUnique.mockResolvedValue(payPageOrder(kind, "SUCCEEDED", true));
    const { body } = await verifyWithStatus();
    expect(body).toMatchObject({
      appointmentType: kind,
      bookingState: "CONFIRMED",
      moneyState: "PAID",
    });
  },
);

it("keeps the poll waiting, unreported, while another door holds the order's capture lock", async () => {
  paymentFindUnique.mockResolvedValue(
    payPageOrder("CONSULTATION", "PENDING", false),
  );
  jest
    .mocked(withRazorpaySdkTimeout)
    .mockResolvedValueOnce({ status: "paid", notes: {} } as never)
    .mockResolvedValueOnce({
      items: [{ id: "pay_1", status: "captured", amount: 11_300, notes: {} }],
    } as never);
  jest.mocked(routeCapturedPayment).mockRejectedValueOnce(
    Object.assign(new Error("canceling statement due to lock timeout"), {
      name: "DriverAdapterError",
      cause: { kind: "postgres", code: "55P03", originalCode: "55P03" },
    }),
  );

  const res = await GET(
    new NextRequest(
      "https://x.test/api/checkout/verify?payment_intent=order_1&sync=true",
    ),
  );

  expect(routeCapturedPayment).toHaveBeenCalledTimes(1);
  expect(res.status).toBe(400);
  expect((await res.json()).status).toBe("PENDING");
  expect(Sentry.captureException).not.toHaveBeenCalled();
});
