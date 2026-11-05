/**
 * @jest-environment node
 */

/**
 * #1771 K-3 — an ops hold whose CAS keeps missing is a 409 that rolls the
 * door back, a release over an open refund is refused before any write, and a
 * release clears only the operator/moderation holds.
 */

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import {
  holdEarnings,
  releaseHeldEarnings,
} from "../../lib/payments/payouts/earnings-hold-ops";

const row = (status: string, openRefunds = 0) => ({
  id: "e1",
  status,
  preHoldStatus: null,
  holdUntil: new Date(0),
  payment: {
    refunds: Array.from({ length: openRefunds }, (_, i) => ({ id: `r${i}` })),
    disputes: [],
  },
});

function db(
  r: ReturnType<typeof row>,
  count: number,
  activeHolds: { reason: string }[] = [],
) {
  const updateMany = jest.fn(async () => ({ count }));
  const holdUpdateMany = jest.fn(async () => ({ count: activeHolds.length }));
  return {
    updateMany,
    holdUpdateMany,
    db: {
      consultantEarnings: {
        findUnique: jest.fn(async () => r),
        findMany: jest.fn(async () => [r]),
        updateMany,
      },
      organizationEarnings: { findUnique: jest.fn(async () => null) },
      earningsHold: {
        findMany: jest.fn(async (args: { where: { reason?: unknown } }) =>
          args.where.reason
            ? activeHolds.map((h, i) => ({
                id: `h${i}`,
                consultantEarningsId: "e1",
                organizationEarningsId: null,
              }))
            : [],
        ),
        updateMany: holdUpdateMany,
        createMany: jest.fn(),
      },
    } as never,
  };
}

it("answers 409 when the hold CAS matches zero rows", async () => {
  const { db: tx } = db(row("READY"), 0);
  await expect(
    holdEarnings(tx, "e1", "chargeback suspected", "ops_1"),
  ).rejects.toMatchObject({ code: "EARNING_CHANGED", httpStatus: 409 });
});

it("refuses to release while the payment has an open refund", async () => {
  const { db: tx, updateMany } = db(row("HELD", 1), 1);
  await expect(
    releaseHeldEarnings(tx, "e1", "dispute settled", "admin_1"),
  ).rejects.toMatchObject({ code: "EARNING_HAS_OPEN_CLAIM" });
  expect(updateMany).not.toHaveBeenCalled();
});

it("refuses a release when only a settlement-owned hold freezes the row", async () => {
  const { db: tx, holdUpdateMany } = db(row("HELD"), 1);
  await expect(
    releaseHeldEarnings(tx, "e1", "dispute won, release it", "admin_1"),
  ).rejects.toMatchObject({ code: "EARNING_HELD_BY_SETTLEMENT" });
  expect(holdUpdateMany).not.toHaveBeenCalled();
});

it("releases the operator hold and returns a matured row with no recorded prior to PENDING", async () => {
  const { db: tx, updateMany } = db(row("HELD"), 1, [{ reason: "OPERATOR" }]);
  await expect(
    releaseHeldEarnings(tx, "e1", "reviewed, all good", "admin_1"),
  ).resolves.toEqual({ side: "consultant", status: "PENDING" });
  // The restore never filters on the hold window: the release job's guards decide READY.
  const restore = (
    updateMany.mock.calls as unknown as [{ where: object }][]
  ).at(-1)?.[0];
  expect(restore?.where).not.toHaveProperty("holdUntil");
});
