import { OccurrenceCompletionStatus } from "@prisma/client";
import { SCHEDULING_INTERVAL_MS } from "../../lib/appointments/occurrences";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The seed's stand-in for the app's occupancy check: one host's live sessions
 * never overlap, tentative or confirmed, because checkout and allocation
 * refuse a time anything else still holds.
 */
export class HostCalendar {
  private readonly busy = new Map<string, Array<[number, number]>>();

  isFree(hostId: string, startsAt: Date, endsAt: Date): boolean {
    const start = startsAt.getTime();
    const end = endsAt.getTime();
    return (this.busy.get(hostId) ?? []).every(
      ([s, e]) => e <= start || s >= end,
    );
  }

  /** Books `[startsAt, endsAt)` for the host; false when it overlaps a held time. */
  claim(hostId: string, startsAt: Date, endsAt: Date): boolean {
    if (!this.isFree(hostId, startsAt, endsAt)) return false;
    const rows = this.busy.get(hostId) ?? [];
    rows.push([startsAt.getTime(), endsAt.getTime()]);
    this.busy.set(hostId, rows);
    return true;
  }
}

/** `day`'s calendar date at `minutesUtc` past UTC midnight, floored to the 30-minute grid. */
export function atGridTime(day: Date, minutesUtc: number): Date {
  const midnight = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
  );
  const offset =
    Math.floor((minutesUtc * 60 * 1000) / SCHEDULING_INTERVAL_MS) *
    SCHEDULING_INTERVAL_MS;
  return new Date(midnight + offset);
}

/**
 * The first start at or after `from` (stepping a day at a time, towards the
 * past when `step` is -1) where the host is free for `durationMs`; null after
 * `tries` days. The time is claimed only when `occupies` is true: a released
 * session holds nothing.
 */
export function placeSession(
  calendar: HostCalendar,
  hostId: string,
  from: Date,
  durationMs: number,
  opts: { occupies: boolean; step?: 1 | -1; tries?: number },
): Date | null {
  const step = opts.step ?? 1;
  const tries = opts.tries ?? 14;
  for (let i = 0; i < tries; i++) {
    const startsAt = new Date(from.getTime() + i * step * DAY_MS);
    const endsAt = new Date(startsAt.getTime() + durationMs);
    if (!opts.occupies) return startsAt;
    if (calendar.claim(hostId, startsAt, endsAt)) return startsAt;
  }
  return null;
}

/** What a cancel, rejection or expiry leaves on a session: CANCELLED plus a tombstone. */
export function releasedSession(at: Date) {
  return {
    completionStatus: OccurrenceCompletionStatus.CANCELLED,
    deletedAt: at,
  };
}
