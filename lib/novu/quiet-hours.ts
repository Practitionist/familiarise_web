/**
 * Q3 fix — quiet-hours deferral for the Novu outbox.
 *
 * Until now `quietHours*` was stored (UI + columns + API) but never read, so
 * the toggle implied enforcement that did not exist. These helpers compute the
 * `notBefore` instant `stageTrigger` should carry; the drain already honours
 * `notBefore <= now`, so writing it is the only missing wire.
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
  const match = /^(\d{1,2}):(\d{2})/.exec(input.trim());
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

/**
 * The instant quiet hours end (today or tomorrow) in UTC, or null when no
 * deferral applies. Pure function of (config, now) for testability.
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

  // Minutes until the window ends, then round up to the next minute boundary.
  const deltaMinutes =
    (end > current ? end - current : 24 * 60 - current + end) || 24 * 60;
  return new Date(now.getTime() + deltaMinutes * 60 * 1000 + 1000);
}
