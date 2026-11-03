/**
 * The Requests tab refetches when the viewer returns to a stale tab and, when
 * the total moved, says so ("N new — Refresh") instead of letting rows move
 * under the pointer mid-allocation.
 */

/**
 * Badge text for a polled total against the total the rows on screen were
 * read at. Null when nothing changed. A drop means rows left the queue
 * elsewhere (allocated in another tab, expired), which is still worth a
 * refresh but is not "new". `topRowChanged` catches the equal-total swap
 * (one allocated, one arrived) the totals alone cannot see.
 */
export function requestsFreshnessBadge(
  knownTotal: number,
  polledTotal: number,
  topRowChanged = false,
): string | null {
  const delta = polledTotal - knownTotal;
  if (delta > 0) return `${delta} new`;
  if (delta < 0 || topRowChanged) return "List changed";
  return null;
}
