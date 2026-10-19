/**
 * @jest-environment node
 */

/**
 * Expiry must not take an autoRenew contract auto-renew has not reached yet:
 * both run in bounded slices in the same daily window.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { expiryCohortWhere } from "@/jobs/contracts/expire-contracts";

it("leaves an un-renewed autoRenew contract to auto-renew for one day after it ends", () => {
  const asOf = new Date("2026-11-02T03:00:00.000Z");
  expect(expiryCohortWhere(asOf)).toEqual({
    status: "ACTIVE",
    effectiveTo: { lte: asOf, not: null },
    NOT: {
      autoRenew: true,
      autoRenewedAt: null,
      effectiveTo: { gt: new Date("2026-11-01T03:00:00.000Z") },
    },
  });
});
