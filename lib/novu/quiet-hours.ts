/**
 * Q3 fix — quiet-hours deferral for the Novu outbox.
 *
 * Until now `quietHours*` was stored (UI + columns + API) but never read, so
 * the toggle implied enforcement that did not exist. These helpers compute the
 * `notBefore` instant `stageTrigger` should carry; the drain only sends rows
 * with `notBefore <= now`, and `stageAndAttempt` skips the inline send while
 * `notBefore` is in the future, so the row waits for the drain.
 *
 * Design notes:
 * - Times are "HH:MM" wall-clock in the recipient's zone (`quietHoursTimezone`
 *   → `User.timezone` → platform default Asia/Kolkata).
 * - Overnight windows (22:00 → 08:00) are handled: "inside" means after start
 *   OR before end.
 * - Invalid/partial config returns null (send ASAP) — never throw from a
 *   notification path.
 * - Urgent categories are NOT deferred here; callers pass `deferrable: true`
 *   for routine product events. Payment-failure / security notices should send
 *   immediately (Courier/Slack severity guidance).
 */

import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_NOTIFICATION_TIMEZONE } from "./humanize";

export interface QuietHoursConfig {
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string | null;
  /** Fallback zone (usually User.timezone). */
  fallbackTimezone?: string | null;
}

function parseMinutes(input: string | null): number | null {
  if (!input) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function isRenderableTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function resolveZone(config: QuietHoursConfig): string {
  const candidates = [
    config.quietHoursTimezone,
    config.fallbackTimezone,
    DEFAULT_NOTIFICATION_TIMEZONE,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && isRenderableTimezone(trimmed)) return trimmed;
  }
  return DEFAULT_NOTIFICATION_TIMEZONE;
}

/** Minutes since midnight for `now` in `timeZone`. */
function minutesInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** Wall-clock calendar date in `timeZone`, via locale parts (DST-correct). */
function wallDateParts(
  now: Date,
  timeZone: string,
): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** The UTC instant of HH:MM wall-clock on a wall date in `zone`. */
function endInstant(
  zone: string,
  y: number,
  m: number,
  d: number,
  endMinutes: number,
): Date {
  const hh = String(Math.floor(endMinutes / 60)).padStart(2, "0");
  const mm = String(endMinutes % 60).padStart(2, "0");
  const pad = (n: number) => String(n).padStart(2, "0");
  return fromZonedTime(`${y}-${pad(m)}-${pad(d)} ${hh}:${mm}:00`, zone);
}

/**
 * The instant quiet hours end (today or tomorrow) in UTC, or null when no
 * deferral applies. Pure function of (config, now) for testability.
 *
 * The end is constructed as a zoned wall-clock time (not minute arithmetic
 * on `now`), so a DST transition inside the window still lands on the
 * configured wall-clock end.
 */
export function computeQuietHoursNotBefore(
  config: QuietHoursConfig,
  now: Date = new Date(),
): Date | null {
  if (!config.quietHoursEnabled) return null;
  const start = parseMinutes(config.quietHoursStart);
  const end = parseMinutes(config.quietHoursEnd);
  if (start === null || end === null || start === end) return null;

  const zone = resolveZone(config);
  const current = minutesInZone(now, zone);
  const inside =
    start < end
      ? current >= start && current < end
      : current >= start || current < end;
  if (!inside) return null;

  try {
    // First wall-clock end strictly after now (+1s boundary rounding).
    // Each step advances a full wall day, so the loop always terminates —
    // the fallback below is unreachable defensiveness.
    let { y, m, d } = wallDateParts(now, zone);
    for (let i = 0; i < 3; i++) {
      const candidate = endInstant(zone, y, m, d, end);
      if (candidate.getTime() > now.getTime()) {
        return new Date(candidate.getTime() + 1000);
      }
      const next = new Date(Date.UTC(y, m - 1, d) + 24 * 60 * 60 * 1000);
      y = next.getUTCFullYear();
      m = next.getUTCMonth() + 1;
      d = next.getUTCDate();
    }
  } catch {
    // Unrenderable zone slipped through: fail open (send ASAP).
    return null;
  }
  return new Date(now.getTime() + 60 * 60 * 1000);
}
