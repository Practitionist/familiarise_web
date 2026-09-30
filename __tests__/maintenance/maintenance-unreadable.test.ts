/**
 * @jest-environment node
 */

/**
 * #E6 — `getMaintenanceState` used to read as OFF during a Redis outage, with
 * no log and no Sentry event.
 *
 * The wrapper is `withCircuitBreaker(operation, () => OFF_STATE)`. Failing open
 * is CORRECT for enforcement — a maintenance window must not turn a Redis blip
 * into a platform-wide 503, and that is why the fallback exists at all. It is
 * wrong for everyone asking what the platform is doing: `phase: "OFF"` is a
 * claim ("we are serving normally") and during an outage it is a fabricated one.
 * `/api/health` reported a healthy platform, the admin dashboard showed no
 * window, and the only trace was a `console.warn` inside a catch-all — which
 * `lib/health/probe.ts` documents is stripped from the Netlify function log
 * (#1122).
 *
 * So the fallback now REPORTS (throttled) and says `unreadable: true`, and the
 * health route degrades on that bit. Enforcement is deliberately unchanged, and
 * these cases pin that too: a read failure must not start refusing writes.
 */

const mockPhaseGet = jest.fn();
const mockConfigGet = jest.fn();

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    get: (key: string) =>
      key.includes("config") ? mockConfigGet(key) : mockPhaseGet(key),
  },
  withCircuitBreaker: (op: () => Promise<unknown>, fallback?: () => unknown) =>
    op().catch(() => (fallback ? fallback() : undefined)),
  isMockRedis: () => false,
  isRedisCircuitOpen: () => false,
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    maintenanceWindow: {
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
  },
}));

import * as Sentry from "@sentry/nextjs";
import { getMaintenanceState } from "../../lib/maintenance";
import { resetThrottledCaptureForTesting } from "../../lib/observability/throttled-capture";

beforeEach(() => {
  jest.clearAllMocks();
  resetThrottledCaptureForTesting();
  mockPhaseGet.mockReset();
  mockConfigGet.mockReset();
});

describe("getMaintenanceState — an unreadable read says so (#E6)", () => {
  it("still fails open to OFF, but flags the answer as a guess", async () => {
    mockPhaseGet.mockRejectedValue(
      new Error("ERR max requests limit exceeded"),
    );
    mockConfigGet.mockRejectedValue(new Error("nope"));

    const state = await getMaintenanceState();

    // Enforcement posture, unchanged and asserted on purpose: this is the whole
    // reason the fallback exists.
    expect(state.phase).toBe("OFF");
    // The honesty bit. Without it, every consumer of "phase" is reading a
    // fabricated answer.
    expect(state.unreadable).toBe(true);
  });

  it("REPORTS the failure — the old fallback logged to nowhere", async () => {
    // `console.*` is stripped from the Netlify function log (#1122), so a
    // catch-all `console.warn` here reported nothing to anyone. A throttled
    // capture is the only channel that survives that.
    mockPhaseGet.mockRejectedValue(
      new Error("UpstashError: connection refused"),
    );
    mockConfigGet.mockRejectedValue(new Error("nope"));

    await getMaintenanceState();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, opts] = (Sentry.captureException as jest.Mock).mock.calls[0];
    expect(error.message).toContain("reporting phase OFF");
    // Warning, not error: nothing is broken for users — that is the point of
    // failing open — but an unreported unreadable read is how a real OFFLINE
    // window goes unenforced with nobody knowing.
    expect(opts.level).toBe("warning");
    expect(opts.tags.reason).toBe("maintenance.read_unreadable");
  });

  it("throttles the report, because the outage is total rather than per-caller", async () => {
    // /api/health, the maintenance cron and the reconcile door all read this.
    mockPhaseGet.mockRejectedValue(new Error("UpstashError"));
    mockConfigGet.mockRejectedValue(new Error("nope"));

    await getMaintenanceState();
    await getMaintenanceState();
    await getMaintenanceState();

    // One report. A Redis outage is one fact, and this project has already
    // spent 80% of an error quota on one dependency once.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("marks a SUCCESSFUL read as readable", async () => {
    mockPhaseGet.mockResolvedValue("OFF");
    mockConfigGet.mockResolvedValue(null);

    const state = await getMaintenanceState();

    expect(state.phase).toBe("OFF");
    expect(state.unreadable).toBe(false);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("reads a real window without flagging it", async () => {
    // The false-positive case that matters: an OFFLINE window in force must NOT
    // come back as `unreadable`, or a real window and a broken read would be
    // indistinguishable and the honest bit would be worthless.
    mockPhaseGet.mockResolvedValue("OFFLINE");
    mockConfigGet.mockResolvedValue(
      JSON.stringify({ reason: "deploy", estimatedEnd: null }),
    );

    const state = await getMaintenanceState();

    expect(state.phase).toBe("OFFLINE");
    expect(state.reason).toBe("deploy");
    expect(state.unreadable).toBe(false);
  });
});
