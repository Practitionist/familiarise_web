/**
 * IST reporting-period arithmetic, shared by the monthly compliance exports
 * and the back office's "today" figures.
 *
 * Every statutory period this codebase reports on is a calendar month reckoned
 * in IST, not UTC. A job that computed its window from UTC components would
 * file the first five and a half hours of each month against the wrong period,
 * which is invisible until a return is queried; the outward-supplies register
 * applies the shift through these helpers.
 *
 * Pure module: no Prisma, no environment reads of its own.
 */

/** IST is UTC+5:30. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The instant that begins the previous IST calendar month.
 * `now` is injectable so callers can be tested without freezing the clock.
 */
export function previousIstCalendarMonthStart(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  // The shift is needed twice, and only doing it once was the bug (#1370):
  // adding the offset picks the right IST month, subtracting it turns that IST
  // midnight back into the instant a UTC-stored timestamp compares against.
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1) - IST_OFFSET_MS,
  );
}

/** The instant that begins the IST calendar day containing `now`. */
export function istDayStart(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) -
      IST_OFFSET_MS,
  );
}

/** The exclusive end of the IST calendar month that `monthStart` begins. */
export function nextMonthStart(monthStart: Date): Date {
  // `monthStart` is an IST midnight, so its own UTC components name the day
  // before; read the month in IST for the same reason the start boundary does.
  const ist = new Date(monthStart.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - IST_OFFSET_MS,
  );
}

/** The instant that begins the Indian financial year (1 April, IST) containing `now`. */
export function istFinancialYearStart(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const year =
    ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return new Date(Date.UTC(year, 3, 1) - IST_OFFSET_MS);
}

/** The IST calendar date holding `now`, as `YYYY-MM-DD`. */
export function istDateKey(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Indian financial year holding `now`, labelled `2026-27`. */
export function istFinancialYearLabel(now: Date = new Date()): string {
  const start = new Date(istFinancialYearStart(now).getTime() + IST_OFFSET_MS);
  const year = start.getUTCFullYear();
  return `${year}-${String(year + 1).slice(2)}`;
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A filing date typed as `YYYY-MM-DD`, read as 00:00 IST that day; null when
 * it is not a real date or falls after today in IST.
 */
export function istFilingDate(
  value: string,
  now: Date = new Date(),
): Date | null {
  const match = DATE_KEY.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const start = new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
  // A day past the month's end rolls over; refuse it rather than move it.
  if (istDateKey(start) !== value.trim()) return null;
  return value.trim() <= istDateKey(now) ? start : null;
}

/** The instant that begins the IST calendar month named by `YYYY-MM`. */
export function istMonthStart(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS);
}
