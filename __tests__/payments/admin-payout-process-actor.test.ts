/** @jest-environment node */
jest.mock("../../lib/auth-helpers", () => ({ requireAdminAuth: jest.fn() }));
jest.mock("../../lib/auth/step-up", () => ({
  requireFreshSession: jest.fn(() => null),
}));
jest.mock("../../lib/payments/payouts", () => ({
  REQUEST_PAYOUT_RUN_BOUNDS: { budgetMs: 8000, lockTtlMs: 120000 },
  processApprovedPayouts: jest.fn(async () => []),
}));
import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "../../lib/auth-helpers";
import { processApprovedPayouts } from "../../lib/payments/payouts";
import { POST } from "../../app/api/admin/payouts/process/route";

beforeEach(() => jest.clearAllMocks());
it("binds a manual payout run to its authenticated admin for maker-checker enforcement", async () => {
  (requireAdminAuth as jest.Mock).mockResolvedValue({
    session: { user: { id: "checker-admin" } },
  });
  const response = await POST(
    new NextRequest("https://test/api/admin/payouts/process", {
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  expect(processApprovedPayouts).toHaveBeenCalledWith({
    budgetMs: 8000,
    lockTtlMs: 120000,
    triggeredByUserId: "checker-admin",
  });
});
it("does not process when admin authorization fails", async () => {
  (requireAdminAuth as jest.Mock).mockResolvedValue({
    error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  });
  expect(
    (
      await POST(
        new NextRequest("https://test/api/admin/payouts/process", {
          method: "POST",
        }),
      )
    ).status,
  ).toBe(403);
  expect(processApprovedPayouts).not.toHaveBeenCalled();
});
