/**
 * @jest-environment node
 */

/**
 * #1771 K-3 — an ops hold whose CAS matches fewer rows than it read is a 409
 * that rolls the door back, and a release over an open refund is refused
 * before any write.
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
  holdUntil: new Date(0),
  payment: {
    refunds: Array.from({ length: openRefunds }, (_, i) => ({ id: `r${i}` })),
    disputes: [],
  },
});

function db(rows: ReturnType<typeof row>[], count: number) {
  const updateMany = jest.fn(async () => ({ count }));
  return {
    updateMany,
    db: {
      consultantEarnings: { findMany: jest.fn(async () => rows), updateMany },
    } as never,
  };
}

it("answers 409 when the hold CAS matches zero rows", async () => {
  const { db: tx } = db([row("READY")], 0);
  await expect(
    holdEarnings(tx, ["e1"], "chargeback suspected"),
  ).rejects.toMatchObject({ code: "EARNING_CHANGED", httpStatus: 409 });
});

it("refuses to release while the payment has an open refund", async () => {
  const { db: tx, updateMany } = db([row("HELD", 1)], 1);
  await expect(
    releaseHeldEarnings(tx, ["e1"], "dispute settled"),
  ).rejects.toMatchObject({ code: "EARNING_HAS_OPEN_CLAIM" });
  expect(updateMany).not.toHaveBeenCalled();
});
