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
/** The marker the seat's payment carries when the stamp's ownership check reads it. */
const held = { key: null as string | null, attempts: 0 };
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
                refundOwedKey: held.key,
              },
            ],
      ),
      findUnique: jest.fn(async () => ({
        refundOwedKey: held.key,
        refundOwedAttempts: held.attempts,
        disputes: [],
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    dispute: { findMany: jest.fn(async () => []) },
    // The owed-refund stamp cancels the unsent payouts that batched the payment's earnings; none here.
    consultantEarnings: { findMany: jest.fn(async () => []) },
    organizationEarnings: { findMany: jest.fn(async () => []) },
    appointmentParticipant: {
      findMany: jest.fn(async () => [{ userId: "u-a", paymentId: "pay-a" }]),
    },
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...(a as [])),
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { __esModule: true, default: db };
});

import prisma from "@/lib/prisma";
import { seriesCancelRefundPaise } from "@/lib/booking/class-series";
import {
  refundWholeEventPayments,
  stampWholeEventRefundsOwed,
} from "@/lib/payments/operations/event-refunds";

const ledger = {
  N: 8,
  heldCount: 8,
  unitPaise: BigInt(10_000),
  deliveredHeld: 3,
  inProgressHeld: 0,
  remaining: [],
  neverScheduled: 5,
  unplaced: 0,
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

describe("a whole-event cancel owns every seat's refund marker or commits nothing", () => {
  const stamp = () =>
    prisma.$transaction((tx) =>
      stampWholeEventRefundsOwed(tx, {
        kind: "class",
        eventId: "cls-1",
        reason: "host cancelled",
        ledgers: new Map([["pay-a", ledger]]),
      }),
    );

  beforeEach(() => {
    held.key = null;
    held.attempts = 0;
    mockExecuteRaw.mockClear();
    mockRefundBookingPayment.mockClear();
  });

  it("refuses with REFUND_IN_PROGRESS when another door's retrying marker holds a seat", async () => {
    mockExecuteRaw.mockResolvedValueOnce(0);
    held.key = "occ:occ-2:pay:pay-a";
    await expect(stamp()).rejects.toMatchObject({
      code: "REFUND_IN_PROGRESS",
      httpStatus: 409,
      userMessage: expect.stringMatching(/class couldn't be cancelled yet/),
    });
  });

  it("refuses with REFUND_NEEDS_SUPPORT when that marker spent its attempts", async () => {
    mockExecuteRaw.mockResolvedValueOnce(0);
    held.key = "occ:occ-2:pay:pay-a";
    held.attempts = 3;
    await expect(stamp()).rejects.toMatchObject({
      code: "REFUND_NEEDS_SUPPORT",
      httpStatus: 409,
    });
  });

  it("refuses when the stamp matched nothing and no marker is there to own", async () => {
    mockExecuteRaw.mockResolvedValueOnce(0);
    await expect(stamp()).rejects.toMatchObject({ code: "REFUND_IN_PROGRESS" });
  });

  it("owns a replay of its own key", async () => {
    mockExecuteRaw.mockResolvedValueOnce(0);
    held.key = KEY;
    const plans = await stamp();
    expect(plans.get("pay-a")).toMatchObject({
      kind: "owe",
      marker: { key: KEY, amountPaise: 50_000 },
    });
  });

  it("drives only its own markers after the commit", async () => {
    await refundWholeEventPayments("class", "cls-1", "host cancelled", null, {
      ledgers: new Map([["pay-a", ledger]]),
    });
    const db = jest.requireMock("../../lib/prisma").default as {
      payment: { findMany: jest.Mock };
    };
    const markerRead = db.payment.findMany.mock.calls.find(
      ([args]) => args.where.refundOwedKey,
    );
    expect(markerRead?.[0].where.refundOwedKey).toEqual({ in: [KEY] });
  });
});
