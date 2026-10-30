/**
 * @jest-environment node
 */
import fs from "fs";
import path from "path";

import { recordSystemError } from "../../lib/enterprise/system-events";

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { systemEvent: { create: jest.fn().mockResolvedValue({}) } },
}));

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const sweepFiles = [
  "jobs/billing/advance-program-cycles.ts",
  "jobs/contracts/auto-renew-contracts.ts",
  "jobs/billing/generate-subscription-invoices.ts",
  "jobs/billing/timeout-member-overages.ts",
  "scripts/cleanup/sweep-abandoned-overage-charges.ts",
  "scripts/appointments/detect-consultant-no-shows.ts",
  "scripts/payouts/handle-stuck-payouts.ts",
];

describe("per-row sweeps report to Sentry once per run", () => {
  it.each(sweepFiles.map((file) => [file]))(
    "%s collects failures and flushes once",
    (file) => {
      const source = read(file);
      expect(source).toContain("createRunFailureReporter(");
      expect(source.match(/\.flush\(\)/g)?.length).toBeGreaterThanOrEqual(1);
      expect(source).not.toContain("Sentry.captureException(");
    },
  );

  it("keeps the SystemEvent row and skips the Sentry capture when asked", async () => {
    await recordSystemError({
      category: "OVERAGE",
      summary: "row failed",
      err: new Error("boom"),
      skipSentry: true,
    });
    expect(captureException).not.toHaveBeenCalled();

    await recordSystemError({
      category: "OVERAGE",
      summary: "row failed",
      err: new Error("boom"),
    });
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
