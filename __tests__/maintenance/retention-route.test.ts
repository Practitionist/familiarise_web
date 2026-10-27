/** @jest-environment node */
const prune = jest.fn();
jest.mock("../../scripts/cleanup/prune-system-job-executions", () => ({
  pruneSystemJobExecutions: (opts: unknown) => prune(opts),
}));
jest.mock("@sentry/nextjs", () => ({
  logger: { info: jest.fn() },
  flush: jest.fn(),
  captureException: jest.fn(),
}));
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

const original = process.env.CRON_SECRET;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  if (original === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = original;
});
function request(query = "", authenticated = true) {
  return new NextRequest(
    `https://example.invalid/api/cleanup/prune-system-job-executions${query}`,
    {
      headers: authenticated
        ? { authorization: "Bearer test-cron-secret" }
        : {},
    },
  );
}
function handlers() {
  const value = getCleanupJobHandlers("prune-system-job-executions");
  if (!value) throw new Error("Missing retention registry entry");
  return value;
}
it("forwards the request start budget and clamped row limit through guard delay", async () => {
  const startedAt = 123_456;
  let now = startedAt;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const { assertNotInMaintenance } = jest.requireMock<{
    assertNotInMaintenance: jest.Mock;
  }>("../../lib/maintenance-cron");
  assertNotInMaintenance.mockImplementationOnce(async () => {
    now += 16_000;
  });
  prune.mockResolvedValue({ success: true, hasMore: true });
  const response = await handlers().POST(request("?limit=900"));
  expect(prune).toHaveBeenCalledWith({ limit: 500, startedAt });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, hasMore: true });
});
it.each(["?limit=", "?limit=-1", "?limit=1.5"])(
  "rejects malformed limit %s before the core runs",
  async (query) => {
    expect((await handlers().POST(request(query))).status).toBe(400);
    expect(prune).not.toHaveBeenCalled();
  },
);
it("rejects a missing bearer before the core runs", async () => {
  expect((await handlers().POST(request("", false))).status).toBe(401);
  expect(prune).not.toHaveBeenCalled();
});
it("returns failure when a later phase crashes", async () => {
  prune.mockRejectedValue(new Error("database unavailable"));
  expect((await handlers().POST(request())).status).toBe(500);
});
