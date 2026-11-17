/** @jest-environment node */
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  getIsolationScope: () => ({ setTag: jest.fn() }),
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

import { NextRequest, NextResponse } from "next/server";

const dispatch = jest.fn();
const audit = jest.fn().mockResolvedValue({ id: "audit" });
const authorize = jest.fn();
const maintenance = jest.fn();
const guard = jest.fn();
const after = jest.fn();
const create = jest.fn();
const findOpen = jest.fn();
const findByKey = jest.fn();
const statusWrite = jest.fn();
const runRequest = jest.fn();
const tx = { adminRunRequest: { create } };
const db = {
  $transaction: jest.fn<Promise<unknown>, [(client: typeof tx) => unknown]>(
    async (fn) => fn(tx),
  ),
  adminRunRequest: {
    findFirst: findOpen,
    findUnique: findByKey,
    updateMany: statusWrite,
  },
};
let post: typeof import("../../app/api/admin/system-jobs/run/route").POST;
let registry: typeof import("../../lib/cron/cleanup-registry");
let schedule: typeof import("../../lib/cron/schedule");

beforeAll(async () => {
  const dependencies = new Map<string, unknown>([
    ["@/lib/prisma", { __esModule: true, default: db }],
    ["@/lib/auth-helpers", { requireBackofficeSurface: authorize }],
    ["@/lib/backoffice/ops-action-log", { recordOpsAction: audit }],
    ["@/lib/maintenance-edge", { getMaintenanceState: maintenance }],
    [
      "@/lib/maintenance-cron",
      {
        assertNotInMaintenance: guard,
        MaintenanceActiveError: class extends Error {},
        MaintenanceUnavailableError: class extends Error {},
      },
    ],
    [
      "@/lib/cron/dispatch-background",
      {
        ...jest.requireActual("@/lib/cron/dispatch-background"),
        dispatchBackgroundJob: dispatch,
      },
    ],
    ["@/lib/observability/report", { reportSentryError: jest.fn() }],
    ["@/lib/api/after-safe", { scheduleAfter: after }],
    [
      "@/lib/cron/schedule",
      {
        ...jest.requireActual("@/lib/cron/schedule"),
        latestWindowStart: jest.fn(
          jest.requireActual("@/lib/cron/schedule").latestWindowStart,
        ),
      },
    ],
  ]);
  for (const [name, mock] of dependencies) jest.doMock(name, () => mock);
  // Lazy, so the actual module loads behind the mocks above.
  jest.doMock("@/lib/cron/admin-run-requests", () => ({
    ...jest.requireActual("@/lib/cron/admin-run-requests"),
    runAdminRunRequest: runRequest,
  }));
  post = (await import("../../app/api/admin/system-jobs/run/route")).POST;
  registry = await import("../../lib/cron/cleanup-registry");
  schedule = await import("../../lib/cron/schedule");
});

beforeEach(() => {
  jest.clearAllMocks();
  authorize.mockResolvedValue({
    session: { user: { id: "admin", role: "ADMIN", name: "Admin" } },
  });
  maintenance.mockResolvedValue({ phase: "OFF" });
  guard.mockResolvedValue(undefined);
  dispatch.mockResolvedValue({ accepted: true, job: "transfer-recordings" });
});

function request(jobId = "transfer-recordings", idempotencyKey?: string) {
  return new NextRequest(
    "https://untrusted-request-host.test/api/admin/system-jobs/run",
    {
      method: "POST",
      body: JSON.stringify({
        jobId,
        reason: "Recover verified recording",
        idempotencyKey,
      }),
    },
  );
}

const KEY_A = "6f1c2a8e-4b7d-4c1e-9a3f-1d2e3f4a5b6c";
const KEY_B = "0a9b8c7d-6e5f-4a3b-8c1d-2e3f4a5b6c7d";
const created = async ({ data }: { data: Record<string, unknown> }) => ({
  ...data,
  status: "REQUESTED",
  attempts: 0,
});

it("runs the registry handler in-process without the cron secret and records ACCEPTED", async () => {
  delete process.env.CRON_SECRET;
  const response = await post(request());
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    accepted: true,
    job: "transfer-recordings",
    dispatched: true,
    message: "Queued for processing. Check execution history for completion.",
  });
  expect(dispatch).toHaveBeenCalledWith("transfer-recordings");
  expect(guard).toHaveBeenCalledWith("transfer-recordings");
  expect(audit).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      id: expect.any(String),
      targetId: "transfer-recordings",
      after: { status: "ACCEPTED", httpStatus: 202 },
    }),
  );
  expect(after).not.toHaveBeenCalled();
});

it("records FAILED with the route's stable message when worker admission fails", async () => {
  dispatch.mockRejectedValueOnce(
    new Error("private worker configuration diagnostic"),
  );
  const response = await post(request());
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain("diagnostic");
  expect(audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ after: { status: "FAILED", httpStatus: 500 } }),
  );
});

it("commits the payout request and its audit row before the 202, then dispatches after it", async () => {
  create.mockImplementationOnce(created);
  const response = await post(request("process-payouts"));
  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body).toMatchObject({ status: "REQUESTED", existing: false });
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      id: body.requestId,
      job: "process-payouts",
      requestedBy: "admin",
      // An older client sends no key; the server mints one.
      idempotencyKey: expect.any(String),
    }),
  });
  expect(audit).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      id: body.requestId,
      after: { status: "REQUESTED", requestId: body.requestId },
    }),
  );
  // The 202 has gone out with the row committed and still REQUESTED; a lost callback leaves it so.
  expect(after).toHaveBeenCalledTimes(1);
  expect(create.mock.invocationCallOrder[0]).toBeLessThan(
    after.mock.invocationCallOrder[0],
  );
  expect(statusWrite).not.toHaveBeenCalled();
  expect(runRequest).not.toHaveBeenCalled();
  await after.mock.calls[0][0]();
  expect(runRequest).toHaveBeenCalledWith(
    expect.objectContaining({ id: body.requestId, job: "process-payouts" }),
  );

  for (const legacy of ["cleanup-approval-payments", "constructor"]) {
    expect((await post(request(legacy))).status).toBe(400);
  }
});

it("returns the job's open request on a unique conflict and dispatches nothing", async () => {
  db.$transaction.mockRejectedValueOnce(
    Object.assign(new Error("unique"), { code: "P2002" }),
  );
  findOpen.mockResolvedValueOnce({ id: "open-1", status: "CLAIMED" });
  const response = await post(request("process-payouts"));
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    requestId: "open-1",
    status: "CLAIMED",
    existing: true,
  });
  expect(after).not.toHaveBeenCalled();
});

it("returns a retried click's request in any status without scheduling it again", async () => {
  db.$transaction.mockRejectedValueOnce(
    Object.assign(new Error("unique"), { code: "P2002" }),
  );
  findByKey.mockResolvedValueOnce({ id: "req-a", status: "DONE" });
  const retry = await post(request("process-payouts", KEY_A));
  expect(await retry.json()).toMatchObject({
    requestId: "req-a",
    status: "DONE",
    existing: true,
  });
  expect(findByKey).toHaveBeenCalledWith({
    where: {
      job_idempotencyKey: { job: "process-payouts", idempotencyKey: KEY_A },
    },
  });
  expect(after).not.toHaveBeenCalled();

  create.mockImplementationOnce(created);
  const fresh = await post(request("process-payouts", KEY_B));
  expect(await fresh.json()).toMatchObject({ existing: false });
  expect(create).toHaveBeenLastCalledWith({
    data: expect.objectContaining({ idempotencyKey: KEY_B }),
  });
  expect(after).toHaveBeenCalledTimes(1);
});

it("does not dispatch when authentication or maintenance refuses the request", async () => {
  authorize.mockResolvedValueOnce({
    error: NextResponse.json({}, { status: 403 }),
  });
  expect((await post(request())).status).toBe(403);
  maintenance.mockResolvedValueOnce({ phase: "OFFLINE" });
  expect((await post(request())).status).toBe(503);
  expect(dispatch).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});

it("repeats a windowed job's latest due window and refuses when none has come due", async () => {
  const handlers = registry.getCleanupJobHandlers("settle-invoice-accruals");
  if (!handlers) throw new Error("settle-invoice-accruals is not registered");
  const invoke = jest
    .spyOn(handlers, "invoke")
    .mockResolvedValue(
      NextResponse.json({}, { headers: { "X-Job-Outcome": "success" } }),
    );
  const at = new Date();
  const response = await post(request("settle-invoice-accruals"));
  expect(response.status).toBe(200);
  const sent = invoke.mock.calls[0][0].nextUrl.searchParams;
  expect(sent.get("windowStart")).toBe(
    schedule.latestWindowStart("settle-invoice-accruals", at)?.toISOString(),
  );
  expect(sent.get("limit")).toBe("10");

  jest.mocked(schedule.latestWindowStart).mockReturnValueOnce(null);
  const refused = await post(request("settle-invoice-accruals"));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "NO_DUE_WINDOW" });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it.each([
  ["partial", 207, "PARTIAL"],
  ["attention", 207, "SUCCEEDED"],
  ["held", 409, "HELD"],
])("audits a %s run as %s", async (runOutcome, httpStatus, auditStatus) => {
  const handlers = registry.getCleanupJobHandlers("reconcile-refunds");
  if (!handlers) throw new Error("reconcile-refunds is not registered");
  jest.spyOn(handlers, "invoke").mockResolvedValueOnce(
    NextResponse.json(
      {},
      {
        status: Number(httpStatus),
        headers: {
          "X-Job-Outcome": "success",
          "X-Run-Outcome": String(runOutcome),
        },
      },
    ),
  );
  await post(request("reconcile-refunds"));
  expect(audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      after: { status: auditStatus, httpStatus },
    }),
  );
});
