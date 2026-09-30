/**
 * @jest-environment node
 */

/**
 * #E3 — the two Stream facts `/api/health` could not see.
 *
 * 1. **A wrong `STREAM_WEBHOOK_SECRET` was undetectable.** Every health check we
 *    had called `getAppSettings()`, which is authenticated by the API secret, so
 *    the HMAC path was never exercised. The route resolves its secret as
 *    `STREAM_WEBHOOK_SECRET || STREAM_API_SECRET`, which means an override set to
 *    something other than the API secret makes every single delivery 401. That
 *    is the 2026-08-12 outage: green platform, zero `WebhookEvent` rows, and
 *    nothing anywhere to say why.
 *
 * 2. **`breakerOpen` was measuring its own absence of data.** It was derived
 *    from whether THIS probe's call threw `StreamUnavailableError`, and the
 *    breaker is a per-instance closure — so on a cold instance (the normal state
 *    of a Netlify function) it has zero failures, never fast-fails, and the
 *    field was structurally always `false`.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// The outage ledger writes to `system_events` through Prisma. Mocked here so
// these cases stay about the SECRET verdict and the breaker's own state; the
// ledger has its own suite in `stream-outage-ledger.test.ts`.
const mockRecordStreamOutage = jest.fn(async () => {});
jest.mock("../../lib/stream/system-event", () => ({
  recordStreamOutage: (...args: unknown[]) =>
    mockRecordStreamOutage(...(args as [])),
  resetStreamOutageLedgerForTesting: jest.fn(),
}));

const mockBreakerStatus = jest.fn(() => ({
  name: "stream",
  state: "CLOSED",
  failures: 0,
  lastFailure: null as number | null,
}));

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {},
  createCircuitBreaker: jest.fn(() => ({
    run: (op: () => unknown) => op(),
    reset: jest.fn(),
    status: () => mockBreakerStatus(),
  })),
  withCircuitBreaker: (op: () => unknown) => op(),
}));

const mockGetAppSettings = jest.fn();
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({ getAppSettings: mockGetAppSettings }),
  getStreamCircuitStatus: () => mockBreakerStatus(),
  isStreamConfigured: () => Boolean(process.env.STREAM_API_SECRET),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  withStreamCircuitBreaker: (op: () => unknown) => op(),
}));

import { resetThrottledCaptureForTesting } from "../../lib/observability/throttled-capture";
import * as Sentry from "@sentry/nextjs";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  resetThrottledCaptureForTesting();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.STREAM_API_SECRET;
  delete process.env.STREAM_WEBHOOK_SECRET;
  mockBreakerStatus.mockReturnValue({
    name: "stream",
    state: "CLOSED",
    failures: 0,
    lastFailure: null,
  });
  mockGetAppSettings.mockResolvedValue({ name: "familiarise" });
  mockRecordStreamOutage.mockClear();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("getStreamWebhookSecretHealth (#E3)", () => {
  it("reports healthy when no override is set — the route falls back to the API secret", async () => {
    process.env.STREAM_API_SECRET = "api-secret";
    const { getStreamWebhookSecretHealth } =
      await import("../../lib/stream/health");

    expect(getStreamWebhookSecretHealth()).toEqual({
      configured: true,
      // True BY CONSTRUCTION when no override exists, which is the whole point:
      // "unset" must not read as suspicious or the alarm fires on every
      // correctly-configured deployment.
      matchesApiSecret: true,
      reason: null,
      hasOverride: false,
    });
  });

  it("reports a MISMATCH when the override disagrees with the API secret", async () => {
    // The 2026-08-12 signature. Stream signs with the API secret; the route
    // verifies with the override; every delivery 401s and nothing says so.
    process.env.STREAM_API_SECRET = "api-secret";
    process.env.STREAM_WEBHOOK_SECRET = "a-different-secret";
    const { getStreamWebhookSecretHealth } =
      await import("../../lib/stream/health");

    expect(getStreamWebhookSecretHealth()).toEqual({
      configured: true,
      matchesApiSecret: false,
      reason: "WEBHOOK_SECRET_OVERRIDE_MISMATCH",
      hasOverride: true,
    });
  });

  it("treats an override EQUAL to the API secret as redundant, not broken", async () => {
    process.env.STREAM_API_SECRET = "api-secret";
    process.env.STREAM_WEBHOOK_SECRET = "api-secret";
    const { getStreamWebhookSecretHealth } =
      await import("../../lib/stream/health");

    expect(getStreamWebhookSecretHealth()).toMatchObject({
      matchesApiSecret: true,
      reason: null,
      hasOverride: true,
    });
  });

  it("reports API_SECRET_UNSET rather than pretending a secret exists", async () => {
    const { getStreamWebhookSecretHealth } =
      await import("../../lib/stream/health");

    expect(getStreamWebhookSecretHealth()).toEqual({
      configured: false,
      matchesApiSecret: null,
      reason: "API_SECRET_UNSET",
      hasOverride: false,
    });
  });

  it("never returns, logs or reports any part of the secret", async () => {
    process.env.STREAM_API_SECRET = "super-secret-api-value";
    process.env.STREAM_WEBHOOK_SECRET = "super-secret-override-value";
    const { getStreamWebhookSecretHealth, getStreamStatus } =
      await import("../../lib/stream/health");

    // The verdict is assertable at all only because it is booleans.
    expect(JSON.stringify(getStreamWebhookSecretHealth())).not.toContain(
      "super-secret",
    );

    const status = await getStreamStatus();
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain("super-secret");
    // And nothing reached Sentry carrying one either.
    const reported = JSON.stringify(
      (Sentry.captureException as jest.Mock).mock.calls,
    );
    expect(reported).not.toContain("super-secret");
  });
});

describe("getStreamStatus — the breaker's own state (#E3)", () => {
  it("reports the breaker's state rather than the probe's own verdict", async () => {
    process.env.STREAM_API_SECRET = "api-secret";
    // The case the old field could never produce: the breaker is OPEN while the
    // probe SUCCEEDS. `breakerOpen` was derived from the probe's rejection, so a
    // successful probe reported `false` no matter what the breaker was doing.
    mockBreakerStatus.mockReturnValue({
      name: "stream",
      state: "OPEN",
      failures: 5,
      lastFailure: 1_700_000_000_000,
    });

    const { getStreamStatus } = await import("../../lib/stream/health");
    const status = await getStreamStatus();

    expect(status.reachable).toBe(true);
    expect(status.breaker.state).toBe("OPEN");
    expect(status.breaker.failures).toBe(5);
    expect(status.breaker.lastFailure).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
    // A successful probe proves Stream answers, so it is not "probeFastFailed"
    // even though the breaker is open.
    expect(status.probeFastFailed).toBe(false);
  });

  it("reports a CLOSED breaker on a cold instance rather than inventing a fault", async () => {
    // The honest shape of the common case: a fresh Netlify instance has a fresh
    // closure with zero failures. Reporting `false` here is correct, and it is
    // also why the OLD field was useless — this is the answer it gave during
    // every outage.
    process.env.STREAM_API_SECRET = "api-secret";
    const { getStreamStatus } = await import("../../lib/stream/health");
    const status = await getStreamStatus();

    expect(status.breaker).toEqual({
      state: "CLOSED",
      failures: 0,
      lastFailure: null,
    });
  });

  it("carries the webhook verdict on the unconfigured path too", async () => {
    // With no API secret the probe is skipped, and the old early return omitted
    // every field the interface has since grown — so a misconfigured deployment
    // reported the LEAST information exactly when it needed the most.
    const { getStreamStatus } = await import("../../lib/stream/health");
    const status = await getStreamStatus();

    expect(status.configured).toBe(false);
    expect(status.reachable).toBeNull();
    expect(status.breaker).toEqual({
      state: "CLOSED",
      failures: 0,
      lastFailure: null,
    });
    expect(status.webhookSecret.reason).toBe("API_SECRET_UNSET");
  });

  it("throttles the mismatch warning — /api/health is polled, the config cannot change", async () => {
    process.env.STREAM_API_SECRET = "api-secret";
    process.env.STREAM_WEBHOOK_SECRET = "wrong";
    const { getStreamStatus } = await import("../../lib/stream/health");

    await getStreamStatus();
    await getStreamStatus();
    await getStreamStatus();

    // Three probes of a permanent misconfiguration is one report. An
    // unthrottled warn here would spend the error allowance on a fact that
    // cannot change while anyone is asleep.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
