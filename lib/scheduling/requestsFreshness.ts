/**
 * #1706 decision B — the Requests tab polls COUNTS, not rows. A count poll
 * every 45 s (paused while hidden, refetched on a stale return through the
 * shared availability poller) surfaces "N new — Refresh"; the list itself
 * only changes when the consultant asks or after their own write, so a row
 * never moves under a pointer mid-allocation.
 */

export const REQUESTS_COUNT_POLL_INTERVAL_MS = 45_000;

/**
 * Badge text for a polled total against the total the rows on screen were
 * read at. Null when nothing changed. A drop means rows left the queue
 * elsewhere (allocated in another tab, expired), which is still worth a
 * refresh but is not "new".
 */
export function requestsFreshnessBadge(
  knownTotal: number,
  polledTotal: number,
): string | null {
  const delta = polledTotal - knownTotal;
  if (delta === 0) return null;
  if (delta > 0) return `${delta} new`;
  return "List changed";
}
