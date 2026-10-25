/** @jest-environment node */
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import * as zod from "zod";
import * as Sentry from "@sentry/nextjs";

const dispatch = jest.fn();
const audit = jest.fn().mockResolvedValue({ id: "audit" });
const authorize = jest.fn();
const maintenance = jest.fn();
const diagnostics = jest.mocked(Sentry.captureException);
const after = jest.fn();
const unexpectedJob = jest.fn(() => {
  throw new Error("Unexpected synchronous job execution");
});

function loadRoute() {
  const file = path.join(
    __dirname,
    "../../app/api/admin/system-jobs/run/route.ts",
  );
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const dependencies = new Map<string, unknown>([
    ["next/server", { NextRequest, NextResponse }],
    ["zod", zod],
    ["@sentry/nextjs", Sentry],
    ["@/lib/prisma", { __esModule: true, default: {} }],
    ["@/lib/auth-helpers", { requireBackofficeSurface: authorize }],
    [
      "@/lib/backoffice/ops-action-log",
      { recordOpsAction: audit, opsReasonSchema: zod.z.string().min(5) },
    ],
    ["@/lib/maintenance-edge", { getMaintenanceState: maintenance }],
    ["@/lib/maintenance-cron", { isFinancialJob: () => false }],
    [
      "@/lib/stream/dispatch-recording-transfer",
      { dispatchRecordingTransfer: dispatch },
    ],
    ["@/lib/observability/report", { reportSentryError: diagnostics }],
    ["@/lib/api/after-safe", { scheduleAfter: after }],
  ]);
  // Unselected jobs must never execute through this dispatch door.
  const otherJobs = new Proxy({}, { get: () => unexpectedJob });
  const exports: Partial<
    typeof import("../../app/api/admin/system-jobs/run/route")
  > = {};
  vm.runInNewContext(outputText, {
    exports,
    module: { exports },
    process,
    console,
    Error,
    require: (name: string) => {
      if (dependencies.has(name)) return dependencies.get(name);
      if (
        name.startsWith("@/scripts/") ||
        name.startsWith("@/jobs/") ||
        name.startsWith("@/lib/")
      )
        return otherJobs;
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  if (!exports.POST) throw new Error("Missing route POST export");
  return exports.POST;
}

const post = loadRoute();
beforeEach(() => {
  jest.clearAllMocks();
  authorize.mockResolvedValue({
    session: { user: { id: "admin", role: "ADMIN", name: "Admin" } },
  });
  maintenance.mockResolvedValue({ phase: "OFF" });
  dispatch.mockResolvedValue({ accepted: true, job: "transfer-recordings" });
});
function request() {
  return new NextRequest(
    "https://untrusted-request-host.test/api/admin/system-jobs/run",
    {
      method: "POST",
      body: JSON.stringify({
        jobId: "transfer-recordings",
        reason: "Recover verified recording",
      }),
    },
  );
}

it("records ACCEPTED, never SUCCEEDED, without starting synchronous or after work", async () => {
  const response = await post(request());
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    accepted: true,
    job: "transfer-recordings",
    dispatched: true,
    message: "Queued for processing. Check execution history for completion.",
  });
  expect(dispatch).toHaveBeenCalledWith();
  expect(audit).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      targetId: "transfer-recordings",
      after: { status: "ACCEPTED" },
    }),
  );
  expect(unexpectedJob).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
});

it("records FAILED and returns a generic error when worker admission fails", async () => {
  dispatch.mockRejectedValueOnce(
    new Error("private worker configuration diagnostic"),
  );
  const response = await post(request());
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain(
    "private worker configuration",
  );
  expect(audit).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ after: { status: "FAILED" } }),
  );
  expect(diagnostics).toHaveBeenCalledTimes(1);
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
