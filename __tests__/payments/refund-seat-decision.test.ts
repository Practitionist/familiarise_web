/**
 * @jest-environment node
 */

/**
 * The gateway rail decides whether a refund ends the seat once the gateway has
 * answered, against the balance committed then, stores it on the Refund row,
 * and a keyed replay answers it. No refund here reaches the cascade: the
 * gateway answers PENDING, or a webhook settled the row first.
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
const mockState = {
  refunds: [] as RefundRow[],
  chargedBackPaise: 0,
  /** What happens while this refund is at the gateway, before its answer. */
  atGateway: null as null | (() => void),
  gatewayStatus: "PENDING" as "PENDING" | "SUCCEEDED",
};
const live = () =>
  mockState.refunds.filter((r) => ["SUCCEEDED", "PENDING"].includes(r.status));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyRefundRequested: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments", () => ({
  createRefund: jest.fn(async () => {
    mockState.atGateway?.();
    return {
      refundId: "",
      amount: 0,
      currency: "INR",
      status: mockState.gatewayStatus,
    };
  }),
}));
jest.mock("../../lib/email", () => ({
  ...jest.requireActual("../../lib/email"),
  prepareRefundProcessedEmail: jest.fn(async () => null),
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
        refunds: mockState.refunds.map((r) => ({
          amountPaise: r.amountPaise,
          status: r.status,
        })),
        disputes: [{ amountPaise: mockState.chargedBackPaise, status: "LOST" }],
      }),
    },
    dispute: {
      aggregate: async () => ({
        _sum: { amountPaise: mockState.chargedBackPaise },
      }),
      findFirst: async () => null,
    },
    refund: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; dedupeKey?: string };
      }) =>
        mockState.refunds.find((r) =>
          where.id ? r.id === where.id : r.dedupeKey === where.dedupeKey,
        ) ?? null,
      findMany: async ({ where }: { where: { status?: { in: string[] } } }) =>
        where.status ? live() : mockState.refunds,
      create: async ({ data }: { data: Omit<RefundRow, "id"> }) => {
        const row = { ...data, id: `refund-${mockState.refunds.length + 1}` };
        mockState.refunds.push(row);
        return row;
      },
      // A webhook that already settled the row leaves the settle claim nothing to flip.
      updateMany: async ({ where }: { where: { status?: string } }) => ({
        count: where.status === "PENDING" ? 0 : 1,
      }),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { metadata: Record<string, unknown> };
      }) => {
        const row = mockState.refunds.find((r) => r.id === where.id);
        if (row) row.metadata = data.metadata;
        return row;
      },
    },
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { __esModule: true, default: db };
});

import { refundPayment } from "../../lib/payments/operations/refund";

beforeEach(() => {
  mockState.refunds = [];
  mockState.chargedBackPaise = 0;
  mockState.atGateway = null;
  mockState.gatewayStatus = "PENDING";
});

/** ₹400 of the ₹500 payment is already out at the gateway as another refund, PENDING. */
const concurrentPending = () =>
  mockState.refunds.push({
    id: "refund-other",
    paymentId: "pay-1",
    amountPaise: 40_000,
    status: "PENDING",
    dedupeKey: "ops:other",
    refundId: "pending_other",
    metadata: {},
  });
const otherFails = () => {
  const other = mockState.refunds.find((r) => r.id === "refund-other");
  if (other) other.status = "FAILED";
};

const settleOwnRow = (): void => {
  const own = mockState.refunds.find((r) => r.id !== "refund-other");
  if (own) own.status = "SUCCEEDED";
};

it.each<[string, "PENDING" | "SUCCEEDED", () => void]>([
  ["answers PENDING", "PENDING", () => undefined],
  ["answers SUCCEEDED after a webhook settled it", "SUCCEEDED", settleOwnRow],
])(
  "keeps the seat when a concurrent ₹400 refund fails while this ₹100 one is at the gateway, and the gateway %s",
  async (_answer, status, settledByWebhook) => {
    concurrentPending();
    mockState.gatewayStatus = status;
    mockState.atGateway = () => {
      otherFails();
      settledByWebhook();
    };

    // At its reservation this ₹100 left nothing refundable; once the other failed, ₹400 is.
    const refund = await refundPayment({
      paymentId: "pay-1",
      amountPaise: 10_000,
      reason: "ops refund: goodwill",
      dedupeKey: "ops:k",
      keepSeatIfPartial: true,
    });

    expect(refund.endsSeat).toBe(false);
    expect(
      mockState.refunds.find((r) => r.dedupeKey === "ops:k")?.metadata,
    ).toMatchObject({ endsSeat: false });
  },
);

it("ends the seat when the concurrent refund is still out once this one is final", async () => {
  concurrentPending();

  const refund = await refundPayment({
    paymentId: "pay-1",
    amountPaise: 10_000,
    reason: "ops refund: goodwill",
    keepSeatIfPartial: true,
  });

  expect(refund.endsSeat).toBe(true);
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
