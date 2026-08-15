/**
 * #1164 — poll-decision logic for the availability heatmap, kept pure so the
 * policy is unit-testable without a DOM. The hook (useCalendarData) owns the
 * timers and listeners; this module owns the two decisions they consult.
 *
 * Polling, not push (#1164 decision): the grid is a hint, allocation
 * re-validates server-side, so bounded staleness is fine and a socket is not.
 */

export const AVAILABILITY_POLL_INTERVAL_MS = 60_000;

/**
 * Staleness floor for the visibility/focus refetch. Both listeners fire on a
 * tab return (focus + visibilitychange), and the first one to refetch stamps
 * the fetch time — so the second sees sub-floor staleness and only re-arms.
 * The same floor absorbs a quick alt-tab flick.
 */
export const RETURN_REFETCH_MIN_STALENESS_MS = 5_000;

export interface PollContext {
  /** autoLoad && consultantId — the same gate the fetch effects use. */
  enabled: boolean;
  /** document.visibilityState at decision time. */
  visibilityState: DocumentVisibilityState;
}

/** A hidden tab never polls; it re-arms on the visibilitychange back. */
export function shouldPoll(ctx: PollContext): boolean {
  return ctx.enabled && ctx.visibilityState !== "hidden";
}

/**
 * Delay before the next poll, given how stale the data already is. On a
 * return to a tab hidden longer than the interval this is 0 — refetch now;
 * a quick alt-tab flick keeps the remainder of the current interval instead
 * of hammering the endpoint.
 */
export function nextPollDelay(
  msSinceLastFetch: number,
  intervalMs: number = AVAILABILITY_POLL_INTERVAL_MS,
): number {
  if (!Number.isFinite(msSinceLastFetch) || msSinceLastFetch < 0) {
    return intervalMs;
  }
  return Math.max(0, intervalMs - msSinceLastFetch);
}

/**
 * Whether a return to the tab/window (focus or visibilitychange→visible)
 * refetches immediately rather than just re-arming the timer. An unknown
 * last-fetch time (NaN) counts as stale — refetching is the safe answer.
 */
export function shouldRefetchOnReturn(msSinceLastFetch: number): boolean {
  return (
    !Number.isFinite(msSinceLastFetch) ||
    msSinceLastFetch >= RETURN_REFETCH_MIN_STALENESS_MS
  );
}
