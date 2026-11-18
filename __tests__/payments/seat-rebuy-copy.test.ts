/**
 * @jest-environment node
 */

/**
 * A buyer who left a seat and tries to buy again: a price-free seat they left
 * themselves rejoins; a removed seat, a credit-funded or paid seat refuse
 * honestly; a seat still held answers already-registered.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  assertSeatRemintable,
  priorSeatStanding,
  seatRebuyRefusal,
  seatRegistrationFor,
  type PriorSeatPayment,
} from "../../lib/payments/checkout/seats";

// The row `findPriorSeatPayment` selects.
const prior = (
  over: Partial<PriorSeatPayment> &
    Pick<PriorSeatPayment, "amount" | "appointmentParticipants">,
): PriorSeatPayment => ({
  id: "pay-1",
  userId: "u-1",
  paymentIntent: over.amount > 0 ? "order_1" : "free_1",
  gatewayPaymentId: over.amount > 0 ? "pay_g" : null,
  originalAmount: over.amount,
  taxAmount: 0,
  gstRegime: null,
  currency: "INR",
  paymentGateway: "RAZORPAY",
  paymentStatus: "SUCCEEDED",
  refunds: [],
  ...over,
});

const left = { status: "CANCELLED" as const, removedByUserId: null };
const removed = { status: "CANCELLED" as const, removedByUserId: "host-1" };

const priceFreeLeft = prior({ amount: 0, appointmentParticipants: [left] });
const priceFreeRefundedRow = prior({
  amount: 0,
  appointmentParticipants: [{ status: "REFUNDED", removedByUserId: null }],
});
// ₹0 at checkout because referral credit covered a ₹500 list price.
const creditFundedLeft = prior({
  amount: 0,
  originalAmount: 50_000,
  appointmentParticipants: [left],
});
const paidLeft = prior({
  amount: 100_000,
  refunds: [{ amountPaise: 50_000 }],
  appointmentParticipants: [left],
});
// The organiser's removal and a conduct removal both mark the seat.
const priceFreeRemoved = prior({
  amount: 0,
  appointmentParticipants: [removed],
});
const paidRemovedRefunded = prior({
  amount: 100_000,
  refunds: [{ amountPaise: 100_000 }],
  appointmentParticipants: [{ ...removed, status: "REFUNDED" }],
});
const held = prior({
  amount: 0,
  appointmentParticipants: [{ status: "CONFIRMED", removedByUserId: null }],
});

it("lets a price-free seat its holder left rejoin, on every caller", () => {
  expect(priorSeatStanding(priceFreeLeft)).toBe("REJOINABLE");
  expect(seatRebuyRefusal(priceFreeLeft)).toBeNull();
  expect(() => assertSeatRemintable(priceFreeLeft, "WEBINAR")).not.toThrow();
  expect(seatRegistrationFor(priceFreeLeft, "u-1", "WEBINAR")).toEqual({
    actorUserId: "u-1",
    reviveReason: "rejoined",
    reviveFromIn: ["CANCELLED"],
  });
});

it.each([
  ["a credit-funded ₹0 seat", creditFundedLeft],
  ["a paid seat with a partial refund", paidLeft],
  ["a free seat whose row reads REFUNDED", priceFreeRefundedRow],
])("keeps the left refusal for %s", (_label, row) => {
  expect(priorSeatStanding(row)).toBe("LEFT");
  expect(() => assertSeatRemintable(row, "WEBINAR")).toThrow(
    expect.objectContaining({
      code: "SEAT_REBUY_UNSUPPORTED",
      message: expect.stringMatching(/left this event/),
    }),
  );
});

it.each([
  ["a removed price-free seat", priceFreeRemoved],
  ["a removed paid seat refunded in full", paidRemovedRefunded],
])("tells %s that the organiser removed them", (_label, row) => {
  expect(priorSeatStanding(row)).toBe("REMOVED");
  expect(() => seatRegistrationFor(row, "u-1", "CLASS")).toThrow(
    expect.objectContaining({
      code: "SEAT_REBUY_UNSUPPORTED",
      message:
        "The organiser removed you from this event. Contact support if you think this was a mistake.",
    }),
  );
});

it("lets a lifted price-free seat rejoin and keeps a lifted paid seat refused", () => {
  const lifted = (row: PriorSeatPayment) => ({
    ...row,
    appointmentParticipants: row.appointmentParticipants.map((seat) => ({
      ...seat,
      removedByUserId: null,
    })),
  });
  expect(priorSeatStanding(lifted(priceFreeRemoved))).toBe("REJOINABLE");
  expect(priorSeatStanding(lifted(paidRemovedRefunded))).toBe("REFUNDED");
});

it("still answers already-registered while the seat is held", () => {
  expect(seatRebuyRefusal(held)).toBe("ALREADY_REGISTERED");
  expect(() => assertSeatRemintable(held, "WEBINAR")).toThrow(
    expect.objectContaining({ code: "ALREADY_REGISTERED" }),
  );
});
