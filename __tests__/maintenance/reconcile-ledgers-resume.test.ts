/**
 * @jest-environment node
 */

/**
 * #1633 — the ticker's backstop for a background driver that is never
 * invoked. `POST /api/cleanup/reconcile-ledgers?resume=1` must advance the
 * newest RUNNING full-scope run by one chunk, answer IDLE when none is in
 * flight, and ignore a run older than the stale window. The auditor and the
 * lock are mocked; this pins the twin's routing, not the reconcile itself.
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
  withCronLock: jest.fn(),
}));

const findMany = jest.fn(async (_args: unknown): Promise<unknown[]> => []);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    ledgerReconciliationReport: {
      findMany: (args: unknown) => findMany(args),
    },
  },
}));

const advanceReconcileRun = jest.fn(async (args: { runId: string }) => ({
  runId: args.runId,
  scope: "full",
  status: "RUNNING" as const,
  progress: { step: 3, cursor: null, calls: 2, startedAt: "" },
  report: null,
}));
jest.mock("../../scripts/reconcile/reconcile-ledgers", () => {
  const actual = jest.requireActual<
    typeof import("../../scripts/reconcile/reconcile-ledgers")
  >("../../scripts/reconcile/reconcile-ledgers");
  return {
    ...actual,
    advanceReconcileRun: (...args: [{ runId: string }]) =>
      advanceReconcileRun(...args),
    markReconcileRunFailed: jest.fn(),
  };
});

import { NextRequest } from "next/server";
import { POST } from "../../app/api/cleanup/reconcile-ledgers/route";

const SECRET = "test-cron-secret";

function resume(): NextRequest {
  return new NextRequest(
    "https://x.test/api/cleanup/reconcile-ledgers?resume=1",
    { method: "POST", headers: { authorization: `Bearer ${SECRET}` } },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
});

describe("POST /api/cleanup/reconcile-ledgers?resume=1", () => {
  it("advances the newest RUNNING full-scope run by one chunk", async () => {
    findMany.mockResolvedValueOnce([
      { id: "run_done", summary: { status: "COMPLETED" } },
      { id: "run_live", summary: { status: "RUNNING" } },
    ]);

    const res = await POST(resume());

    expect(res.status).toBe(200);
    expect(advanceReconcileRun).toHaveBeenCalledWith({ runId: "run_live" });
    expect(await res.json()).toMatchObject({
      status: "RUNNING",
      runId: "run_live",
    });
    // The lookup itself excludes stale rows: it asks only for the window.
    const where = findMany.mock.calls[0][0] as {
      where: { scope: string; runAt: { gte: Date } };
    };
    expect(where.where.scope).toBe("full");
    expect(Date.now() - where.where.runAt.gte.getTime()).toBeGreaterThan(
      40 * 60 * 1000,
    );
  });

  it("answers IDLE, and opens nothing, when no run is in flight", async () => {
    findMany.mockResolvedValueOnce([
      { id: "run_failed", summary: { status: "FAILED" } },
    ]);

    const res = await POST(resume());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "IDLE", runId: null });
    expect(advanceReconcileRun).not.toHaveBeenCalled();
  });
});
