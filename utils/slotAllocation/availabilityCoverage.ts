import { isMinuteWithinWeeklySlot } from "./slotTimeUtils";

/**
 * #1320 — "is this booking window inside the consultant's published
 * availability?" answered against the UNION of their rows, not one row.
 * Pure, so checkout's validation and the tests share one implementation.
 */

export interface WeeklyCoverageRow {
  startDay: string;
  startTimeUtc: number;
  endTimeUtc: number;
  utcOffsetMinutes: number;
}

export interface CustomCoverageRow {
  startsAt: Date;
  endsAt: Date;
}

export interface WindowAtom {
  day: number;
  minutes: number;
  start: Date;
}

const ATOM_MS = 30 * 60 * 1000;

/** The 30-minute atoms of [start, end), keyed by UTC weekday + minute. */
export function windowAtoms(start: Date, end: Date): WindowAtom[] {
  const atoms: WindowAtom[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += ATOM_MS) {
    const d = new Date(t);
    atoms.push({
      day: d.getUTCDay(),
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      start: d,
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
  for (const atom of atoms) {
    const inWeekly = weeklyRows.some((row) =>
      isMinuteWithinWeeklySlot(
        atom.day,
        atom.minutes,
        30,
        row.startDay,
        row.startTimeUtc,
        row.endTimeUtc,
        row.utcOffsetMinutes,
      ),
    );
    if (inWeekly) continue;
    const atomEnd = new Date(atom.start.getTime() + ATOM_MS);
    const inCustom = customRows.some(
      (row) => atom.start >= row.startsAt && atomEnd <= row.endsAt,
    );
    if (!inCustom) return atom;
  }
  return null;
}
