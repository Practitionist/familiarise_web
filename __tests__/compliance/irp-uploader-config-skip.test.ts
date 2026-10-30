/**
 * @jest-environment node
 */

/**
 * Without PLATFORM_GSTIN the uploader touches no invoice and answers a typed
 * skip that the run row records; it never reaches Sentry.
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

it("skips the run with a typed reason and sends nothing to Sentry", async () => {
  delete process.env.PLATFORM_GSTIN;
  jest.spyOn(console, "warn").mockImplementation(() => {});

  const result = await runIrpUploader({ limit: 10 });

  expect(result).toEqual({
    processed: 0,
    failed: 0,
    skippedRows: 0,
    skipped: "PLATFORM_GSTIN not configured",
  });
  expect(prisma.organizationInvoice.findMany).not.toHaveBeenCalled();
  expect(reportSentryMessage).not.toHaveBeenCalled();
});
