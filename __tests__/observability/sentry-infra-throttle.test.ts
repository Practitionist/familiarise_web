/**
 * Quota guard for the Sentry errors budget (2026-09-21: an Upstash outage
 * burned 80% of the 5,000-error quota reporting itself).
 */
import {
  infraThrottleKey,
  INFRA_THROTTLE_MS,
  INFRA_TRANSIENT_PATTERNS,
} from "../../sentry.shared.config";

describe("infraThrottleKey", () => {
  test("quota-wall message matches regardless of route", () => {
    const a = infraThrottleKey({
      message:
        "UpstashError: Command failed: ERR max requests limit exceeded. Limit: 500000",
    });
    const b = infraThrottleKey({
      exception: {
        values: [
          {
            type: "UpstashError",
            value: "ERR MAX REQUESTS LIMIT EXCEEDED on middleware",
          },
        ],
      },
    });
    expect(a).not.toBeNull();
    expect(a).toBe(b); // one shared key per class, not per route
  });

  test("fail-closed lock refusal matches", () => {
    expect(
      infraThrottleKey({
        exception: {
          values: [
            {
              type: "CronLockUnavailableError",
              value:
                "reconcile-payment-status is fail-closed and requires a real Redis lock",
            },
          ],
        },
      }),
    ).not.toBeNull();
  });

  test("ordinary errors pass through (null = no throttle)", () => {
    expect(
      infraThrottleKey({
        exception: {
          values: [{ type: "TypeError", value: "Cannot read properties" }],
        },
      }),
    ).toBeNull();
    expect(
      infraThrottleKey({
        message: "UpstashError: WRONGPASS invalid password",
      }),
    ).toBeNull(); // other Upstash failures still page normally
  });

  test("window is ten minutes", () => {
    expect(INFRA_THROTTLE_MS).toBe(10 * 60 * 1000);
    /**
     * Pinned so growing this list is a conscious act rather than an accident.
     * Each entry is a separate throttle class with its own window, so adding
     * one is cheap in events and expensive in attention: the new class stops
     * being distinguishable from a real fault, or starts hiding a real fault.
     *
     * 3 as of #1868, which added `/\[system-events\] write failed/` for the
     * failed-`SystemEvent`-write report. That one is keyed on an explicit
     * marker rather than on a database-error pattern, precisely so it cannot
     * swallow genuine data faults — see
     * `__tests__/observability/system-event-write-throttle.test.ts` for the
     * negative cases that hold it to that.
     */
    expect(INFRA_TRANSIENT_PATTERNS).toHaveLength(3);
  });
});
