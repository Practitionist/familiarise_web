/**
 * @jest-environment node
 */

/**
 * #1584 P1-CR03 — reconcile-disputes wrote `dispute.update({ where: { disputeId } })`
 * unconditionally, so a `dispute.lost` webhook landing between the fetch and
 * the write was overwritten by the stale gateway snapshot. Every write is now
 * `updateMany` predicated on the status the loop read, and a miss is skipped.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
}));
const mockGetRazorpayDispute = jest.fn();
jest.mock("../../lib/payments/core/razorpay-disputes", () => ({
  ...jest.requireActual("../../lib/payments/core/razorpay-disputes"),
  getRazorpayDispute: (...a: unknown[]) => mockGetRazorpayDispute(...a),
}));

const updateMany = jest.fn(async ({ where }: { where: { status: string } }) =>
  // The row moved to LOST underneath the run: the CAS on UNDER_REVIEW misses.
  where.status === "UNDER_REVIEW" ? { count: 0 } : { count: 1 },
);
const update = jest.fn();
type FindArgs = { where: { OR?: unknown }; take?: number; orderBy?: unknown };
const row = (disputeId: string, status = "UNDER_REVIEW") => ({
  disputeId,
  status,
  paymentGateway: "RAZORPAY",
  dueBy: null,
  evidence: null,
  payment: { id: "p1", amount: 1000, gatewayPaymentId: "pay_1" },
});
// The second (stale-rotation) query carries the `OR`; the deadline-window query does not.
const findMany = jest.fn(async (args: FindArgs) =>
  args.where.OR ? [row("dp_1")] : [],
);
jest.mock("../../lib/prisma", () => {
  const db = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
    dispute: {
      findMany: (a: FindArgs) => findMany(a),
      updateMany: (...a: unknown[]) => updateMany(...(a as [never])),
      update: (...a: unknown[]) => update(...a),
    },
  };
  return { __esModule: true, default: db };
});

import { reconcileDisputes } from "../../scripts/disputes/reconcile-disputes";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("dispute reconciliation is a CAS on the status it read", () => {
  it("does not overwrite a dispute whose status changed mid-run", async () => {
    mockGetRazorpayDispute.mockResolvedValue({
      paymentId: "pay_1",
      status: "needs_response",
      evidence: {},
      isChargeRefundable: true,
      dueBy: null,
    });

    const result = await reconcileDisputes();

    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      disputeId: "dp_1",
      status: "UNDER_REVIEW",
    });
    // The miss is a skip, not a reconciliation and not an error.
    expect(result.reconciledCount).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe("dispute reconciliation honours the ticker's limit", () => {
  beforeEach(() =>
    mockGetRazorpayDispute.mockResolvedValue({
      paymentId: "pay_1",
      status: "needs_response",
      evidence: {},
      isChargeRefundable: true,
      dueBy: null,
    }),
  );

  it("polls deadline-window rows first and fills the rest from the stale rotation", async () => {
    findMany.mockImplementationOnce(async () => [row("dp_due")]);

    await reconcileDisputes({ limit: 10 });

    const [due, stale] = findMany.mock.calls.map((c) => c[0]);
    expect(due).toMatchObject({
      where: { paymentGateway: "RAZORPAY", dueBy: { lte: expect.any(Date) } },
      orderBy: [{ updatedAt: "asc" }, { dueBy: "asc" }],
      take: 10,
    });
    expect(stale).toMatchObject({
      where: {
        paymentGateway: "RAZORPAY",
        updatedAt: { lt: expect.any(Date) },
      },
      take: 9,
    });
  });

  it("skips the stale query when deadline-window rows fill the limit", async () => {
    findMany.mockImplementationOnce(async () => [row("dp_a"), row("dp_b")]);

    await reconcileDisputes({ limit: 2 });

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("is unbounded without a limit", async () => {
    await reconcileDisputes().catch(() => undefined);

    for (const [args] of findMany.mock.calls) {
      expect(args).not.toHaveProperty("take");
    }
  });
});

describe("a dispute whose poll fails rotates behind the batch", () => {
  it("touches updatedAt under the status CAS and reports the error", async () => {
    mockGetRazorpayDispute.mockRejectedValueOnce(new Error("gateway 502"));

    const result = await reconcileDisputes({ limit: 10 });

    expect(updateMany).toHaveBeenCalledWith({
      where: { disputeId: "dp_1", status: "UNDER_REVIEW" },
      data: { updatedAt: expect.any(Date) },
    });
    expect(result.errors).toEqual(["Dispute dp_1: gateway 502"]);
  });
});
