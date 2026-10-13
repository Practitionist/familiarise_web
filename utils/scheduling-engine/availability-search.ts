/**
 * Two bounds on the allocator's availability search, kept out of
 * `SchedulingService` because they are pure and because each has to be true of
 * every candidate rather than of one walk.
 *
 * 1. `buildAvailabilityIndex` — the CUSTOM arm's per-candidate `.some()` over
 *    every published row, with two `new Date()` allocations per row per call,
 *    replaced by one merged interval list built ONCE per allocation and then
 *    binary-searched. `isWithinAvailability` is called once per candidate start,
 *    up to `MAX_CANDIDATE_STARTS_PER_ROW` per row, per day of the scheduling
 *    window, so the scan was O(rows × candidates × days) with a Date allocation
 *    inside the inner loop. Now O(rows log rows) once plus O(log rows) per
 *    candidate.
 *
 * 2. `createSearchBudget` — a wall-clock ceiling on the search itself. The
 *    search runs OUTSIDE the write transaction but still inside one request and
 *    under a Redis grant that is never renewed (`lockAutoAllocate`, 150 s), so a
 *    search that overruns both returns a 504 and leaves the grant unrenewed. A
 *    partial answer beats an infrastructure timeout, so the caller stops
 *    searching and answers with the same shortage it raises for a full calendar.
 */

import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";

/** Half-open `[startMs, endMs)`. */
export type AvailabilityInterval = readonly [number, number];

interface MutableInterval {
  startMs: number;
  endMs: number;
}

interface CustomAvailabilityRow {
  startsAt: Date | string;
  endsAt: Date | string;
}

/**
 * The published custom rows as one sorted, non-overlapping interval list.
 *
 * Only OVERLAPPING rows are folded, which keeps the index exactly equivalent to
 * the per-row containment test it replaces: a contiguous atom is contained in a
 * union of intervals if and only if it is contained in one connected component,
 * and a connected component is precisely a run of overlapping rows. Back-to-back
 * rows stay separate, so an atom spanning the seam is still (correctly) refused.
 */
export function buildAvailabilityIndex(
  rows: readonly CustomAvailabilityRow[],
): AvailabilityInterval[] {
  const sorted: MutableInterval[] = [];
  for (const row of rows) {
    const startMs = new Date(row.startsAt).getTime();
    const endMs = new Date(row.endsAt).getTime();
    // A malformed row covers nothing; dropping it here is what the old
    // comparison did too, since no finite candidate satisfies either side.
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;
    sorted.push({ startMs, endMs });
  }
  sorted.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: MutableInterval[] = [];
  for (const row of sorted) {
    const last = merged[merged.length - 1];
    if (last && row.startMs < last.endMs) {
      if (row.endMs > last.endMs) last.endMs = row.endMs;
      continue;
    }
    merged.push({ ...row });
  }
  return merged.map((row) => [row.startMs, row.endMs] as const);
}

/**
 * Whether one published interval covers `[startMs, startMs + durationMs)`.
 *
 * Binary search for the last interval that STARTS at or before the atom, then
 * one containment test. No allocation, and the answer does not depend on how
 * many rows the consultant published.
 */
export function indexCoversAtom(
  index: readonly AvailabilityInterval[],
  startMs: number,
  durationMs: number = SCHEDULING_INTERVAL_MS,
): boolean {
  if (index.length === 0) return false;
  let low = 0;
  let high = index.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (index[mid][0] <= startMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // Nothing starts at or before the atom, so nothing contains it.
  if (found === -1) return false;
  return index[found][1] >= startMs + durationMs;
}

/**
 * A wall-clock ceiling on one search. `now` is injectable so the exhaustion
 * path is testable without waiting, and so a caller that already has a clock
 * hands the same one over.
 */
export interface SearchBudget {
  readonly limitMs: number;
  /** Milliseconds since the budget was opened. */
  spentMs(): number;
  /** True once the search has spent its ceiling. */
  exhausted(): boolean;
}

export function createSearchBudget(
  limitMs: number,
  now: () => number = Date.now,
): SearchBudget {
  const startedAt = now();
  return {
    limitMs,
    spentMs: () => now() - startedAt,
    exhausted: () => now() - startedAt > limitMs,
  };
}
