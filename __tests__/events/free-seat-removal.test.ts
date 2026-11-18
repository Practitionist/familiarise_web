/** @jest-environment node */
/**
 * The removal dialog decides "free" from the seat's own payment, never from
 * the plan's current price: a seat bought at ₹500 on a plan now listed at ₹0
 * is still refunded, and a ₹0 seat is free whatever the plan says today.
 */
import { projectRow } from "../fixtures/prisma-projection";

let mockRows: Record<string, unknown>[] = [];
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: jest.fn(async (args: Record<string, unknown>) =>
        mockRows.map((row) => projectRow(row, args)),
      ),
    },
  },
}));

import { readSeatPayments } from "@/lib/data/seat-payments";
import { removingFreeSeat } from "@/lib/appointments/seat-payments";

const row = (over: Record<string, unknown>) => ({
  id: "pay-1",
  userId: "u-1",
  appointmentId: "appt-1",
  paymentStatus: "SUCCEEDED",
  paymentIntent: "free_abc",
  amount: 0,
  originalAmount: 0,
  currency: "INR",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  deletedAt: null,
  refunds: [],
  ...over,
});

it("a ₹0 seat is free, whatever the plan is listed at now", async () => {
  mockRows = [row({})];
  const [seat] = await readSeatPayments(["appt-1"], ["u-1"]);
  expect(seat.priceFree).toBe(true);
  expect(seat).not.toHaveProperty("paymentIntent");
  expect(removingFreeSeat(seat, 50_000)).toBe(true);
});

it("a paid seat is not free once the plan's price drops to ₹0", async () => {
  mockRows = [
    row({ paymentIntent: "order_1", amount: 50_000, originalAmount: 50_000 }),
  ];
  const [seat] = await readSeatPayments(["appt-1"], ["u-1"]);
  expect(seat.priceFree).toBe(false);
  expect(removingFreeSeat(seat, 0)).toBe(false);
});

it("a seat with no payment row falls back to the plan's price", () => {
  expect(removingFreeSeat(undefined, 0)).toBe(true);
  expect(removingFreeSeat(undefined, 50_000)).toBe(false);
});
