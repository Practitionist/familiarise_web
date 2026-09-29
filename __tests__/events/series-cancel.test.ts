/**
 * @jest-environment node
 */

/**
 * #1780 D-5 — a host cancelling a class series refunds each seat only the
 * sessions it was not delivered (amount − unit × delivered), keyed per seat;
 * the delivered share of the fee, and so of the earnings, stays (the cascade
 * half is pinned in __tests__/payments/refund-operation.test.ts).
 */

const refundPayment = jest.fn(async (input: { amountPaise?: number }) => ({
  refundId: "rf",
  amountRefundedPaise: input.amountPaise ?? 80_000,
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...a: unknown[]) => refundPayment(...(a as [never])),
  RefundValidationError: class extends Error {},
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: jest.fn(async () => [
        { id: "pay-a", amount: 80_000, paymentIntent: "order_a" },
      ]),
      findUnique: jest.fn(async () => ({ refunds: [], disputes: [] })),
    },
  },
}));

import { seriesCancelRefundPaise } from "@/lib/booking/class-series";
import { refundWholeEventPayments } from "@/lib/payments/operations/event-refunds";

const ledger = {
  N: 8,
  heldCount: 8,
  unitPaise: BigInt(10_000),
  deliveredHeld: 3,
  remaining: [],
  neverScheduled: 5,
};

it("N = 8 with 3 delivered refunds each seat 5 units, keyed on the payment", async () => {
  expect(seriesCancelRefundPaise(ledger, 80_000)).toBe(BigInt(50_000));
  await refundWholeEventPayments("class", "cls-1", "host cancelled", null, {
    ledgers: new Map([["pay-a", ledger]]),
  });
  expect(refundPayment).toHaveBeenCalledWith(
    expect.objectContaining({
      paymentId: "pay-a",
      amountPaise: 50_000,
      dedupeKey: "series-cancel:pay-a",
    }),
  );
});
