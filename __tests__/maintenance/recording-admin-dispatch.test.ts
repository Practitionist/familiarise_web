/** @jest-environment node */
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

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
    ["@/lib/maintenance-cron", { isFinancialJob: () => false }],
    [
      "@/lib/stream/dispatch-recording-transfer",
      { dispatchRecordingTransfer: dispatch },
    ],
    ["@/lib/observability/report", { reportSentryError: diagnostics }],
    ["@/lib/api/after-safe", { scheduleAfter: after }],
  ]);
  for (const [name, mock] of dependencies) jest.doMock(name, () => mock);
  // Unselected jobs must never execute through this dispatch door.
  const unselectedModules = [
    "@/scripts/payments/cleanup-abandoned-payments",
    "@/scripts/payments/reconcile-payment-status",
    "@/scripts/payments/reconcile-orphaned-confirmations",
    "@/scripts/refunds/reconcile-pending-refunds",
    "@/scripts/disputes/reconcile-disputes",
    "@/scripts/earnings/sync-payment-earnings",
    "@/scripts/earnings/release-earnings",
    "@/scripts/appointments/auto-complete-appointments",
    "@/scripts/appointments/expire-stale-requests",
    "@/scripts/appointments/cleanup-tentative-occurrences",
    "@/scripts/appointments/reconcile-occurrence-availability",
    "@/lib/payments/payouts",
    "@/scripts/payouts/handle-stuck-payouts",
    "@/scripts/payouts/reconcile-payout-status",
    "@/lib/auth/cleanup-auth-tokens",
    "@/scripts/cleanup/archive-webhook-events",
    "@/scripts/cleanup/reconcile-document-storage",
    "@/lib/documents/document-purge",
    "@/scripts/alerts/alert-orphaned-payments",
    "@/scripts/stream/stream-sync",
    "@/scripts/stream/reconcile-orphaned-recordings",
    "@/lib/stream/recording-retention",
    "@/jobs/stream/expire-event-channels",
    "@/jobs/meetings/reconcile-orphaned-sessions",
  ];
  for (const name of unselectedModules)
    jest.doMock(name, () => new Proxy({}, { get: () => unexpectedJob }));
  post = (await import("../../app/api/admin/system-jobs/run/route")).POST;
});

beforeEach(() => {
  jest.clearAllMocks();
  authorize.mockResolvedValue({
    session: { user: { id: "admin", role: "ADMIN", name: "Admin" } },
  });
  maintenance.mockResolvedValue({ phase: "OFF" });
  dispatch.mockResolvedValue({ accepted: true, job: "transfer-recordings" });
});
function request(jobId = "transfer-recordings") {
  return new NextRequest(
    "https://untrusted-request-host.test/api/admin/system-jobs/run",
    {
      method: "POST",
      body: JSON.stringify({
        jobId,
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
  expect(await response.json()).toEqual({ error: "Failed to run job" });
  expect(audit).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ after: { status: "FAILED" } }),
  );
  expect(diagnostics).toHaveBeenCalledTimes(1);
});

it("keeps another job's runtime diagnostic out of the staff response while auditing failure", async () => {
  const response = await post(request("cleanup-abandoned-payments"));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Failed to run job" });
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
