/**
 * #1706 decision B — the Requests tab's count poll: 45 s cadence through the
 * shared availability poller, hidden-tab pause, and a badge that only ever
 * says "N new" / "List changed" against the totals the rows were read at.
 */

import "./setup";

import { createAvailabilityPoller } from "@/lib/scheduling/availabilityPolling";
import {
  REQUESTS_COUNT_POLL_INTERVAL_MS,
  requestsFreshnessBadge,
} from "@/lib/scheduling/requestsFreshness";

describe("requestsFreshnessBadge", () => {
  it("is silent when the polled total matches, names new rows, and flags a drop", () => {
    expect(requestsFreshnessBadge(4, 4)).toBeNull();
    expect(requestsFreshnessBadge(4, 7)).toBe("3 new");
    expect(requestsFreshnessBadge(4, 2)).toBe("List changed");
  });
});

describe("count poll cadence", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("ticks at the 45 s interval, not the poller's 60 s default, and never while hidden", () => {
    let visibility: DocumentVisibilityState = "visible";
    const fetch = jest.fn(() => Promise.resolve());
    const poller = createAvailabilityPoller({
      isEnabled: () => true,
      visibilityState: () => visibility,
      msSinceLastFetch: () => 0,
      inFlight: () => null,
      fetch,
      intervalMs: REQUESTS_COUNT_POLL_INTERVAL_MS,
    });

    poller.arm();
    jest.advanceTimersByTime(REQUESTS_COUNT_POLL_INTERVAL_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    poller.onVisibilityChange();
    jest.advanceTimersByTime(REQUESTS_COUNT_POLL_INTERVAL_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(1);

    poller.dispose();
  });
});
