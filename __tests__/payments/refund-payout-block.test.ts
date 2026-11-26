/**
 * @jest-environment node
 */

/**
 * #1020 sibling — refund guard at disbursement. A payout whose earnings sit on
 * a payment with an IN-FLIGHT (PENDING) or SUCCEEDED-BUT-UNCASCADED refund must
 * never reach the gateway: same pre-claim reject shape as the dispute guard
 * above it, and for a stronger reason, because a refund has no earnable HELD
 * status to fall back on.
 *
 * The state is reachable: reconcile-pending-refunds.ts settles a refund at the
 * 1h RECONCILIATION_THRESHOLD_MS without running the cascade, so until the
 * 15-minute cascade-refund-earnings backstop stamps `cascadedAt` the earning
 * reads READY with refundedShareAmount = 0 on an already-refunded booking.
 *
 * Unlike dispute-payout-block.test.ts, the two guards share one
 * `consultantEarnings.findFirst` mock, so this file dispatches on the predicate
 * the implementation actually emits and EVALUATES it against fixture refund
 * rows. The FAILED / cascaded-SUCCEEDED exemptions are therefore asserted as
 * behaviour, not as whatever the mock was told to return.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      groupBy: async () => [],
    },
    consultantEarnings: {
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({
        _sum: {
          consultantSharePaise: 500000,
          grossAmount: null,
          refundedShareAmount: null,
        },
      }),
    },
    consultantTaxInfo: { findUnique: jest.fn().mockResolvedValue(null) },
    ledgerTransaction: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  isMockRedis: jest.fn().mockReturnValue(false),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
  isRedisCircuitOpen: jest.fn().mockReturnValue(false),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  getCurrentFYCumulativePayments: jest.fn().mockResolvedValue(0),
  getFYDateRange: jest.fn().mockReturnValue({
    start: new Date("2026-04-01T00:00:00+05:30"),
    end: new Date("2027-04-01T00:00:00+05:30"),
  }),
  getIndianFinancialYear: jest.fn().mockReturnValue("2026-27"),
  recordTDSDeduction: jest.fn(),
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
}));

import { RefundStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { processApprovedPayouts } from "../../lib/payments/payouts/payout-service";
import { matchesWhere } from "../fixtures/mem-db";

/** The Prisma surface processApprovedPayouts touches in these tests. */
interface PayoutPrismaMock {
  consultantPayout: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
  };
  consultantEarnings: {
    updateMany: jest.Mock;
    findFirst: jest.Mock;
    aggregate: jest.Mock;
  };
  consultantTaxInfo: { findUnique: jest.Mock };
}

// One seam over the generated client (repo-wide mock idiom): everything
// downstream reads the fully-typed PayoutPrismaMock.
const mocks = prisma as unknown as PayoutPrismaMock;

/** Swap the global fetch for a mock WITHOUT any-casting through globals. */
function stubGlobalFetch(mock: jest.Mock): void {
  Object.defineProperty(globalThis, "fetch", {
    value: mock,
    configurable: true,
    writable: true,
  });
}

const APPROVED = {
  id: "po_1",
  consultantProfileId: "cprof_1",
  amount: 500000,
  currency: "INR",
  provider: "RAZORPAY",
  method: "BANK_TRANSFER",
  idempotencyKey: null,
  retryCount: 0,
  payoutAccount: {
    razorpayFundAccId: "fa_x",
    accountType: "BANK_ACCOUNT",
    isVerified: true,
    payoutsFrozenAt: null,
  },
  consultantProfile: {
    user: { name: "Priya", email: "p@x.com" },
  },
};

type RefundRow = {
  status: RefundStatus;
  cascadedAt: Date | null;
  /** Defaults to a cash refund; a credit restoration is 0. */
  amountPaise?: number;
};

/**
 * Evaluates the guard's own payment predicate against one fixture payment, so
 * the exemptions are pinned against what the source really emits, whatever its
 * shape. A refund row defaults to a cash refund.
 */
function stubEarnings(
  refunds: RefundRow[],
  refundOwedKey: string | null = null,
): void {
  const payment = {
    refunds: refunds.map((row) => ({ amountPaise: 100, ...row })),
    disputes: [], // no live dispute in any case here
    refundOwedKey,
  };
  mocks.consultantEarnings.findFirst.mockImplementation(
    (args: { where: { payment?: Record<string, unknown> } }) =>
      args?.where?.payment && matchesWhere(payment, args.where.payment)
        ? { id: "ce_refund_blocked" }
        : null,
  );
}

type RefundClause = { refunds?: { some: Record<string, unknown> } };
type GuardCall = {
  where: {
    payoutId?: string;
    payment?: RefundClause & { OR?: RefundClause[] };
  };
  select?: unknown;
};

/** The guard call that carries a `refunds.some` filter, alone or inside an `OR`. */
function refundGuardCall(): GuardCall | undefined {
  return mocks.consultantEarnings.findFirst.mock.calls
    .map(([arg]: [GuardCall]) => arg)
    .find((arg: GuardCall) => refundClauseOf(arg) !== undefined);
}

function refundClauseOf(arg: GuardCall): RefundClause | undefined {
  const payment = arg?.where?.payment;
  return [payment, ...(payment?.OR ?? [])].find((c) => !!c?.refunds);
}

/** The `refunds.some` filter the guard actually sent, or undefined. */
function refundFilterSent(): Record<string, unknown> | undefined {
  const call = refundGuardCall();
  return call ? refundClauseOf(call)?.refunds?.some : undefined;
}

let gatewayFetch: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAZORPAY_KEY_ID = "k";
  process.env.RAZORPAY_SECRET = "s";
  process.env.RAZORPAYX_KEY_SECRET = "x";
  process.env.RAZORPAYX_ACCOUNT_NUMBER = "acc";
  // Same env + fetch stub as dispute-payout-block.test.ts: the RazorpayX
  // client goes through global fetch.
  gatewayFetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "pout_x" }) });
  stubGlobalFetch(gatewayFetch);
  mocks.consultantTaxInfo.findUnique.mockResolvedValue(null);
  mocks.consultantPayout.updateMany.mockResolvedValue({ count: 1 });
  mocks.consultantEarnings.updateMany.mockResolvedValue({ count: 0 });
  mocks.consultantEarnings.aggregate.mockResolvedValue({
    _sum: {
      consultantSharePaise: 500000,
      grossAmount: null,
      refundedShareAmount: null,
    },
  });
  mocks.consultantPayout.findMany.mockResolvedValue([APPROVED]);
});

describe("consultant rail — uncascaded-refund disbursement block", () => {
  it("a PENDING refund blocks submission BEFORE the CAS claim or any gateway call", async () => {
    stubEarnings([{ status: RefundStatus.PENDING, cascadedAt: null }]);

    const results = await processApprovedPayouts();

    // Guard fires pre-claim: no APPROVED→PROCESSING write, no gateway fetch.
    expect(mocks.consultantPayout.updateMany).not.toHaveBeenCalled();
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ success: false, skipped: true });
    // Earnings stay linked + BATCHED — the cascade lands, then the normal
    // batch/release flow resumes.
    expect(mocks.consultantEarnings.updateMany).not.toHaveBeenCalled();
  });

  it("a SUCCEEDED refund whose cascade has NOT run blocks the same way", async () => {
    // The state reconcile-pending-refunds.ts leaves behind: settled at the 1h
    // threshold, cascade-refund-earnings has not stamped `cascadedAt` yet.
    stubEarnings([{ status: RefundStatus.SUCCEEDED, cascadedAt: null }]);

    const results = await processApprovedPayouts();

    expect(mocks.consultantPayout.updateMany).not.toHaveBeenCalled();
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ success: false, skipped: true });
  });

  it("a FAILED refund does NOT block — the gateway never returned the money", async () => {
    stubEarnings([{ status: RefundStatus.FAILED, cascadedAt: null }]);

    await processApprovedPayouts();

    expect(mocks.consultantPayout.updateMany).toHaveBeenCalled();
    expect(gatewayFetch).toHaveBeenCalled();
  });

  it("a CANCELLED refund does NOT block either", async () => {
    stubEarnings([{ status: RefundStatus.CANCELLED, cascadedAt: null }]);

    await processApprovedPayouts();

    expect(mocks.consultantPayout.updateMany).toHaveBeenCalled();
    expect(gatewayFetch).toHaveBeenCalled();
  });

  it("a SUCCEEDED refund whose cascade HAS run does NOT block", async () => {
    // The share is already deducted from the earning, so paying it is correct.
    stubEarnings([
      { status: RefundStatus.SUCCEEDED, cascadedAt: new Date("2026-09-01") },
    ]);

    await processApprovedPayouts();

    expect(mocks.consultantPayout.updateMany).toHaveBeenCalled();
    expect(gatewayFetch).toHaveBeenCalled();
  });

  it("a credit-restoration row (SUCCEEDED, never cascaded) does NOT block", async () => {
    stubEarnings([
      { status: RefundStatus.SUCCEEDED, cascadedAt: null, amountPaise: 0 },
    ]);

    await processApprovedPayouts();

    expect(mocks.consultantPayout.updateMany).toHaveBeenCalled();
    expect(gatewayFetch).toHaveBeenCalled();
  });

  it("a mixed set blocks if ANY refund is still in flight", async () => {
    stubEarnings([
      { status: RefundStatus.FAILED, cascadedAt: null },
      { status: RefundStatus.SUCCEEDED, cascadedAt: new Date("2026-09-01") },
      { status: RefundStatus.PENDING, cascadedAt: null },
    ]);

    const results = await processApprovedPayouts();

    expect(mocks.consultantPayout.updateMany).not.toHaveBeenCalled();
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ success: false, skipped: true });
  });

  it("no refunds at all does NOT block", async () => {
    stubEarnings([]);

    await processApprovedPayouts();

    expect(mocks.consultantPayout.updateMany).toHaveBeenCalled();
    expect(gatewayFetch).toHaveBeenCalled();
  });

  it("an owed-refund marker with no refund row blocks the same way", async () => {
    stubEarnings([], "cancel:appt_1");

    const results = await processApprovedPayouts();

    expect(mocks.consultantPayout.updateMany).not.toHaveBeenCalled();
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ success: false, skipped: true });
    expect(mocks.consultantEarnings.updateMany).not.toHaveBeenCalled();
  });
});

describe("consultant rail — payout.amount vs what its earnings still owe", () => {
  it("a refund cascaded onto a BATCHED earning after batching fails the payout and releases BATCHED earnings back to READY", async () => {
    stubEarnings([
      { status: RefundStatus.SUCCEEDED, cascadedAt: new Date("2026-09-01") },
    ]);
    // Batched at 500000; a post-batch cascade lowered the owed amount by 1000.
    mocks.consultantEarnings.aggregate.mockResolvedValue({
      _sum: { consultantSharePaise: 500000, refundedShareAmount: 1000 },
    });

    const results = await processApprovedPayouts();

    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(mocks.consultantPayout.updateMany).toHaveBeenCalledWith({
      where: { id: "po_1", status: "APPROVED" },
      data: expect.objectContaining({
        status: "FAILED",
        failureReason: expect.stringContaining(
          "SHORTFALL_BEFORE_DISBURSEMENT:",
        ),
        tdsDeducted: 0,
        netAmount: null,
      }),
    });
    expect(mocks.consultantEarnings.updateMany).toHaveBeenCalledWith({
      where: { payoutId: "po_1", status: "BATCHED" },
      data: {
        payoutId: null,
        status: "READY",
        releasedFromPayoutId: "po_1",
      },
    });
    expect(results[0]).toMatchObject({
      success: false,
      error: expect.stringContaining("SHORTFALL_BEFORE_DISBURSEMENT:"),
    });
  });
});

describe("the guard's predicate is scoped to the earnings in this payout", () => {
  beforeEach(() => {
    stubEarnings([]);
  });

  it("scopes the lookup to the earnings already linked to this payout", async () => {
    await processApprovedPayouts();

    const call = mocks.consultantEarnings.findFirst.mock.calls.find(
      ([arg]: [{ where: { payoutId?: string } }]) =>
        arg.where.payoutId === "po_1",
    );
    expect(call).toBeDefined();
    expect(call![0].where.payoutId).toBe("po_1");
  });

  it("asks for id only — a cheap existence probe, like the dispute guard", async () => {
    await processApprovedPayouts();

    const call = refundGuardCall();
    expect(call).toBeDefined();
    expect(call!.select).toEqual({ id: true });
  });

  it("exempts exactly the two refund statuses where no money moved", async () => {
    await processApprovedPayouts();

    const filter = refundFilterSent();
    expect(filter).toBeDefined();
    expect((filter!.status as { notIn: RefundStatus[] }).notIn).toEqual([
      RefundStatus.FAILED,
      RefundStatus.CANCELLED,
    ]);
  });

  it("blocks on PENDING, and on SUCCEEDED with no cascade stamp", async () => {
    await processApprovedPayouts();

    expect(refundFilterSent()!.OR).toEqual([
      { status: RefundStatus.PENDING },
      { cascadedAt: null },
    ]);
  });
});
