/**
 * @jest-environment node
 */

/**
 * #1557 / #1124 — `/api/health` on a cold instance.
 *
 * The route used to arm its database deadline, hit the instance's first-await
 * stall, and report `database: "unreachable"` because the deadline woke before
 * the query ran. Now it yields first, measures the yield, and arms nothing
 * until the loop is back. The pins: a block that lands on that first yield is
 * reported under `platform.eventLoopStallMs` and does NOT touch `database` or
 * `status`; a database that really fails still does.
 *
 * #E3 / #E5 / #E6 extended the body, and the pins below cover the three new
 * claims that can change `status`: an unreadable maintenance phase, a webhook
 * secret that cannot verify anything, and the two Stream-breaker reads that
 * this route used to be unable to see at all.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { user: { findFirst: jest.fn() } },
}));

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: { get: jest.fn() },
  isMockRedis: jest.fn(() => true),
  isRedisCircuitOpen: jest.fn(() => false),
  // #E3 — `lib/stream-client.ts` builds Stream's breaker at module load with
  // this factory, so the mock has to provide it or importing the health route
  // throws. The status it returns is what the route's `stream.breaker` block
  // reports, so it is a mock with a value rather than a bare jest.fn().
  createCircuitBreaker: jest.fn((name: string) => ({
    run: (op: () => unknown) => op(),
    reset: jest.fn(),
    status: () => ({
      name,
      state: mockStreamBreakerState,
      failures: mockStreamBreakerFailures,
      lastFailure: null,
    }),
  })),
}));

let mockStreamBreakerState = "CLOSED";
let mockStreamBreakerFailures = 0;

jest.mock("../../lib/maintenance", () => ({
  getMaintenanceState: jest.fn(async () => ({
    phase: "OFF",
    reason: null,
    estimatedEnd: null,
    bypassSecret: null,
    betterstackIncidentId: null,
    unreadable: false,
  })),
}));

jest.mock("../../lib/stream/health", () => ({
  getStreamStatus: jest.fn(async () => ({
    configured: true,
    reachable: true,
    breakerOpen: false,
    breaker: { state: "CLOSED", failures: 0, lastFailure: null },
    probeFastFailed: false,
    webhookSecret: {
      configured: true,
      matchesApiSecret: true,
      reason: null,
      hasOverride: false,
    },
    latencyMs: 12,
  })),
}));

// #E5 — the usage block. Mocked so the health route's own assertions are about
// the ROUTE (does it report, does it degrade) rather than about Redis, which
// `__tests__/stream/usage-meter.test.ts` covers directly.
jest.mock("../../lib/stream/usage", () => ({
  readStreamUsage: jest.fn(async () => ({
    snapshot: null,
    meters: { mau: null, participantMinutes: null, feedApiCalls: null },
    worstAlert: null,
    unmetered: ["feedApiCalls"],
  })),
}));

import * as Sentry from "@sentry/nextjs";

import { GET } from "../../app/api/health/route";
import { getStreamStatus } from "../../lib/stream/health";
import { readStreamUsage } from "../../lib/stream/usage";
import prisma from "@/lib/prisma";
import redis, { isMockRedis, isRedisCircuitOpen } from "@/lib/redis";

const findFirst = prisma.user.findFirst as unknown as jest.Mock;
const warn = Sentry.logger.warn as jest.Mock;
const mockIsMockRedis = isMockRedis as jest.Mock;
const mockRedisGet = redis.get as jest.Mock;
const mockStreamStatus = getStreamStatus as jest.Mock;
const mockReadUsage = readStreamUsage as jest.Mock;

const request = () => new Request("https://x.test/api/health");

/** Block the loop synchronously for `ms` on its next turn. */
function blockLoopSoon(ms: number): void {
  setTimeout(() => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* busy */
    }
  }, 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  findFirst.mockResolvedValue({ id: "u1" });
  mockIsMockRedis.mockReturnValue(true);
  mockRedisGet.mockReset();
  mockStreamBreakerState = "CLOSED";
  mockStreamBreakerFailures = 0;
  mockStreamStatus.mockResolvedValue({
    configured: true,
    reachable: true,
    breakerOpen: false,
    breaker: { state: "CLOSED", failures: 0, lastFailure: null },
    probeFastFailed: false,
    webhookSecret: {
      configured: true,
      matchesApiSecret: true,
      reason: null,
      hasOverride: false,
    },
    latencyMs: 12,
  });
  mockReadUsage.mockResolvedValue({
    snapshot: null,
    meters: { mau: null, participantMinutes: null, feedApiCalls: null },
    worstAlert: null,
    unmetered: ["feedApiCalls"],
  });
});

describe("GET /api/health", () => {
  it("is healthy with a running loop and a reachable database", async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.database).toBe("connected");
    expect(body.platform.eventLoopStallMs).toBeLessThan(50);
    expect(body.platform.databaseProbeRetried).toBe(false);
    expect(typeof body.platform.databaseLatencyMs).toBe("number");
    expect(typeof body.platform.processUptimeMs).toBe("number");
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a first-await stall under platform and leaves the database verdict alone", async () => {
    // Queued before the handler runs, so it lands on the handler's first
    // yield — the same place #1124's stall lands on a brand-new instance.
    blockLoopSoon(60);

    const res = await GET(request());
    const body = await res.json();

    expect(body.platform.eventLoopStallMs).toBeGreaterThanOrEqual(55);
    expect(body.database).toBe("connected");
    expect(body.status).toBe("healthy");
    expect(findFirst).toHaveBeenCalledTimes(1);
    // Under the 1 s reporting threshold: telemetry in the body, no log line.
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a stall over the reporting threshold as a cold-instance stall, not a DB failure", async () => {
    blockLoopSoon(1_050);

    const body = await (await GET(request())).json();

    expect(body.platform.eventLoopStallMs).toBeGreaterThan(1_000);
    expect(body.database).toBe("connected");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("Cold-instance event-loop stall");
    expect(warn.mock.calls[0][1].extra.eventLoopStallMs).toBe(
      body.platform.eventLoopStallMs,
    );
  });

  it("a database that really fails is still degraded, and says why", async () => {
    findFirst.mockRejectedValue(new Error("connection refused"));

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("unreachable");
    expect(body.platform.databaseProbeRetried).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("DB health probe failed");
    expect(warn.mock.calls[0][1].extra).toMatchObject({
      message: "connection refused",
      timedOut: false,
      retried: false,
    });
  });

  // #1822 Q-7 — a Redis quota failure (`UpstashError: ERR max requests limit
  // exceeded`) used to be invisible in this body; it must degrade the
  // overall status and name the error class, with no message/secret leak.
  describe("redis probe (#1822 Q-7)", () => {
    it("reports ok and leaves status alone when Redis is healthy", async () => {
      mockIsMockRedis.mockReturnValue(false);
      mockRedisGet.mockResolvedValueOnce(null);

      const body = await (await GET(request())).json();

      expect(body.redis).toEqual({ status: "ok" });
      expect(body.status).toBe("healthy");
    });

    it("reports degraded with the error class, and degrades the overall status, on a Redis failure", async () => {
      mockIsMockRedis.mockReturnValue(false);
      mockRedisGet.mockRejectedValueOnce(
        Object.assign(new Error("ERR max requests limit exceeded"), {
          name: "UpstashError",
        }),
      );

      const res = await GET(request());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe("degraded");
      expect(body.redis).toEqual({
        status: "degraded",
        reason: "QUOTA_EXCEEDED",
      });
    });

    it("reports degraded when the GET succeeds but the breaker is open", async () => {
      mockIsMockRedis.mockReturnValue(false);
      mockRedisGet.mockResolvedValueOnce(null);
      (isRedisCircuitOpen as jest.Mock).mockReturnValueOnce(true);

      const body = await (await GET(request())).json();

      expect(body.redis).toEqual({
        status: "degraded",
        reason: "CIRCUIT_OPEN",
      });
      expect(body.status).toBe("degraded");
    });

    it("reports ok without probing Redis at all on mock Redis (no quota cost)", async () => {
      mockIsMockRedis.mockReturnValue(true);

      const body = await (await GET(request())).json();

      expect(body.redis).toEqual({ status: "ok" });
      expect(mockRedisGet).not.toHaveBeenCalled();
    });
  });

  // #E3 — `getStreamCircuitStatus()` has existed since #1280 2.1 with a
  // docblock saying /api/health reports Stream's breaker, and it was called from
  // NOWHERE. The claim below is the whole of the change: a Stream outage has to
  // be visible on this route, and a boolean cannot carry the trend.
  describe("stream breaker (#E3)", () => {
    it("reports the breaker's own state, not just the probe's verdict", async () => {
      const body = await (await GET(request())).json();

      expect(body.stream.breaker).toEqual({
        state: "CLOSED",
        failures: 0,
        lastFailure: null,
      });
    });

    it("surfaces an OPEN breaker and its failure count", async () => {
      // The case the old field could never produce: the breaker is open on an
      // instance whose probe SUCCEEDED. Before this, `breakerOpen` was derived
      // from the probe's own rejection, so a successful probe reported `false`
      // no matter what the breaker was doing — and on a cold instance the
      // breaker is closed anyway, so the field was structurally always false.
      mockStreamBreakerState = "OPEN";
      mockStreamBreakerFailures = 5;

      const body = await (await GET(request())).json();

      expect(body.stream.breaker.state).toBe("OPEN");
      expect(body.stream.breaker.failures).toBe(5);
    });

    it("does not degrade the platform for a Stream outage", async () => {
      // Stream being down leaves booking, payments and every read path working.
      // Degrading the whole platform on a vendor outage trains people to ignore
      // this endpoint, which is the failure mode #1822 was written against.
      mockStreamBreakerState = "OPEN";

      const body = await (await GET(request())).json();

      expect(body.status).toBe("healthy");
      expect(body.stream.breaker.state).toBe("OPEN");
    });
  });

  // #E3 — the 2026-08-12 signature: every webhook 401'd, nothing said so, and
  // the only symptom was zero `WebhookEvent` rows days later. A wrong
  // `STREAM_WEBHOOK_SECRET` is the one Stream condition that MUST degrade this
  // route, because nothing else in the system was going to report it.
  describe("stream webhook secret (#E3)", () => {
    it("is healthy when the secret resolves to the API secret", async () => {
      const body = await (await GET(request())).json();

      expect(body.stream.webhookSecret).toEqual({
        configured: true,
        matchesApiSecret: true,
        reason: null,
        hasOverride: false,
      });
      expect(body.status).toBe("healthy");
    });

    it("degrades the platform when an override disagrees with the API secret", async () => {
      mockStreamStatus.mockResolvedValue({
        configured: true,
        reachable: true,
        breakerOpen: false,
        breaker: { state: "CLOSED", failures: 0, lastFailure: null },
        probeFastFailed: false,
        webhookSecret: {
          configured: true,
          matchesApiSecret: false,
          reason: "WEBHOOK_SECRET_OVERRIDE_MISMATCH",
          hasOverride: true,
        },
        latencyMs: 9,
      });

      const res = await GET(request());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe("degraded");
      // Booleans and a stable code only — never the secret, which is why the
      // whole shape is assertable here at all.
      expect(body.stream.webhookSecret).toEqual({
        configured: true,
        matchesApiSecret: false,
        reason: "WEBHOOK_SECRET_OVERRIDE_MISMATCH",
        hasOverride: true,
      });
    });

    it("degrades when there is no API secret at all", async () => {
      mockStreamStatus.mockResolvedValue({
        configured: false,
        reachable: null,
        breakerOpen: false,
        breaker: { state: "CLOSED", failures: 0, lastFailure: null },
        probeFastFailed: false,
        webhookSecret: {
          configured: false,
          matchesApiSecret: null,
          reason: "API_SECRET_UNSET",
          hasOverride: false,
        },
      });

      const body = await (await GET(request())).json();

      expect(body.status).toBe("degraded");
    });
  });

  // #E6 — the maintenance read fails OPEN (enforcement must not turn a Redis
  // blip into a platform-wide 503), but "phase: OFF" from a throwing read is a
  // fabricated answer, and the function log strips `console.*` so it was
  // invisible. `unreadable` is the honest bit and it degrades this route.
  describe("maintenance read (#E6)", () => {
    it("passes the unreadable flag through and degrades on it", async () => {
      const { getMaintenanceState } = jest.requireMock("../../lib/maintenance");
      getMaintenanceState.mockResolvedValueOnce({
        phase: "OFF",
        reason: null,
        estimatedEnd: null,
        bypassSecret: null,
        betterstackIncidentId: null,
        unreadable: true,
      });

      const body = await (await GET(request())).json();

      expect(body.maintenance).toEqual({
        phase: "OFF",
        reason: null,
        estimatedEnd: null,
        unreadable: true,
      });
      expect(body.status).toBe("degraded");
    });
  });

  // #E5 — the `usage` block. Reported always, degrading never: an approaching
  // commercial limit is not a platform impairment, and a 3am page for it would
  // be a page nobody acts on.
  describe("stream usage (#E5)", () => {
    // #1829 — this route is UNAUTHENTICATED. It is what an uptime monitor and a
    // load balancer hit, so its body is public, and the absolute figures it
    // carries are the business's growth curve plus the plan ceilings. The Maker
    // cap in particular is the one number worth knowing the shape of before
    // arriving at it, because Stream does not degrade there — it stops accepting
    // new connections.
    //
    // So the level stays public (a monitor can act on a bucket, and a
    // three-way 60/80/90 split reveals nothing), data QUALITY stays public (a
    // figure nobody can trust is not worth hiding), and the values do not.
    it("reports the ALERT level and data quality, and not the figures", async () => {
      const body = await (await GET(request())).json();

      expect(body.usage).toEqual({
        alert: null,
        quality: {
          unmetered: ["feedApiCalls"],
          estimated: null,
          computedAt: null,
        },
        windowDays: null,
        windowKind: "calendar-month",
        redacted: true,
      });
      expect(body.status).toBe("healthy");
    });

    it("publishes no absolute usage figure or plan cap", async () => {
      mockReadUsage.mockResolvedValue({
        snapshot: {
          mau: 1300,
          participantMinutes: 40000,
          peakConcurrency: 12,
          computedAt: "2026-09-29T04:20:00.000Z",
          estimated: false,
        },
        meters: {
          mau: { used: 1300, cap: 2000, pct: 0.65, alert: 0.6 },
          participantMinutes: {
            used: 40000,
            cap: 333000,
            pct: 0.1201,
            alert: null,
          },
          feedApiCalls: null,
        },
        worstAlert: 0.6,
        unmetered: ["feedApiCalls"],
      });

      const body = await (await GET(request())).json();
      const serialised = JSON.stringify(body.usage);

      // The level and the quality survive; the numbers do not.
      expect(body.usage.alert).toBe(0.6);
      expect(body.usage.quality.computedAt).toBe("2026-09-29T04:20:00.000Z");
      expect(body.usage.redacted).toBe(true);
      // The MAU window is the CALENDAR month (Stream resets it monthly), and the
      // redacted block says so — a reader needs to know which bucket a figure
      // would have belonged to in order to interpret any future figure.
      expect(body.usage.windowKind).toBe("calendar-month");

      // Neither the usage nor either cap, as a value or a digit sequence.
      for (const secret of [
        "1300",
        "40000",
        "2000",
        "333000",
        "0.65",
        "0.1201",
      ]) {
        expect(serialised).not.toContain(secret);
      }
      // Nor the figure keys, in case someone re-adds them under a new name.
      expect(body.usage).not.toHaveProperty("mau");
      expect(body.usage).not.toHaveProperty("participantMinutes");
      expect(body.usage).not.toHaveProperty("worstAlert");

      // Alarm BEFORE the cap, and never as a platform outage.
      expect(body.status).toBe("healthy");
    });
  });
});
