/**
 * @jest-environment node
 */

/**
 * The gateway rail decides whether a refund ends the seat inside its
 * reservation, stores it on the Refund row, and a keyed replay answers it.
 * The gateway answers PENDING, so each refund stops before the cascade.
 */

type RefundRow = {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: string;
  dedupeKey: string | null;
  refundId: string;
  metadata: Record<string, unknown>;
};
const mockState = { refunds: [] as RefundRow[], chargedBackPaise: 0 };
const live = () =>
  mockState.refunds.filter((r) => ["SUCCEEDED", "PENDING"].includes(r.status));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyRefundRequested: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments", () => ({
  createRefund: jest.fn(async () => ({
    refundId: "",
    amount: 0,
    currency: "INR",
    status: "PENDING",
  })),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    user: { findMany: async () => [] },
    payment: {
      // ₹500 card payment.
      findUnique: async () => ({
        id: "pay-1",
        userId: "buyer-1",
        amount: 50_000,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentGateway: "RAZORPAY",
        paymentIntent: "pay_abc",
        displayCurrencyAtCheckout: null,
        exchangeRateAtCheckout: null,
        organizationId: null,
        refunds: live().map((r) => ({
          amountPaise: r.amountPaise,
          status: r.status,
        })),
      }),
    },
    dispute: {
      aggregate: async () => ({
        _sum: { amountPaise: mockState.chargedBackPaise },
      }),
      findFirst: async () => null,
    },
    refund: {
      findUnique: async ({ where }: { where: { dedupeKey?: string } }) =>
        mockState.refunds.find((r) => r.dedupeKey === where.dedupeKey) ?? null,
      findMany: async () => live().map((r) => ({ amountPaise: r.amountPaise })),
      create: async ({ data }: { data: Omit<RefundRow, "id"> }) => {
        const row = { ...data, id: `refund-${mockState.refunds.length + 1}` };
        mockState.refunds.push(row);
        return row;
      },
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { __esModule: true, default: db };
});

import { refundPayment } from "../../lib/payments/operations/refund";

beforeEach(() => {
  mockState.refunds = [];
  mockState.chargedBackPaise = 0;
});

it("a ₹100 partial keeps the seat, and resending its key with no amount answers that decision", async () => {
  const first = await refundPayment({
    paymentId: "pay-1",
    amountPaise: 10_000,
    reason: "ops refund: goodwill",
    dedupeKey: "ops:k",
    keepSeatIfPartial: true,
  });
  const replay = await refundPayment({
    paymentId: "pay-1",
    reason: "ops refund: goodwill",
    dedupeKey: "ops:k",
    keepSeatIfPartial: true,
  });

  expect(first.endsSeat).toBe(false);
  expect(mockState.refunds).toHaveLength(1);
  expect(mockState.refunds[0]?.metadata).toMatchObject({ endsSeat: false });
  expect(replay).toMatchObject({
    refundId: first.refundId,
    amountRefundedPaise: 10_000,
    endsSeat: false,
  });
});

it("ends the seat on the refund that returns the rest, counting a lost chargeback", async () => {
  mockState.chargedBackPaise = 20_000;
  const partial = await refundPayment({
    paymentId: "pay-1",
    amountPaise: 10_000,
    reason: "goodwill",
    keepSeatIfPartial: true,
  });
  const rest = await refundPayment({
    paymentId: "pay-1",
    amountPaise: 20_000,
    reason: "goodwill",
    keepSeatIfPartial: true,
  });
  const cancel = await refundPayment({ paymentId: "pay-1", reason: "x" }).catch(
    (err: { code: string }) => err.code,
  );

  expect([partial.endsSeat, rest.endsSeat]).toEqual([false, true]);
  expect(mockState.refunds.map((r) => r.metadata.endsSeat)).toEqual([
    false,
    true,
  ]);
  expect(cancel).toBe("ALREADY_FULLY_REFUNDED");
});

it("a refund with no amount, or with keepSeat, records its decision whatever the balance", async () => {
  const kept = await refundPayment({
    paymentId: "pay-1",
    amountPaise: 50_000,
    reason: "missed session",
    keepSeat: true,
  });
  mockState.refunds = [];
  const ended = await refundPayment({
    paymentId: "pay-1",
    reason: "cancellation",
    keepSeatIfPartial: true,
  });

  expect([kept.endsSeat, ended.endsSeat]).toEqual([false, true]);
});
