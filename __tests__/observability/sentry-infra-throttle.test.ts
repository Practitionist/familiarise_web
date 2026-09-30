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
     * 4 as of #E4, which added `/Stream circuit breaker is OPEN/`. That entry is
     * separate from the `subsystem: stream` rule below on purpose: "the breaker
     * is refusing" and "Stream returned a 5xx" have different causes and fixing
     * one is not fixing the other, so they must not share a window.
     */
    expect(INFRA_TRANSIENT_PATTERNS).toHaveLength(4);
  });
});

/**
 * #E4 — a Stream vendor incident must cost a TRICKLE, not the error quota.
 *
 * The 2026-09-21 Upstash incident burned 80% of the 5,000-error allowance
 * reporting one dependency being down. Stream has the same shape and a longer
 * tail: `withStreamCircuitBreaker` raises a `StreamUnavailableError` on EVERY
 * Stream call while the breaker is open, and those calls are on the request
 * path, so a ten-minute outage on a modest site is hundreds of identical
 * events. Keying on the `subsystem` TAG rather than the message is what makes
 * this hold for call sites that did not exist when the rule was written.
 */
describe("infraThrottleKey — subsystem: stream (#E4)", () => {
  test("a Stream 5xx trickles", () => {
    expect(
      infraThrottleKey({
        message: "Stream 503 — getOrCreateCall failed",
        tags: { subsystem: "stream" },
      }),
    ).toBe("stream.subsystem");
  });

  test("a Stream 429 trickles — self-inflicted quota is not a fault", () => {
    expect(
      infraThrottleKey({
        exception: {
          values: [
            {
              type: "Error",
              value: "StreamChat error code 29: too many requests (429)",
            },
          ],
        },
        tags: { subsystem: "stream", op: "meetings.join" },
      }),
    ).toBe("stream.subsystem");
  });

  test("the breaker fast-fail keys on its OWN class, not the subsystem rule", () => {
    // Both checks could match; the more specific class has to win, or clearing
    // a Stream 5xx and clearing the breaker become one indistinguishable issue.
    const key = infraThrottleKey({
      message:
        "Stream circuit breaker is OPEN — Stream temporarily unavailable",
      tags: { subsystem: "stream" },
    });
    expect(key).toBe(INFRA_TRANSIENT_PATTERNS[3].source);
    expect(key).not.toBe("stream.subsystem");
  });

  test("a SUSPENDED APP still pages — it is not an outage and not transient", () => {
    // Stream code 99, tagged `stream.billing` by `withStreamCircuitBreaker`. It
    // does not self-resolve, it has exactly one human action, and folding it
    // into the vendor trickle is how "we owe Stream money" gets lost.
    expect(
      infraThrottleKey({
        exception: {
          values: [
            { type: "Error", value: "App suspended" },
            { type: "Error", value: "stream unavailable" },
          ],
        },
        tags: { subsystem: "stream", reason: "stream.billing" },
      }),
    ).toBeNull();
  });

  test("a non-transient Stream event is NOT throttled by its tag alone", () => {
    // The negative case that holds the rule honest. If `subsystem: "stream"` on
    // its own were enough, a genuine one-off defect of ours would be suppressed
    // for ten minutes after the first event of the day, and fixing it would
    // look like the throttle ate it.
    expect(
      infraThrottleKey({
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined (reading 'cid')",
            },
          ],
        },
        tags: { subsystem: "stream" },
      }),
    ).toBeNull();
  });

  test("an ordinary non-Stream event with a transient-looking message is untouched", () => {
    expect(
      infraThrottleKey({
        exception: {
          values: [{ type: "FetchError", value: "socket hang up" }],
        },
        tags: { subsystem: "api" },
      }),
    ).toBeNull();
  });
});
