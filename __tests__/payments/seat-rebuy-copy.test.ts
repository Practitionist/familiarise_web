/**
 * @jest-environment node
 */

/**
 * A buyer who left a seat (partial or zero refund) and tries to buy again is
 * told the seat was left, never that they still hold it.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { assertSeatRemintable } from "../../lib/payments/checkout/seats";

const prior = (seatStatus: string | null) =>
  ({
    id: "pay-1",
    userId: "u-1",
    paymentIntent: "order_1",
    gatewayPaymentId: "pay_g",
    amount: 100_000,
    originalAmount: 100_000,
    taxAmount: 0,
    currency: "INR",
    paymentGateway: "RAZORPAY",
    paymentStatus: "SUCCEEDED",
    refunds: [{ amountPaise: 50_000 }],
    appointmentParticipants: seatStatus ? [{ status: seatStatus }] : [],
  }) as unknown as Parameters<typeof assertSeatRemintable>[0];

it("answers SEAT_REBUY_UNSUPPORTED for a seat left with a partial refund", () => {
  expect(() => assertSeatRemintable(prior("CANCELLED"), "WEBINAR")).toThrow(
    expect.objectContaining({
      code: "SEAT_REBUY_UNSUPPORTED",
      message: expect.stringMatching(/left this event/),
    }),
  );
});

it("still answers already-registered while the seat is held", () => {
  expect(() => assertSeatRemintable(prior("CONFIRMED"), "WEBINAR")).toThrow(
    expect.not.objectContaining({ code: "SEAT_REBUY_UNSUPPORTED" }),
  );
});
