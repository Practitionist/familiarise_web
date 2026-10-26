/**
 * @jest-environment node
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  flush: jest.fn(),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

const assertNotInMaintenance = jest.fn();
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: (...a: unknown[]) => assertNotInMaintenance(...a),
  MaintenanceUnavailableError: class MaintenanceUnavailableError extends Error {},
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
}));

const cleanupAuthTokens = jest.fn();
jest.mock("../../lib/auth/cleanup-auth-tokens", () => ({
  cleanupAuthTokens: (...args: unknown[]) => cleanupAuthTokens(...args),
}));

import type { NextRequest } from "next/server";
import { getCleanupJobHandlers } from "../../lib/cron/cleanup-registry";

const SECRET = "test-cron-secret";

function request(authorization?: string, query = ""): NextRequest {
  const headers = new Headers(authorization ? { authorization } : {});
  return {
    headers,
    nextUrl: { searchParams: new URLSearchParams(query) },
  } as unknown as NextRequest;
}

describe("/api/cleanup/auth-tokens registry entry", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
  });

  afterAll(() => {
    process.env.CRON_SECRET = original;
  });

  it("runs cleanupAuthTokens under the cleanup-auth-tokens maintenance gate", async () => {
    const result = {
      success: true,
      verificationTokensDeleted: 2,
      sessionsDeleted: 3,
      idempotencyRecordsDeleted: 1,
      staleInvitationsExpired: 1,
      totalCleaned: 7,
      errors: [],
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    cleanupAuthTokens.mockResolvedValue(result);

    const { POST } = getCleanupJobHandlers("auth-tokens")!;
    const res = await POST(request(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(cleanupAuthTokens).toHaveBeenCalledTimes(1);
    expect(cleanupAuthTokens).toHaveBeenCalledWith({
      limit: undefined,
      startedAt: expect.any(Number),
    });
    expect(assertNotInMaintenance).toHaveBeenCalledWith("cleanup-auth-tokens");
  });

  it("passes a validated limit to the canonical core", async () => {
    cleanupAuthTokens.mockResolvedValue({ success: true, hasMore: true });
    const { POST } = getCleanupJobHandlers("auth-tokens")!;
    expect((await POST(request(`Bearer ${SECRET}`, "limit=3"))).status).toBe(
      200,
    );
    expect(cleanupAuthTokens).toHaveBeenCalledWith({
      limit: 3,
      startedAt: expect.any(Number),
    });
  });

  it("rejects an invalid limit before invoking the core", async () => {
    const { POST } = getCleanupJobHandlers("auth-tokens")!;
    expect((await POST(request(`Bearer ${SECRET}`, "limit=0"))).status).toBe(
      400,
    );
    expect(cleanupAuthTokens).not.toHaveBeenCalled();
  });

  it("answers 500 when the sweep reports errors", async () => {
    cleanupAuthTokens.mockResolvedValue({ success: false, errors: ["x"] });
    const { POST } = getCleanupJobHandlers("auth-tokens")!;
    const res = await POST(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
  });

  it("rejects a request without the cron bearer", async () => {
    const { POST } = getCleanupJobHandlers("auth-tokens")!;
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(cleanupAuthTokens).not.toHaveBeenCalled();
  });
});
