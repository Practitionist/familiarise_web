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
  resolve194OTaxablePaise: jest.requireActual("../../lib/compliance/tds-194o")
    .resolve194OTaxablePaise,
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
}));

import { RefundStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { processApprovedPayouts } from "../../lib/payments/payouts/payout-service";

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
  consultantProfile: {
    payoutAccounts: [
      {
        razorpayFundAccId: "fa_x",
        accountType: "BANK_ACCOUNT",
      },
    ],
    user: { name: "Priya", email: "p@x.com" },
  },
};

type RefundRow = {
  status: RefundStatus;
  cascadedAt: Date | null;
  /** Defaults to a cash refund; a credit restoration is 0. */
  amountPaise?: number;
};

/** The filter keys refundRowBlocks knows how to interpret. */
const SUPPORTED_KEYS = new Set(["status", "cascadedAt", "OR", "amountPaise"]);

/**
 * Applies the guard's own Prisma refund filter to one fixture row, so the
 * exemptions are pinned against the predicate the source really emits. Mirrors
 * only what the guard emits — status equality / `notIn`, an exact `cascadedAt`
 * match, and an `OR` of those. Any other key throws, so a rewritten guard
 * fails loudly instead of quietly matching nothing.
 */
function refundRowBlocks(
  filter: Record<string, unknown>,
  row: RefundRow,
): boolean {
  for (const key of Object.keys(filter)) {
    if (!SUPPORTED_KEYS.has(key)) {
      throw new Error(`Unsupported refund filter key in guard: ${key}`);
    }
  }

  const status = filter.status as
    | { notIn?: RefundStatus[] }
    | RefundStatus
    | undefined;
  if (status !== undefined) {
    if (typeof status === "object" && status.notIn) {
      if (status.notIn.includes(row.status)) return false;
    } else if (status !== row.status) {
      return false;
    }
  }

  if (filter.cascadedAt !== undefined && filter.cascadedAt !== row.cascadedAt) {
    return false;
  }

  const amount = filter.amountPaise as { gt?: number } | undefined;
  if (amount?.gt !== undefined && !((row.amountPaise ?? 100) > amount.gt)) {
    return false;
  }

  const or = filter.OR as Record<string, unknown>[] | undefined;
  if (or) return or.some((clause) => refundRowBlocks(clause, row));

  return true;
}

/**
 * Dispatch on the predicate shape so the dispute guard and the refund guard can
 * share one mock without depending on their relative order.
 */
function stubEarnings(refunds: RefundRow[]): void {
  mocks.consultantEarnings.findFirst.mockImplementation(
    (args: { where: { payment?: Record<string, unknown> } }) => {
      const payment = args?.where?.payment;
      if (payment?.disputes) return null; // no live dispute in any case here
      const some = payment?.refunds as
        | { some: Record<string, unknown> }
        | undefined;
      if (some) {
        return refunds.some((row) => refundRowBlocks(some.some, row))
          ? { id: "ce_refund_blocked" }
          : null;
      }
      return null; // any other findFirst in the path is not a guard
    },
  );
}

/** The `payment.refunds.some` filter the guard actually sent, or undefined. */
function refundFilterSent(): Record<string, unknown> | undefined {
  const call = mocks.consultantEarnings.findFirst.mock.calls.find(
    ([arg]: [{ where: { payment?: { refunds?: { some: unknown } } } }]) =>
      !!arg?.where?.payment?.refunds,
  );
  return call?.[0].where.payment?.refunds?.some as
    | Record<string, unknown>
    | undefined;
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
        failureReason: expect.stringContaining("SHORTFALL_BEFORE_DISBURSEMENT:"),
        tdsDeducted: 0,
        netAmount: null,
      }),
    });
    expect(mocks.consultantEarnings.updateMany).toHaveBeenCalledWith({
      where: { payoutId: "po_1", status: "BATCHED" },
      data: { payoutId: null, status: "READY" },
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

    const call = mocks.consultantEarnings.findFirst.mock.calls.find(
      ([arg]: [{ where: { payment?: { refunds?: unknown } } }]) =>
        !!arg?.where?.payment?.refunds,
    );
    expect(call).toBeDefined();
    expect(call![0].select).toEqual({ id: true });
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
