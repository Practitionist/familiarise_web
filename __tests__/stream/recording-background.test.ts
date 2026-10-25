/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

jest.mock("../../lib/stream/recording-transfer-service", () => ({
  transferRecordings: jest.fn(),
}));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class extends Error {},
  MaintenanceUnavailableError: class extends Error {},
}));
jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: jest.fn(),
}));
jest.mock("../../lib/observability/job-sentry", () => ({
  initJobSentry: jest.fn(),
  flushJobSentry: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@sentry/nextjs", () => ({
  logger: { info: jest.fn() },
  flush: jest.fn().mockResolvedValue(true),
}));

import { transferRecordings } from "../../lib/stream/recording-transfer-service";
import { assertNotInMaintenance } from "../../lib/maintenance-cron";
import {
  initJobSentry,
  flushJobSentry,
} from "../../lib/observability/job-sentry";

function loadWorker() {
  const file = path.join(
    __dirname,
    "../../netlify/functions/recording-transfer-background.mts",
  );
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const exports: Partial<
    typeof import("../../netlify/functions/recording-transfer-background.mjs")
  > = {};
  vm.runInNewContext(outputText, {
    module: { exports },
    exports,
    require,
    process,
  });
  if (!exports.default || !exports.config)
    throw new Error("Missing worker exports");
  return { run: exports.default, config: exports.config };
}

const worker = loadWorker();
const runTransfer = jest.mocked(transferRecordings);
const guard = jest.mocked(assertNotInMaintenance);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "worker-test-secret";
  runTransfer.mockResolvedValue({
    success: true,
    reclaimedStale: 0,
    processed: 1,
    succeeded: 1,
    failed: 0,
    exhaustedReported: 0,
    errors: [],
  });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

function request(secret = "worker-test-secret", method = "POST") {
  return new Request(
    "https://site.test/.netlify/functions/recording-transfer-background",
    {
      method,
      headers: { authorization: `Bearer ${secret}` },
    },
  );
}

it("is a background adapter with no independent schedule", () => {
  expect(worker.config).toEqual({ background: true });
});

it("uses the shared authenticated cleanup boundary and existing implementation", async () => {
  await worker.run(request());
  expect(guard).toHaveBeenCalledWith("transfer-recordings");
  expect(runTransfer).toHaveBeenCalledTimes(1);
  expect(initJobSentry).toHaveBeenCalledTimes(1);
  expect(flushJobSentry).toHaveBeenCalledTimes(1);
});

it("never starts work for an invalid bearer or a non-POST invocation", async () => {
  await worker.run(request("wrong"));
  await worker.run(request("worker-test-secret", "GET"));
  expect(runTransfer).not.toHaveBeenCalled();
  expect(guard).not.toHaveBeenCalled();
});

it("surfaces failed execution to Netlify instead of treating admission as completion", async () => {
  runTransfer.mockResolvedValueOnce({
    success: false,
    reclaimedStale: 0,
    processed: 1,
    succeeded: 0,
    failed: 1,
    exhaustedReported: 0,
    errors: ["copy failed"],
  });
  await expect(worker.run(request())).rejects.toThrow("HTTP 500");
  expect(flushJobSentry).toHaveBeenCalledTimes(1);
});

it("does not run the copy when the maintenance guard rejects admission", async () => {
  guard.mockRejectedValueOnce(new Error("maintenance state unavailable"));
  await expect(worker.run(request())).rejects.toThrow("HTTP 500");
  expect(runTransfer).not.toHaveBeenCalled();
});
