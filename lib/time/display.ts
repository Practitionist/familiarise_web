/**
 * Locale-derived clock and date labels for the scheduling surfaces (#1703 F3).
 *
 * Everything here goes through `Intl.DateTimeFormat` with the viewer's own
 * locale, so an en-IN viewer reads "7:30 pm" and an en-GB viewer "19:30" with
 * no 12/24-hour toggle. Pure: nothing reads `new Date()`, and `zone` decides
 * the wall clock so the server and the browser print the same string.
 */

/** `undefined` lets Intl pick the runtime locale; tests pass one explicitly. */
export interface DisplayOpts {
  locale?: string;
  zone?: string;
}

function formatter(
  options: Intl.DateTimeFormatOptions,
  opts: DisplayOpts = {},
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(opts.locale, {
    ...options,
    ...(opts.zone ? { timeZone: opts.zone } : {}),
  });
}

/** "7:30 pm" (en-IN), "19:30" (en-GB), "7:30 PM" (en-US). */
export function formatClockTime(date: Date, opts?: DisplayOpts): string {
  return formatter({ hour: "numeric", minute: "2-digit" }, opts).format(date);
}

/** "Thu 24 Sep". */
export function formatDayLabel(date: Date, opts?: DisplayOpts): string {
  return formatter(
    { weekday: "short", day: "numeric", month: "short" },
    opts,
  ).format(date);
}

/** "Thu 24 Sep, 2:00 pm". */
export function formatDateTimeLabel(date: Date, opts?: DisplayOpts): string {
  return `${formatDayLabel(date, opts)}, ${formatClockTime(date, opts)}`;
}

/** "Thu" — the weekday over a grid column. */
export function formatWeekdayShort(date: Date, opts?: DisplayOpts): string {
  return formatter({ weekday: "short" }, opts).format(date);
}

/** "22" — the day number under a weekday header. */
export function formatDayOfMonth(date: Date, opts?: DisplayOpts): string {
  return formatter({ day: "numeric" }, opts).format(date);
}

/** "September 2026". */
export function formatMonthLabel(date: Date, opts?: DisplayOpts): string {
  return formatter({ month: "long", year: "numeric" }, opts).format(date);
}

/** "24 Sep 2026". */
export function formatDateLabel(date: Date, opts?: DisplayOpts): string {
  return formatter(
    { day: "numeric", month: "short", year: "numeric" },
    opts,
  ).format(date);
}

/** "22 Sep – 28 Sep 2026" for a week header; both ends in one zone. */
export function formatDateRangeLabel(
  from: Date,
  to: Date,
  opts?: DisplayOpts,
): string {
  const short = formatter({ day: "numeric", month: "short" }, opts);
  return `${short.format(from)} – ${formatDateLabel(to, opts)}`;
}
