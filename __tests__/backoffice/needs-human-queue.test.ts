/**
 * @jest-environment node
 */

/**
 * #1824 review — an unrelated later refund keeps a credit seat queued; only an
 * ops credit return after the escalation (or no credit left) settles it.
 */

const refunds: unknown[] = [];
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    refund: { findMany: async () => refunds },
    referralCreditUsage: {
      findMany: async () => [{ paymentId: "pay_1", amount: 59_000 }],
    },
  },
}));

import { dropSettled } from "../../lib/backoffice/needs-human";

const escalatedAt = new Date("2026-09-25T10:00:00Z");
const later = new Date("2026-09-25T11:00:00Z");
const item = { id: "evt_1", createdAt: escalatedAt, paymentId: "pay_1" };

it("keeps the seat after an unrelated refund, drops it after an ops credit return", async () => {
  refunds.push({ paymentId: "pay_1", createdAt: later, metadata: null });
  expect(await dropSettled([item])).toEqual([item]);
  refunds.push({
    paymentId: "pay_1",
    createdAt: later,
    metadata: { source: "free-credit-partial" },
  });
  expect(await dropSettled([item])).toEqual([]);
});
