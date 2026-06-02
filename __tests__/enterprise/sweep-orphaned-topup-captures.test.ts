/**
 * @jest-environment node
 */

/**
 * #785 (task #23) — captured-but-uncredited wallet top-up reconciler. Re-runs the
 * idempotent confirmTopUp for top-ups whose confirm/ledger post rolled back
 * (capturedAt + providerPaymentId set outside the tx, still PENDING). Pins the
 * query shape + the recredit/already-confirmed/failure accounting.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { walletTopUp: { findMany: jest.fn() } },
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  confirmTopUp: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { confirmTopUp } from "../../lib/api/organizations/wallet";
import { sweepOrphanedTopupCaptures } from "../../scripts/cleanup/sweep-orphaned-topup-captures";

const mockFindMany = (
  prisma as unknown as { walletTopUp: { findMany: jest.Mock } }
).walletTopUp.findMany;
const mockConfirm = confirmTopUp as jest.Mock;

const orphan = (o: Record<string, unknown> = {}) => ({
  providerOrderId: "we_1",
  providerPaymentId: "pay_1",
  amountPaise: 50000,
  ...o,
});

beforeEach(() => jest.clearAllMocks());

describe("sweepOrphanedTopupCaptures (#785)", () => {
  it("re-credits a captured-but-uncredited top-up via the idempotent confirm", async () => {
    mockFindMany.mockResolvedValue([orphan()]);
    mockConfirm.mockResolvedValue({ confirmed: true, balanceAfter: 100000 });

    const r = await sweepOrphanedTopupCaptures({ graceMinutes: 5 });

    expect(r).toMatchObject({ scanned: 1, recredited: 1, stillFailing: 0 });
    expect(mockConfirm).toHaveBeenCalledWith(expect.anything(), {
      providerOrderId: "we_1",
      providerPaymentId: "pay_1",
      amountPaise: 50000,
    });
    // query: PENDING + captured (capturedAt range, which excludes null) + paid id
    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("PENDING");
    expect(where.providerPaymentId).toEqual({ not: null });
    expect(where.capturedAt).toHaveProperty("lt");
  });

  it("already-CONFIRMED (confirmed=false) is not counted as recredited", async () => {
    mockFindMany.mockResolvedValue([orphan()]);
    mockConfirm.mockResolvedValue({ confirmed: false });

    const r = await sweepOrphanedTopupCaptures();

    expect(r.recredited).toBe(0);
    expect(r.stillFailing).toBe(0);
  });

  it("a confirm throw counts as stillFailing", async () => {
    mockFindMany.mockResolvedValue([orphan()]);
    mockConfirm.mockRejectedValue(new Error("ledger down"));

    const r = await sweepOrphanedTopupCaptures();

    expect(r.stillFailing).toBe(1);
    expect(r.errors[0]).toContain("ledger down");
  });

  it("empty scan → no-op", async () => {
    mockFindMany.mockResolvedValue([]);
    const r = await sweepOrphanedTopupCaptures();
    expect(r).toMatchObject({ scanned: 0, recredited: 0 });
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
