/**
 * @jest-environment node
 */

/**
 * #1584 P1-CR03 — the overage-charge twin called its script with no
 * arguments, so the ticker's `?limit=` was silently dropped and the sweep
 * always ran unbounded. Pins that the twin forwards the parsed limit.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
}));

jest.mock("../../scripts/cleanup/sweep-abandoned-overage-charges", () => ({
  sweepAbandonedOverageCharges: jest.fn(),
}));

import { POST } from "../../app/api/cleanup/sweep-abandoned-overage-charges/route";
import { sweepAbandonedOverageCharges } from "../../scripts/cleanup/sweep-abandoned-overage-charges";

const mockSweep = sweepAbandonedOverageCharges as jest.Mock;
const SECRET = "test-cron-secret";

describe("POST /api/cleanup/sweep-abandoned-overage-charges", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, CRON_SECRET: SECRET };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("forwards ?limit=7 to the sweep", async () => {
    mockSweep.mockResolvedValue({ success: true, scanned: 0, failed: 0 });
    const headers = new Headers({ authorization: `Bearer ${SECRET}` });
    const nextUrl = new URL(
      "http://localhost/api/cleanup/sweep-abandoned-overage-charges?limit=7",
    );

    const res = await POST({ headers, nextUrl } as never);

    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledWith({ limit: 7 });
  });
});
