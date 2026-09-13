/**
 * @jest-environment node
 */

/**
 * #1454 — a full-scope POST /api/admin/reconcile-ledgers must not hold the
 * request open: it opens the run row, hands the run id to the background
 * driver with the cron secret, and answers 202 with that id. An org-scoped
 * POST keeps the synchronous report. Everything below the route is mocked;
 * this pins the route's contract, not the auditor.
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

jest.mock("../../lib/url", () => ({
  getAppUrl: () => "https://deploy-preview-1--site.netlify.app",
}));

const findMany = jest.fn(async (..._args: unknown[]) => []);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    ledgerReconciliationReport: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

const createReconcileRun = jest.fn(async (_opts: unknown, id: string) => id);
const runReconcileLedgers = jest.fn(async (..._args: unknown[]) => ({
  id: "rep_org",
  ok: true,
}));
jest.mock("../../scripts/reconcile/reconcile-ledgers", () => ({
  createReconcileRun: (...args: [unknown, string]) =>
    createReconcileRun(...args),
  runReconcileLedgers: (...args: unknown[]) => runReconcileLedgers(...args),
  markReconcileRunFailed: jest.fn(async () => {}),
  isReconcileRunInProgress: (row: { summary: { status?: string } }) =>
    row.summary?.status === "RUNNING",
  RECONCILE_RUN_STALE_MS: 45 * 60 * 1000,
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/reconcile-ledgers/route";

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
  process.env.CRON_SECRET = "s3cret";
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("POST /api/admin/reconcile-ledgers", () => {
  it("answers 202 with the run id after kicking the background driver", async () => {
    const res = await POST(post({}));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.data.status).toBe("RUNNING");
    expect(body.data.reportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createReconcileRun).toHaveBeenCalledWith(
      { scope: "full", triggeredById: "admin_1" },
      body.data.reportId,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://deploy-preview-1--site.netlify.app/.netlify/functions/reconcile-ledgers-background?runId=${body.data.reportId}&triggeredById=admin_1`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer s3cret" }),
        body: JSON.stringify({
          runId: body.data.reportId,
          triggeredById: "admin_1",
        }),
      }),
    );
    expect(runReconcileLedgers).not.toHaveBeenCalled();
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
