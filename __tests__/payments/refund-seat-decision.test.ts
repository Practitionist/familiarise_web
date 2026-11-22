/**
 * @jest-environment node
 */

/**
 * A booking refund decides whether it ends the seat once, as its row settles SUCCEEDED, from the
 * seat intent its reservation stored, counting only SUCCEEDED refunds and lost chargebacks as
 * returned. A PENDING refund never ends a seat; a replay applies nothing of its own.
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
  /** The gateway's answer: its refund id and settlement status. */
  gatewayAnswer: { refundId: "", status: "PENDING" },
};
const live = () =>
  mockState.refunds.filter((r) => ["SUCCEEDED", "PENDING"].includes(r.status));
/** The ₹500 card payment as the settle hook reads it. */
const paymentRow = () => ({
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
  refundOwedKey: null,
  refunds: mockState.refunds.map((r) => ({
    amountPaise: r.amountPaise,
    status: r.status,
  })),
  disputes: [{ amountPaise: mockState.chargedBackPaise, status: "LOST" }],
});

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyRefundRequested: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments", () => ({
  createRefund: jest.fn(async () => {
    mockState.atGateway?.();
    return { amount: 0, currency: "INR", ...mockState.gatewayAnswer };
  }),
}));
const mockStampSeat = jest.fn(async (..._a: unknown[]) => 1);
jest.mock("../../lib/booking/participants", () => ({
  ...jest.requireActual("../../lib/booking/participants"),
  transitionParticipant: (...a: unknown[]) => mockStampSeat(...a),
}));
const mockIntentInTx = jest.fn(
  async (_tx: unknown, _intent: { refundId: string; payerUserId: string }) =>
    new Date("2026-11-22T10:00:00Z"),
);
jest.mock("../../lib/stream/revocation-intents", () => ({
  persistRefundRevocationInTx: (
    tx: unknown,
    intent: { refundId: string; payerUserId: string },
  ) => mockIntentInTx(tx, intent),
}));
const mockRevoke = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../../lib/stream/access-revocation", () => ({
  revokeRefundedSeatAccess: (...a: unknown[]) => mockRevoke(...a),
}));
jest.mock("../../lib/email", () => ({
  ...jest.requireActual("../../lib/email"),
  prepareRefundProcessedEmail: jest.fn(async () => null),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    user: { findMany: async () => [] },
    payment: { findUnique: async () => paymentRow() },
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
        where: { id?: string; dedupeKey?: string; refundId?: string };
      }) => {
        const row = mockState.refunds.find((r) =>
          where.id
            ? r.id === where.id
            : where.refundId
              ? r.refundId === where.refundId
              : r.dedupeKey === where.dedupeKey,
        );
        return row ? { ...row, payment: paymentRow() } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
        mockState.refunds.find((r) => r.id === where.id),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<RefundRow>;
      }) => {
        const row = mockState.refunds.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      deleteMany: async ({
        where,
      }: {
        where: { id: string; status: string };
      }) => {
        const before = mockState.refunds.length;
        mockState.refunds = mockState.refunds.filter(
          (r) => !(r.id === where.id && r.status === where.status),
        );
        return { count: before - mockState.refunds.length };
      },
      findMany: async () => live(),
      create: async ({ data }: { data: Omit<RefundRow, "id"> }) => {
        const row = { ...data, id: `refund-${mockState.refunds.length + 1}` };
        mockState.refunds.push(row);
        return row;
      },
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
        // Refund.refundId is unique.
        if (
          data.refundId &&
          mockState.refunds.some(
            (r) => r.refundId === data.refundId && !rows.includes(r),
          )
        ) {
          const { Prisma } = jest.requireActual("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      },
    },
    supportFinancialRecommendation: { updateMany: async () => ({ count: 0 }) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { __esModule: true, default: db };
});

import { refundPayment } from "../../lib/payments/operations/refund";
import { refundBookingPayment } from "../../lib/payments/operations/booking-refund";
import {
  seatIntentOf,
  settleRefundSeatTx,
} from "../../lib/payments/operations/refund-seat";
import prisma, { type Tx } from "../../lib/prisma";

beforeEach(() => {
  jest.clearAllMocks();
  mockState.refunds = [];
  mockState.chargedBackPaise = 0;
  mockState.atGateway = null;
  mockState.gatewayAnswer = { refundId: "", status: "PENDING" };
});

/** A refund row as its reservation wrote it, PENDING at the gateway. */
const reserved = (
  id: string,
  amountPaise: number,
  intent: Parameters<typeof seatIntentOf>[0],
): RefundRow => {
  const row = {
    id,
    paymentId: "pay-1",
    amountPaise,
    status: "PENDING",
    dedupeKey: `ops:${id}`,
    refundId: `rfnd_${id}`,
    metadata: { source: "app", seatIntent: seatIntentOf(intent) },
  };
  mockState.refunds.push(row);
  return row;
};
const row = (id: string) => mockState.refunds.find((r) => r.id === id);

/** A settle path (live, webhook, reconcile): the PENDING→SUCCEEDED CAS, then the hook in its transaction. */
const settle = (id: string) =>
  prisma.$transaction(async (tx: Tx) => {
    const flipped = await tx.refund.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "SUCCEEDED" },
    });
    return {
      tx,
      seat: flipped.count === 1 ? await settleRefundSeatTx(tx, id) : null,
    };
  });

it("an ambiguous gateway error keeps the intent on the PENDING row; a replay touches nothing, and the later settle ends the seat", async () => {
  mockState.atGateway = () => {
    throw new Error("socket hang up");
  };
  await expect(
    refundPayment({
      paymentId: "pay-1",
      reason: "cancellation",
      dedupeKey: "cancel:k",
      bookingSeat: true,
    }),
  ).rejects.toMatchObject({ code: "GATEWAY_REFUND_FAILED" });
  const own = mockState.refunds[0];
  expect(own).toMatchObject({ status: "PENDING" });
  expect(own?.metadata).toMatchObject({
    seatIntent: {
      keepSeat: false,
      keepSeatIfPartial: false,
    },
  });
  expect(own?.metadata).not.toHaveProperty("endsSeat");

  mockState.atGateway = null;
  await expect(
    refundBookingPayment({
      paymentId: "pay-1",
      reason: "cancellation",
      dedupeKey: "cancel:k",
    }),
  ).resolves.toMatchObject({ refundId: own?.id, status: "PENDING" });
  expect(mockStampSeat).not.toHaveBeenCalled();
  expect(mockIntentInTx).not.toHaveBeenCalled();

  // The webhook settles it: the decision, the stamp and the revocation intent share its transaction.
  const { tx, seat } = await settle(own?.id ?? "");
  expect(seat?.endsSeat).toBe(true);
  expect(own?.metadata).toMatchObject({ endsSeat: true });
  expect(mockStampSeat).toHaveBeenCalledWith(
    tx,
    { paymentId: "pay-1" },
    "REFUNDED",
    { history: { reason: "refunded", actorUserId: null } },
  );
  expect(mockIntentInTx).toHaveBeenCalledWith(tx, {
    refundId: own?.id,
    payerUserId: "buyer-1",
  });
});

it.each<[string, "SUCCEEDED" | "FAILED", boolean]>([
  ["its settle ends the seat", "SUCCEEDED", true],
  ["the seat stays kept", "FAILED", false],
])(
  "a ₹100 partial that settles while a ₹400 refund is PENDING keeps the seat; if the ₹400 then %s",
  async (_case, outcome, ends) => {
    reserved("r-400", 40_000, { keepSeatIfPartial: true });
    reserved("r-100", 10_000, { keepSeatIfPartial: true });

    expect((await settle("r-100")).seat?.endsSeat).toBe(false);
    expect(row("r-100")?.metadata).toMatchObject({ endsSeat: false });
    expect(mockStampSeat).not.toHaveBeenCalled();

    // A FAILED ₹400 has nothing left to settle; a SUCCEEDED one settles and decides.
    const other = row("r-400");
    if (other && outcome === "FAILED") other.status = "FAILED";
    expect((await settle("r-400")).seat?.endsSeat ?? false).toBe(ends);
    expect(mockStampSeat).toHaveBeenCalledTimes(ends ? 1 : 0);
    expect(mockIntentInTx).toHaveBeenCalledTimes(ends ? 1 : 0);
  },
);

it("counts a lost chargeback toward the returned total", async () => {
  mockState.chargedBackPaise = 40_000;
  reserved("r-100", 10_000, { keepSeatIfPartial: true });

  expect((await settle("r-100")).seat?.endsSeat).toBe(true);
});

it("a keepSeat refund of the whole payment keeps the seat when it settles", async () => {
  reserved("r-500", 50_000, { keepSeat: true });

  expect((await settle("r-500")).seat?.endsSeat).toBe(false);
  expect(row("r-500")?.metadata).toMatchObject({ endsSeat: false });
  expect(mockStampSeat).not.toHaveBeenCalled();
});

it("a refund no booking door asked for stores no intent and leaves the seat alone", async () => {
  await refundPayment({ paymentId: "pay-1", reason: "capture mismatch" });
  const own = mockState.refunds[0];
  expect(own?.metadata).not.toHaveProperty("seatIntent");

  expect((await settle(own?.id ?? "")).seat).toEqual({
    endsSeat: false,
    revocationGeneration: null,
  });
  expect(own?.metadata).not.toHaveProperty("endsSeat");
  expect(mockStampSeat).not.toHaveBeenCalled();
});

it("a stored decision is answered as is, and nothing is applied again", async () => {
  reserved("r-500", 50_000, {});
  await settle("r-500");
  jest.clearAllMocks();

  await expect(
    prisma.$transaction((tx: Tx) => settleRefundSeatTx(tx, "r-500")),
  ).resolves.toEqual({ endsSeat: true, revocationGeneration: null });
  expect(mockStampSeat).not.toHaveBeenCalled();
  expect(mockIntentInTx).not.toHaveBeenCalled();
});

it("a ₹100 partial that kept the seat replays without an amount and keeps it", async () => {
  reserved("r-100", 10_000, { keepSeatIfPartial: true });
  await settle("r-100");

  await expect(
    refundBookingPayment({
      paymentId: "pay-1",
      reason: "ops refund: goodwill",
      dedupeKey: "ops:r-100",
      keepSeatIfPartial: true,
    }),
  ).resolves.toMatchObject({ refundId: "r-100", amountRefundedPaise: 10_000 });
  expect(mockState.refunds).toHaveLength(1);
  expect(mockStampSeat).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
});

it("a webhook row that settled before our bind inherits the reservation's intent and decides the seat in the adoption", async () => {
  // Razorpay's webhook recorded the refund as SUCCEEDED, with no intent, before our bind landed.
  mockState.gatewayAnswer = { refundId: "rfnd_web", status: "SUCCEEDED" };
  mockState.atGateway = () => {
    mockState.refunds.push({
      id: "refund-web",
      paymentId: "pay-1",
      amountPaise: 50_000,
      status: "SUCCEEDED",
      dedupeKey: null,
      refundId: "rfnd_web",
      metadata: {},
    });
  };

  const refund = await refundPayment({
    paymentId: "pay-1",
    reason: "cancellation",
    dedupeKey: "cancel:k",
    bookingSeat: true,
  });

  expect(mockState.refunds.map((r) => r.id)).toEqual(["refund-web"]);
  expect(row("refund-web")).toMatchObject({
    dedupeKey: "cancel:k",
    metadata: expect.objectContaining({
      seatIntent: {
        keepSeat: false,
        keepSeatIfPartial: false,
      },
      endsSeat: true,
    }),
  });
  expect(mockStampSeat).toHaveBeenCalledTimes(1);
  expect(mockIntentInTx).toHaveBeenCalledWith(expect.anything(), {
    refundId: "refund-web",
    payerUserId: "buyer-1",
  });
  // The booking door drives the revocation the adoption wrote.
  expect(refund).toMatchObject({
    refundId: "refund-web",
    endsSeat: true,
    revocationGeneration: new Date("2026-11-22T10:00:00Z"),
  });
});

it.each<[string, "SUCCEEDED" | "FAILED", boolean]>([
  ["its settle ends the seat", "SUCCEEDED", true],
  ["the seat stays kept", "FAILED", false],
])(
  "an Ops Full refund that sends the ₹100 left beside a PENDING ₹400 keeps the seat; if the ₹400 then %s",
  async (_case, outcome, ends) => {
    reserved("r-400", 40_000, { keepSeatIfPartial: true });
    // Full: no amount named, so the reservation sent what the PENDING ₹400 left.
    reserved("r-full", 10_000, { keepSeatIfPartial: true });

    expect((await settle("r-full")).seat?.endsSeat).toBe(false);
    expect(mockStampSeat).not.toHaveBeenCalled();

    const other = row("r-400");
    if (other && outcome === "FAILED") other.status = "FAILED";
    expect((await settle("r-400")).seat?.endsSeat ?? false).toBe(ends);
    expect(mockStampSeat).toHaveBeenCalledTimes(ends ? 1 : 0);
  },
);
