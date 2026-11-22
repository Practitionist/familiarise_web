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
  /** A concurrent decision that commits between this one's read and its write. */
  raceDecision: null as null | boolean,
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
const mockStampSeat = jest.fn(async (..._a: unknown[]) => 1);
jest.mock("../../lib/booking/participants", () => ({
  ...jest.requireActual("../../lib/booking/participants"),
  transitionParticipant: (...a: unknown[]) => mockStampSeat(...a),
}));
const mockRevoke = jest.fn(async (..._a: unknown[]) => undefined);
/** Stands in for the revocation-intent table: an intent written in a transaction records its refund. */
const mockIntentInTx = jest.fn(
  async (_tx: unknown, _intent: { refundId: string }) =>
    new Date("2026-11-22T10:00:00Z"),
);
jest.mock("../../lib/stream/access-revocation", () => ({
  persistRefundRevocation: (...a: unknown[]) => mockRevoke(...a),
  revokeRefundedSeatAccess: (...a: unknown[]) => mockRevoke(...a),
  persistRefundRevocationInTx: (tx: unknown, intent: { refundId: string }) =>
    mockIntentInTx(tx, intent),
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
      // Filters by id and status, so a row a webhook already settled leaves the settle claim nothing to flip.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; status?: string };
        data: Partial<RefundRow>;
      }) => {
        const rows = mockState.refunds.filter(
          (r) =>
            (!where.id || r.id === where.id) &&
            (!where.status || r.status === where.status),
        );
        if (mockState.raceDecision !== null && data.metadata) {
          // The other transaction stored its decision first, so this conditional write matches nothing.
          for (const r of rows)
            r.metadata = { ...r.metadata, endsSeat: mockState.raceDecision };
          mockState.raceDecision = null;
          return { count: 0 };
        }
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      },
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
import { refundBookingPayment } from "../../lib/payments/operations/booking-refund";
import { decideRefundSeatTx } from "../../lib/payments/operations/refund-seat";
import prisma from "../../lib/prisma";

beforeEach(() => {
  mockStampSeat.mockClear();
  mockRevoke.mockClear();
  mockIntentInTx.mockClear();
  mockState.raceDecision = null;
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

it("a replay while the refund is at the gateway answers it as in flight, and the finalisation replaces the marker", async () => {
  let inFlight: unknown = null;
  let reserved: unknown = null;
  // The replay omits keepSeat; it reads the reserved row before the gateway answers.
  mockState.atGateway = () => {
    reserved = { ...mockState.refunds[0]?.metadata };
    inFlight = refundPayment({
      paymentId: "pay-1",
      reason: "support refund",
      dedupeKey: "case-recommendation:rec-1",
    });
  };
  const original = await refundPayment({
    paymentId: "pay-1",
    reason: "support refund",
    dedupeKey: "case-recommendation:rec-1",
    keepSeat: true,
  });

  expect(reserved).toMatchObject({ seatDecision: "pending" });

  expect(await inFlight).toMatchObject({
    refundId: original.refundId,
    seatPending: true,
  });
  expect(await inFlight).not.toHaveProperty("endsSeat");
  expect(original.endsSeat).toBe(false);
  expect(mockState.refunds[0]?.metadata).toMatchObject({ endsSeat: false });
  expect(mockState.refunds[0]?.metadata).not.toHaveProperty("seatDecision");
});

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

it("an ambiguous gateway error keeps the first request's intent, so a replay without keepSeat keeps the seat", async () => {
  // Support's full ₹500 refund keeps the seat; the gateway call then drops with no answer.
  mockState.atGateway = () => {
    throw new Error("socket hang up");
  };
  await expect(
    refundPayment({
      paymentId: "pay-1",
      reason: "support refund",
      dedupeKey: "case-recommendation:rec-1",
      keepSeat: true,
    }),
  ).rejects.toMatchObject({ code: "GATEWAY_REFUND_FAILED" });
  expect(mockState.refunds[0]).toMatchObject({ status: "PENDING" });
  expect(mockState.refunds[0]?.metadata).toMatchObject({
    seatIntent: {
      keepSeat: true,
      keepSeatIfPartial: false,
      amountNamed: false,
    },
  });
  expect(mockState.refunds[0]?.metadata).not.toHaveProperty("seatDecision");

  mockState.atGateway = null;
  const replay = await refundBookingPayment({
    paymentId: "pay-1",
    reason: "support refund",
    dedupeKey: "case-recommendation:rec-1",
  });

  expect(replay).toMatchObject({ refundId: mockState.refunds[0]?.id });
  expect(mockStampSeat).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockState.refunds[0]?.metadata).toMatchObject({ endsSeat: false });
});

it("decides from the row's stored intent, never the deciding caller's", async () => {
  mockState.refunds.push({
    id: "refund-1",
    paymentId: "pay-1",
    amountPaise: 50_000,
    status: "SUCCEEDED",
    dedupeKey: "k",
    refundId: "rfnd_1",
    metadata: {
      seatIntent: {
        keepSeat: true,
        keepSeatIfPartial: false,
        amountNamed: false,
      },
    },
  });
  const decided = await prisma.$transaction((tx) =>
    decideRefundSeatTx(tx, {
      refundRowId: "refund-1",
      paymentId: "pay-1",
      paymentPaise: 50_000,
      intent: { keepSeat: false, keepSeatIfPartial: false, amountNamed: false },
    }),
  );

  expect(decided.endsSeat).toBe(false);
});

it("a FAILED refund stores no decision and keeps the seat", async () => {
  const metadata = {
    seatIntent: {
      keepSeat: false,
      keepSeatIfPartial: false,
      amountNamed: false,
    },
  };
  mockState.refunds.push({
    id: "refund-1",
    paymentId: "pay-1",
    amountPaise: 50_000,
    status: "FAILED",
    dedupeKey: null,
    refundId: "rfnd_1",
    metadata,
  });

  const decided = await prisma.$transaction((tx) =>
    decideRefundSeatTx(tx, {
      refundRowId: "refund-1",
      paymentId: "pay-1",
      paymentPaise: 50_000,
    }),
  );

  expect(decided.endsSeat).toBe(false);
  expect(mockState.refunds[0]?.metadata).toEqual(metadata);
});

it("a decision another transaction stored first wins, and this one writes nothing of its own", async () => {
  const intent = {
    keepSeat: false,
    keepSeatIfPartial: false,
    amountNamed: false,
  };
  mockState.refunds.push({
    id: "refund-1",
    paymentId: "pay-1",
    amountPaise: 50_000,
    status: "SUCCEEDED",
    dedupeKey: null,
    refundId: "rfnd_1",
    metadata: { seatDecision: "pending", seatIntent: intent },
  });
  mockState.raceDecision = false;

  const decided = await prisma.$transaction((tx) =>
    decideRefundSeatTx(tx, {
      refundRowId: "refund-1",
      paymentId: "pay-1",
      paymentPaise: 50_000,
      persistRevocation: async () => new Date(),
    }),
  );

  // This read would end the seat; the stored winner keeps it.
  expect(decided).toEqual({ endsSeat: false, revocationGeneration: null });
  expect(mockState.refunds[0]?.metadata).toMatchObject({ endsSeat: false });
});

it("the live path writes the seat-ending decision's revocation intent in the deciding transaction", async () => {
  const refund = await refundBookingPayment({
    paymentId: "pay-1",
    reason: "cancellation",
    dedupeKey: "cancel:k",
  });

  expect(mockIntentInTx).toHaveBeenCalledWith(expect.anything(), {
    refundId: refund.refundId,
    payerUserId: "buyer-1",
  });
  expect(mockState.refunds[0]?.metadata).toMatchObject({ endsSeat: true });
  // Only the Stream drive runs after commit; no second intent write.
  expect(mockRevoke).toHaveBeenCalledTimes(1);
  expect(mockRevoke).toHaveBeenCalledWith(
    { refundId: refund.refundId, payerUserId: "buyer-1" },
    new Date("2026-11-22T10:00:00Z"),
  );
});
