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
    // Equal totals hide a swap (one allocated, one new); the top row tells.
    expect(requestsFreshnessBadge(4, 4, true)).toBe("List changed");
    expect(requestsFreshnessBadge(4, 7, true)).toBe("3 new");
  });
});

describe("count poll cadence", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("ticks at the 45 s interval, not the poller's 60 s default, and never while hidden", async () => {
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

    // Async advances flush the fetch continuation that re-arms the next
    // tick, so the hidden branch below cancels a real pending poll.
    poller.arm();
    await jest.advanceTimersByTimeAsync(REQUESTS_COUNT_POLL_INTERVAL_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    visibility = "hidden";
    poller.onVisibilityChange();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(REQUESTS_COUNT_POLL_INTERVAL_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(1);

    poller.dispose();
  });
});
