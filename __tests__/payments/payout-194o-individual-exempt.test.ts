/**
 * @jest-environment node
 *
 * Section 194-O at payout time: a PAN-bearing INDIVIDUAL whose gross receipts
 * stay under ₹5,00,000 in the financial year has nothing withheld.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    consultantEarnings: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({
        _sum: {
          consultantSharePaise: 500_000,
          grossAmount: 625_000,
          refundedShareAmount: null,
        },
      }),
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

import prisma from "../../lib/prisma";
import { processApprovedPayouts } from "../../lib/payments/payouts/payout-service";

const mocks = prisma as unknown as {
  consultantPayout: { findMany: jest.Mock; updateMany: jest.Mock };
};

it("withholds nothing for a PAN-bearing individual below ₹5L in the FY", async () => {
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
  mocks.consultantPayout.findMany.mockResolvedValue([
    {
      id: "po_1",
      consultantProfileId: "cprof_1",
      amount: 500_000,
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
    },
  ]);

  await processApprovedPayouts();

  expect(mocks.consultantPayout.updateMany).toHaveBeenCalledWith({
    where: { id: "po_1", status: "PROCESSING" },
    data: expect.objectContaining({ tdsDeducted: 0, netAmount: 500_000 }),
  });
});
