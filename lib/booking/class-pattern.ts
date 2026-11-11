/**
 * A class's weekly pattern ("Mon and Thu at 18:00, starting 1 Dec") projected
 * into its N session starts, on the host's wall clock. Every start is a local
 * date plus a local time resolved in the host's zone, so a daylight-saving
 * change between sessions keeps them at 18:00 rather than drifting an hour.
 *
 * Pure and Prisma-free: the scheduler previews it in the browser and the
 * allocator re-checks every resulting time when the host saves.
 */

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { atomPhaseMinutes } from "@/lib/time/grid-zone";

const ATOM_MS = 30 * 60_000;
/** One pattern never needs more than a year and a half to place a long class. */
const MAX_DAYS_SCANNED = 550;

export interface PatternRow {
  /** 0 = Sunday … 6 = Saturday, in the host's zone. */
  weekday: number;
  /** Minutes after local midnight, on the zone's atom phase (1080 for 18:00, 1095 for 18:15 at +05:45). */
  startMinutes: number;
}

export interface ClassPattern {
  /** First local date the class may meet, `yyyy-MM-dd` in `zone`. */
  startDate: string;
  rows: PatternRow[];
  zone: string;
}

export type PatternProblem =
  | "NO_ROWS"
  | "BAD_START_DATE"
  | "OFF_GRID_TIME"
  | "DUPLICATE_ROW"
  | "TOO_MANY_PER_DAY";

/** The zone's atom phase on `startDate`, read at local noon; an unreadable date reads now. */
export function startDatePhase(startDate: string, zone: string): number {
  const noon = fromZonedTime(`${startDate}T12:00:00`, zone);
  return atomPhaseMinutes(
    zone,
    Number.isNaN(noon.getTime()) ? new Date() : noon,
  );
}

/** Why a pattern can't be projected, or null when it can. */
export function patternProblem(
  pattern: ClassPattern,
  perDayCap: number,
): PatternProblem | null {
  if (pattern.rows.length === 0) return "NO_ROWS";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pattern.startDate)) return "BAD_START_DATE";
  const phase = startDatePhase(pattern.startDate, pattern.zone);
  const seen = new Set<string>();
  const perDay = new Map<number, number>();
  for (const row of pattern.rows) {
    if (
      !Number.isInteger(row.weekday) ||
      row.weekday < 0 ||
      row.weekday > 6 ||
      row.startMinutes < 0 ||
      row.startMinutes >= 24 * 60 ||
      (row.startMinutes - phase) % 30 !== 0
    ) {
      return "OFF_GRID_TIME";
    }
    const key = `${row.weekday}:${row.startMinutes}`;
    if (seen.has(key)) return "DUPLICATE_ROW";
    seen.add(key);
    perDay.set(row.weekday, (perDay.get(row.weekday) ?? 0) + 1);
  }
  for (const count of perDay.values()) {
    if (count > perDayCap) return "TOO_MANY_PER_DAY";
  }
  return null;
}

export const PATTERN_PROBLEM_COPY: Record<PatternProblem, string> = {
  NO_ROWS: "Add at least one weekday and time.",
  BAD_START_DATE: "Pick the date the class starts.",
  OFF_GRID_TIME: "Pick each time from the list.",
  DUPLICATE_ROW: "Two rows have the same day and time.",
  TOO_MANY_PER_DAY: "A class meets at most twice on one day.",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The first `count` starts of the pattern from its start date, in time order.
 * A start in the past or before `notBeforeMs` is skipped rather than counted,
 * so the class still gets `count` sessions.
 */
export function projectPattern(
  pattern: ClassPattern,
  count: number,
  notBeforeMs = 0,
): Date[] {
  const [y, m, d] = pattern.startDate.split("-").map(Number);
  const rows = [...pattern.rows].sort(
    (a, b) => a.weekday - b.weekday || a.startMinutes - b.startMinutes,
  );
  const starts: Date[] = [];
  for (
    let offset = 0;
    offset < MAX_DAYS_SCANNED && starts.length < count;
    offset += 1
  ) {
    // Calendar arithmetic on a UTC date only names the local day.
    const day = new Date(Date.UTC(y, m - 1, d + offset));
    const weekday = day.getUTCDay();
    const dateKey = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    for (const row of rows) {
      if (row.weekday !== weekday || starts.length >= count) continue;
      const wall = `${dateKey}T${pad(Math.floor(row.startMinutes / 60))}:${pad(row.startMinutes % 60)}:00`;
      const start = fromZonedTime(wall, pattern.zone);
      // Only a wall time inside a DST gap resolves off the lattice.
      if (start.getTime() % ATOM_MS !== 0) continue;
      if (start.getTime() < notBeforeMs) continue;
      starts.push(start);
    }
  }
  return starts;
}

/** The 30-minute atom starts the allocator takes for these sessions. */
export function sessionAtoms(
  starts: readonly Date[],
  sessionMinutes: number,
): string[] {
  const atomsPerSession = Math.max(1, Math.ceil(sessionMinutes / 30));
  return starts.flatMap((start) =>
    Array.from({ length: atomsPerSession }, (_, i) =>
      new Date(start.getTime() + i * ATOM_MS).toISOString(),
    ),
  );
}

/**
 * The default series a class gets from just a first session: its weekday and
 * local time, then `sessionsPerWeek` meetings spread across each week (2 → the
 * first day and three days later; 3 → every other day), on the host's clock.
 */
export function seriesStartsFrom(
  first: Date,
  sessionsPerWeek: number,
  count: number,
  zone: string,
): Date[] {
  const perWeek = Math.min(7, Math.max(1, Math.trunc(sessionsPerWeek)));
  const gap = Math.floor(7 / perWeek);
  const weekday = Number(formatInTimeZone(first, zone, "i")) % 7;
  const [hours, minutes] = formatInTimeZone(first, zone, "HH:mm")
    .split(":")
    .map(Number);
  return projectPattern(
    {
      startDate: formatInTimeZone(first, zone, "yyyy-MM-dd"),
      rows: Array.from({ length: perWeek }, (_, i) => ({
        weekday: (weekday + i * gap) % 7,
        startMinutes: hours * 60 + minutes,
      })),
      zone,
    },
    count,
  );
}
