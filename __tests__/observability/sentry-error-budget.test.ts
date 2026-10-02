/**
 * #1933 — the per-key throttle and the per-process breaker in beforeSend's
 * budget stage. One pin for the policy; the pattern classes keep their own
 * suites.
 */
import type { Event } from "@sentry/nextjs";
import {
  applyErrorBudget,
  INFRA_THROTTLE_MS,
  resetSentryBudgetState,
} from "../../sentry.shared.config";

const thrown = (value: string, fn = "handler"): Event => ({
  exception: {
    values: [
      {
        type: "Error",
        value,
        stacktrace: {
          frames: [{ filename: "app/x.ts", function: fn, in_app: true }],
        },
      },
    ],
  },
});

describe("applyErrorBudget", () => {
  beforeEach(() => {
    resetSentryBudgetState();
    jest.useFakeTimers().setSystemTime(new Date("2026-10-02T00:00:00Z"));
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("passes the first event per key, drops a repeat in the window, passes a different key", () => {
    expect(applyErrorBudget(thrown("row 123 failed"))).not.toBeNull();
    // Same shape, different id: normalised to the same key.
    expect(applyErrorBudget(thrown("row 456 failed"))).toBeNull();
    expect(applyErrorBudget(thrown("other failure"))).not.toBeNull();
    jest.advanceTimersByTime(INFRA_THROTTLE_MS + 1);
    expect(applyErrorBudget(thrown("row 789 failed"))).not.toBeNull();
  });

  it("fingerprints pool exhaustion into one family and drops expected info", () => {
    const ev = applyErrorBudget(
      thrown("Timed out fetching a new connection from the connection pool"),
    );
    expect(ev?.fingerprint).toEqual(["prisma-pool-exhaustion"]);
    expect(
      applyErrorBudget({
        message: "x",
        level: "info",
        tags: { expected: "true" },
      }),
    ).toBeNull();
  });

  it("caps a process at 30 events per hour, then resumes", () => {
    let passed = 0;
    for (let i = 0; i < 40; i++) {
      if (applyErrorBudget(thrown(`distinct failure ${"x".repeat(i)}`)))
        passed += 1;
    }
    expect(passed).toBe(30);
    expect(console.warn).toHaveBeenCalledTimes(1);
    // A fatal skips the open breaker but keeps its per-key throttle.
    const fatal = {
      ...thrown("WALLET_BALANCE_DRIFT"),
      level: "fatal" as const,
    };
    expect(applyErrorBudget(fatal)).not.toBeNull();
    expect(applyErrorBudget({ ...fatal })).toBeNull();
    jest.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(applyErrorBudget(thrown("after the hour"))).not.toBeNull();
  });
});
