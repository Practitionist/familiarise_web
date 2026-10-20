/**
 * @jest-environment node
 */

/**
 * #1757 — the process-payouts job failed every weekly run with "processing
 * lock unavailable" while the ADR 11 freeze (ENABLE_LIVE_PAYOUTS off) was the
 * real reason the service returned []. Flag off + waiting rows is a parked
 * notice; flag on + waiting rows + nothing processed is still the lock/Redis
 * failure the guard was written for.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { consultantPayout: { count: jest.fn() } },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/payout-service", () => ({
  createPayoutBatchSlice: jest.fn(),
  processApprovedPayouts: jest.fn(),
  REQUEST_PAYOUT_RUN_BOUNDS: {},
}));
jest.mock("../../lib/payments/payouts/org-payout-service", () => ({
  createOrgPayoutBatches: jest.fn(),
  processPendingOrgPayouts: jest.fn(),
}));

import { classifyEmptyRun } from "../../lib/payments/payouts/scheduled-runs";

describe("process-payouts job — flag off is not a failure (#1757)", () => {
  it("flag off + 3 APPROVED → parked notice, no error", () => {
    const v = classifyEmptyRun({ waiting: 3, livePayoutsEnabled: false });
    expect(v.kind).toBe("parked");
    expect(v).toMatchObject({ notice: expect.stringContaining("3 APPROVED") });
  });

  it("flag on + 3 APPROVED + [] → failed", () => {
    expect(classifyEmptyRun({ waiting: 3, livePayoutsEnabled: true })).toEqual({
      kind: "failed",
      error:
        "3 APPROVED payouts waiting; processing lock held or RazorpayX balance short",
    });
  });

  it("nothing waiting → ok regardless of the flag", () => {
    expect(classifyEmptyRun({ waiting: 0, livePayoutsEnabled: false })).toEqual(
      { kind: "ok" },
    );
  });
});
