/** @jest-environment node */
const consent = jest.fn(),
  breach = jest.fn(),
  disconnect = jest.fn(),
  maintenance = jest.fn();
const callbacks = new Map<string, () => Promise<void>>();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $disconnect: () => disconnect() },
}));
jest.mock("../../lib/compliance/consent-retention", () => ({
  runConsentRetentionSweeper: (opts: unknown) => consent(opts),
}));
jest.mock("../../lib/compliance/databreach-deadline-alerts", () => ({
  runDataBreachDeadlineAlerts: (opts: unknown) => breach(opts),
}));
jest.mock("../../lib/maintenance-cron", () => ({
  abortIfMaintenance: (job: string) => maintenance(job),
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
  MaintenanceUnavailableError: class MaintenanceUnavailableError extends Error {},
}));
jest.mock("../../lib/observability/job-sentry", () => ({
  runJob: (job: string, run: () => Promise<void>) => callbacks.set(job, run),
}));
jest.mock("dotenv/config", () => ({}));

const startedAt = new Date("2026-10-27T00:00:00Z").getTime();
beforeEach(() => {
  jest.resetAllMocks();
  callbacks.clear();
  jest.useFakeTimers().setSystemTime(startedAt);
  maintenance.mockResolvedValue(undefined);
  disconnect.mockResolvedValue(undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function loadDrivers() {
  jest.isolateModules(() => {
    require("../../jobs/compliance/consent-retention-sweeper");
    require("../../jobs/compliance/databreach-deadline-alerts");
  });
}
function driver(job: string) {
  const run = callbacks.get(job);
  if (!run) throw new Error(`Missing driver: ${job}`);
  return run;
}

it.each([{ job: "consent-retention-sweeper", run: consent }])(
  "shares the original deadline across every $job slice",
  async ({ job, run }) => {
    maintenance.mockImplementationOnce(async () => {
      jest.advanceTimersByTime(2_000);
    });
    run
      .mockImplementationOnce(async () => {
        jest.advanceTimersByTime(5_000);
        return { deleteMode: true, deleted: 1, pruned: 1, hasMore: true };
      })
      .mockResolvedValueOnce({
        deleteMode: true,
        deleted: 1,
        pruned: 1,
        hasMore: false,
      });
    loadDrivers();
    await driver(job)();
    const args =
      job === "consent-retention-sweeper"
        ? { limit: 500, startedAt, delete: false }
        : { limit: 500, startedAt };
    expect(run.mock.calls).toEqual([[args], [args]]);
    expect(disconnect).toHaveBeenCalledTimes(1);
  },
);

it.each([{ job: "consent-retention-sweeper", run: consent }])(
  "starts no $job slice after maintenance consumes its budget",
  async ({ job, run }) => {
    run.mockResolvedValueOnce({
      deleteMode: true,
      deleted: 0,
      pruned: 0,
      hasMore: false,
    });
    maintenance.mockImplementationOnce(async () => {
      jest.advanceTimersByTime(16_000);
    });
    loadDrivers();
    await driver(job)();
    expect(run).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  },
);

it("passes the breach driver's pre-maintenance start time to its single core slice", async () => {
  maintenance.mockImplementationOnce(async () => {
    jest.advanceTimersByTime(16_000);
  });
  breach.mockResolvedValueOnce({ success: false, hasMore: true });
  const previousExitCode = process.exitCode;
  loadDrivers();
  try {
    await driver("databreach-deadline-alerts")();
    expect(breach).toHaveBeenCalledWith({ limit: 50, startedAt });
    expect(process.exitCode).toBe(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
