/**
 * @jest-environment node
 */

/**
 * The scheduled org batch starts each org's period at its oldest READY,
 * unbatched earning, so an earning that turned READY late is still paid.
 */
const WINDOW = new Date("2026-11-02T20:00:00.000Z");
const OLD = new Date(WINDOW.getTime() - 20 * 24 * 60 * 60 * 1000);
const earning = {
  id: "oe-1",
  organizationId: "org-a",
  createdAt: OLD,
  grossAmountPaise: 100_000,
  platformFeePaise: 10_000,
  orgSharePaise: 90_000,
  refundedAmountPaise: 0,
  currency: "INR",
};
type Range = { gte?: Date; lt: Date };
const inRange = (at: Date, r: Range) => (!r.gte || at >= r.gte) && at < r.lt;

jest.mock("../../lib/prisma", () => {
  const client = {
    organizationEarnings: {
      groupBy: jest.fn(async ({ where }: { where: { createdAt: Range } }) =>
        inRange(earning.createdAt, where.createdAt)
          ? [
              {
                organizationId: earning.organizationId,
                _count: 1,
                _min: { createdAt: earning.createdAt },
              },
            ]
          : [],
      ),
      updateMany: jest.fn(
        async ({ where }: { where: { createdAt?: Range } }) => ({
          count:
            !where.createdAt || inRange(earning.createdAt, where.createdAt)
              ? 1
              : 0,
        }),
      ),
      findMany: jest.fn(async () => [earning]),
    },
    organizationPayoutAccount: {
      findUnique: jest.fn(async () => ({ status: "VERIFIED" })),
    },
    organizationPayout: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: "op-1",
        ...data,
      })),
      update: jest.fn(async () => ({})),
    },
    organization: { findUnique: jest.fn(async () => null) },
    orgAuditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(async () => "tok"),
  releaseLock: jest.fn(async () => undefined),
}));
jest.mock("../../lib/maintenance", () => ({
  getActiveOrgMaintenanceWindow: jest.fn(async () => null),
}));
jest.mock("../../lib/compliance/tds", () => ({
  ...jest.requireActual("../../lib/compliance/tds"),
  resolveEffectiveTdsRate: jest.fn(async () => 0.001),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  recoverClawbackOnPayout: jest.fn(async () => 0),
}));

import { createOrgPayoutBatches } from "@/lib/payments/payouts/org-payout-service";

it("batches an org READY earning created 20 days before the window", async () => {
  const r = await createOrgPayoutBatches({ periodEnd: WINDOW, limit: 10 });
  expect(r).toMatchObject({ payoutsCreated: 1, failed: 0, remaining: 0 });
  expect(r.errors).toEqual([]);
});
