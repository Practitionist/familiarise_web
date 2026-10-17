/**
 * @jest-environment node
 */

/**
 * #1780 D-5 — a host cancelling a class series refunds each seat only the
 * sessions it was not delivered (amount − unit × delivered), keyed per seat;
 * the delivered share of the fee, and so of the earnings, stays (the cascade
 * half is pinned in __tests__/payments/refund-operation.test.ts).
 */

const KEY = "event-cancel:cls-1:pay:pay-a";
const mockRefundBookingPayment = jest.fn(
  async (input: { amountPaise?: number }) => ({
    refundId: "rf",
    amountRefundedPaise: input.amountPaise ?? 80_000,
    rail: "GATEWAY",
  }),
);
const mockExecuteRaw = jest.fn(async () => 1);
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) =>
    mockRefundBookingPayment(...(a as [never])),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  findDedupedRefund: jest.fn(async () => null),
  RefundGatewayError: class extends Error {},
  RefundValidationError: class extends Error {},
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    payment: {
      // The plan read, then the marker read once the seat is stamped.
      findMany: jest.fn(async (args: { where: { refundOwedKey?: unknown } }) =>
        args.where.refundOwedKey
          ? [
              {
                id: "pay-a",
                refundOwedKey: KEY,
                refundOwedPaise: 50_000,
                refundOwedReason: "host cancelled",
                refundOwedAttempts: 0,
              },
            ]
          : [
              {
                id: "pay-a",
                amount: 80_000,
                paymentIntent: "order_a",
                refunds: [],
                disputes: [],
              },
            ],
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    dispute: { findMany: jest.fn(async () => []) },
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...(a as [])),
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { __esModule: true, default: db };
});

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

it("N = 8 with 3 delivered refunds each seat 5 units, keyed on the event and payment", async () => {
  expect(seriesCancelRefundPaise(ledger, 80_000)).toBe(BigInt(50_000));
  await refundWholeEventPayments("class", "cls-1", "host cancelled", null, {
    ledgers: new Map([["pay-a", ledger]]),
  });
  // The seat is stamped owed its undelivered share, then driven under that key.
  const stamp = mockExecuteRaw.mock.calls[0] as unknown as [
    { values: unknown[] },
  ];
  expect(stamp[0].values.slice(0, 3)).toEqual([["pay-a"], [KEY], [50_000]]);
  expect(mockRefundBookingPayment).toHaveBeenCalledWith(
    expect.objectContaining({
      paymentId: "pay-a",
      amountPaise: 50_000,
      dedupeKey: KEY,
    }),
  );
});
