/**
 * @jest-environment node
 */

/**
 * `cleanupRoute` is now the whole HTTP surface of 36 cleanup endpoints, several
 * of which are money jobs. Every guard those routes used to carry by hand — the
 * cron-secret check, the maintenance gate, the lock-held mapping and the
 * result-to-status mapping — exists exactly once, so a defect in any of them is
 * a defect in all 36 at the same time.
 *
 * The status mapping is the one worth pinning hardest. The routes only supply a
 * callback; if the factory ever stopped calling it, every money route would
 * answer a clean 200 on a failed run, and the per-route tests — which assert
 * against the route's source text — would all still pass.
 */

jest.mock("@sentry/core", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/**
 * Both dependencies are mocked with the error classes declared inside the
 * factory, the same way `__tests__/payments/admin-refund-error-mapping.test.ts`
 * does it: the factory imports them from these paths, so `instanceof` compares
 * identical constructors, and the real modules stay out of the graph. That
 * matters here — `lib/cron/with-cron-lock` pulls in `lib/redis`, and a routing
 * test must not need a Redis to prove a status code.
 */
jest.mock("../../lib/cron/with-cron-lock", () => ({
  CronLockHeldError: class CronLockHeldError extends Error {
    constructor(
      readonly jobName: string,
      readonly holderRunId: string | null = null,
    ) {
      super(jobName);
    }
  },
  // #1822 Q-2 — cleanup-route.ts now checks `instanceof CronLockUnavailableError`
  // too; without this export the check throws on `undefined`.
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  withCronLock: jest.fn(),
}));

jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceUnavailableError: class MaintenanceUnavailableError extends Error {},
  MaintenanceActiveError: class MaintenanceActiveError extends Error {
    httpStatus = 503;
    phase: string;
    constructor(jobName: string, phase: string) {
      super(`Maintenance mode is ${phase} — ${jobName} is unavailable`);
      this.phase = phase;
    }
  },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({ id: "row" }),
    },
  },
}));

import type { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import {
  currentRun,
  noteRunFinished,
  noteRunId,
} from "../../lib/cron/run-context";
import * as Sentry from "@sentry/core";

import {
  cleanupRoute,
  InvalidLimitError,
  parseLimitParam,
  statusFor,
} from "../../lib/cron/cleanup-route";
import {
  CronLockHeldError,
  CronLockUnavailableError,
} from "../../lib/cron/with-cron-lock";
import { resetThrottledCaptureForTesting } from "../../lib/observability/throttled-capture";
import { BackgroundDispatchRefusedError } from "../../lib/cron/dispatch-refusal";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
  MaintenanceUnavailableError,
} from "../../lib/maintenance-cron";

const guard = assertNotInMaintenance as jest.Mock;

const SECRET = "test-cron-secret";

const TICK = "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d";

function request(
  auth: string | null = `Bearer ${SECRET}`,
  extra: Record<string, string> = {},
): NextRequest {
  const headers = new Headers({ "x-tick-id": TICK, ...extra });
  if (auth !== null) headers.set("authorization", auth);
  return { headers } as unknown as NextRequest;
}

const executions = jest.mocked(prisma.systemJobExecution);

describe("statusFor", () => {
  it("puts failure ahead of the needs-attention flag", () => {
    // The bug this replaced: `flagged ? 207 : success ? 200 : 500` answered a
    // 2xx for a run that both failed and flagged, so a monitor read it healthy.
    expect(statusFor({ success: false }, true)).toBe(500);
    expect(statusFor({ success: false }, false)).toBe(500);
  });

  it("maps a clean run to 200 and a clean-but-flagged run to 207", () => {
    expect(statusFor({ success: true }, false)).toBe(200);
    expect(statusFor({ success: true }, true)).toBe(207);
  });

  it("answers 207, not 500, for a run that completed and found double bookings", () => {
    // reconcile-occurrence-availability's twin: `success` is "the run
    // completed"; findings are the needs-attention flag.
    const result = { success: true, doubleBookingsDetected: 2 };
    expect(statusFor(result, result.doubleBookingsDetected > 0)).toBe(207);
    const failed = { success: false, doubleBookingsDetected: 2 };
    expect(statusFor(failed, failed.doubleBookingsDetected > 0)).toBe(500);
  });

  it("treats a result with no success field as successful", () => {
    // Several routes return counters only; absence is not failure.
    expect(statusFor({})).toBe(200);
  });
});

/**
 * #1459 — `reconcile-orphaned-confirmations` kept its own parser that logged a
 * malformed `?limit=` and swept the defaults, so a broken caller produced a run
 * that looked healthy. Every ticker target now shares this one, which is worth
 * pinning directly rather than only through the route's 400 mapping.
 */
describe("parseLimitParam", () => {
  const withLimit = (raw: string | null): NextRequest =>
    ({
      nextUrl: {
        searchParams: new URLSearchParams(raw === null ? "" : { limit: raw }),
      },
    }) as unknown as NextRequest;

  it("refuses a present-but-invalid limit instead of falling back to unbounded", () => {
    // "" is `?limit=`: present, so it is junk rather than the absent default.
    for (const raw of ["", "abc", "0", "-5", "2.5"]) {
      expect(() => parseLimitParam(withLimit(raw))).toThrow(InvalidLimitError);
    }
  });

  it("clamps above the cap and passes a sane value through", () => {
    expect(parseLimitParam(withLimit("5000"))).toBe(500);
    expect(parseLimitParam(withLimit("50"))).toBe(50);
  });

  it("treats an absent limit as the unbounded GitHub Actions run", () => {
    expect(parseLimitParam(withLimit(null))).toBeUndefined();
  });
});

describe("cleanupRoute", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // The catch-all is throttled per job, so windows must not leak.
    resetThrottledCaptureForTesting();
    guard.mockResolvedValue(undefined);
    process.env = { ...OLD_ENV, CRON_SECRET: SECRET };
    delete process.env.GITHUB_ACTIONS;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("rejects a caller without the cron secret and never runs the job", async () => {
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "test-job", run });

    const res = await POST(request("Bearer wrong-secret-of-equal-length"));

    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a caller with no authorization header at all", async () => {
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "test-job", run });

    expect((await POST(request(null))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects everyone when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "test-job", run });

    expect((await POST(request())).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("honours the route's status callback", async () => {
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => ({ success: true, discrepancies: 3 }),
      status: (r) => statusFor(r, r.discrepancies > 0),
    });

    expect((await POST(request())).status).toBe(207);
  });

  it("maps a failed run to 500 by default", async () => {
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => ({ success: false, errorCount: 2 }),
    });

    const res = await POST(request());

    expect(res.status).toBe(500);
    // The body stays the result, not an error envelope: the run itself finished.
    expect(await res.json()).toEqual({ success: false, errorCount: 2 });
  });

  it("answers 409 when a concurrent run holds the lock", async () => {
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => {
        throw new CronLockHeldError("held");
      },
    });

    expect((await POST(request())).status).toBe(409);
  });

  it("answers an off-production background dispatch with the typed refusal and a CANCELLED row", async () => {
    const { POST } = cleanupRoute({
      job: "expire-event-channels",
      run: async () => {
        throw new BackgroundDispatchRefusedError("expire-event-channels");
      },
      status: () => 202,
    });

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect(res.headers.get("x-run-outcome")).toBe("refused");
    expect(await res.json()).toMatchObject({
      code: "BACKGROUND_DISPATCH_PRODUCTION_ONLY",
    });
    expect(executions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CANCELLED",
          result: expect.objectContaining({
            outcome: "refused",
            reason: "background-dispatch-production-only",
          }),
        }),
      }),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("refuses every job on a preview deploy, which shares production's database", async () => {
    process.env.SITE_ID = "site";
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "preview";
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "process-payouts", run });

    const res = await POST(request());

    expect(run).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(res.headers.get("x-run-outcome")).toBe("refused");
    expect(await res.json()).toMatchObject({ code: "JOB_RUN_PRODUCTION_ONLY" });
    expect(executions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CANCELLED",
          result: expect.objectContaining({
            outcome: "refused",
            reason: "job-run-production-only",
            environment: "preview",
          }),
        }),
      }),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // #1822 owner decision — one shared key, 15-min window: two jobs, one capture.
  it("reports lock-unavailable once across different jobs within 15 min", async () => {
    resetThrottledCaptureForTesting();
    const failing = (job: string) =>
      cleanupRoute({
        job,
        run: async () => {
          throw new CronLockUnavailableError(job);
        },
      }).POST;

    expect((await failing("job-a")(request())).status).toBe(503);
    expect((await failing("job-b")(request())).status).toBe(503);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("answers 503 with the phase when maintenance is active", async () => {
    guard.mockRejectedValue(new MaintenanceActiveError("test-job", "DEGRADED"));
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "test-job", run });

    const res = await POST(request());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ phase: "DEGRADED" });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports unreadable state as an operational failure without a planned phase", async () => {
    guard.mockRejectedValue(new MaintenanceUnavailableError());
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "test-job", run });

    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "",
      code: "MAINTENANCE_STATE_UNREADABLE",
    });
    expect(run).not.toHaveBeenCalled();
    expect(Sentry.flush).toHaveBeenCalled();
  });

  it("passes the job name to the maintenance guard, since DEGRADED keys on it", async () => {
    const { POST } = cleanupRoute({
      job: "reconcile-pending-refunds",
      run: async () => ({ success: true }),
    });

    await POST(request());

    expect(guard).toHaveBeenCalledWith("reconcile-pending-refunds");
  });

  it("answers 400 INVALID_LIMIT and never runs the job on a bad ?limit=", async () => {
    const run = jest.fn(() => {
      throw new InvalidLimitError();
    });
    const { POST } = cleanupRoute({ job: "test-job", run });

    const res = await POST(request());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_LIMIT" });
  });

  it("never returns the exception text to the caller", async () => {
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => {
        throw new Error('relation "Payment" column "razorpayPayoutId"');
      },
      failureMessage: "Failed to run the test job",
    });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to run the test job" });
    expect(JSON.stringify(body)).not.toContain("razorpayPayoutId");
  });

  // #1441 — a rethrown plain object used to reach Sentry as "[object Object]".
  it("reports a thrown non-Error to Sentry with its code in the message", async () => {
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => {
        throw { code: "REFUND_GATEWAY_TIMEOUT" };
      },
    });

    await POST(request());

    const [reported, ctx] = (Sentry.captureException as jest.Mock).mock
      .calls[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toContain("REFUND_GATEWAY_TIMEOUT");
    expect(ctx.tags).toMatchObject({ subsystem: "cron", job: "test-job" });
    expect(Sentry.flush).toHaveBeenCalledWith(2_000);
  });

  it("flushes Sentry before returning on a 500 run result even when CRON_SENTRY_CANARY is unset", async () => {
    delete process.env.CRON_SENTRY_CANARY;
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => ({ success: false }),
    });

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(Sentry.flush).toHaveBeenCalledWith(2_000);
  });
});

describe("cleanupRoute run record", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    resetThrottledCaptureForTesting();
    guard.mockResolvedValue(undefined);
    process.env = { ...OLD_ENV, CRON_SECRET: SECRET };
    delete process.env.GITHUB_ACTIONS;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("records a 207 run as FAILED/partial with its summary, items and tick", async () => {
    const { POST } = cleanupRoute({
      job: "retry-auto-refunds",
      run: async () => {
        noteRunId("exec-1");
        noteRunFinished("exec-1", { checkpoint: "c-2" });
        return { success: true, scanned: 4, failed: 1 };
      },
      status: () => 207,
    });

    const res = await POST(request());
    expect(res.status).toBe(207);
    expect(res.headers.get("x-run-outcome")).toBe("partial");
    expect(executions.updateMany).toHaveBeenCalledWith({
      where: {
        id: "exec-1",
        status: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
      },
      data: {
        status: "FAILED",
        result: expect.objectContaining({
          outcome: "partial",
          httpStatus: 207,
          tickId: TICK,
          checkpoint: "c-2",
          summary: { success: true, scanned: 4, failed: 1 },
          counters: expect.objectContaining({ casMiss: 0 }),
        }),
        itemsProcessed: 4,
        errorCount: 1,
      },
    });
    expect(executions.create).not.toHaveBeenCalled();
  });

  it("records the job's own item counts when its summary has no recognised key", async () => {
    const { POST } = cleanupRoute({
      job: "expire-reschedule-proposals",
      run: async () => {
        noteRunId("exec-3");
        noteRunFinished("exec-3", null);
        return { proposalsExpired: 6 };
      },
      items: (r) => ({ processed: r.proposalsExpired }),
    });

    await POST(request());
    expect(executions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ itemsProcessed: 6, errorCount: null }),
      }),
    );
  });

  it("records findings with no failing item as COMPLETED/attention, and findings with failures as partial", async () => {
    const route = (errors: string[]) =>
      cleanupRoute({
        job: "reconcile-org-invoice-payments",
        run: async () => {
          noteRunId("exec-2");
          noteRunFinished("exec-2", null);
          return { success: true, scanned: 3, unapplied: 1, errors };
        },
        needsAttention: (r) => r.unapplied > 0,
      }).POST;

    expect((await route([])(request())).status).toBe(207);
    expect(executions.updateMany.mock.calls[0][0].data).toMatchObject({
      status: "COMPLETED",
      result: expect.objectContaining({ outcome: "attention" }),
    });

    expect((await route(["inv-9: gateway 502"])(request())).status).toBe(207);
    expect(executions.updateMany.mock.calls[1][0].data).toMatchObject({
      status: "FAILED",
      result: expect.objectContaining({ outcome: "partial" }),
    });
  });

  it("records a 207 whose failures appear only in the summary as partial, not attention", async () => {
    const { POST } = cleanupRoute({
      job: "retry-auto-refunds",
      run: async () => {
        noteRunId("exec-3");
        noteRunFinished("exec-3", null);
        return { success: true, failed: 0, owed: { failed: 2, stuck: [] } };
      },
      summarize: (r) => ({ failed: r.failed + r.owed.failed }),
      needsAttention: (r) => r.owed.failed > 0,
    });

    expect((await POST(request())).status).toBe(207);
    expect(executions.updateMany.mock.calls[0][0].data).toMatchObject({
      status: "FAILED",
      result: expect.objectContaining({ outcome: "partial" }),
      errorCount: 2,
    });
  });

  it("takes the run trigger header only behind a valid bearer, and only in the allowed shape", async () => {
    const seen: (string | undefined)[] = [];
    const { POST } = cleanupRoute({
      job: "transfer-recordings",
      run: async () => {
        seen.push(currentRun()?.triggeredBy);
        return { success: true };
      },
    });
    const admin = { "x-run-trigger": "admin:user_1" };

    const refused = await POST(
      request("Bearer wrong-secret-of-equal-length", admin),
    );
    expect(refused.status).toBe(401);
    expect(executions.create).not.toHaveBeenCalled();
    await POST(request(undefined, { "x-run-trigger": "admin:x;drop" }));
    await POST(request(undefined, admin));
    expect(seen).toEqual(["cron", "admin:user_1"]);
  });

  it("writes a zero-duration CANCELLED held row naming the holder on a 409", async () => {
    const { POST } = cleanupRoute({
      job: "appointment-reminders",
      run: async () => {
        throw new CronLockHeldError("send-appointment-reminders", "exec-live");
      },
    });

    expect((await POST(request())).status).toBe(409);
    expect(executions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobName: "send-appointment-reminders",
        status: "CANCELLED",
        durationMs: 0,
        triggeredBy: "cron",
        result: expect.objectContaining({
          outcome: "held",
          holderRunId: "exec-live",
          tickId: TICK,
        }),
      }),
      select: { id: true },
    });
  });

  it("writes a refused row when maintenance holds the job, and nothing for a bad bearer", async () => {
    guard.mockRejectedValue(new MaintenanceActiveError("test-job", "DEGRADED"));
    const { POST } = cleanupRoute({ job: "test-job", run: jest.fn() });

    await POST(request("Bearer wrong-secret-of-equal-length"));
    expect(executions.create).not.toHaveBeenCalled();

    expect((await POST(request())).status).toBe(503);
    expect(executions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobName: "test-job",
          status: "CANCELLED",
          result: expect.objectContaining({
            outcome: "refused",
            reason: "maintenance:DEGRADED",
          }),
        }),
      }),
    );
  });

  it("records a config skip as CANCELLED/skipped even when the core opened no row", async () => {
    const { POST } = cleanupRoute({
      job: "heal-consumer-invoices",
      run: async () => ({
        scanned: 0,
        failed: 0,
        skipped: "PLATFORM_GSTIN not configured",
      }),
    });

    expect((await POST(request())).status).toBe(200);
    expect(executions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CANCELLED",
          result: expect.objectContaining({
            outcome: "skipped",
            reason: "PLATFORM_GSTIN not configured",
          }),
        }),
      }),
    );
  });
});
