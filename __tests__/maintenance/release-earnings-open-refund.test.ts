/**
 * @jest-environment node
 */

/**
 * #1775 P-2 — the release sweep moved PENDING earnings past their hold to
 * READY without reading refunds, so a seat whose refund was still in flight
 * could be paid out. The open-refund predicate rides the cohort AND the CAS.
 */

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: jest.fn(
    async (_key: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

type Where = {
  status?: string;
  payment?: { refunds?: { none?: { status?: string } } };
};
const refundStatus: Record<string, string> = { ce_1: "PENDING" };
const matches = (id: string, where: Where) =>
  !where.payment?.refunds?.none ||
  refundStatus[id] !== where.payment.refunds.none.status;
const ROW = {
  id: "ce_1",
  status: "PENDING",
  holdUntil: new Date("2026-06-01T00:00:00.000Z"),
  consultantSharePaise: 90_000,
  consultantProfile: { user: { name: "C", email: "c@x" } },
  payment: { id: "pay_1", amount: 100_000 },
};

jest.mock("../../lib/prisma", () => {
  const consultantEarnings = {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      matches(ROW.id, where) ? [ROW] : [],
    ),
    updateMany: jest.fn(async ({ where }: { where: Where }) => ({
      count: matches(ROW.id, where) ? 1 : 0,
    })),
  };
  const organizationEarnings = {
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 0 })),
  };
  const client = { consultantEarnings, organizationEarnings };
  return {
    __esModule: true,
    default: {
      ...client,
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
      $disconnect: jest.fn(),
    },
  };
});

import prisma from "@/lib/prisma";
import { releaseEarningsFromHold } from "@/scripts/earnings/release-earnings";

it("holds an earning while its payment has a PENDING refund, releases it once settled", async () => {
  const held = await releaseEarningsFromHold();
  expect(held.releasedCount).toBe(0);
  const claim = (prisma.consultantEarnings.updateMany as jest.Mock).mock
    .calls[0][0];
  expect(claim.where.payment.refunds.none.status).toBe("PENDING");

  refundStatus.ce_1 = "SUCCEEDED";
  const released = await releaseEarningsFromHold();
  expect(released.releasedCount).toBe(1);
});

it("#1569 D10 — the claim also keeps an earning whose booking owes a miss PENDING", async () => {
  await releaseEarningsFromHold();
  const claim = (prisma.consultantEarnings.updateMany as jest.Mock).mock
    .calls[0][0];
  expect(claim.where.payment.OR).toEqual([
    { appointmentId: null },
    {
      appointment: {
        AND: [
          {
            occurrences: {
              none: expect.objectContaining({ seatsSettledAt: null }),
            },
          },
          {
            occurrences: {
              none: expect.objectContaining({ completionStatus: "UNVERIFIED" }),
            },
          },
        ],
      },
    },
  ]);
});
