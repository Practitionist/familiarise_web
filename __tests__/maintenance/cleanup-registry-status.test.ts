/** @jest-environment node */
import type { NextRequest } from "next/server";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  withCronLock: jest.fn(),
}));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
}));
jest.mock("../../jobs/notifications/drain-notification-outbox", () => ({
  drainNotificationOutbox: jest.fn(),
}));
jest.mock("../../lib/stream/dispatch-recording-transfer", () => ({
  dispatchRecordingTransfer: jest.fn(),
}));

import { getCleanupJobHandlers } from "../../lib/cron/cleanup-registry";
import { drainNotificationOutbox } from "../../jobs/notifications/drain-notification-outbox";
import { dispatchRecordingTransfer } from "../../lib/stream/dispatch-recording-transfer";

const SECRET = "test-cron-secret";

function request(slug: string): NextRequest {
  return {
    headers: new Headers({ authorization: `Bearer ${SECRET}` }),
    nextUrl: new URL(`https://example.test/api/cleanup/${slug}`),
  } as unknown as NextRequest;
}

async function hit(slug: string) {
  const handlers = getCleanupJobHandlers(slug);
  if (!handlers) throw new Error(`no cleanup twin for ${slug}`);
  const res = await handlers.POST(request(slug));
  return { status: res.status, outcome: res.headers.get("x-job-outcome") };
}

describe("cleanup registry status callbacks are authoritative", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    jest.clearAllMocks();
  });

  const drainResult = (errors: string[]) => ({
    scanned: 3,
    sent: 2,
    retried: 0,
    deadLettered: 0,
    errors,
  });

  it("drain-notification-outbox answers 500 when a row errored, not the inferred 207", async () => {
    jest
      .mocked(drainNotificationOutbox)
      .mockResolvedValue(drainResult(["Novu 502"]) as never);
    await expect(hit("drain-notification-outbox")).resolves.toEqual({
      status: 500,
      outcome: "failure",
    });
  });

  it("drain-notification-outbox answers 200 on a clean drain", async () => {
    jest
      .mocked(drainNotificationOutbox)
      .mockResolvedValue(drainResult([]) as never);
    await expect(hit("drain-notification-outbox")).resolves.toEqual({
      status: 200,
      outcome: "success",
    });
  });

  it("transfer-recordings acknowledges dispatch without running a synchronous copy", async () => {
    jest
      .mocked(dispatchRecordingTransfer)
      .mockResolvedValue({ accepted: true, job: "transfer-recordings" });
    await expect(hit("transfer-recordings")).resolves.toEqual({
      status: 202,
      outcome: "success",
    });
    expect(dispatchRecordingTransfer).toHaveBeenCalledWith();
  });
  it("does not acknowledge failed worker admission", async () => {
    jest
      .mocked(dispatchRecordingTransfer)
      .mockRejectedValue(new Error("HTTP 503"));
    await expect(hit("transfer-recordings")).resolves.toEqual({
      status: 500,
      outcome: "failure",
    });
  });
});
