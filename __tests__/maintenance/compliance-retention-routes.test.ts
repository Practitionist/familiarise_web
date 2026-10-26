/** @jest-environment node */
const consent = jest.fn(),
  events = jest.fn(),
  breach = jest.fn();
jest.mock("../../lib/compliance/consent-retention", () => ({
  runConsentRetentionSweeper: (opts: unknown) => consent(opts),
}));
jest.mock("../../lib/observability/system-event-retention", () => ({
  pruneSystemEvents: (opts: unknown) => events(opts),
}));
jest.mock("../../lib/compliance/databreach-deadline-alerts", () => ({
  runDataBreachDeadlineAlerts: (opts: unknown) => breach(opts),
}));
jest.mock("@sentry/nextjs", () => ({
  logger: { info: jest.fn() },
  flush: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
  MaintenanceUnavailableError: class MaintenanceUnavailableError extends Error {},
}));
jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: jest.fn(),
}));
import { NextRequest } from "next/server";
import { getCleanupJobHandlers } from "../../lib/cron/cleanup-registry";
import { assertNotInMaintenance } from "../../lib/maintenance-cron";

const originalSecret = process.env.CRON_SECRET;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

it.each([
  { job: "consent-retention-sweeper", run: consent },
  { job: "prune-system-events", run: events },
  { job: "databreach-deadline-alerts", run: breach },
])(
  "preserves request admission time through maintenance for $job",
  async ({ job, run }) => {
    const startedAt = 123_456;
    let now = startedAt;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    jest.mocked(assertNotInMaintenance).mockImplementationOnce(async () => {
      now += 16_000;
    });
    run.mockResolvedValueOnce({ success: true, hasMore: true });
    const handlers = getCleanupJobHandlers(job);
    if (!handlers) throw new Error(`Missing registered job: ${job}`);
    const request = new NextRequest(
      `https://example.invalid/api/cleanup/${job}?limit=900`,
      { headers: { authorization: "Bearer test-cron-secret" } },
    );
    expect((await handlers.POST(request)).status).toBe(200);
    expect(run).toHaveBeenCalledWith({ limit: 500, startedAt });
  },
);
