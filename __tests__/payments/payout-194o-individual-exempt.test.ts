/**
 * @jest-environment node
 *
 * Section 194-O at payout time for a PAN-bearing INDIVIDUAL. Each payout is
 * ₹20,000 gross (₹16,000 net share) unless a case says otherwise. Earlier
 * payouts live in an in-memory table so the history reads are what is tested;
 * prior FY gross is a base figure plus the gross of that FY's live payouts.
 */
type PayoutRow = {
  id: string;
  status: string;
  tdsFinancialYear: string;
  tdsRateAppliedBps: number;
  tdsDeducted: number;
  tdsCarryPaise: number;
  tdsCreditPaise: number;
  tdsCatchUpFy: string | null;
  gross: number;
};
type Where = Record<string, unknown> & {
  id?: { not: string };
  status?: unknown;
  payoutId?: unknown;
  OR?: Array<{ payout?: { tdsFinancialYear?: string | null } }>;
};

const mockPayoutFindMany = jest.fn();
const mockPayoutUpdateMany = jest.fn();
const mockZeroCashCompletion = jest.fn();
let mockTable: PayoutRow[] = [];
let mockBasePriorGross: Record<string, number> = {};
let mockOwnGross = 2_000_000;
let mockReversalsPaise = 0;
let mockRaceWinner: PayoutRow | null = null;
let mockCurrentFy = "2026-27";

const live = (r: PayoutRow, where: Where) =>
  ["PROCESSING", "COMPLETED"].includes(r.status) && r.id !== where.id?.not;
const sums = (gross: number) => ({
  _sum: {
    grossAmount: gross,
    consultantSharePaise: (gross * 4) / 5,
    refundedShareAmount: 0,
  },
});

jest.mock("../../lib/prisma", () => {
  const db = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
    consultantPayout: {
      findMany: (...a: unknown[]) => mockPayoutFindMany(...a),
      findUnique: async () => null,
      findUniqueOrThrow: async () => {
        mockZeroCashCompletion();
        throw new Error("zero-cash completion reached");
      },
      update: jest.fn(),
      updateMany: async (args: {
        where: { id: string };
        data: { tdsCatchUpFy?: string | null };
      }) => {
        mockPayoutUpdateMany(args);
        if (args.data.tdsCatchUpFy && mockRaceWinner) {
          mockTable.push(mockRaceWinner);
          mockRaceWinner = null;
          throw Object.assign(new Error("unique"), {
            code: "P2002",
            meta: { target: ["consultantProfileId", "tdsCatchUpFy"] },
          });
        }
        return { count: 1 };
      },
      groupBy: async ({ where }: { where: Where }) =>
        mockTable
          .filter((r) => live(r, where))
          .map((r) => ({
            tdsFinancialYear: r.tdsFinancialYear,
            tdsRateAppliedBps: r.tdsRateAppliedBps,
            _sum: {
              tdsDeducted: r.tdsDeducted,
              tdsCarryPaise: r.tdsCarryPaise,
              tdsCreditPaise: r.tdsCreditPaise,
            },
          })),
    },
    tDSRecord: {
      aggregate: async () => ({ _sum: { tdsDeducted: mockReversalsPaise } }),
    },
    consultantEarnings: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: async ({ where }: { where: Where }) => {
        if (typeof where.payoutId === "string" || where.status === "READY") {
          return sums(mockOwnGross);
        }
        const fy = where.OR?.[0]?.payout?.tdsFinancialYear ?? "";
        const fromTable = mockTable
          .filter(
            (r) =>
              live(r, { id: where.payoutId as { not: string } }) &&
              r.tdsFinancialYear === fy,
          )
          .reduce((s, r) => s + r.gross, 0);
        return sums((mockBasePriorGross[fy] ?? 0) + fromTable);
      },
    },
    consultantTaxInfo: {
      findUnique: jest.fn().mockResolvedValue({
        isIndianResident: true,
        taxEntityType: "INDIVIDUAL",
        panEncrypted: Buffer.from("pan"),
      }),
    },
    payoutAccount: {
      findFirst: async () => ({
        id: "pa_1",
        provider: "RAZORPAY",
        isVerified: true,
      }),
    },
    ledgerTransaction: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { __esModule: true, default: db };
});
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  outstandingClawbackPaise: async () => 0,
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
  getFYDateRange: jest.requireActual("../../lib/payments/tax/tds-service")
    .getFYDateRange,
  getIndianFinancialYear: () => mockCurrentFy,
  recordTDSDeduction: jest.fn(),
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
}));

import {
  previewInstantPayout,
  processApprovedPayouts,
} from "../../lib/payments/payouts/payout-service";

const payout = (id: string, amount: number) => ({
  id,
  consultantProfileId: "cprof_1",
  amount,
  currency: "INR",
  provider: "RAZORPAY",
  method: "BANK_TRANSFER",
  idempotencyKey: null,
  retryCount: 0,
  consultantProfile: {
    payoutAccounts: [
      { razorpayFundAccId: "fa_x", accountType: "BANK_ACCOUNT" },
    ],
    user: { name: "Priya", email: "p@x.com" },
  },
});

type Staged = {
  tdsDeducted: number;
  netAmount: number;
  tdsCarryPaise: number;
  tdsCreditPaise: number;
  tdsCatchUpFy: string | null;
};

/** Runs one payout and returns the TDS fields it finally staged. */
async function stage(id: string, amount = 1_600_000): Promise<Staged> {
  mockPayoutUpdateMany.mockClear();
  mockPayoutFindMany.mockResolvedValue([payout(id, amount)]);
  await processApprovedPayouts();
  const calls = mockPayoutUpdateMany.mock.calls.filter(
    ([args]) =>
      args.where.id === id &&
      "tdsCatchUpFy" in args.data &&
      !("status" in args.data),
  );
  return calls[calls.length - 1][0].data;
}

const row = (over: Partial<PayoutRow>): PayoutRow => ({
  id: "po_cross",
  status: "COMPLETED",
  tdsFinancialYear: "2026-27",
  tdsRateAppliedBps: 10,
  tdsDeducted: 51_000,
  tdsCarryPaise: 0,
  tdsCreditPaise: 0,
  tdsCatchUpFy: "2026-27",
  gross: 2_000_000,
  ...over,
});

beforeAll(() => {
  process.env.RAZORPAY_KEY_ID = "k";
  process.env.RAZORPAY_SECRET = "s";
  process.env.RAZORPAYX_KEY_SECRET = "x";
  process.env.RAZORPAYX_ACCOUNT_NUMBER = "acc";
  Object.defineProperty(globalThis, "fetch", {
    value: jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: "pout_x" }) }),
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  mockCurrentFy = "2026-27";
  mockTable = [];
  mockBasePriorGross = { "2026-27": 49_000_000 };
  mockOwnGross = 2_000_000;
  mockReversalsPaise = 0;
  mockRaceWinner = null;
  mockZeroCashCompletion.mockClear();
});

it("withholds nothing while the year stays at or below ₹5L", async () => {
  mockBasePriorGross["2026-27"] = 48_000_000;
  expect((await stage("po_next")).tdsDeducted).toBe(0);
});

// ₹4,90,000 + ₹20,000: 0.1 % × ₹5,10,000 = ₹510 (excess-only gave ₹10).
it("withholds on the whole YTD gross when crossing, and marks the FY catch-up", async () => {
  const s = await stage("po_cross");
  expect(s).toMatchObject({ tdsDeducted: 51_000, tdsCatchUpFy: "2026-27" });
  expect(s.netAmount).toBe(1_549_000);
});

it("withholds on its own gross after the crossing", async () => {
  mockTable = [row({})];
  expect(await stage("po_next")).toMatchObject({
    tdsDeducted: 2_000,
    tdsCatchUpFy: null,
  });
});

it("recomputes the same catch-up when the crossing payout is retried", async () => {
  expect((await stage("po_cross")).tdsDeducted).toBe(51_000);
  mockTable = [row({ status: "PROCESSING" })];
  expect((await stage("po_cross")).tdsDeducted).toBe(51_000);
});

it("loses the one-catch-up race and pays only the increment the winner left", async () => {
  mockRaceWinner = row({ id: "po_winner", status: "PROCESSING" });
  expect(await stage("po_loser")).toMatchObject({
    tdsDeducted: 2_000,
    tdsCatchUpFy: null,
  });
});

it("starts 1 April afresh after a 31 March crossing", async () => {
  mockTable = [row({})];
  mockCurrentFy = "2027-28";
  expect((await stage("po_april")).tdsDeducted).toBe(0);
});

it("credits back the year's TDS when refunds pull the year to ₹5L or below", async () => {
  // ₹4,70,000 left after refunds + ₹20,000 = ₹4,90,000; ₹510 withheld less ₹20 reversed.
  mockBasePriorGross["2026-27"] = 45_000_000;
  mockTable = [row({})];
  mockReversalsPaise = -2_000;
  expect(await stage("po_next")).toMatchObject({
    tdsDeducted: 0,
    tdsCreditPaise: 49_000,
    netAmount: 1_649_000,
  });
});

it("withholds what fits, carries the rest, and collects it on the next payout", async () => {
  const first = await stage("po_small", 30_000);
  expect(first).toMatchObject({
    tdsDeducted: 30_000,
    tdsCarryPaise: 21_000,
    netAmount: 0,
  });
  expect(mockZeroCashCompletion).toHaveBeenCalled();

  mockTable = [
    row({ id: "po_small", tdsDeducted: 30_000, tdsCarryPaise: 21_000 }),
  ];
  expect(await stage("po_next")).toMatchObject({
    tdsDeducted: 23_000,
    tdsCarryPaise: -21_000,
  });
});

it("still deducts an unpaid carry after the financial year rolls over", async () => {
  mockTable = [
    row({ id: "po_small", tdsDeducted: 30_000, tdsCarryPaise: 21_000 }),
  ];
  mockCurrentFy = "2027-28";
  expect((await stage("po_april")).tdsDeducted).toBe(21_000);
});

it("previews exactly what the instant payout then withholds", async () => {
  const preview = await previewInstantPayout(
    "cprof_1",
    new Date("2026-10-17T06:00:00Z"),
  );
  expect(preview.tdsEstimatePaise).toBe(51_000);
  expect((await stage("po_instant")).tdsDeducted).toBe(
    preview.tdsEstimatePaise,
  );
});
