/**
 * @jest-environment node
 */

/**
 * #1943 — a full-scope or org-scoped POST /api/admin/reconcile-ledgers runs
 * `runReconcileLedgers` directly in-process under its cron lock, avoiding the
 * removed `/.netlify/functions/reconcile-ledgers-background` HTTP hop that
 * caused a 502 error.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1" } },
  })),
}));

const findMany = jest.fn(
  async (..._args: unknown[]): Promise<unknown[]> => [],
);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    ledgerReconciliationReport: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

const runReconcileLedgers = jest.fn(async (..._args: unknown[]) => ({
  id: "rep_1",
  ok: true,
}));
jest.mock("../../scripts/reconcile/reconcile-ledgers", () => ({
  runReconcileLedgers: (...args: unknown[]) => runReconcileLedgers(...args),
  isReconcileRunInProgress: (row: { summary: { status?: string } }) =>
    row.summary?.status === "RUNNING",
  RECONCILE_RUN_STALE_MS: 45 * 60 * 1000,
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/reconcile-ledgers/route";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";

const fetchMock = jest.fn(async () => new Response(null, { status: 202 }));

function post(body: unknown) {
  return new NextRequest("https://x.test/api/admin/reconcile-ledgers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("POST /api/admin/reconcile-ledgers", () => {
  it("runs a full-scope reconciliation in-process and answers 200 with the report", async () => {
    const res = await POST(post({}));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ id: "rep_1", ok: true });
    expect(runReconcileLedgers).toHaveBeenCalledWith({
      scope: "full",
      triggeredById: "admin_1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 409 when a full-scope run is already in progress", async () => {
    findMany.mockResolvedValueOnce([
      { id: "run_active", runAt: new Date(), summary: { status: "RUNNING" } },
    ]);

    const res = await POST(post({}));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.reportId).toBe("run_active");
    expect(runReconcileLedgers).not.toHaveBeenCalled();
  });

  it("answers 409 when the reconcile-ledgers cron lock is held", async () => {
    runReconcileLedgers.mockRejectedValueOnce(
      new CronLockHeldError("reconcile-ledgers"),
    );

    const res = await POST(post({}));
    expect(res.status).toBe(409);
  });

  it("keeps an org-scoped run synchronous", async () => {
    const res = await POST(post({ organizationId: "org_1" }));

    expect(res.status).toBe(200);
    expect(runReconcileLedgers).toHaveBeenCalledWith({
      scope: "org:org_1",
      organizationId: "org_1",
      triggeredById: "admin_1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
