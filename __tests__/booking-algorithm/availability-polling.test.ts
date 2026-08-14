/**
 * Poll-decision policy for the availability heatmap (#1164). The hook owns the
 * timers; these three functions own the decisions, so the behaviour that
 * matters — never poll a hidden tab, refetch on a stale return, don't hammer
 * the endpoint on an alt-tab flick — is pinned without a DOM.
 */

import "./setup";

import {
  AVAILABILITY_POLL_INTERVAL_MS,
  RETURN_REFETCH_MIN_STALENESS_MS,
  nextPollDelay,
  shouldPoll,
  shouldRefetchOnReturn,
} from "@/lib/scheduling/availabilityPolling";

describe("shouldPoll", () => {
  it("polls a visible tab that the hook has enabled", () => {
    expect(shouldPoll({ enabled: true, visibilityState: "visible" })).toBe(true);
  });

  it("never polls a hidden tab", () => {
    expect(shouldPoll({ enabled: true, visibilityState: "hidden" })).toBe(false);
  });

  it("never polls when the fetch gate itself is off", () => {
    // autoLoad=false / no consultantId — the same gate the fetch effects use.
    expect(shouldPoll({ enabled: false, visibilityState: "visible" })).toBe(
      false,
    );
  });
});

describe("nextPollDelay", () => {
  it("waits a full interval when the data was just fetched", () => {
    expect(nextPollDelay(0)).toBe(AVAILABILITY_POLL_INTERVAL_MS);
  });

  it("waits only the remainder of the current interval", () => {
    expect(nextPollDelay(20_000)).toBe(AVAILABILITY_POLL_INTERVAL_MS - 20_000);
  });

  it("fires immediately once the interval has already elapsed", () => {
    // A tab hidden longer than the interval must not sit out another minute.
    expect(nextPollDelay(AVAILABILITY_POLL_INTERVAL_MS + 5 * 60_000)).toBe(0);
  });

  it("treats an unknown last-fetch time as a fresh interval", () => {
    // NaN is the pre-first-fetch state; scheduling at 0 would busy-loop.
    expect(nextPollDelay(Number.NaN)).toBe(AVAILABILITY_POLL_INTERVAL_MS);
    expect(nextPollDelay(-1)).toBe(AVAILABILITY_POLL_INTERVAL_MS);
  });

  it("honours a caller-supplied interval", () => {
    expect(nextPollDelay(1_000, 10_000)).toBe(9_000);
  });
});

describe("shouldRefetchOnReturn", () => {
  it("refetches when the grid is at least as stale as the floor", () => {
    expect(shouldRefetchOnReturn(RETURN_REFETCH_MIN_STALENESS_MS)).toBe(true);
    expect(shouldRefetchOnReturn(60_000)).toBe(true);
  });

  it("only re-arms after an alt-tab flick", () => {
    // focus and visibilitychange both fire on a return; the second one must
    // not issue a duplicate request behind the first.
    expect(shouldRefetchOnReturn(0)).toBe(false);
    expect(shouldRefetchOnReturn(RETURN_REFETCH_MIN_STALENESS_MS - 1)).toBe(
      false,
    );
  });

  it("refetches when the last fetch time is unknown", () => {
    expect(shouldRefetchOnReturn(Number.NaN)).toBe(true);
  });
});
