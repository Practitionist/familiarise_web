/**
 * Shared API formatting utilities for schedule slots
 * Single source of truth for converting local slots to API format
 */

import {
  convertTimezoneToUtc,
  convertTimezoneToUtcWithOvernight,
  convertUtcToTimezone,
  isOvernight,
  sortSlotsByTime,
} from "@/utils/dateTimeUtils";
import { dateToMinuteUtc } from "@/utils/scheduling-engine/slotTimeUtils";
import { resolveOvernightStatus } from "@/utils/schedule/overnight";
import { isValidTimeRange } from "@/utils/scheduling-engine/interval-validation";
import { THIRTY_MIN_MS } from "@/utils/scheduling-engine/intervals";
import { DayOfWeek } from "@prisma/client";
import type { CustomSlot, SlotsType, WeeklySlot } from "./types";

/**
 * The booking grid, as an instant-space fact.
 *
 * The server refuses a published window whose boundaries are not on this grid
 * (`lib/scheduling/availability-contract`, refusal code GRID): the grid
 * generator and the allocator both step 30 minutes FROM THE ROW'S OWN START, so
 * a row at 03:15 mints 03:15/03:45 and checkout refuses every one of them with
 * SLOT_NOT_ON_GRID. `THIRTY_MIN_MS` is the same 30 minutes the engine schedules
 * in; it is imported rather than written as a literal because the server derives
 * its own copy from `SCHEDULING_INTERVAL_MS` and the two must not drift.
 *
 * The offset deliberately does not appear in the arithmetic. The grid is a
 * property of the INSTANT and the instant is what the server tests, so ceiling
 * in instant space is the exact inverse of the server's own check and cannot
 * disagree with it the way a separately-resolved offset can — `fromZonedTime`
 * has already decided what the consultant's 09:00 means, including on a
 * spring-forward day where 02:30 does not exist.
 *
 * The zone is the reason the two can ever differ, which is what makes a
 * 15-minute entry step insufficient on its own:
 *
 *   Asia/Kolkata   (+05:30)  09:00 local → 03:30Z → already on the grid
 *   Asia/Kathmandu (+05:45)  09:00 local → 03:15Z → off by half an atom
 *
 * An offset that is a whole number of 30 minutes (every :00 and :30 zone, which
 * is every zone this app ships for) leaves the consultant's local lattice
 * already equal to the grid, so their round hours publish untouched. The 15
 * minutes of a :45 zone is what shifts that lattice off :00/:30, and fifteen
 * minutes is therefore the most a snap can ever cost.
 */
const GRID_MS = THIRTY_MIN_MS;

/**
 * Epoch dates the weekly path carries local minutes through, and the probe the
 * picker normalises against. Which calendar day carried them is irrelevant —
 * only the UTC minute-of-day survives into a weekly row — so the epoch is used
 * everywhere rather than a "today" that would make a weekly row's stored minutes
 * depend on when it was saved.
 */
const PROBE_DATE = "1970-01-01";
const PROBE_NEXT_DATE = "1970-01-02";

/**
 * The smallest FORWARD move that puts an instant on the booking grid. Never
 * negative, so a row only ever loses bookable time the consultant said they
 * had — it never gains an hour they did not.
 *
 * Forward, not nearest and not floor. Nearest is not available as a plain rule:
 * half an atom is the ONLY residue a real zone produces (every IANA offset is a
 * multiple of 15 minutes), so "nearest" is ambiguous on precisely the values
 * that need snapping and would need a tie-break invented on top. Floor is worse
 * than ambiguous — it publishes hours the consultant never agreed to, e.g.
 * 23:45–00:45 becoming 23:30–00:30, which puts them on the books half an hour
 * before their own day starts. Ceiling has no tie-break case at all: a value
 * already on the grid moves zero.
 */
export function gridSnapDeltaMs(instantMs: number): number {
  const remainder = ((instantMs % GRID_MS) + GRID_MS) % GRID_MS;
  return remainder === 0 ? 0 : GRID_MS - remainder;
}

export interface GridSnappedInstants {
  startsAtMs: number;
  endsAtMs: number;
  /** The shared forward shift. 0 when the start was already on the grid. */
  deltaMs: number;
}

/**
 * Snaps a row's start onto the grid and carries its END by the SAME shift.
 *
 * One shared shift, never two independent snaps. The server's duration rule is
 * only `[30, 720]` minutes — the "whole number of 30-minute atoms" requirement
 * arrives INDIRECTLY, as a GRID refusal of `endsAt`. Snapping the boundaries
 * independently can give them different shifts, which turns a legal 60-minute
 * row into a 45- or 75-minute one and leaves the end off the grid, so the
 * consultant is refused for a second reason than the one that was actually
 * wrong with their hours. A shared shift preserves the typed duration exactly
 * and lands both ends on the grid together.
 */
export function snapInstantsToSchedulingGrid(
  startsAtMs: number,
  endsAtMs: number,
): GridSnappedInstants {
  const deltaMs = gridSnapDeltaMs(startsAtMs);
  return {
    startsAtMs: startsAtMs + deltaMs,
    endsAtMs: endsAtMs + deltaMs,
    deltaMs,
  };
}

/**
 * The local HH:MM a slot will actually be PUBLISHED as.
 *
 * Used by the availability pickers so the snapped value is visible in the input
 * the consultant typed in, before the save, rather than only in the rows the
 * form re-reads afterwards. The save path (`weeklySlotForSave`,
 * `formatCustomSlot`) re-applies the same shift, so a caller that never routes
 * through a picker still cannot publish an off-grid row.
 *
 * Returns the slot untouched when either boundary is blank (a row still being
 * filled in) or when the zone cannot resolve it — an unusable timezone is the
 * save path's error to raise with a real message, not the picker's to swallow.
 */
export function normaliseSlotToSchedulingGrid<
  T extends { startTime: string; endTime: string },
>(slot: T, timezone: string): T {
  if (!slot.startTime || !slot.endTime) return slot;

  const startsAt = convertTimezoneToUtc(slot.startTime, PROBE_DATE, timezone);
  const endsAt = convertTimezoneToUtc(
    slot.endTime,
    isOvernight(slot.startTime, slot.endTime) ? PROBE_NEXT_DATE : PROBE_DATE,
    timezone,
  );
  if (!startsAt || !endsAt) return slot;

  const snapped = snapInstantsToSchedulingGrid(
    new Date(startsAt).getTime(),
    new Date(endsAt).getTime(),
  );
  const startTime = convertUtcToTimezone(
    new Date(snapped.startsAtMs).toISOString(),
    timezone,
  );
  const endTime = convertUtcToTimezone(
    new Date(snapped.endsAtMs).toISOString(),
    timezone,
  );
  if (!startTime || !endTime) return slot;

  return { ...slot, startTime, endTime };
}

/**
 * API format for weekly slots (dashboard → PUT /api/user/consultants/[id])
 */
export interface WeeklySlotApiFormat {
  dayOfWeekforStartTimeInUTC: string;
  dayOfWeekforEndTimeInUTC: string;
  startsAt: string;
  endsAt: string;
}

/**
 * API format for custom (date-specific) slots
 */
export interface CustomSlotApiFormat {
  startsAt: string;
  endsAt: string;
}

/**
 * Helper function to get the next day of the week
 */
const getNextDayOfWeek = (dayOfWeek: string): string => {
  const days = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ];
  const currentIndex = days.indexOf(dayOfWeek);
  return days[(currentIndex + 1) % days.length];
};

/**
 * Formats slots for API submission (dashboard save path).
 * Converts local times to UTC and handles overnight slot detection.
 * Overnight slots produce a single record with startDay !== endDay.
 *
 * THROWS on a formatting failure, deliberately. This used to carry three nested
 * catches that degraded instead: a per-slot one dropped the offending slot from
 * the payload, and an outer one returned `[]` for the whole schedule. The result
 * is a PUT body (SettingsTab.tsx), so degrading here does not mean "render less"
 * — it means SAVE less. A single throwing slot silently vanished from the
 * consultant's availability, and the outer catch wiped it entirely; SettingsTab
 * then refetched and displayed the wiped state as "what was actually saved". An
 * availability save has to be all-or-nothing, and the caller already has a
 * try/catch with a destructive toast to fail into. (#1125)
 *
 * @param slots - The slots to format (keyed by day or date)
 * @param isWeekly - Whether these are weekly recurring slots
 * @param timezone - The user's timezone (e.g., "America/New_York")
 * @returns Array of formatted slots ready for API submission
 */
export function formatSlotsForApi(
  slots: SlotsType,
  isWeekly: boolean,
  timezone: string = "UTC",
): (WeeklySlotApiFormat | CustomSlotApiFormat)[] {
  return Object.entries(slots)
    .filter(([key, daySlots]) => {
      // Ensure we have valid key and slots array
      return key && Array.isArray(daySlots) && daySlots.length > 0;
    })
    .flatMap(([key, daySlots]) => {
      // Sort slots chronologically before processing
      const sortedSlots = sortSlotsByTime(daySlots);

      const validSlots = sortedSlots.filter((slot) => {
        // Comprehensive slot validation
        return (
          slot &&
          typeof slot === "object" &&
          slot.isValid === true &&
          slot.startTime &&
          slot.endTime &&
          typeof slot.startTime === "string" &&
          typeof slot.endTime === "string" &&
          isValidTimeRange(slot.startTime, slot.endTime)
        );
      });

      if (isWeekly) {
        // flatMap because formatWeeklySlot returns an array
        return validSlots.flatMap((slot) =>
          formatWeeklySlot(slot, key, timezone),
        );
      }
      return validSlots.map((slot) => formatCustomSlot(slot, key, timezone));
    });
}

/**
 * Formats a single weekly slot for API submission.
 *
 * A thin adapter over `weeklySlotForSave`: the two save paths (this one, and
 * the onboarding server action) build exactly the same row and differ only in
 * the envelope they hand to their caller. `dayOfWeekforStartTimeInUTC` keeps
 * its historical name because the PUT body's Zod schema and the settings form
 * still speak it, but it carries `startDay` — the consultant's LOCAL day.
 */
function formatWeeklySlot(
  slot: { startTime: string; endTime: string; isOvernightUTC?: boolean },
  dayKey: string,
  timezone: string,
): WeeklySlotApiFormat[] {
  const row = weeklySlotForSave(slot, dayKey, timezone);
  return [
    {
      dayOfWeekforStartTimeInUTC: row.startDay,
      dayOfWeekforEndTimeInUTC: row.endDay,
      startsAt: row.startsAtUtc,
      endsAt: row.endsAtUtc,
    },
  ];
}

/**
 * Formats a single custom (date-specific) slot for API submission.
 * Overnight handling delegates to convertTimezoneToUtcWithOvernight.
 *
 * The start is snapped onto the booking grid and the end carried by the same
 * shift (`snapInstantsToSchedulingGrid`): a custom row hands the allocator its
 * raw `startsAt` via `matchCustomSlotToDay`, so an off-grid start mints off-grid
 * candidate starts exactly as a weekly one does, and the server refuses the row
 * with GRID.
 */
function formatCustomSlot(
  slot: { startTime: string; endTime: string },
  dateKey: string,
  timezone: string,
): CustomSlotApiFormat {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateKey)) {
    throw new Error(`Invalid date format: ${dateKey}`);
  }

  const startTimeUtc = convertTimezoneToUtcWithOvernight(
    slot.startTime,
    dateKey,
    timezone,
    false, // isEndTime
  );

  const endTimeUtc = convertTimezoneToUtcWithOvernight(
    slot.endTime,
    dateKey,
    timezone,
    true, // isEndTime
    slot.startTime, // startTimeStr for overnight detection
  );

  // Throws rather than returning null, which the caller then filtered away.
  // `convertTimezoneToUtcWithOvernight` returns "" for both an unparseable time
  // and a caught conversion error, so a null here was indistinguishable from
  // "this slot is fine but omitted" — and it was omitted from a SAVE payload.
  // Dropping a boundary the consultant typed is not a degradation we get to
  // make on their behalf. (#1125)
  if (!startTimeUtc || !endTimeUtc) {
    throw new Error(
      `Could not convert slot ${slot.startTime}-${slot.endTime} on ${dateKey} to UTC in ${timezone}`,
    );
  }

  // Both boundaries in real instants, so a shift that carries the start across
  // a UTC midnight carries the end with it and the date lands where it belongs.
  const snapped = snapInstantsToSchedulingGrid(
    new Date(startTimeUtc).getTime(),
    new Date(endTimeUtc).getTime(),
  );

  return {
    startsAt: new Date(snapped.startsAtMs).toISOString(),
    endsAt: new Date(snapped.endsAtMs).toISOString(),
  };
}

/** A save-ready weekly row, plus the UTC instants the PUT body speaks in. */
export type WeeklySlotForSave = WeeklySlot & {
  startsAtUtc: string;
  endsAtUtc: string;
};

/**
 * Builds the one canonical weekly row from a local HH:MM slot and the day key
 * the consultant typed it under.
 *
 * #1343 — there were two builders and they disagreed about what `startDay`
 * means. This one shifted the day forward or back by the UTC day the converted
 * instant landed on, storing the UTC day; `buildWeeklySlotsForSave` stored the
 * local day; the validator, the allocator and the settings loader all read the
 * local day. For a consultant in IST every row starting before 05:30 local
 * therefore walked back one weekday on every save — Monday 01:00 was saved as
 * Sunday, reloaded into Sunday's form row, and saved again as Saturday. The
 * day key IS the day the consultant meant, so it is stored verbatim and the
 * UTC weekday is derived per occurrence from the row's frozen offset
 * (`utils/schedule/weekly-projection.ts`).
 *
 * `endDay` still records whether the row crosses midnight IN UTC, because that
 * is what `validateWeeklySlotTimeOrder` and the overlap SQL require of the
 * stored pair: an IST 23:00→02:00 slot is same-day in UTC (17:30→20:30) and is
 * stored as one same-day row.
 *
 * THROWS on a conversion failure rather than dropping the slot — see
 * `formatSlotsForApi`'s contract note (#1125); both save paths feed a payload,
 * so degrading here means saving less than the consultant typed.
 */
export function weeklySlotForSave(
  slot: { startTime: string; endTime: string; isOvernightUTC?: boolean },
  dayKey: string,
  timezone: string,
): WeeklySlotForSave {
  const dayOfWeek = dayKey.toUpperCase();
  const validDays: string[] = Object.values(DayOfWeek);
  if (!validDays.includes(dayOfWeek)) {
    throw new Error(`Invalid day of week: ${dayOfWeek}`);
  }
  const startDay = dayOfWeek as DayOfWeek;

  const baseDate = PROBE_DATE;
  const nextDate = PROBE_NEXT_DATE;
  // #503 item 2 — canonical resolver replaces the inline OR of two rules.
  const { isOvernight: overnight } = resolveOvernightStatus({
    startTime: slot.startTime,
    endTime: slot.endTime,
  });

  // convertTimezoneToUtc returns "" for both an unparseable time and a caught
  // conversion error (an unusable timezone reaches it that way), so an empty
  // string can never be distinguished from a slot legitimately omitted. (#1125)
  const startsAtUtc = convertTimezoneToUtc(slot.startTime, baseDate, timezone);
  if (!startsAtUtc) {
    throw new Error(
      `Could not convert weekly slot start ${slot.startTime} on ${dayOfWeek} to UTC in ${timezone}`,
    );
  }

  const endsAtUtc = convertTimezoneToUtc(
    slot.endTime,
    overnight ? nextDate : baseDate,
    timezone,
  );
  if (!endsAtUtc) {
    throw new Error(
      `Could not convert weekly slot end ${slot.endTime} on ${dayOfWeek} to UTC in ${timezone}`,
    );
  }

  // Snapped only after both conversions succeeded, so the throwing contract
  // above is unchanged. A start on the grid shifts zero; a :45-offset zone's
  // 09:00 shifts to 09:15 (03:15Z → 03:30Z), which is what keeps the row from
  // minting 03:15/03:45 cells that checkout refuses.
  const snapped = snapInstantsToSchedulingGrid(
    new Date(startsAtUtc).getTime(),
    new Date(endsAtUtc).getTime(),
  );
  const snappedStartsAtUtc = new Date(snapped.startsAtMs).toISOString();
  const snappedEndsAtUtc = new Date(snapped.endsAtMs).toISOString();

  // UTC minutes are correct regardless of which epoch date carried them.
  const startTimeUtc = dateToMinuteUtc(new Date(snappedStartsAtUtc));
  const endTimeUtc = dateToMinuteUtc(new Date(snappedEndsAtUtc));

  const crossesMidnightUtc = resolveOvernightStatus({
    startTimeUtc,
    endTimeUtc,
  }).isOvernight;

  return {
    startDay,
    endDay: crossesMidnightUtc
      ? (getNextDayOfWeek(startDay) as DayOfWeek)
      : startDay,
    startTimeUtc,
    endTimeUtc,
    startsAtUtc: snappedStartsAtUtc,
    endsAtUtc: snappedEndsAtUtc,
  };
}

/**
 * Converts a SlotsType map (local HH:MM) into WeeklySlot records (UTC minutes, 0–1439)
 * ready for the onboarding server action.
 *
 * Overnight slots produce a single record with startDay !== endDay.
 */
export function buildWeeklySlotsForSave(
  slots: SlotsType,
  timezone: string,
): WeeklySlot[] {
  return Object.entries(slots).flatMap(([day, daySlots]) =>
    sortSlotsByTime(daySlots)
      .filter((s) => s.startTime && s.endTime && s.isValid)
      .map((slot) => {
        const { startDay, endDay, startTimeUtc, endTimeUtc } =
          weeklySlotForSave(slot, day, timezone);
        return { startDay, endDay, startTimeUtc, endTimeUtc };
      }),
  );
}

/**
 * Converts a SlotsType map (local HH:MM, keyed by YYYY-MM-DD) into CustomSlot
 * records (ISO strings) ready for the onboarding server action.
 *
 * Overnight slots produce a single record where endsAt is on the next calendar day.
 *
 * Delegates to `formatCustomSlot` rather than repeating its conversion. This
 * used to be a second, near-identical copy that returned `[]` for a row whose
 * timezone would not resolve — so onboarding silently published LESS than the
 * consultant typed while the settings path refused loudly, and it had no grid
 * snap at all. One converter, one answer, and the throwing contract (#1125)
 * both save paths now share.
 */
export function buildCustomSlotsForSave(
  slots: SlotsType,
  timezone: string,
): CustomSlot[] {
  return Object.entries(slots).flatMap(([dateString, daySlots]) =>
    sortSlotsByTime(daySlots)
      .filter((s) => s.startTime && s.endTime && s.isValid)
      .map((slot): CustomSlot => {
        const { startsAt, endsAt } = formatCustomSlot(
          slot,
          dateString,
          timezone,
        );
        // Both overnight and same-day: single record
        return { startsAt, endsAt };
      }),
  );
}
