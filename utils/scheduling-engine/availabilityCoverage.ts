import type { Tx } from "@/lib/prisma";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { reportIncompleteWeeklyRows } from "@/lib/scheduling/incomplete-weekly-rows";
import {
  createWeeklyCoverage,
  partitionWeeklyRows,
  type WeeklyCoverage,
  type WeeklyRowLocalColumns,
} from "@/utils/schedule/weekly-projection";

/**
 * #1320 — "is this booking window inside the consultant's published
 * availability?" answered against the UNION of their rows, not one row.
 * Pure, so checkout's validation and the tests share one implementation.
 */

export type WeeklyCoverageRow = WeeklyRowLocalColumns;

export interface CustomCoverageRow {
  startsAt: Date;
  endsAt: Date;
}

export interface WindowAtom {
  day: number;
  minutes: number;
  start: Date;
  /**
   * Half-open end of the atom, clamped to the window end. Whole atoms span
   * the full 30 minutes; a trailing partial atom (non-multiple window) is
   * tested by containment of what the window actually covers — testing it as
   * a full atom rejected windows a row fully contains.
   */
  end: Date;
}

const ATOM_MS = SCHEDULING_INTERVAL_MS;

/** The 30-minute atoms of [start, end), keyed by UTC weekday + minute. */
export function windowAtoms(start: Date, end: Date): WindowAtom[] {
  const atoms: WindowAtom[] = [];
  const endMs = end.getTime();
  for (let t = start.getTime(); t < endMs; t += ATOM_MS) {
    const d = new Date(t);
    atoms.push({
      day: d.getUTCDay(),
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      start: d,
      end: new Date(Math.min(t + ATOM_MS, endMs)),
    });
  }
  return atoms;
}

/** The first atom no weekly or custom row covers, or null when fully covered. */
export function findUncoveredAtom(
  atoms: WindowAtom[],
  weeklyRows: WeeklyCoverageRow[],
  customRows: CustomCoverageRow[],
): WindowAtom | null {
  return findUncoveredAtomIn(
    atoms,
    createWeeklyCoverage(weeklyRows),
    customRows,
  );
}

/** `findUncoveredAtom` against a prebuilt weekly coverage, for callers testing many windows. */
export function findUncoveredAtomIn(
  atoms: WindowAtom[],
  weekly: WeeklyCoverage,
  customRows: CustomCoverageRow[],
): WindowAtom | null {
  for (const atom of atoms) {
    if (weekly.covers(atom.start.getTime(), atom.end.getTime())) continue;
    const inCustom = customRows.some(
      (row) => atom.start >= row.startsAt && atom.end <= row.endsAt,
    );
    if (!inCustom) return atom;
  }
  return null;
}

/**
 * The rows that actually publish availability for one consultant over
 * [start, end). ScheduleType is exclusive — a consultant is WEEKLY xor CUSTOM —
 * so the inactive arm contributes nothing, exactly as the expert-page
 * allocation route already filters it. Reading the dormant arm would let a
 * stale row from a consultant's previous schedule mode cover an atom no
 * surface offers.
 */
export interface PublishedCoverage {
  scheduleType: "WEEKLY" | "CUSTOM" | null;
  weeklyRows: WeeklyCoverageRow[];
  customRows: CustomCoverageRow[];
}

/** The columns a weekly row is projected from, plus its id for refusal reports. */
export const WEEKLY_COVERAGE_SELECT = {
  id: true,
  timezone: true,
  localStartDay: true,
  localStartMinutes: true,
  localEndMinutes: true,
  localEndDay: true,
} as const;

export async function loadPublishedCoverage(
  db: Pick<
    Tx,
    | "consultantProfile"
    | "availabilityWindowWeekly"
    | "availabilityWindowCustom"
  >,
  consultantProfileId: string,
  start: Date,
  end: Date,
): Promise<PublishedCoverage> {
  const profile = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: { scheduleType: true, deletedAt: true },
  });
  // A soft-deleted expert publishes nothing, whatever rows survived the
  // deletion. Fail closed here rather than at each caller: checkout reaches
  // this loader through a fallback that never saw the named row, and trial
  // scheduling reaches it directly.
  if (!profile || profile.deletedAt) {
    return { scheduleType: null, weeklyRows: [], customRows: [] };
  }
  const scheduleType = profile.scheduleType;
  const storedWeekly =
    scheduleType === "WEEKLY"
      ? await db.availabilityWindowWeekly.findMany({
          where: { consultantProfileId },
          select: WEEKLY_COVERAGE_SELECT,
        })
      : [];
  const { usable: weeklyRows, refused } = partitionWeeklyRows(storedWeekly);
  reportIncompleteWeeklyRows(refused, {
    op: "load-published-coverage",
    consultantProfileId,
  });
  const customRows =
    scheduleType === "CUSTOM"
      ? await db.availabilityWindowCustom.findMany({
          where: {
            consultantProfileId,
            startsAt: { lt: end },
            endsAt: { gt: start },
          },
          select: { startsAt: true, endsAt: true },
        })
      : [];
  return { scheduleType, weeklyRows, customRows };
}
