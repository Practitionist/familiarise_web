/** @jest-environment node */

/**
 * POST /api/admin/payouts/process disburses every APPROVED payout.
 *
 * The route is a `withOpsAction` door, so the run is bound to the
 * authenticated admin: the actor's id is what reaches the payout service as
 * `triggeredByUserId`, and the maker-checker rule that skips a payout the
 * caller approved themselves is decided from that same id.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(),
}));
jest.mock("../../lib/auth/step-up", () => ({
  requireFreshSession: jest.fn(() => null),
}));
jest.mock("../../lib/backoffice/money-limit", () => ({
  assertMoneyOpsBudget: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/payouts", () => ({
  REQUEST_PAYOUT_RUN_BOUNDS: { budgetMs: 8000, lockTtlMs: 120000 },
  processApprovedPayouts: jest.fn(async () => []),
}));

const create = jest.fn(async (_args: unknown) => ({ id: "row" }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (t: unknown) => unknown) =>
      fn({ opsActionLog: { create } }),
    opsActionLog: { create: (a: unknown) => create(a) },
  },
}));

import { NextRequest, NextResponse } from "next/server";
import { requireBackofficeSurface } from "../../lib/auth-helpers";
import { processApprovedPayouts } from "../../lib/payments/payouts";
import { POST } from "../../app/api/admin/payouts/process/route";

const post = (body: unknown) =>
  POST(
    new NextRequest("https://test/api/admin/payouts/process", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({} as never) },
  );

beforeEach(() => jest.clearAllMocks());

it("binds a manual payout run to its authenticated admin for maker-checker enforcement", async () => {
  (requireBackofficeSurface as jest.Mock).mockResolvedValue({
    session: { user: { id: "checker-admin", role: "ADMIN" } },
  });
  const response = await post({ reason: "monthly disbursement run" });
  expect(response.status).toBe(200);
  expect(processApprovedPayouts).toHaveBeenCalledWith({
    budgetMs: 8000,
    lockTtlMs: 120000,
    triggeredByUserId: "checker-admin",
  });
});

it("does not process when admin authorization fails", async () => {
  (requireBackofficeSurface as jest.Mock).mockResolvedValue({
    error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  });
  expect((await post({ reason: "monthly disbursement run" })).status).toBe(403);
  expect(processApprovedPayouts).not.toHaveBeenCalled();
});

it("refuses a run with no reason and moves no money", async () => {
  (requireBackofficeSurface as jest.Mock).mockResolvedValue({
    session: { user: { id: "checker-admin", role: "ADMIN" } },
  });
  expect((await post({})).status).toBe(400);
  expect(processApprovedPayouts).not.toHaveBeenCalled();
});
