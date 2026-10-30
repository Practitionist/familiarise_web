/**
 * How old the availability grid on screen is, said out loud. The grid polls
 * about once a minute and the booking write re-validates server-side, so a
 * stale grid can cost a click but never double-book; this only makes the age
 * and a persistently failing poll visible. Pure: the hook decides when to
 * re-ask, the component renders the label.
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
 * @param fetchedAtMs when the last SUCCESSFUL availability response landed
 *   (a 304 counts), or NaN when none has. Failures never move it.
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

/** Field-wise equality, so a ticking clock that changes nothing re-renders nothing. */
export function sameFreshness(
  a: AvailabilityFreshnessState,
  b: AvailabilityFreshnessState,
): boolean {
  return (
    a.freshness === b.freshness && a.label === b.label && a.failed === b.failed
  );
}
