/**
 * @jest-environment node
 */

/**
 * #1766 — the payout pipeline is unchanged by per-cycle earnings: batching
 * selects READY rows only, so three matured tranches of one subscription
 * payment ride into ONE payout, net of anything already refunded, while an
 * undelivered tranche (still PENDING with a NULL hold) stays out of it. TDS
 * is computed on the payout sum at disbursement, never per tranche.
 */

const CONSULTANT = "cp-1";

const tranches = [
  {
    id: "t0",
    status: "READY",
    consultantSharePaise: 30_000,
    refundedShareAmount: 0,
  },
  {
    id: "t1",
    status: "READY",
    consultantSharePaise: 30_000,
    refundedShareAmount: 0,
  },
  {
    id: "t2",
    status: "READY",
    consultantSharePaise: 30_000,
    refundedShareAmount: 10_000,
  },
  {
    id: "t3",
    status: "PENDING",
    consultantSharePaise: 30_000,
    refundedShareAmount: 0,
  },
];

const readyOnly = (where: { status: string; payoutId: null }) =>
  tranches.filter((t) => t.status === where.status);

const mockPayoutCreate = jest.fn();
const mockEarningsUpdateMany = jest.fn();

jest.mock("../../lib/prisma", () => {
  const tx = {
    consultantEarnings: {
      findMany: jest.fn(
        async ({ where }: { where: { status: string; payoutId: null } }) =>
          readyOnly(where),
      ),
      updateMany: (...a: unknown[]) => mockEarningsUpdateMany(...a),
    },
    consultantPayout: { create: (...a: unknown[]) => mockPayoutCreate(...a) },
  };
  return {
    __esModule: true,
    default: {
      consultantEarnings: {
        groupBy: jest.fn(
          async ({ where }: { where: { status: string; payoutId: null } }) => {
            const rows = readyOnly(where);
            return rows.length
              ? [
                  {
                    consultantProfileId: CONSULTANT,
                    _sum: {
                      consultantSharePaise: rows.reduce(
                        (s, r) => s + r.consultantSharePaise,
                        0,
                      ),
                    },
                  },
                ]
              : [];
          },
        ),
      },
      payoutAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: "pa-1",
          provider: "RAZORPAY",
          accountType: "BANK_ACCOUNT",
        }),
      },
      consultantProfile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            msmeStatus: "NONE",
            writtenAgreementWithFamiliarise: false,
          }),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
    },
  };
});
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  isMockRedis: jest.fn().mockReturnValue(false),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
  isRedisCircuitOpen: jest.fn().mockReturnValue(false),
}));
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  getCurrentFYCumulativePayments: jest.fn().mockResolvedValue(0),
  getFYDateRange: jest.fn(),
  getIndianFinancialYear: jest.fn().mockReturnValue("2026-27"),
  recordTDSDeduction: jest.fn(),
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
}));

import { createPayoutBatch } from "../../lib/payments/payouts/payout-service";

beforeEach(() => {
  jest.clearAllMocks();
  mockPayoutCreate.mockImplementation(async ({ data }: { data: unknown }) => ({
    id: "payout-1",
    ...(data as object),
  }));
  mockEarningsUpdateMany.mockResolvedValue({ count: 3 });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

it("three READY tranches of one payment batch as one payout, net of the refunded share; the unstamped tranche stays out", async () => {
  await createPayoutBatch();

  expect(mockPayoutCreate).toHaveBeenCalledTimes(1);
  const { data } = mockPayoutCreate.mock.calls[0][0] as {
    data: { amount: number; consultantProfileId: string };
  };
  expect(data.consultantProfileId).toBe(CONSULTANT);
  expect(data.amount).toBe(30_000 + 30_000 + 20_000);

  expect(mockEarningsUpdateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: { in: ["t0", "t1", "t2"] },
        status: "READY",
        payoutId: null,
      }),
      data: { payoutId: "payout-1", status: "BATCHED" },
    }),
  );
});
