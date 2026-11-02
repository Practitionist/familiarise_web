/**
 * @jest-environment node
 */
import {
  adminActorId,
  currentRun,
  noteCounter,
  noteRunId,
  withRunContext,
} from "../../lib/cron/run-context";
import { casMiss } from "../../lib/cron/run-counters";
import {
  runTelemetryResult,
  settleTelemetry,
} from "../../lib/cron/run-telemetry";
import { emitTelemetryLog } from "../../lib/observability/betterstack-telemetry";
import { createRunFailureReporter } from "../../lib/observability/run-failures";

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

describe("run context", () => {
  it("is a no-op outside a run", () => {
    expect(currentRun()).toBeUndefined();
    expect(() => {
      casMiss();
      noteCounter("poolTimeout");
      noteRunId("exec-x");
    }).not.toThrow();
    expect(adminActorId()).toBeUndefined();
  });

  it("keeps counters and run ids per run, across awaits and timers, and isolates concurrent runs", async () => {
    const run = (triggeredBy: string, misses: number) =>
      withRunContext({ triggeredBy, tickId: "tick-1" }, async () => {
        for (let i = 0; i < misses; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          casMiss();
        }
        noteRunId(`exec-${triggeredBy}`);
        return currentRun();
      });
    const [cron, admin] = await Promise.all([
      run("cron", 2),
      run("admin:user-7", 1),
    ]);
    expect(cron?.counters.casMiss).toBe(2);
    expect(cron?.runIds).toEqual(["exec-cron"]);
    expect(admin?.counters).toMatchObject({ casMiss: 1, poolTimeout: 0 });
    expect(admin?.tickId).toBe("tick-1");
    expect(currentRun()).toBeUndefined();
  });

  it("names the admin actor only for admin triggers", async () => {
    await withRunContext({ triggeredBy: "admin:user-9" }, async () => {
      expect(adminActorId()).toBe("user-9");
    });
    await withRunContext({ triggeredBy: "cron" }, async () => {
      expect(adminActorId()).toBeUndefined();
    });
  });

  it("records ingest rejections and capped, ids-only failures for the run row", async () => {
    process.env.ENABLE_BETTERSTACK_TELEMETRY = "true";
    process.env.BETTERSTACK_SOURCE_TOKEN = "tok";
    process.env.BETTERSTACK_INGEST_URL = "https://in.example.test";
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const statuses = [202, 402, 503];
    global.fetch = jest.fn(async () => ({
      status: statuses.shift() ?? 403,
    })) as never;
    const result = await withRunContext({ triggeredBy: "cron" }, async () => {
      for (let i = 0; i < 4; i++) {
        void emitTelemetryLog({ level: "warn", message: "x" });
      }
      const failures = createRunFailureReporter("payments");
      for (let i = 0; i < 52; i++) {
        failures.add("refund-owed.retry", new Error("timeout"), {
          paymentId: `pay_${i}`,
          email: "a@b.test",
          attempts: 2,
        });
      }
      const run = currentRun();
      if (!run) throw new Error("no run");
      await settleTelemetry(run.telemetry);
      return runTelemetryResult(run.telemetry);
    });
    expect(result.telemetry).toEqual({
      sent: 1,
      rejected: { "402": 1, "403": 1, "5xx": 1, network: 0, other: 0 },
    });
    expect(result.failures).toHaveLength(50);
    expect(result.failures?.[0]).toEqual({
      entityId: "pay_0",
      reason: "refund-owed.retry",
      attempt: 2,
    });
    expect(result.failuresOverflow).toBe(2);
  });
});
