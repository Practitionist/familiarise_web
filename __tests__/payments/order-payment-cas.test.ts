/**
 * @jest-environment node
 */

/**
 * The digital-product and replay capture webhooks settle the order's pre-mint
 * Payment by CAS on the status they read; a lost race throws, so the capture
 * rolls back whole and its redelivery settles from fresh state.
 */
import fs from "node:fs";
import path from "node:path";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));

import {
  OrderPaymentMovedError,
  settleOrderPayment,
} from "@/lib/payments/webhooks/standalone-sale-capture";
import type { Tx } from "@/lib/prisma";

function fakeTx(count: number) {
  const updateMany = jest.fn(async () => ({ count }));
  const findUniqueOrThrow = jest.fn(async () => ({
    id: "pay-1",
    paymentStatus: "SUCCEEDED",
  }));
  return {
    tx: { payment: { updateMany, findUniqueOrThrow } } as unknown as Tx,
    updateMany,
  };
}

it("writes SUCCEEDED only from the status the capture read", async () => {
  const { tx, updateMany } = fakeTx(1);
  const row = await settleOrderPayment(
    tx,
    { id: "pay-1", paymentStatus: "PENDING" },
    { amount: 49_900, description: "sale" },
  );
  expect(updateMany).toHaveBeenCalledWith({
    where: { id: "pay-1", paymentStatus: "PENDING" },
    data: { amount: 49_900, description: "sale", paymentStatus: "SUCCEEDED" },
  });
  expect(row).toMatchObject({ id: "pay-1", paymentStatus: "SUCCEEDED" });
});

it("throws on a lost race so the whole capture rolls back", async () => {
  const { tx } = fakeTx(0);
  await expect(
    settleOrderPayment(tx, { id: "pay-1", paymentStatus: "FAILED" }, {}),
  ).rejects.toBeInstanceOf(OrderPaymentMovedError);
});

it.each([
  "lib/payments/webhooks/digital-product-purchase.ts",
  "lib/payments/webhooks/recording-purchase.ts",
])("%s never writes a Payment status without CAS", (rel) => {
  const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  expect(src).toContain("settleOrderPayment(tx, orderPayment");
  expect(src).not.toMatch(/tx\.payment\.update\(/);
});
