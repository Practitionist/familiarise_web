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
    expect(INFRA_TRANSIENT_PATTERNS).toHaveLength(2);
  });
});
