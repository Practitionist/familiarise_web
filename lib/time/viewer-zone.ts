/**
 * Render every absolute instant in the VIEWER'S zone, on the server and in
 * the browser alike, through Intl alone. date-fns-tz built a host-local Date,
 * so a wall time inside the browser's spring-forward hour printed an hour late.
 *
 * Pure on purpose: nothing here reads `new Date()` or the runtime zone, so a
 * rendered string is a function of (instant, zone, pattern) and nothing else.
 */

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

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const wallFormats = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of an instant in `zone`, read by Intl with no host-local Date. */
function wallClock(date: Date, zone: string): WallClock {
  let fmt = wallFormats.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    wallFormats.set(zone, fmt);
  }
  const parts = fmt.formatToParts(date);
  const num = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour") % 24,
    minute: num("minute"),
    second: num("second"),
    weekday: WEEKDAYS.indexOf(weekday),
  };
}

/** The zone's UTC offset at `date` as "+05:30". */
function offsetText(date: Date, clock: WallClock): string {
  const wall = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  const minutes = Math.round(
    (wall - Math.floor(date.getTime() / 1000) * 1000) / 60_000,
  );
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Short zone name in en-US from Intl ("PDT", "GMT", "GMT+11"). */
function intlZoneName(date: Date, zone: string): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? zone
  );
}

/** The date-fns tokens the repo's patterns use, in date-fns's en-US wording. */
const TOKENS: Record<
  string,
  (c: WallClock, date: Date, zone: string) => string
> = {
  yyyy: (c) => String(c.year).padStart(4, "0"),
  MMMM: (c) => MONTHS[c.month - 1],
  MMM: (c) => MONTHS[c.month - 1].slice(0, 3),
  MM: (c) => pad(c.month),
  dd: (c) => pad(c.day),
  d: (c) => String(c.day),
  EEEE: (c) => WEEKDAYS_LONG[c.weekday],
  EEE: (c) => WEEKDAYS[c.weekday],
  HH: (c) => pad(c.hour),
  h: (c) => String(c.hour % 12 || 12),
  mm: (c) => pad(c.minute),
  a: (c) => (c.hour < 12 ? "AM" : "PM"),
  zzz: (_c, date, zone) => zoneLabel(date, zone),
  xxx: (c, date) => offsetText(date, c),
};

/**
 * Format an instant in `zone` with a date-fns pattern, independent of the
 * runtime zone. Only the tokens in `TOKENS` and quoted text are understood; any
 * other letter run throws, so a new pattern cannot silently misprint.
 */
export function formatInViewerZone(
  date: Date | string | number,
  zone: string,
  pattern: string,
): string {
  const at = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(at.getTime())) throw new RangeError("Invalid time value");
  const clock = wallClock(at, zone);
  let out = "";
  for (let i = 0; i < pattern.length;) {
    const ch = pattern[i];
    if (ch === "'") {
      const close = pattern.indexOf("'", i + 1);
      if (close === -1) throw new RangeError(`Unclosed quote in "${pattern}"`);
      out += close === i + 1 ? "'" : pattern.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (pattern[j] === ch) j++;
      const token = pattern.slice(i, j);
      const render = TOKENS[token];
      if (!render) {
        throw new RangeError(
          `Unsupported date token "${token}" in "${pattern}"`,
        );
      }
      out += render(clock, at, zone);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Legacy IANA spellings browsers and old profiles still report, folded to
 * the canonical name so one zone is never shown under two names (#1703 F3).
 */
const ZONE_ALIASES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "US/Eastern": "America/New_York",
  "US/Central": "America/Chicago",
  "US/Mountain": "America/Denver",
  "US/Pacific": "America/Los_Angeles",
  "Etc/UTC": "UTC",
  "Etc/GMT": "UTC",
  GMT: "UTC",
};

/** The canonical IANA name for a zone string, trimmed; unknown names pass through. */
export function canonicalZone(zone: string): string {
  const trimmed = zone.trim();
  return ZONE_ALIASES[trimmed] ?? trimmed;
}

/** Short zone name for a label ("IST", "UTC", "GMT+8"); DST-aware, hence the date. */
/**
 * ICU prints "GMT+5:30" for India on Linux and "IST" on macOS, so the label a
 * user actually reads is pinned here and Intl only names the rest (#1653).
 */
export const ZONE_ABBREVIATION: Record<string, string> = {
  "Asia/Kolkata": "IST",
  // Kept for readers that index this map directly (lib/novu/humanize.ts).
  "Asia/Calcutta": "IST",
};

export function zoneLabel(date: Date | string | number, zone: string): string {
  const canonical = canonicalZone(zone);
  return (
    ZONE_ABBREVIATION[canonical] ??
    // An explicit en-US: the runtime locale differs between server and browser.
    intlZoneName(new Date(date), canonical)
  );
}

/**
 * "IST (UTC+05:30)" — the abbreviation plus the offset in force at `date`,
 * for the grid footer and anywhere a zone is named to a person (#1703 F3).
 * Callers put `canonicalZone(zone)` in a `title` so the IANA name is one
 * hover away without cluttering the line.
 */
export function zoneDisplayLabel(
  date: Date | string | number,
  zone: string,
): string {
  const canonical = canonicalZone(zone);
  const offset = formatInViewerZone(date, canonical, "xxx");
  return `${zoneLabel(date, canonical)} (UTC${offset === "+00:00" ? "" : offset})`;
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
