/**
 * @jest-environment node
 */

/**
 * #1675 PR-Y review round — the Paid-out tile is Σ over COMPLETED payouts of
 * `netAmount ?? amount − tdsDeducted`, never `_sum(netAmount)`: the failure
 * and reversal paths null `netAmount`, and a payout completed after a failed
 * attempt would otherwise vanish from the tile while its row shows the net.
 */

import prisma from "@/lib/prisma";
import { buildConsultantEarningsPayload } from "@/lib/data/consultant-earnings-analytics";

jest.mock("server-only", () => ({}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantEarnings: { groupBy: jest.fn() },
    consultantPayout: { findMany: jest.fn() },
  },
}));
jest.mock("../../lib/payments/payouts", () => ({
  getConsultantEarningsSummary: jest.fn().mockResolvedValue({}),
  getConsultantEarnings: jest
    .fn()
    .mockResolvedValue({ earnings: [], total: 0, hasMore: false }),
  checkPayoutEligibility: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../lib/payments/payouts/payout-service", () => ({
  getConsultantPayouts: jest.fn().mockResolvedValue([]),
}));

const groupBy = prisma.consultantEarnings.groupBy as jest.Mock;
const findMany = prisma.consultantPayout.findMany as jest.Mock;

it("a COMPLETED payout with netAmount null counts as amount − tdsDeducted in the tile", async () => {
  groupBy.mockResolvedValue([]);
  findMany.mockResolvedValue([
    {
      amount: BigInt(100_000),
      tdsDeducted: BigInt(100),
      netAmount: BigInt(99_900),
    },
    { amount: BigInt(50_000), tdsDeducted: BigInt(50), netAmount: null },
  ]);

  const { totals } = await buildConsultantEarningsPayload("cp_1");

  expect(findMany.mock.calls[0][0].where).toEqual({
    consultantProfileId: "cp_1",
    status: "COMPLETED",
  });
  expect(totals.paidOut).toBe(99_900 + 49_950);
});
