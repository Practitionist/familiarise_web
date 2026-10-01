/**
 * #1863 — how old the availability heatmap on screen is, said out loud.
 *
 * The grid polls every ~60 s with jitter and refetches on focus (ADR 16:
 * polling, not push). Two things follow from that and neither was visible:
 *
 *   1. A consultant who leaves the allocate page open for forty minutes and
 *      then hits Auto Allocate gets a refusal with no indication the cells they
 *      were reading were forty minutes old. The refusal is CORRECT — the
 *      allocator re-validates server-side, which is exactly why ADR 16 chose
 *      polling — but it reads as the grid having lied to them.
 *   2. Background poll failures are deliberately silent (a flaky minute must
 *      not toast every 60 s), so a persistently failing endpoint shows a frozen
 *      grid indefinitely with no signal that it is frozen. Silent-by-design is
 *      right for a transient blip and wrong for a grid that has not updated in
 *      an hour.
 *
 * This module is the pure half — the same shape as
 * `lib/scheduling/requestsFreshness.ts`, which is the pattern the Requests inbox
 * already established for exactly this problem. It decides WHAT to say; the
 * hook decides when to re-ask and the component renders it.
 *
 * DO NOT "FIX" THE CADENCE. A socket is not the missing piece here: bounded
 * staleness is acceptable by design because the booking mutation re-validates
 * server-side, so the worst a stale grid can do is cost a wasted click, never a
 * double-booking. What was missing was not freshness but HONESTY about
 * freshness. If you are here to replace the 60 s poll with SSE or WebSocket,
 * read `docs/booking/00-architecture-decisions.md` (ADR 16) first — the poll
 * costs one indexed read per viewer per minute and buys the absence of a
 * long-lived connection in a serverless function, which is the trade the
 * platform made on purpose.
 */

import { AVAILABILITY_POLL_INTERVAL_MS } from "@/lib/scheduling/availabilityPolling";

/**
 * When the indicator starts saying anything. One poll interval is the point at
 * which "the last poll should have landed by now" stops being a reasonable
 * assumption, so below it the badge is noise the consultant learns to ignore.
 * Two intervals is where a human notices a clock has stopped.
 */
export const FRESHNESS_WARN_AFTER_MS = AVAILABILITY_POLL_INTERVAL_MS * 2;
export const FRESHNESS_STALE_AFTER_MS = AVAILABILITY_POLL_INTERVAL_MS * 5;

/**
 * How often the badge re-reads the clock. The grid itself is unchanged between
 * polls (ADR 16), so this is a state write and nothing else — it must never
 * grow into a second poll, and nothing here changes the request cadence.
 */
export const FRESHNESS_TICK_MS = 15_000;

export type AvailabilityFreshness = "unknown" | "fresh" | "ageing" | "stale";

export interface AvailabilityFreshnessState {
  freshness: AvailabilityFreshness;
  /** Ready to print, or null while the data is still inside the first interval. */
  label: string | null;
  /** True once the poll has failed so persistently that the cells are frozen. */
  failed: boolean;
}

/** "40 s ago" / "4 min ago" / "1 h 12 m ago" — coarse on purpose. */
export function ageText(msSinceFetch: number): string {
  if (!Number.isFinite(msSinceFetch) || msSinceFetch < 0) return "unknown";
  const seconds = Math.floor(msSinceFetch / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0
    ? `${hours} h ${restMinutes} min ago`
    : `${hours} h ago`;
}

/**
 * What the grid should say about itself.
 *
 * @param fetchedAtMs when the last availability response settled, or NaN when
 *   none has (the first paint, or every fetch has failed).
 * @param nowMs current time.
 * @param consecutiveFailures background polls that have failed in a row. Zero
 *   means healthy. A single failure is deliberately not enough to say anything:
 *   that is the transient blip the silent catch was designed for, and a badge
 *   that fires on it teaches the consultant to ignore the badge.
 */
export function availabilityFreshness(
  fetchedAtMs: number,
  nowMs: number,
  consecutiveFailures = 0,
): AvailabilityFreshnessState {
  // No successful fetch ever: the grid is not "stale", it has never loaded, and
  // the component's own loading/error state owns that case.
  if (!Number.isFinite(fetchedAtMs)) {
    return {
      freshness: "unknown",
      label: null,
      failed: consecutiveFailures > 0,
    };
  }

  const age = Math.max(0, nowMs - fetchedAtMs);

  // The failure branch comes FIRST and outranks the age: a grid that last
  // updated thirty seconds ago and has failed five polls since is not fresh,
  // it is a frozen picture that happens to be recent, and saying "30s ago"
  // would be the more comforting lie.
  if (consecutiveFailures >= 3) {
    return {
      freshness: "stale",
      label: `Not updating — could not refresh (last good ${ageText(age)})`,
      failed: true,
    };
  }
  if (age >= FRESHNESS_STALE_AFTER_MS) {
    return {
      freshness: "stale",
      label: `Last checked ${ageText(age)} — refresh before allocating`,
      failed: false,
    };
  }
  if (age >= FRESHNESS_WARN_AFTER_MS) {
    return {
      freshness: "ageing",
      label: `Last checked ${ageText(age)}`,
      failed: false,
    };
  }
  return { freshness: "fresh", label: null, failed: false };
}
