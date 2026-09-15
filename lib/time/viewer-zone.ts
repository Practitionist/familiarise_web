/**
 * Render every absolute instant in the VIEWER'S zone, on the server and in
 * the browser alike. date-fns's `format()` reads the runtime's local zone, so
 * Netlify (UTC) and a browser in Asia/Kolkata produced two wall clocks for one
 * instant and React threw hydration error #418 on the Appointments pages.
 *
 * Pure on purpose: nothing here reads `new Date()` or the runtime zone, so a
 * rendered string is a function of (instant, zone, pattern) and nothing else.
 */

import { formatInTimeZone } from "date-fns-tz";

export const UTC_ZONE = "UTC";

export interface ViewerZone {
  /** IANA zone every time on the page is rendered in. */
  zone: string;
  /** True when `zone` is the viewer's own saved timezone, so no label is shown. */
  own: boolean;
}

/** True when the runtime knows this IANA name; a bad saved value must not crash a page. */
export function isValidTimeZone(
  zone: string | null | undefined,
): zone is string {
  if (!zone) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface ResolveViewerZoneOpts {
  /** `User.timezone` off the session — the viewer's own zone when set. */
  userTimezone?: string | null;
  /** The appointment's scheduling zone, when the caller has one. */
  fallbackZone?: string | null;
}

/** The viewer's saved zone, else the caller's fallback, else UTC. */
export function resolveViewerZone({
  userTimezone,
  fallbackZone,
}: ResolveViewerZoneOpts = {}): string {
  if (isValidTimeZone(userTimezone)) return userTimezone;
  if (isValidTimeZone(fallbackZone)) return fallbackZone;
  return UTC_ZONE;
}

/** `resolveViewerZone` plus whether the result is the viewer's own zone. */
export function describeViewerZone(
  opts: ResolveViewerZoneOpts = {},
): ViewerZone {
  const zone = resolveViewerZone(opts);
  return { zone, own: isValidTimeZone(opts.userTimezone) };
}

/** Format an instant in `zone` with a date-fns pattern, independent of the runtime zone. */
export function formatInViewerZone(
  date: Date | string | number,
  zone: string,
  pattern: string,
): string {
  return formatInTimeZone(date, zone, pattern);
}

/** Short zone name for a label ("IST", "UTC", "GMT+8"); DST-aware, hence the date. */
export function zoneLabel(date: Date | string | number, zone: string): string {
  return formatInTimeZone(date, zone, "zzz");
}

/**
 * Format for the page's viewer: no suffix in their own zone, a short zone
 * label otherwise, so a time shown in a fallback zone is never mistaken for
 * theirs.
 */
export function formatForViewer(
  date: Date | string | number,
  viewer: ViewerZone,
  pattern: string,
): string {
  const text = formatInViewerZone(date, viewer.zone, pattern);
  return viewer.own ? text : `${text} ${zoneLabel(date, viewer.zone)}`;
}
