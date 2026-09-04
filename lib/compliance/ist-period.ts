/**
 * IST reporting-period arithmetic, shared by the monthly compliance exports.
 *
 * Every statutory period this codebase reports on is a calendar month reckoned
 * in IST, not UTC. A job that computed its window from UTC components would
 * file the first five and a half hours of each month against the wrong period,
 * which is invisible until a return is queried. Both the GSTR-8 draft and the
 * outward-supplies register need exactly the same shift, so it lives here once
 * rather than being transcribed into each job.
 *
 * Pure module: no Prisma, no environment reads of its own.
 */

/** IST is UTC+5:30. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The UTC instant that begins the previous calendar month, as reckoned in IST.
 * `now` is injectable so callers can be tested without freezing the clock.
 */
export function previousIstCalendarMonthStart(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
}

/** The exclusive end of the calendar month that `monthStart` begins. */
export function nextMonthStart(monthStart: Date): Date {
  return new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1),
  );
}

/**
 * Parse a `YYYY-MM-DD` environment override into a UTC instant, rejecting
 * anything else. A silently-misparsed boundary exports the wrong period, and
 * that only surfaces at filing time, so the format is checked rather than
 * handed to the Date constructor to interpret however it likes.
 */
export function parseIsoDateOverride(raw: string, envName: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new TypeError(`${envName} must be a YYYY-MM-DD date; got "${raw}"`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`${envName} is not a real date; got "${raw}"`);
  }
  // The NaN check alone is not enough: the ISO parser ROLLS OVER a day that is
  // out of range for its month, so "2026-02-30" silently becomes 2026-03-02 and
  // the operator exports a period they never asked for. Round-tripping the
  // parsed instant back to YYYY-MM-DD is the cheapest way to catch that.
  if (parsed.toISOString().slice(0, 10) !== raw) {
    throw new TypeError(`${envName} is not a real calendar date; got "${raw}"`);
  }
  return parsed;
}
