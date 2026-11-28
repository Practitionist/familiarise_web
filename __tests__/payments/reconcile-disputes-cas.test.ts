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
// The discovery pass has its own suite; here it is a quiet pass unless a test says otherwise.
const mockDiscover = jest.fn();
jest.mock("../../lib/payments/discovery/dispute-discovery", () => ({
  discoverGatewayDisputes: (...a: unknown[]) => mockDiscover(...a),
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
import { quietDisputeDiscovery } from "../fixtures/quiet-discovery";

beforeEach(() => {
  jest.clearAllMocks();
  mockDiscover.mockResolvedValue(quietDisputeDiscovery());
});

describe("the poll leaves discovery its share of the run", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stops starting polls at half the run's start budget, leaves the rest untouched for the next run, and discovery still starts in time", async () => {
    const startedAt = 1_800_000_000_000;
    let clock = startedAt;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    findMany
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [
        row("dp_1"),
        row("dp_2"),
        row("dp_3"),
      ]);
    // Each poll of the gateway takes nine seconds.
    mockGetRazorpayDispute.mockImplementation(async () => {
      clock += 9_000;
      return {
        paymentId: "pay_1",
        status: "under_review",
        evidence: {},
        isChargeRefundable: true,
        dueBy: null,
      };
    });

    const result = await reconcileDisputes({ limit: 10, startedAt });

    expect(mockGetRazorpayDispute.mock.calls.map((c) => c[0])).toEqual([
      "dp_1",
    ]);
    expect(result.totalProcessed).toBe(1);
    const touched = updateMany.mock.calls.map(
      ([args]) => (args as { where: { disputeId?: string } }).where.disputeId,
    );
    expect(touched).toEqual(["dp_1"]);
    const outOfTime = mockDiscover.mock.calls[0][0] as () => boolean;
    expect(outOfTime()).toBe(false);
  });
});

describe("the discovery pass runs after the poll", () => {
  it("returns the pass's counts, keeps its position as the run's checkpoint, and fails the run on its errors", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDiscover.mockResolvedValue({
      ...quietDisputeDiscovery(),
      listed: 2,
      imported: 1,
      alreadyKnown: 1,
      errors: ["Dispute disp_bad: could not serialize access"],
      stoppedShort: { bound: "deadline", pagesHandled: 0 },
      checkpoint: '{"skip":0,"cutRuns":1}',
    });

    const startedAt = Date.now();
    const result = await reconcileDisputes({ limit: 10, startedAt });

    expect(result.discovery).toEqual({
      listed: 2,
      imported: 1,
      alreadyKnown: 1,
      updated: 0,
      notAdopted: 0,
      unknownPayment: 0,
      stoppedShort: { bound: "deadline", pagesHandled: 0 },
    });
    expect(result.checkpoint).toBe('{"skip":0,"cutRuns":1}');
    expect(result.errors).toEqual([
      "Dispute disp_bad: could not serialize access",
    ]);
    expect(result.success).toBe(false);

    // The pass stops starting hand-overs at the run's start deadline.
    const outOfTime = mockDiscover.mock.calls[0][0] as () => boolean;
    expect(outOfTime()).toBe(false);
    jest.spyOn(Date, "now").mockReturnValue(startedAt + 16_000);
    expect(outOfTime()).toBe(true);
    jest.restoreAllMocks();
  });

  it("a pass that throws is one error and records no checkpoint, so the stored position stands", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDiscover.mockRejectedValue(new Error("connection terminated"));

    const result = await reconcileDisputes({ limit: 10 });

    expect(result.discovery).toBeNull();
    expect(result).not.toHaveProperty("checkpoint");
    expect(result.errors).toEqual(["Dispute discovery: connection terminated"]);
  });
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

  it("skips the stale query when deadline-window rows fill a limit of one", async () => {
    findMany.mockImplementationOnce(async () => [row("dp_a")]);

    await reconcileDisputes({ limit: 1 });

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("reserves room for a null-dueBy row when deadline-window rows exceed the limit", async () => {
    findMany
      .mockImplementationOnce(async (args: FindArgs) =>
        Array.from({ length: args.take ?? 0 }, (_, i) => row(`dp_due${i}`)),
      )
      .mockImplementationOnce(async () => [row("dp_null")]);

    await reconcileDisputes({ limit: 3 });

    expect(findMany.mock.calls[1]?.[0]).toMatchObject({ take: 1 });
    const polled = mockGetRazorpayDispute.mock.calls.map((c) => c[0]);
    expect(polled).toHaveLength(3);
    expect(polled).toContain("dp_null");
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
