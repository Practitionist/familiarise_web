/**
 * @jest-environment node
 *
 * Section 194-O at payout time for a PAN-bearing INDIVIDUAL. Each payout is
 * ₹20,000 gross (₹16,000 net share). Prior FY gross and earlier withholding are
 * served from small in-memory tables so the WHERE filters are what is tested.
 */
type PayoutRow = {
  id: string;
  status: string;
  tdsFinancialYear: string;
  tdsDeducted: number;
};
type GrossSums = { gross: number; share: number; refunded: number };

const mockPayoutFindMany = jest.fn();
const mockPayoutUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
let mockPayoutTable: PayoutRow[] = [];
let mockPriorGrossByFy: Record<string, GrossSums> = {};
let mockCurrentFy = "2026-27";

const sums = (s: GrossSums | undefined) => ({
  _sum: {
    grossAmount: s?.gross ?? null,
    consultantSharePaise: s?.share ?? null,
    refundedShareAmount: s?.refunded ?? null,
  },
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findMany: (...a: unknown[]) => mockPayoutFindMany(...a),
      updateMany: (...a: unknown[]) => mockPayoutUpdateMany(...a),
      update: jest.fn(),
      count: ({
        where,
      }: {
        where: {
          id: { not: string };
          tdsFinancialYear: string;
          tdsDeducted: { gt: number };
          status: { in: string[] };
        };
      }) =>
        Promise.resolve(
          mockPayoutTable.filter(
            (p) =>
              p.id !== where.id.not &&
              p.tdsFinancialYear === where.tdsFinancialYear &&
              p.tdsDeducted > where.tdsDeducted.gt &&
              where.status.in.includes(p.status),
          ).length,
        ),
    },
    consultantEarnings: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: ({
        where,
      }: {
        where: {
          payoutId: unknown;
          OR?: Array<{ payout?: { tdsFinancialYear?: string | null } }>;
        };
      }) => {
        if (typeof where.payoutId === "string") {
          return Promise.resolve(
            sums({ gross: 2_000_000, share: 1_600_000, refunded: 0 }),
          );
        }
        const fy = where.OR?.[0]?.payout?.tdsFinancialYear;
        return Promise.resolve(sums(fy ? mockPriorGrossByFy[fy] : undefined));
      },
    },
    consultantTaxInfo: {
      findUnique: jest.fn().mockResolvedValue({
        isIndianResident: true,
        taxEntityType: "INDIVIDUAL",
        panEncrypted: Buffer.from("pan"),
      }),
    },
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
  getFYDateRange: jest.requireActual("../../lib/payments/tax/tds-service")
    .getFYDateRange,
  getIndianFinancialYear: () => mockCurrentFy,
  recordTDSDeduction: jest.fn(),
  resolve194OTaxablePaise: jest.requireActual("../../lib/compliance/tds-194o")
    .resolve194OTaxablePaise,
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
}));

import { processApprovedPayouts } from "../../lib/payments/payouts/payout-service";

const payout = (id: string) => ({
  id,
  consultantProfileId: "cprof_1",
  amount: 1_600_000,
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

async function stagedTdsFor(id: string): Promise<number> {
  mockPayoutUpdateMany.mockClear();
  mockPayoutFindMany.mockResolvedValue([payout(id)]);
  await processApprovedPayouts();
  const staged = mockPayoutUpdateMany.mock.calls.find(
    ([args]) => args.where.id === id && "tdsDeducted" in args.data,
  );
  return staged?.[0].data.tdsDeducted;
}

const crossed: PayoutRow = {
  id: "po_cross",
  status: "PROCESSING",
  tdsFinancialYear: "2026-27",
  tdsDeducted: 51_000,
};

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
  mockPayoutTable = [];
  mockPriorGrossByFy = {
    "2026-27": { gross: 49_000_000, share: 39_200_000, refunded: 0 },
  };
});

it.each([
  [
    "withholds nothing below ₹5L",
    { gross: 8_000_000, share: 6_400_000, refunded: 0 },
    [],
    0,
  ],
  // ₹4,90,000 + ₹20,000: 0.1 % × ₹5,10,000 = ₹510 (excess-only gave ₹10).
  ["withholds on the whole YTD gross when crossing", undefined, [], 51_000],
  [
    "withholds on its own gross after the crossing",
    { gross: 51_000_000, share: 40_800_000, refunded: 0 },
    [crossed],
    2_000,
  ],
  // ₹24,500 refunded gross leaves ₹4,65,500 + ₹20,000 under the threshold.
  [
    "counts a pre-crossing refund against the YTD",
    { gross: 49_000_000, share: 39_200_000, refunded: 1_960_000 },
    [],
    0,
  ],
])("%s", async (_name, prior, table, expectedTds) => {
  if (prior) mockPriorGrossByFy["2026-27"] = prior;
  mockPayoutTable = table;
  expect(await stagedTdsFor("po_next")).toBe(expectedTds);
});

it("recomputes the same catch-up when the crossing payout is retried", async () => {
  expect(await stagedTdsFor("po_cross")).toBe(51_000);
  mockPayoutTable = [crossed];
  expect(await stagedTdsFor("po_cross")).toBe(51_000);
});

it("starts 1 April afresh after a 31 March crossing", async () => {
  mockPayoutTable = [crossed];
  mockCurrentFy = "2027-28";
  expect(await stagedTdsFor("po_april")).toBe(0);
});
