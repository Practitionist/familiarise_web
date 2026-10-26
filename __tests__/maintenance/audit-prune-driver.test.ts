/** @jest-environment node */
import {
  pruneAuditLogs,
  disconnectDatabase,
} from "../../scripts/cleanup/prune-audit-logs";

jest.mock("dotenv/config", () => ({}));
jest.mock("../../scripts/cleanup/prune-audit-logs", () => ({
  pruneAuditLogs: jest.fn(),
  disconnectDatabase: jest.fn(),
}));
jest.mock("../../lib/maintenance-cron", () => ({
  abortIfMaintenance: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ logger: { info: jest.fn() } }));
jest.mock("../../lib/observability/job-sentry", () => ({ runJob: jest.fn() }));
import "../../jobs/cleanup/prune-audit-logs";

const { runJob } = jest.requireMock<{
  runJob: jest.Mock<void, [string, () => Promise<void>]>;
}>("../../lib/observability/job-sentry");
const runDriver = runJob.mock.calls[0][1];
const prune = jest.mocked(pruneAuditLogs);
const disconnect = jest.mocked(disconnectDatabase);
const NOW = new Date("2026-10-23T12:00:00Z");
const previousExitCode = process.exitCode;

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.spyOn(console, "log").mockImplementation(() => {});
  prune.mockResolvedValue({
    scanned: 1,
    deleted7y: 0,
    deleted2y: 1,
    perOrgSummaries: 1,
    cutoff7y: "cutoff7y",
    cutoff2y: "cutoff2y",
    success: true,
    errors: [],
    hasMore: true,
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  process.exitCode = previousExitCode;
});

it("caps a progressing backlog at forty canonical slices", async () => {
  await runDriver();
  expect(prune).toHaveBeenCalledTimes(40);
  for (const [options] of prune.mock.calls)
    expect(options).toEqual({ limit: 500, startedAt: NOW.getTime() });
  expect(disconnect).toHaveBeenCalledTimes(1);
});

it("stops when one bounded slice cannot make progress", async () => {
  prune.mockResolvedValue({
    scanned: 1,
    deleted7y: 0,
    deleted2y: 0,
    perOrgSummaries: 0,
    cutoff7y: "cutoff7y",
    cutoff2y: "cutoff2y",
    success: true,
    errors: [],
    hasMore: true,
  });
  await runDriver();
  expect(prune).toHaveBeenCalledTimes(1);
});

it("shares its start budget across otherwise progressing slices", async () => {
  prune.mockImplementation(async () => {
    jest.setSystemTime(NOW.getTime() + 16_000);
    return {
      scanned: 1,
      deleted7y: 0,
      deleted2y: 1,
      perOrgSummaries: 1,
      cutoff7y: "cutoff7y",
      cutoff2y: "cutoff2y",
      success: true,
      errors: [],
      hasMore: true,
    };
  });
  await runDriver();
  expect(prune).toHaveBeenCalledTimes(1);
});

it("does not invoke another slice after a completed backlog", async () => {
  prune.mockResolvedValue({
    scanned: 0,
    deleted7y: 0,
    deleted2y: 0,
    perOrgSummaries: 0,
    cutoff7y: "cutoff7y",
    cutoff2y: "cutoff2y",
    success: true,
    errors: [],
    hasMore: false,
  });
  await runDriver();
  expect(prune).toHaveBeenCalledTimes(1);
});

it("disconnects when a core invocation rejects", async () => {
  prune.mockRejectedValue(new Error("unavailable"));
  await expect(runDriver()).rejects.toThrow("unavailable");
  expect(disconnect).toHaveBeenCalledTimes(1);
});
