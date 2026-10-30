/** @jest-environment node */
const mockExpire = jest.fn();
const mockRecover = jest.fn();
const mockWindDown = jest.fn();
const mockSync = jest.fn();
const mockChannels = jest.fn();
const mockRunCreate = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { systemJobExecution: { create: mockRunCreate } },
}));
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
  MaintenanceUnavailableError: class extends Error {},
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
import streamMaintenance, {
  config as workerConfig,
} from "../../netlify/functions/stream-maintenance-background";
import { STREAM_LIFECYCLE_JOBS } from "../../lib/cron/schedule";
import { assertNotInMaintenance } from "../../lib/maintenance-cron";
import { flushJobSentry } from "../../lib/observability/job-sentry";
import { CronLockUnavailableError } from "../../lib/cron/cron-lock-errors";
const mocks = new Map([
  ["expire-recordings", mockExpire],
  ["reconcile-orphaned-recordings", mockRecover],
  ["wind-down-deactivated-orgs", mockWindDown],
  ["stream-sync", mockSync],
  ["expire-event-channels", mockChannels],
]);
const worker = { run: streamMaintenance, config: workerConfig };
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
  "logs a failed %s run instead of throwing into Netlify's retries",
  async (job) => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    mocks.get(job)?.mockResolvedValueOnce({ success: false });
    await expect(worker.run(request(job))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({ event: "background-worker-failed", job, status: 500 }),
    );
    expect(flushJobSentry).toHaveBeenCalledTimes(1);
    error.mockRestore();
  },
);
it("records a refused lease, which leaves no run row of its own", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockSync.mockRejectedValueOnce(new CronLockUnavailableError("stream-sync"));
  await worker.run(request("stream-sync"));
  expect(mockRunCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        jobName: "stream-sync",
        status: "FAILED",
      }),
    }),
  );
  mockRunCreate.mockClear();
  mockSync.mockResolvedValueOnce({ success: false });
  await worker.run(request("stream-sync"));
  expect(mockRunCreate).not.toHaveBeenCalled();
});
it("refuses off production before any work, whatever the bearer", async () => {
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  await worker.run(request("stream-sync"), {
    deploy: { context: "deploy-preview", id: "d1" },
  });
  for (const mock of mocks.values()) expect(mock).not.toHaveBeenCalled();
  expect(assertNotInMaintenance).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({
      event: "background-worker-refused",
      job: "stream-sync",
      reason: "off-production",
      deployContext: "deploy-preview",
    }),
  );
  log.mockRestore();
});
it("refuses wrong bearers, unknown targets and non-POST requests without executing any core", async () => {
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  await worker.run(request("stream-sync", "wrong"), {
    deploy: { context: "production" },
  });
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({
      event: "background-worker-refused",
      job: "stream-sync",
      reason: "unauthorized",
    }),
  );
  expect(assertNotInMaintenance).not.toHaveBeenCalled();
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
  jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(worker.run(request("stream-sync"))).resolves.toBeUndefined();
  expect(mockSync).not.toHaveBeenCalled();
});
