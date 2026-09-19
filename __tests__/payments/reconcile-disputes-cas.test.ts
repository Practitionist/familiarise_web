/**
 * @jest-environment node
 */

/**
 * #1584 P1-CR03 — reconcile-disputes wrote `dispute.update({ where: { disputeId } })`
 * unconditionally, so a `dispute.lost` webhook landing between the fetch and
 * the write was overwritten by the stale gateway snapshot. Every write is now
 * `updateMany` predicated on the status the loop read, and a miss is skipped.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
}));
const getDispute = jest.fn();
jest.mock("../../lib/payments", () => ({
  getDispute: (...a: unknown[]) => getDispute(...a),
}));

const updateMany = jest.fn(async ({ where }: { where: { status: string } }) =>
  // The row moved to LOST underneath the run: the CAS on UNDER_REVIEW misses.
  where.status === "UNDER_REVIEW" ? { count: 0 } : { count: 1 },
);
const update = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    dispute: {
      findMany: jest.fn(async () => [
        {
          disputeId: "dp_1",
          status: "UNDER_REVIEW",
          paymentGateway: "STRIPE",
          dueBy: null,
          evidence: null,
          payment: {},
        },
      ]),
      updateMany: (...a: unknown[]) => updateMany(...(a as [never])),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));

import { reconcileDisputes } from "../../scripts/disputes/reconcile-disputes";

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_ENABLED = "true";
});

describe("dispute reconciliation is a CAS on the status it read", () => {
  it("does not overwrite a dispute whose status changed mid-run", async () => {
    getDispute.mockResolvedValue({
      status: "needs_response",
      evidence: {},
      isChargeRefundable: true,
      dueBy: null,
    });

    const result = await reconcileDisputes();

    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      disputeId: "dp_1",
      status: "UNDER_REVIEW",
    });
    // The miss is a skip, not a reconciliation and not an error.
    expect(result.reconciledCount).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
