/**
 * @jest-environment node
 */

/**
 * #863 — RazorpayX balance preflight. Insufficient balance holds the batch
 * (ok:false) and pages ops; an unknown balance or a disabled flag fails OPEN
 * (ok:true) so a new read dependency never stalls payouts.
 */

const mockGetBalance = jest.fn();
const mockConfigured = jest.fn();
const mockRecordSystemError = jest.fn().mockResolvedValue(undefined);
let liveEnabled = true;

jest.mock("../../lib/feature-flags", () => ({
  get ENABLE_LIVE_PAYOUTS() {
    return liveEnabled;
  },
}));
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  getRazorpayPayoutsService: () => ({ getAccountBalance: mockGetBalance }),
  isRazorpayPayoutsConfigured: () => mockConfigured(),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

import { assertPayoutBalance } from "@/lib/payments/payouts/balance-preflight";

beforeEach(() => {
  mockGetBalance.mockReset();
  mockRecordSystemError.mockClear();
  mockConfigured.mockReturnValue(true);
  liveEnabled = true;
});

describe("assertPayoutBalance (#863)", () => {
  it("holds the batch and pages ops when the balance is known-insufficient", async () => {
    mockGetBalance.mockResolvedValue(500);
    const r = await assertPayoutBalance(1000);
    expect(r.ok).toBe(false);
    expect(r.balancePaise).toBe(500);
    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
    expect(mockRecordSystemError.mock.calls[0][0].summary).toMatch(
      /RAZORPAYX_BALANCE_INSUFFICIENT/,
    );
  });

  it("passes when the balance covers the batch", async () => {
    mockGetBalance.mockResolvedValue(2000);
    const r = await assertPayoutBalance(1000);
    expect(r.ok).toBe(true);
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("fails OPEN on an unknown balance (null)", async () => {
    mockGetBalance.mockResolvedValue(null);
    const r = await assertPayoutBalance(1000);
    expect(r.ok).toBe(true);
    expect(r.balancePaise).toBeNull();
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("is a no-op ok when live payouts are disabled (never reads the balance)", async () => {
    liveEnabled = false;
    const r = await assertPayoutBalance(1000);
    expect(r.ok).toBe(true);
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it("is a no-op ok when the gateway is not configured", async () => {
    mockConfigured.mockReturnValue(false);
    const r = await assertPayoutBalance(1000);
    expect(r.ok).toBe(true);
    expect(mockGetBalance).not.toHaveBeenCalled();
  });
});
