/**
 * @jest-environment node
 */

/**
 * #1771 K-8 — a reconcile job whose cron lock is held answers 409
 * ALREADY_RUNNING, and the attempt still leaves its audit row.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1", role: "ADMIN" } },
  })),
}));
const create = jest.fn(async (_a: unknown) => ({ id: "row" }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { opsActionLog: { create: (a: unknown) => create(a) } },
}));
jest.mock("../../lib/maintenance-edge", () => ({
  getMaintenanceState: async () => ({ phase: "OFF" }),
}));
jest.mock("../../scripts/refunds/reconcile-pending-refunds", () => {
  const { CronLockHeldError } = jest.requireActual(
    "../../lib/cron/cron-lock-errors",
  );
  return {
    reconcilePendingRefunds: async () => {
      throw new CronLockHeldError("reconcile-pending-refunds");
    },
  };
});
jest.mock("../../scripts/payments/reconcile-payment-status", () => ({}));
jest.mock("../../scripts/earnings/sync-payment-earnings", () => ({}));
jest.mock("../../app/api/admin/reconcile-ledgers/route", () => ({}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/reconcile/[job]/route";

it("answers 409 ALREADY_RUNNING and logs the attempt", async () => {
  const res = await POST(
    new NextRequest("https://x.test/api/admin/reconcile/refunds", {
      method: "POST",
      body: JSON.stringify({ reason: "refund stuck since noon" }),
    }),
    { params: Promise.resolve({ job: "refunds" } as never) },
  );
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("ALREADY_RUNNING");
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0]).toMatchObject({
    data: {
      targetId: "refunds",
      after: { status: "FAILED", code: "CRON_LOCK_HELD" },
    },
  });
});
