/**
 * @jest-environment node
 */

/**
 * Without PLATFORM_GSTIN the uploader touches no invoice, answers a typed
 * skip, and warns Sentry only on the first slot of its daily window.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { organizationInvoice: { findMany: jest.fn() } },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { reportSentryMessage } from "@/lib/observability/report";
import { runIrpUploader } from "@/jobs/compliance/irp-uploader";

it("skips the run with a typed reason and warns once per window", async () => {
  delete process.env.PLATFORM_GSTIN;
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  const first = await runIrpUploader({
    limit: 10,
    windowStart: minutesAgo(25),
  });
  await runIrpUploader({ limit: 10, windowStart: minutesAgo(85) });

  expect(first).toEqual({
    processed: 0,
    failed: 0,
    skippedRows: 0,
    skipped: "PLATFORM_GSTIN not configured",
  });
  expect(prisma.organizationInvoice.findMany).not.toHaveBeenCalled();
  expect(reportSentryMessage).toHaveBeenCalledTimes(1);
});
