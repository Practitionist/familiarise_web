/**
 * The one place a weekly availability row's `utcOffsetMinutes` is decided
 * (#1326, #1348).
 *
 * Four write paths used to answer this question for themselves and two of them
 * answered it wrong: onboarding stored `0` for a consultant with no profile
 * timezone, as did the per-row PATCH, so every row they wrote projected as if
 * the consultant lived in UTC and the grid drew their availability five and a
 * half hours away from where they published it. Nothing validated a caller who
 * sent an offset of their own either, so a client could contradict the profile
 * silently.
 *
 * The rule: the consultant's `User.timezone` is the source, a caller-supplied
 * value may only agree with it, and an absent or unusable zone falls back to
 * the launch offset rather than to UTC (ADR 17 — IST-only at launch).
 */

import { getTimezoneOffsetMinutes } from "@/utils/scheduling-engine/slotTimeUtils";
import {
  isKnownTimeZone,
  weeklyRowLocalColumns,
  weeklySaveProbeOffsetMinutes,
  type WeeklyRowLocalColumns,
  type WeeklyRowTimes,
} from "@/utils/schedule/weekly-projection";

/**
 * The five local columns for a row the save path built: its UTC minutes were
 * converted on `WEEKLY_SAVE_PROBE_DATE`, so that date's offset recovers the
 * wall clock the consultant typed.
 */
export function weeklyLocalColumnsForSave(
  row: WeeklyRowTimes,
  timezone: string,
): WeeklyRowLocalColumns {
  return weeklyRowLocalColumns(
    row,
    timezone,
    weeklySaveProbeOffsetMinutes(timezone),
  );
}

/** IST. The platform's only market at launch (ADR 17). */
export const LAUNCH_UTC_OFFSET_MINUTES = 330;
export const LAUNCH_TIMEZONE = "Asia/Kolkata";

export const WEEKLY_OFFSET_CONFLICT_CODE = "UTC_OFFSET_CONFLICT";

/** A caller sent a `utcOffsetMinutes` that contradicts the profile zone. */
export class WeeklyOffsetConflictError extends Error {
  readonly code = WEEKLY_OFFSET_CONFLICT_CODE;

  constructor(
    readonly suppliedOffsetMinutes: number,
    readonly resolvedOffsetMinutes: number,
  ) {
    super(
      `utcOffsetMinutes ${suppliedOffsetMinutes} contradicts the consultant's profile timezone (${resolvedOffsetMinutes})`,
    );
    this.name = "WeeklyOffsetConflictError";
  }
}

/**
 * Legacy IANA aliases some browsers still report from
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`, folded to the canonical
 * name so a row is stamped with the zone it actually lives in.
 */
const ZONE_ALIASES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
};

function normaliseZone(profileTimezone: string | null | undefined): string {
  const zone = profileTimezone?.trim() ?? "";
  return ZONE_ALIASES[zone] ?? zone;
}

/** The zone's offset, or null when the zone is unset or unresolvable. */
function derivedOffsetMinutes(zone: string): number | null {
  if (!zone || !isKnownTimeZone(zone)) return null;
  return getTimezoneOffsetMinutes(zone);
}

/**
 * The IANA zone stamped onto the row's `timezone` column: the consultant's own
 * when it resolves, the launch zone otherwise.
 */
export function resolveWeeklyTimezone(
  profileTimezone: string | null | undefined,
): string {
  const zone = normaliseZone(profileTimezone);
  return derivedOffsetMinutes(zone) === null ? LAUNCH_TIMEZONE : zone;
}

export interface ResolveWeeklyOffsetInput {
  /** `User.timezone` of the consultant who owns the rows. */
  profileTimezone: string | null | undefined;
  /** What the request body asked for, if anything. May only agree. */
  callerSupplied?: number | null;
}

/**
 * The offset every weekly row written in this request must carry.
 *
 * @throws WeeklyOffsetConflictError when `callerSupplied` disagrees; routes
 *         answer that with 400 `UTC_OFFSET_CONFLICT`.
 */
export function resolveWeeklyUtcOffsetMinutes({
  profileTimezone,
  callerSupplied,
}: ResolveWeeklyOffsetInput): number {
  const zone = normaliseZone(profileTimezone);
  const resolved = derivedOffsetMinutes(zone) ?? LAUNCH_UTC_OFFSET_MINUTES;

  if (
    callerSupplied !== undefined &&
    callerSupplied !== null &&
    callerSupplied !== resolved
  ) {
    throw new WeeklyOffsetConflictError(callerSupplied, resolved);
  }

  return resolved;
}
