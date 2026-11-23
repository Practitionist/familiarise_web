/**
 * @jest-environment node
 */

/**
 * The consultant retry ceiling: a payout the gateway confirms it never received
 * is re-armed until PAYOUT_CONSTANTS.MAX_RETRY_ATTEMPTS, then fails and returns
 * its earnings to READY. Any answer short of a confirmed "none" leaves it parked
 * PROCESSING with its earnings linked. The real stuck-payout job and the real
 * disbursement run share one in-memory row; RazorpayX is the faked transport.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Enough of Prisma's WHERE and update data to drive the rows below. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return (row[k] ?? null) === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { in?: unknown[]; lt?: number | Date };
      if (op.in) return op.in.includes(row[k]);
      if (op.lt !== undefined) return (row[k] as number) < (op.lt as number);
      throw new Error(`matches: unsupported filter on ${k}`);
    }
    return row[k] === v;
  });
}
function apply(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    const inc = v as { increment?: number } | null;
    row[k] =
      inc && typeof inc === "object" && "increment" in inc
        ? (row[k] as number) + (inc.increment ?? 0)
        : v;
  }
  row.updatedAt = new Date();
}

/** A Prisma double whose unstubbed members throw instead of reading undefined. */
function strict<T extends object>(name: string, target: T): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key !== "symbol" && key !== "then" && !(key in obj)) {
        throw new Error(`${name}.${String(key)} is not stubbed`);
      }
      return Reflect.get(obj, key, receiver);
    },
  });
}

let mockPayout: Row;
let mockEarnings: Row[];

const mockDb = strict("prisma", {
  consultantPayout: strict("prisma.consultantPayout", {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      [mockPayout].filter((r) => matches(r, where)),
    ),
    updateMany: jest.fn(
      async ({ where, data }: { where: Where; data: Row }) => {
        if (!matches(mockPayout, where)) return { count: 0 };
        apply(mockPayout, data);
        return { count: 1 };
      },
    ),
  }),
  consultantEarnings: strict("prisma.consultantEarnings", {
    // No live dispute and no uncascaded refund on these payments.
    findFirst: jest.fn(async () => null),
    aggregate: jest.fn(async ({ where }: { where: Where }) => {
      const rows = mockEarnings.filter((e) => matches(e, where));
      const sum = (k: string) => rows.reduce((s, e) => s + (e[k] as number), 0);
      return {
        _sum: {
          consultantSharePaise: sum("consultantSharePaise"),
          refundedShareAmount: sum("refundedShareAmount"),
        },
      };
    }),
    updateMany: jest.fn(
      async ({ where, data }: { where: Where; data: Row }) => {
        const rows = mockEarnings.filter((e) => matches(e, where));
        for (const e of rows) Object.assign(e, data);
        return { count: rows.length };
      },
    ),
  }),
  consultantTaxInfo: strict("prisma.consultantTaxInfo", {
    findUnique: jest.fn(async () => ({ isIndianResident: true })),
  }),
  organizationPayout: strict("prisma.organizationPayout", {
    findMany: jest.fn(async () => []),
  }),
  $transaction: jest.fn(
    async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(mockDb),
  ),
  $executeRaw: jest.fn(async () => 0),
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default(): unknown {
    return mockDb;
  },
}));
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(async () => "tok"),
  releaseLock: jest.fn(async () => undefined),
  isMockRedis: () => false,
  checkRedisHealth: async () => true,
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
  LONG_JOB_TTL_MS: 1000,
  CronLockHeldError: class extends Error {},
  CronLockUnavailableError: class extends Error {},
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn(async () => undefined),
  recordSystemEventSafe: jest.fn(async () => undefined),
  recordSystemError: jest.fn(async () => undefined),
  recordSystemErrorSafe: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutFailed: jest.fn(),
  notifyPayoutProcessed: jest.fn(),
}));
// The stuck job reaches the webhook handlers only for a payout the gateway holds.
jest.mock("../../lib/payments/payouts", () => ({
  applyOrgGatewayStatus: jest.fn(),
  handlePayoutWebhook: jest.fn(),
  markOrgPayoutFailed: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn(async () => ({ ok: true })),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  clawbackRecoveredPaise: jest.fn(async () => 0),
  releaseClawbackRecovery: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/payouts/consultant-tds", () => ({
  earningsGrossPaise: async (_db: unknown, _w: unknown, fallback: number) =>
    fallback,
  planConsultantPayoutTds: async () => ({
    withholdPaise: 0,
    creditPaise: 0,
    carryPaise: 0,
    catchUpFy: null,
    rateAppliedBps: 0,
    taxablePaise: 0,
    tdsSection: "194O",
    reason: "below threshold",
  }),
}));
jest.mock("../../lib/compliance/tds", () => ({
  ...jest.requireActual("../../lib/compliance/tds"),
  resolveEffectiveTdsRate: jest.fn(async () => 0.001),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  getCurrentFYCumulativePayments: jest.fn(async () => 0),
  getIndianFinancialYear: () => "2026-27",
  recordTDSDeduction: jest.fn(),
  recordTdsReversal: jest.fn(),
}));
const listPayouts = jest.fn();
const createPayout = jest.fn();
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  ...jest.requireActual("../../lib/payments/payouts/razorpay-payouts"),
  isRazorpayPayoutsConfigured: () => true,
  resolveRazorpayXCredentials: () => ({ keyId: "k", keySecret: "s" }),
  getRazorpayPayoutsService: () => ({
    listPayouts: (...a: unknown[]) => listPayouts(...a),
    createPayout: (...a: unknown[]) => createPayout(...a),
    determinePayoutMode: () => "IMPS",
    generateIdempotencyKey: (id: string) => `idem_${id}`,
  }),
}));

import { RazorpayXHttpError } from "../../lib/payments/payouts/razorpay-payouts";
import { processApprovedPayouts } from "../../lib/payments/payouts/payout-service";
import { handleStuckPayouts } from "../../scripts/payouts/handle-stuck-payouts";

/** A day passes, so the job sees the row as stuck. */
const age = () => {
  mockPayout.updatedAt = new Date(0);
};

beforeEach(() => {
  // ₹12,000 batched on Monday; the first send's reply was lost.
  mockPayout = {
    id: "po_1",
    consultantProfileId: "cprof_1",
    provider: "RAZORPAY",
    providerPayoutId: null,
    amount: 1_200_000,
    currency: "INR",
    method: "BANK_TRANSFER",
    idempotencyKey: "batch_po_1",
    status: "PROCESSING",
    retryCount: 0,
    approvedBy: "admin_1",
    updatedAt: new Date(0),
    payoutAccount: {
      razorpayFundAccId: "fa_1",
      accountType: "BANK_ACCOUNT",
      isVerified: true,
      payoutsAllowedAfter: null,
      payoutsFrozenAt: null,
    },
    consultantProfile: { payoutAccounts: [], user: { name: "Asha" } },
  };
  mockEarnings = ["ce_1", "ce_2"].map((id) => ({
    id,
    payoutId: "po_1",
    status: "BATCHED",
    consultantSharePaise: 600_000,
    refundedShareAmount: 0,
    releasedFromPayoutId: null,
  }));
  listPayouts.mockResolvedValue({ entity: "collection", items: [] });
  // Every retry meets a gateway 5xx, so its outcome is unknown again.
  createPayout.mockRejectedValue(
    new RazorpayXHttpError(
      "RazorpayX API error (HTTP 503)",
      "SERVER_ERROR",
      503,
    ),
  );
});

it("fails the payout and returns its earnings at the ceiling instead of parking it APPROVED", async () => {
  let last;
  for (let day = 0; day < 3; day++) {
    age();
    last = await handleStuckPayouts();
    await processApprovedPayouts();
  }

  expect(createPayout).toHaveBeenCalledTimes(2);
  expect(mockPayout).toMatchObject({ status: "FAILED", retryCount: 2 });
  expect(mockEarnings).toEqual([
    expect.objectContaining({ status: "READY", payoutId: null }),
    expect.objectContaining({ status: "READY", payoutId: null }),
  ]);
  expect(last).toMatchObject({ failedCount: 1, retriedCount: 0 });
});

describe("at the ceiling, an answer that is not a confirmed none", () => {
  beforeEach(() => {
    mockPayout.retryCount = 2;
  });

  it.each([
    ["a lookup error", () => listPayouts.mockRejectedValue(new Error("503"))],
    [
      "two payouts on one reference",
      () =>
        listPayouts.mockResolvedValue({
          items: [
            { id: "pout_a", reference_id: "po_1" },
            { id: "pout_b", reference_id: "po_1" },
          ],
        }),
    ],
    [
      "a gateway id bound while the lookup was out",
      () =>
        listPayouts.mockImplementation(async () => {
          mockPayout.providerPayoutId = "pout_late";
          return { items: [] };
        }),
    ],
  ])(
    "%s leaves it PROCESSING with its earnings linked",
    async (_l, arrange) => {
      arrange();

      await handleStuckPayouts();

      expect(mockPayout.status).toBe("PROCESSING");
      expect(mockEarnings.map((e) => [e.status, e.payoutId])).toEqual([
        ["BATCHED", "po_1"],
        ["BATCHED", "po_1"],
      ]);
    },
  );
});
