/**
 * @jest-environment node
 */

/**
 * A buyer who left a seat (CANCELLED or REFUNDED, free or paid) and tries to
 * buy again is told the seat was left, never that they still hold it.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  assertSeatRemintable,
  seatRebuyRefusal,
  type PriorSeatPayment,
} from "../../lib/payments/checkout/seats";

// The row `findPriorSeatPayment` selects.
const prior = (
  over: Pick<
    PriorSeatPayment,
    "amount" | "refunds" | "appointmentParticipants"
  >,
): PriorSeatPayment => ({
  id: "pay-1",
  userId: "u-1",
  paymentIntent: "order_1",
  gatewayPaymentId: over.amount > 0 ? "pay_g" : null,
  originalAmount: over.amount,
  taxAmount: 0,
  gstRegime: null,
  currency: "INR",
  paymentGateway: "RAZORPAY",
  paymentStatus: "SUCCEEDED",
  ...over,
});

const freeSeatLeft = prior({
  amount: 0,
  refunds: [],
  appointmentParticipants: [{ status: "REFUNDED" }],
});
const paidSeatLeft = prior({
  amount: 100_000,
  refunds: [{ amountPaise: 50_000 }],
  appointmentParticipants: [{ status: "REFUNDED" }],
});
const paidSeatCancelled = prior({
  amount: 100_000,
  refunds: [{ amountPaise: 50_000 }],
  appointmentParticipants: [{ status: "CANCELLED" }],
});
const activeSeat = prior({
  amount: 0,
  refunds: [],
  appointmentParticipants: [{ status: "CONFIRMED" }],
});

it.each([
  ["a free seat left", freeSeatLeft],
  ["a paid seat left with a partial refund", paidSeatLeft],
  ["a paid seat cancelled with a partial refund", paidSeatCancelled],
])("answers SEAT_REBUY_UNSUPPORTED for %s", (_label, row) => {
  expect(seatRebuyRefusal(row)).toBe("LEFT");
  expect(() => assertSeatRemintable(row, "WEBINAR")).toThrow(
    expect.objectContaining({
      code: "SEAT_REBUY_UNSUPPORTED",
      message: expect.stringMatching(/left this event/),
    }),
  );
});

it("still answers already-registered while the seat is held", () => {
  expect(seatRebuyRefusal(activeSeat)).toBe("ALREADY_REGISTERED");
  expect(() => assertSeatRemintable(activeSeat, "WEBINAR")).toThrow(
    expect.objectContaining({ code: "ALREADY_REGISTERED" }),
  );
});
