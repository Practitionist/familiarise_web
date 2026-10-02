/**
 * @jest-environment node
 */

/**
 * Razorpay disputes reconcile by poll (GET /v1/disputes/:id): a LOST adopted
 * by the poll flips status through the CAS and settles through the shared
 * lost-dispute path, an id-less row resolves via the order join, and gateway
 * failures count toward manual review without crashing the loop. Mocks at the
 * getDispute boundary like reconcile-disputes-cas.test.ts.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
}));

const mockGetDispute = jest.fn();
jest.mock("../../lib/payments", () => ({
  getDispute: (...a: unknown[]) => (mockGetDispute as jest.Mock)(...a),
}));

const mockRazorpayPaymentsFetch = jest.fn();
jest.mock("../../lib/payments/core/razorpay", () => ({
  getRazorpayClient: () => ({
    payments: {
      fetch: (...a: unknown[]) =>
        (mockRazorpayPaymentsFetch as jest.Mock)(...a),
    },
  }),
  withRazorpaySdkTimeout: (_op: string, fn: () => unknown) => fn(),
}));

const mockSettleLostDispute = jest.fn();
jest.mock("../../app/api/webhooks/utils", () => ({
  settleLostDispute: (...a: unknown[]) =>
    (mockSettleLostDispute as jest.Mock)(...a),
}));

const mockRecordSystemErrorSafe = jest.fn();
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: (...a: unknown[]) =>
    (mockRecordSystemErrorSafe as jest.Mock)(...a),
}));

interface PaymentRow {
  id: string;
  amount: number;
  gatewayPaymentId: string | null;
  paymentIntent: string;
  gstTcsCollectedPaise: number | null;
}

interface DisputeRow {
  id: string;
  disputeId: string;
  status: string;
  paymentGateway: string;
  dueBy: Date | null;
  updatedAt: Date;
  evidence: Record<string, unknown> | null;
  amountPaise: number;
  isChargeRefundable: boolean;
  paymentId: string;
  payment: PaymentRow | null;
}

interface EarningRow {
  id: string;
  paymentId: string;
  status: string;
}

const store: {
  disputes: DisputeRow[];
  payments: PaymentRow[];
  earnings: EarningRow[];
} = { disputes: [], payments: [], earnings: [] };

const mockDisputeFindMany = jest.fn();
const mockDisputeUpdateMany = jest.fn();
const mockPaymentFindFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    dispute: {
      findMany: (...a: unknown[]) =>
        (mockDisputeFindMany as jest.Mock)(...a),
      updateMany: (...a: unknown[]) =>
        (mockDisputeUpdateMany as jest.Mock)(...a),
    },
    payment: {
      findFirst: (...a: unknown[]) =>
        (mockPaymentFindFirst as jest.Mock)(...a),
    },
    $transaction: (fn: (tx: unknown) => unknown) => fn({}),
  },
}));

import { RazorpayDisputeError } from "../../lib/payments/core/razorpay-disputes";
import { reconcileDisputes } from "../../scripts/disputes/reconcile-disputes";

const STALE = new Date(Date.now() - 48 * 60 * 60 * 1000);

function seedLinkedDispute(overrides?: Partial<DisputeRow>): DisputeRow {
  const payment: PaymentRow = {
    id: "pay_1",
    amount: 10_000,
    gatewayPaymentId: "pay_rzp_1",
    paymentIntent: "order_1",
    gstTcsCollectedPaise: null,
  };
  const dispute: DisputeRow = {
    id: "row_1",
    disputeId: "disp_1",
    status: "NEEDS_RESPONSE",
    paymentGateway: "RAZORPAY",
    dueBy: null,
    updatedAt: STALE,
    evidence: null,
    amountPaise: 10_000,
    isChargeRefundable: true,
    paymentId: payment.id,
    payment,
    ...overrides,
  };
  store.payments = [payment];
  if (overrides?.payment !== undefined) {
    store.payments = overrides.payment ? [overrides.payment] : [];
  }
  store.disputes = [dispute];
  return dispute;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_ENABLED = "true";
  store.disputes = [];
  store.payments = [];
  store.earnings = [];

  mockDisputeFindMany.mockImplementation(async () =>
    store.disputes.filter((d) =>
      [
        "NEEDS_RESPONSE",
        "WARNING_NEEDS_RESPONSE",
        "UNDER_REVIEW",
        "WARNING_UNDER_REVIEW",
      ].includes(d.status),
    ),
  );
  mockDisputeUpdateMany.mockImplementation(
    async (args: {
      where: { disputeId: string; status: string };
      data: Record<string, unknown>;
    }) => {
      const row = store.disputes.find(
        (d) =>
          d.disputeId === args.where.disputeId &&
          d.status === args.where.status,
      );
      if (!row) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    },
  );
  mockPaymentFindFirst.mockImplementation(
    async (args: {
      where: { gatewayPaymentId?: string; paymentIntent?: string };
    }) => {
      if (args.where.gatewayPaymentId) {
        return (
          store.payments.find(
            (p) => p.gatewayPaymentId === args.where.gatewayPaymentId,
          ) ?? null
        );
      }
      if (args.where.paymentIntent) {
        return (
          store.payments.find(
            (p) => p.paymentIntent === args.where.paymentIntent,
          ) ?? null
        );
      }
      return null;
    },
  );
  mockSettleLostDispute.mockImplementation(
    async (_tx: unknown, input: { paymentId: string; disputeId: string }) => {
      for (const e of store.earnings) {
        if (
          e.paymentId === input.paymentId &&
          (e.status === "HELD" || e.status === "PAID")
        ) {
          e.status = "REFUNDED";
        }
      }
      return { consultantClawbackPage: null };
    },
  );
});

describe("razorpay dispute reconcile", () => {
  it("a LOST via poll flips status and settles, and a re-poll is a no-op", async () => {
    seedLinkedDispute();
    store.earnings = [{ id: "ce_1", paymentId: "pay_1", status: "HELD" }];
    mockGetDispute.mockResolvedValue({
      disputeId: "disp_1",
      status: "lost",
      evidence: {},
      isChargeRefundable: false,
      dueBy: undefined,
      paymentId: "pay_rzp_1",
    });

    const first = await reconcileDisputes();

    expect(first.reconciledCount).toBe(1);
    expect(first.errors).toEqual([]);
    expect(store.disputes[0].status).toBe("LOST");
    expect(mockSettleLostDispute).toHaveBeenCalledTimes(1);
    expect(mockSettleLostDispute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ disputeId: "disp_1", paymentId: "pay_1" }),
    );
    expect(store.earnings[0].status).toBe("REFUNDED");
    expect(mockRazorpayPaymentsFetch).not.toHaveBeenCalled();

    const second = await reconcileDisputes();

    expect(second.totalProcessed).toBe(0);
    expect(second.reconciledCount).toBe(0);
    expect(mockSettleLostDispute).toHaveBeenCalledTimes(1);
    expect(second.errors).toEqual([]);
  });

  it("an id-less row resolves through the order join", async () => {
    const payment: PaymentRow = {
      id: "pay_9",
      amount: 5_000,
      gatewayPaymentId: null,
      paymentIntent: "order_9",
      gstTcsCollectedPaise: null,
    };
    store.payments = [payment];
    store.disputes = [
      {
        id: "row_9",
        disputeId: "disp_9",
        status: "NEEDS_RESPONSE",
        paymentGateway: "RAZORPAY",
        dueBy: null,
        updatedAt: STALE,
        evidence: null,
        amountPaise: 5_000,
        isChargeRefundable: true,
        paymentId: payment.id,
        payment,
      },
    ];
    mockGetDispute.mockResolvedValue({
      disputeId: "disp_9",
      status: "lost",
      evidence: {},
      isChargeRefundable: false,
      dueBy: undefined,
      paymentId: "pay_rzp_9",
    });
    mockRazorpayPaymentsFetch.mockResolvedValue({ order_id: "order_9" });

    const result = await reconcileDisputes();

    expect(mockRazorpayPaymentsFetch).toHaveBeenCalledWith("pay_rzp_9");
    expect(store.disputes[0].status).toBe("LOST");
    expect(mockSettleLostDispute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ disputeId: "disp_9", paymentId: "pay_9" }),
    );
    expect(result.errors).toEqual([]);
  });

  it("a gateway throw counts toward manual review without crashing the loop", async () => {
    const paymentB: PaymentRow = {
      id: "pay_b",
      amount: 7_000,
      gatewayPaymentId: "pay_rzp_b",
      paymentIntent: "order_b",
      gstTcsCollectedPaise: null,
    };
    store.payments = [paymentB];
    store.disputes = [
      {
        id: "row_a",
        disputeId: "disp_a",
        status: "NEEDS_RESPONSE",
        paymentGateway: "RAZORPAY",
        dueBy: null,
        updatedAt: STALE,
        evidence: null,
        amountPaise: 3_000,
        isChargeRefundable: true,
        paymentId: "missing",
        payment: null,
      },
      {
        id: "row_b",
        disputeId: "disp_b",
        status: "NEEDS_RESPONSE",
        paymentGateway: "RAZORPAY",
        dueBy: null,
        updatedAt: STALE,
        evidence: null,
        amountPaise: 7_000,
        isChargeRefundable: true,
        paymentId: paymentB.id,
        payment: paymentB,
      },
    ];
    mockGetDispute.mockImplementation(async (disputeId: string) => {
      if (disputeId === "disp_a") throw new Error("gateway timeout");
      return {
        disputeId,
        status: "under_review",
        evidence: {},
        isChargeRefundable: true,
        dueBy: undefined,
        paymentId: "pay_rzp_b",
      };
    });

    const result = await reconcileDisputes();

    expect(result.razorpayManualReviewCount).toBe(1);
    expect(result.errors).toEqual(["Dispute disp_a: gateway timeout"]);
    expect(result.success).toBe(false);
    expect(result.reconciledCount).toBe(1);
    expect(store.disputes[1].status).toBe("UNDER_REVIEW");
  });

  it("an unknown gateway id is flagged for manual review, not retried as an error", async () => {
    seedLinkedDispute();
    mockGetDispute.mockRejectedValue(
      new RazorpayDisputeError(
        "The id provided does not exist",
        "GATEWAY_REFUSED",
        409,
        "BAD_REQUEST_ERROR",
        "input_validation_failed",
      ),
    );

    const result = await reconcileDisputes();

    expect(result.razorpayManualReviewCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(store.disputes[0].status).toBe("NEEDS_RESPONSE");
    expect(store.disputes[0].evidence).toMatchObject({
      reconciliation_note: expect.stringContaining("unknown at Razorpay"),
    });
    expect(mockSettleLostDispute).not.toHaveBeenCalled();
  });
});
