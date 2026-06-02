/**
 * @jest-environment node
 */

/**
 * #785 (task #24) — false-FAILED payout guard. If the gateway ALREADY accepted a
 * payout (providerPayoutId set) but a later DB write throws, marking the payout
 * FAILED + unlinking its earnings would re-batch them into a DOUBLE disbursement.
 * The catch must instead quarantine the row PROCESSING with earnings LINKED.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    consultantEarnings: { updateMany: jest.fn() },
  },
}));
jest.mock("../../lib/payments/payouts/org-payout-service", () => ({
  processOrgPayout: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { processApprovedPayouts } from "../../scripts/payouts/process-payouts";

const cp = (
  prisma as unknown as {
    consultantPayout: { findMany: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
    consultantEarnings: { updateMany: jest.Mock };
  }
).consultantPayout;
const ce = (
  prisma as unknown as { consultantEarnings: { updateMany: jest.Mock } }
).consultantEarnings;

const APPROVED = {
  id: "po_1",
  amount: 500000,
  currency: "INR",
  provider: "RAZORPAY",
  retryCount: 0,
  consultantProfile: {
    payoutAccounts: [{ razorpayFundAccId: "fa_x" }],
    user: { name: "Priya", email: "p@x.com" },
  },
};

const unlinkedEarnings = () =>
  ce.updateMany.mock.calls.some(
    ([arg]: [{ data?: { payoutId?: unknown } }]) => arg?.data?.payoutId === null,
  );
const markedFailed = () =>
  cp.update.mock.calls.some(
    ([arg]: [{ data?: { status?: unknown } }]) =>
      arg?.data?.status === "FAILED",
  );

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAZORPAY_KEY_ID = "k";
  process.env.RAZORPAY_KEY_SECRET = "s";
  process.env.RAZORPAYX_ACCOUNT_NUMBER = "acc";
  (global as unknown as { fetch: unknown }).fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "pout_x" }) });
  cp.updateMany.mockResolvedValue({ count: 1 }); // claim APPROVED→PROCESSING
  ce.updateMany.mockResolvedValue({ count: 0 });
});

describe("processApprovedPayouts — #785 false-FAILED guard", () => {
  it("gateway accepted + post-submit DB write fails → does NOT FAIL or unlink earnings (no double-pay)", async () => {
    cp.findMany.mockResolvedValue([APPROVED]);
    // the persist-after-gateway throws; the catch's re-persist succeeds.
    cp.update
      .mockRejectedValueOnce(new Error("DB write failed"))
      .mockResolvedValue({});

    await processApprovedPayouts();

    expect((global as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalled();
    // the double-pay vector — earnings must STAY linked.
    expect(unlinkedEarnings()).toBe(false);
    expect(markedFailed()).toBe(false);
    // quarantined PROCESSING with the gateway id so handle-stuck-payouts reconciles.
    const quarantined = cp.update.mock.calls.some(
      ([arg]: [{ data?: { providerPayoutId?: unknown; status?: unknown } }]) =>
        arg?.data?.providerPayoutId === "pout_x" &&
        arg?.data?.status === "PROCESSING",
    );
    expect(quarantined).toBe(true);
  });

  it("genuine pre-gateway failure (gateway rejects) → FAILs + unlinks earnings", async () => {
    cp.findMany.mockResolvedValue([APPROVED]);
    cp.update.mockResolvedValue({});
    (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "bad fund account" }),
    });

    await processApprovedPayouts();

    expect(markedFailed()).toBe(true);
    expect(unlinkedEarnings()).toBe(true);
  });
});
