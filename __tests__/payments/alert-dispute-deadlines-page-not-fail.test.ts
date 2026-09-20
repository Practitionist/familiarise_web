/**
 * @jest-environment node
 */

/**
 * #1757 — alert-dispute-deadlines exited 1 on any CRITICAL dispute, so a
 * seeded NEEDS_RESPONSE dispute with `dueBy` in the past kept the hourly job
 * red for weeks. A deadline is a page, not a job failure: the core reports one
 * expected warning per run and the result stays `success: true`.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { dispute: { findMany: jest.fn() }, $disconnect: jest.fn() },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_key: string, _opts: unknown, fn: () => Promise<unknown>) =>
    fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { reportSentryMessage } from "../../lib/observability/report";
import { alertDisputeDeadlines } from "../../scripts/disputes/alert-dispute-deadlines";

const findMany = (prisma as unknown as { dispute: { findMany: jest.Mock } })
  .dispute.findMany;
const mockPage = reportSentryMessage as jest.Mock;

const HOUR = 60 * 60 * 1000;
const pastDue = {
  id: "row_1",
  disputeId: "dsp_past_due",
  status: "NEEDS_RESPONSE",
  amountPaise: 50_000,
  currency: "INR",
  reason: "fraudulent",
  dueBy: new Date(Date.now() - 2 * HOUR),
  paymentId: "pay_1",
  paymentGateway: "RAZORPAY",
  payment: { user: { email: "a@x.com", name: "A" }, appointment: null },
};

beforeEach(() => jest.clearAllMocks());

it("a CRITICAL (past due) dispute → success:true + exactly one expected warning", async () => {
  // Within-48h cohort is empty; the past-due cohort carries the seed row.
  findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([pastDue]);

  const result = await alertDisputeDeadlines();

  expect(result.success).toBe(true);
  expect(result.criticalCount).toBe(1);
  expect(mockPage).toHaveBeenCalledTimes(1);
  expect(mockPage.mock.calls[0][1]).toMatchObject({
    expected: true,
    level: "warning",
    extra: { pastDue: ["dsp_past_due"], critical: [] },
  });
});

it("no critical dispute → no warning", async () => {
  findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

  const result = await alertDisputeDeadlines();

  expect(result.criticalCount).toBe(0);
  expect(mockPage).not.toHaveBeenCalled();
});
