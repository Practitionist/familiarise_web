/**
 * @jest-environment node
 */

/**
 * #1943 — `POST /api/cleanup/reconcile-ledgers` runs a full-scope ledger
 * reconciliation directly via `runReconcileLedgers({ scope: "full" })` under
 * its cron lock.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  withCronLock: jest.fn(),
}));

const runReconcileLedgers = jest.fn(async (args: { scope: string }) => ({
  id: "rep_full",
  scope: args.scope,
  ok: true,
  summary: { discrepanciesCount: 0 },
}));
jest.mock("../../scripts/reconcile/reconcile-ledgers", () => {
  const actual = jest.requireActual<
    typeof import("../../scripts/reconcile/reconcile-ledgers")
  >("../../scripts/reconcile/reconcile-ledgers");
  return {
    ...actual,
    runReconcileLedgers: (...args: [{ scope: string }]) =>
      runReconcileLedgers(...args),
  };
});

import { NextRequest } from "next/server";
import { POST } from "../../app/api/cleanup/[job]/route";

const SECRET = "test-cron-secret";

function invokeReconcile(): NextRequest {
  return new NextRequest("https://x.test/api/cleanup/reconcile-ledgers", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
});

describe("POST /api/cleanup/reconcile-ledgers", () => {
  it("runs a full-scope ledger reconciliation and answers OK", async () => {
    const res = await POST(invokeReconcile(), {
      params: Promise.resolve({ job: "reconcile-ledgers" }),
    });

    expect(res.status).toBe(200);
    expect(runReconcileLedgers).toHaveBeenCalledWith({ scope: "full" });
    expect(await res.json()).toMatchObject({
      status: "OK",
      report: { id: "rep_full", scope: "full", ok: true },
    });
  });
});
