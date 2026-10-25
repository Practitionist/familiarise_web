/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
const mockExpire = jest.fn();
const mockRecover = jest.fn();
const mockWindDown = jest.fn();
const mockSync = jest.fn();
const mockChannels = jest.fn();
jest.mock("../../lib/stream/recording-retention", () => ({
  expireRecordings: mockExpire,
}));
jest.mock("../../scripts/stream/reconcile-orphaned-recordings", () => ({
  reconcileOrphanedRecordings: mockRecover,
}));
jest.mock("../../jobs/stream/wind-down-deactivated-orgs", () => ({
  windDownDeactivatedOrgs: mockWindDown,
}));
jest.mock("../../scripts/stream/stream-sync", () => ({
  performStreamUserSync: mockSync,
}));
jest.mock("../../jobs/stream/expire-event-channels", () => ({
  expireEventChannels: mockChannels,
}));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class extends Error {},
}));
jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: jest.fn(),
}));
jest.mock("../../lib/observability/job-sentry", () => ({
  initJobSentry: jest.fn(),
  flushJobSentry: jest.fn().mockResolvedValue(true),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
  logger: { info: jest.fn() },
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
import { STREAM_LIFECYCLE_JOBS } from "../../lib/cron/schedule";
import { assertNotInMaintenance } from "../../lib/maintenance-cron";
import { flushJobSentry } from "../../lib/observability/job-sentry";
const mocks = new Map([
  ["expire-recordings", mockExpire],
  ["reconcile-orphaned-recordings", mockRecover],
  ["wind-down-deactivated-orgs", mockWindDown],
  ["stream-sync", mockSync],
  ["expire-event-channels", mockChannels],
]);
function loadWorker() {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "../../netlify/functions/stream-maintenance-background.mts",
    ),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const exports: Partial<
    typeof import("../../netlify/functions/stream-maintenance-background.mjs")
  > = {};
  vm.runInNewContext(outputText, {
    module: { exports },
    exports,
    require,
    process,
    URL,
  });
  if (!exports.default || !exports.config)
    throw new Error("Missing lifecycle worker exports");
  return { run: exports.default, config: exports.config };
}
const worker = loadWorker();
const priorSecret = process.env.CRON_SECRET;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "test-lifecycle";
  for (const mock of mocks.values()) mock.mockResolvedValue({ success: true });
});
afterAll(() => {
  if (priorSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = priorSecret;
});
const request = (job: string, secret = "test-lifecycle", method = "POST") =>
  new Request(
    `https://test.invalid/.netlify/functions/stream-maintenance-background?job=${job}`,
    { method, headers: { authorization: `Bearer ${secret}` } },
  );
it("has no independent schedule", () =>
  expect(worker.config).toEqual({ background: true }));
it.each(STREAM_LIFECYCLE_JOBS)(
  "executes only the selected %s core after shared admission",
  async (job) => {
    await worker.run(request(job));
    expect(assertNotInMaintenance).toHaveBeenCalledWith(job);
    for (const [name, mock] of mocks)
      expect(mock).toHaveBeenCalledTimes(name === job ? 1 : 0);
    expect(flushJobSentry).toHaveBeenCalledTimes(1);
  },
);
it.each(STREAM_LIFECYCLE_JOBS)(
  "throws instead of returning a discarded failed %s response",
  async (job) => {
    mocks.get(job)?.mockResolvedValueOnce({ success: false });
    await expect(worker.run(request(job))).rejects.toThrow("HTTP 500");
    expect(flushJobSentry).toHaveBeenCalledTimes(1);
  },
);
it("refuses wrong bearers, unknown targets and non-POST requests without executing any core", async () => {
  await worker.run(request("stream-sync", "wrong"));
  await worker.run(request("transfer-recordings"));
  await worker.run(request("stream-sync", "test-lifecycle", "GET"));
  for (const mock of mocks.values()) expect(mock).not.toHaveBeenCalled();
});
it("preserves dry-run dispatch for principal sync", async () => {
  const req = request("stream-sync");
  const url = new URL(req.url);
  url.searchParams.set("dry-run", "true");
  await worker.run(new Request(url, req));
  expect(mockSync).toHaveBeenCalledWith({ dryRun: true });
});
it("refuses every core when maintenance admission fails", async () => {
  jest
    .mocked(assertNotInMaintenance)
    .mockRejectedValueOnce(new Error("maintenance unavailable"));
  await expect(worker.run(request("stream-sync"))).rejects.toThrow("HTTP 500");
  expect(mockSync).not.toHaveBeenCalled();
});
