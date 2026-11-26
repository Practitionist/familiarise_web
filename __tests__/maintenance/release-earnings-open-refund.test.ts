/**
 * @jest-environment node
 */

// Invariant: an earning is not released while a cash refund on its payment is
// PENDING, or SUCCEEDED with its cascade not yet applied; the claim restates it.

jest.mock("../../lib/cron/with-cron-lock", () =>
  jest.requireActual("../fixtures/earnings-release-world").cronLockModule(),
);

jest.mock("../../lib/prisma", () =>
  jest
    .requireActual("../fixtures/earnings-release-world")
    .earningsPrismaModule(),
);

import prisma from "@/lib/prisma";
import type { Row } from "../fixtures/mem-db";
import {
  seedEarnings,
  type EarningsTable as Table,
} from "../fixtures/earnings-release-world";
import { releaseEarningsFromHold } from "@/scripts/earnings/release-earnings";

const consultantEarnings = prisma.consultantEarnings as unknown as Table;
const organizationEarnings = prisma.organizationEarnings as unknown as Table;

const payment: Row = {
  id: "pay_1",
  amount: 100_000,
  appointmentId: null,
  refundOwedKey: null,
  refunds: [],
};

function seedWithRefund(refund: Row) {
  payment.refunds = [refund];
  seedEarnings(
    { consultantEarnings, organizationEarnings },
    "PENDING",
    payment,
  );
}

beforeEach(() => jest.clearAllMocks());

it.each([
  ["a PENDING refund", { status: "PENDING", cascadedAt: null }, 0],
  [
    "a SUCCEEDED refund whose cascade has not run",
    { status: "SUCCEEDED", cascadedAt: null },
    0,
  ],
  [
    "a SUCCEEDED refund already cascaded",
    { status: "SUCCEEDED", cascadedAt: new Date("2026-09-01") },
    1,
  ],
  ["a FAILED refund", { status: "FAILED", cascadedAt: null }, 1],
  [
    "a zero-amount credit restoration",
    { status: "SUCCEEDED", cascadedAt: null, amountPaise: 0 },
    1,
  ],
])("%s on the payment releases %#: both arms agree", async (_l, refund, n) => {
  seedWithRefund({ amountPaise: 5_000, ...refund });

  const out = await releaseEarningsFromHold();

  expect(out).toMatchObject({
    releasedCount: n,
    organizationEarningsReleased: n,
  });
  expect(consultantEarnings.rows[0].status).toBe(n ? "READY" : "PENDING");
  expect(organizationEarnings.rows[0].status).toBe(n ? "READY" : "PENDING");
});

it("the claim also keeps an earning whose booking owes a miss PENDING", async () => {
  seedWithRefund({ amountPaise: 5_000, status: "FAILED", cascadedAt: null });
  await releaseEarningsFromHold();
  const claim = consultantEarnings.updateMany.mock.calls[0][0];
  expect((claim.where as { payment: { OR: unknown } }).payment.OR).toEqual([
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
          {
            occurrences: {
              none: expect.objectContaining({
                outcome: "LEARNER_ABSENT",
                outcomeConfirmedAt: null,
              }),
            },
          },
        ],
      },
    },
  ]);
});
