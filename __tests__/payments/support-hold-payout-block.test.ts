/** @jest-environment node */
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(async () => "lock"),
  releaseLock: jest.fn(),
  isMockRedis: jest.fn(() => false),
  checkRedisHealth: jest.fn(async () => true),
}));
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn(async () => ({ ok: true })),
}));
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  ...jest.requireActual("../../lib/payments/payouts/razorpay-payouts"),
  getRazorpayPayoutsService: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: { findMany: jest.fn(), updateMany: jest.fn() },
    consultantEarnings: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import prisma from "../../lib/prisma";
import { processApprovedPayouts } from "../../lib/payments/payouts/payout-service";
import {
  processOrgPayout,
  createOrgPayoutBatch,
} from "../../lib/payments/payouts/org-payout-service";
import { getRazorpayPayoutsService } from "../../lib/payments/payouts/razorpay-payouts";

type PaymentGuard = {
  supportHolds?: { some: { releasedAt: null } };
  disputes?: unknown;
  refunds?: unknown;
};
const tx = {
  consultantEarnings: { findFirst: jest.fn() },
  consultantPayout: { updateMany: jest.fn() },
  organizationEarnings: { findFirst: jest.fn(), updateMany: jest.fn() },
  organizationPayout: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  },
  organizationPayoutAccount: { findUnique: jest.fn() },
};
const transaction = jest.mocked(prisma.$transaction);
const findPayouts = jest.mocked(prisma.consultantPayout.findMany);
const holds: { releasedAt: Date | null }[] = [];
let disputeActive = false;
let refundActive = false;
function findBlockedEarning({ where }: { where: { payment: PaymentGuard } }) {
  const payment = where.payment;
  if (payment.supportHolds)
    return holds.some(
      (hold) => hold.releasedAt === payment.supportHolds?.some.releasedAt,
    )
      ? { id: "held-earning" }
      : null;
  if (payment.disputes)
    return disputeActive ? { id: "disputed-earning" } : null;
  if (payment.refunds) return refundActive ? { id: "refunding-earning" } : null;
  throw new Error("Unrecognized payment gate");
}

beforeEach(() => {
  jest.clearAllMocks();
  holds.length = 0;
  disputeActive = false;
  refundActive = false;
  process.env.ENABLE_LIVE_PAYOUTS = "true";
  (transaction as jest.Mock).mockImplementation(
    (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  );
  (findPayouts as jest.Mock).mockResolvedValue([
    {
      id: "consultant-payout",
      consultantProfileId: "consultant",
      amount: 500000,
      currency: "INR",
      provider: "RAZORPAY",
      method: "BANK_TRANSFER",
      retryCount: 0,
      approvedBy: "SYSTEM_AUTO_APPROVE",
      consultantProfile: {
        payoutAccounts: [],
        user: { name: "Expert", email: "expert@test" },
      },
    },
  ]);
  tx.consultantEarnings.findFirst.mockImplementation(findBlockedEarning);
  tx.organizationEarnings.findFirst.mockImplementation(findBlockedEarning);
  tx.organizationPayout.findUnique.mockResolvedValue({ status: "APPROVED" });
});

afterEach(() => delete process.env.ENABLE_LIVE_PAYOUTS);

it("blocks consultant disbursement inside the Serializable transaction when any support hold remains active", async () => {
  holds.push({ releasedAt: new Date() }, { releasedAt: null });
  expect(await processApprovedPayouts()).toEqual([
    {
      payoutId: "consultant-payout",
      success: false,
      skipped: true,
      error: "Payment held for support review",
    },
  ]);
  expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "Serializable",
  });
  expect(prisma.consultantEarnings.findFirst).not.toHaveBeenCalled();
  expect(tx.consultantPayout.updateMany).not.toHaveBeenCalled();
  expect(getRazorpayPayoutsService).not.toHaveBeenCalled();
});

it.each(["dispute", "refund"])(
  "releasing the support hold preserves the independent %s block",
  async (kind) => {
    holds.push({ releasedAt: new Date() });
    disputeActive = kind === "dispute";
    refundActive = kind === "refund";
    const results = await processApprovedPayouts();
    expect(results[0]).toMatchObject({ success: false, skipped: true });
    expect(tx.consultantEarnings.findFirst).toHaveBeenCalledTimes(
      kind === "dispute" ? 2 : 3,
    );
    expect(tx.consultantPayout.updateMany).not.toHaveBeenCalled();
    expect(getRazorpayPayoutsService).not.toHaveBeenCalled();
  },
);

it("blocks organization disbursement without claiming or submitting the payout", async () => {
  holds.push({ releasedAt: null });
  expect(await processOrgPayout("org-payout")).toEqual({
    status: "APPROVED",
    submittedToGateway: false,
    claimed: false,
  });
  expect(tx.organizationPayout.updateMany).not.toHaveBeenCalled();
  expect(getRazorpayPayoutsService).not.toHaveBeenCalled();
  expect(transaction).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ isolationLevel: "Serializable" }),
  );
});

it("organization batching cannot claim earnings whose payment has an active support hold", async () => {
  holds.push({ releasedAt: null });
  tx.organizationPayoutAccount.findUnique.mockResolvedValue({
    status: "VERIFIED",
  });
  tx.organizationPayout.create.mockResolvedValue({ id: "new-payout" });
  tx.organizationEarnings.updateMany.mockImplementation(
    ({ where }: { where: { payment?: { NOT?: PaymentGuard } } }) => ({
      count:
        where.payment?.NOT?.supportHolds &&
        holds.some((hold) => hold.releasedAt === null)
          ? 0
          : 1,
    }),
  );
  await expect(
    createOrgPayoutBatch("org", new Date("2026-01-01"), new Date("2026-02-01")),
  ).rejects.toThrow("No READY earnings");
  expect(transaction).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ isolationLevel: "Serializable" }),
  );
});
