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
import * as zod from "zod";

const dispatch = jest.fn();
const audit = jest.fn().mockResolvedValue({ id: "audit" });
const authorize = jest.fn();
const maintenance = jest.fn();
const guard = jest.fn();
const after = jest.fn();
let post: typeof import("../../app/api/admin/system-jobs/run/route").POST;

beforeAll(async () => {
  const dependencies = new Map<string, unknown>([
    ["@/lib/prisma", { __esModule: true, default: {} }],
    ["@/lib/auth-helpers", { requireBackofficeSurface: authorize }],
    [
      "@/lib/backoffice/ops-action-log",
      { recordOpsAction: audit, opsReasonSchema: zod.z.string().min(5) },
    ],
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
  ]);
  for (const [name, mock] of dependencies) jest.doMock(name, () => mock);
  post = (await import("../../app/api/admin/system-jobs/run/route")).POST;
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

function request(jobId = "transfer-recordings") {
  return new NextRequest(
    "https://untrusted-request-host.test/api/admin/system-jobs/run",
    {
      method: "POST",
      body: JSON.stringify({ jobId, reason: "Recover verified recording" }),
    },
  );
}

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
    {},
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
    {},
    expect.objectContaining({ after: { status: "FAILED", httpStatus: 500 } }),
  );
});

it("defers the payout run past the response and refuses ids outside the registry", async () => {
  const deferred = await post(request("process-payouts"));
  expect(deferred.status).toBe(202);
  expect(after).toHaveBeenCalledTimes(1);
  expect(audit).not.toHaveBeenCalled();

  for (const legacy of ["cleanup-approval-payments", "constructor"]) {
    expect((await post(request(legacy))).status).toBe(400);
  }
  expect(audit).not.toHaveBeenCalled();
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
