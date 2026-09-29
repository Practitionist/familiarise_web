/**
 * @jest-environment node
 */

/**
 * #1822 Q-1 — the shared per-instance/per-minute Sentry throttle extracted
 * from `lib/rate-limit.ts`'s #1125 pattern. The pin: two failures within the
 * window mint one capture, not two — this is what turned one Upstash outage
 * into ~4,000 Sentry events (the whole monthly error budget) in ~25h.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import {
  captureThrottled,
  resetThrottledCaptureForTesting,
} from "../../lib/observability/throttled-capture";

const mockCapture = Sentry.captureException as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resetThrottledCaptureForTesting();
});

describe("captureThrottled", () => {
  it("reports the first failure in a window", () => {
    const sent = captureThrottled("k", new Error("boom"), {
      subsystem: "test",
    });

    expect(sent).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it("does not report a second failure within the same window, under the same key", () => {
    captureThrottled("k", new Error("first"), { subsystem: "test" });
    const sent = captureThrottled("k", new Error("second"), {
      subsystem: "test",
    });

    expect(sent).toBe(false);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it("reports again once the window has elapsed", () => {
    jest.useFakeTimers();
    try {
      captureThrottled("k", new Error("first"), { subsystem: "test" }, 60_000);
      jest.advanceTimersByTime(60_001);
      const sent = captureThrottled(
        "k",
        new Error("second"),
        { subsystem: "test" },
        60_000,
      );

      expect(sent).toBe(true);
      expect(mockCapture).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps separate windows for different keys", () => {
    captureThrottled("a", new Error("first"), { subsystem: "test" });
    const sent = captureThrottled("b", new Error("second"), {
      subsystem: "test",
    });

    expect(sent).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(2);
  });
});
