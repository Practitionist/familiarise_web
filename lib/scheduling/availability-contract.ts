/**
 * The one rule set for a consultant's published availability, shared by every
 * write path — the onboarding wizard's sync, the per-row
 * `/api/scheduling/availability/*` routes, and the settings PUT. Three
 * independent copies had drifted: only onboarding enforced the 30 min–12 h
 * window bound, and nothing server-side refused an empty set for the chosen
 * schedule type. See docs/onboarding/03-availability-contract.md.
 *
 * Pure. Returns a typed refusal (or throws one via the `assert*` twins) so a
 * route can map the code to a status and the UI to copy.
 */

import type { DayOfWeek } from "@prisma/client";
import {
  slotsOverlap,
  validateWeeklySlotTimeOrder,
} from "@/utils/scheduling-engine/slotTimeUtils";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";

export const MIN_WINDOW_MINUTES = 30;
export const MAX_WINDOW_MINUTES = 12 * 60;
const MINUTES_PER_DAY = 24 * 60;

/**
 * The grid a published window's boundaries must sit on, in minutes. Derived
 * from the engine's own atom rather than written as a literal, because the two
 * have to be the same number: a window off this grid mints starts the buyer
 * path refuses (see GRID below), and the buyer's own edge check
 * (`slotStartRefusal`) tests the same 30 minutes from the same engine constant.
 */
export const AVAILABILITY_GRID_MINUTES = SCHEDULING_INTERVAL_MS / 60_000;

/** Whether a minute-of-day value is a legal booking-grid boundary. */
function isOnGridMinute(minutes: number): boolean {
  return minutes % AVAILABILITY_GRID_MINUTES === 0;
}

/** Whether an instant sits on the :00/:30 UTC grid the buyer path demands. */
export function isOnSchedulingGrid(instantMs: number): boolean {
  return instantMs % SCHEDULING_INTERVAL_MS === 0;
}

export interface WeeklyWindowInput {
  startDay: DayOfWeek;
  endDay: DayOfWeek;
  startTimeUtc: number;
  endTimeUtc: number;
  utcOffsetMinutes?: number | null;
}

export interface CustomWindowInput {
  startsAt: Date | string;
  endsAt: Date | string;
}

export type AvailabilityRefusalCode =
  | "EMPTY"
  | "RANGE"
  | "ORDER"
  | "DURATION"
  | "GRID"
  | "OVERLAP"
  | "PAST";

export interface AvailabilityRefusal {
  code: AvailabilityRefusalCode;
  /** Zero-based index of the offending window (the second one for OVERLAP). */
  index?: number;
  message: string;
}

export class AvailabilityContractError extends Error {
  readonly code: AvailabilityRefusalCode;
  readonly index?: number;
  constructor(refusal: AvailabilityRefusal) {
    super(refusal.message);
    this.name = "AvailabilityContractError";
    this.code = refusal.code;
    this.index = refusal.index;
  }
}

/** HTTP status a route answers with for each refusal. All are the caller's fault. */
export const AVAILABILITY_REFUSAL_STATUS: Record<
  AvailabilityRefusalCode,
  number
> = {
  EMPTY: 400,
  RANGE: 400,
  ORDER: 400,
  DURATION: 400,
  GRID: 400,
  OVERLAP: 400,
  PAST: 400,
};

function weeklyDurationMinutes(row: WeeklyWindowInput): number {
  // Overnight rows cross midnight; validateWeeklySlotTimeOrder has already
  // required endDay to be the next day and start > end for those.
  return row.endTimeUtc > row.startTimeUtc
    ? row.endTimeUtc - row.startTimeUtc
    : MINUTES_PER_DAY - row.startTimeUtc + row.endTimeUtc;
}

function isMinuteOfDay(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MINUTES_PER_DAY
  );
}

const durationMessage = (index: number) =>
  `Window ${index + 1}: duration must be between ${MIN_WINDOW_MINUTES} minutes and ${MAX_WINDOW_MINUTES / 60} hours`;

const gridMessage = (index: number) =>
  `Window ${index + 1}: times must start on the hour or half hour — a window off the ${AVAILABILITY_GRID_MINUTES}-minute booking grid publishes hours nobody can book`;

/**
 * The GRID refusal: a window whose boundaries are not on the booking grid.
 *
 * Both the grid generator and the allocator step 30 minutes FROM THIS ROW'S OWN
 * START, so an off-grid row mints starts at :15 and :45. Every buyer path then
 * refuses them structurally — `slotStartRefusal` answers SLOT_NOT_ON_GRID in
 * checkout and in request-for-approval — so the row is not "harder to book", it
 * is 100% unbookable, and the grid shows cells the checkout throws away.
 *
 * Refused rather than snapped: silently moving a consultant's published hours is
 * worse than telling them, and a snapped row is indistinguishable from one they
 * chose. Checked LAST, after RANGE / ORDER / DURATION, so the cheaper and more
 * specific complaints about the same row still speak first.
 */
function gridRefusal(
  offGrid: boolean,
  index: number,
): AvailabilityRefusal | null {
  return offGrid ? { code: "GRID", index, message: gridMessage(index) } : null;
}

/** Validate one weekly window on its own (no pairwise check). */
export function validateWeeklyWindow(
  row: WeeklyWindowInput,
  index = 0,
): AvailabilityRefusal | null {
  if (!isMinuteOfDay(row.startTimeUtc) || !isMinuteOfDay(row.endTimeUtc)) {
    return {
      code: "RANGE",
      index,
      message: `Window ${index + 1}: times must be whole minutes from 0 to 1439`,
    };
  }
  const order = validateWeeklySlotTimeOrder(
    row.startDay,
    row.endDay,
    row.startTimeUtc,
    row.endTimeUtc,
  );
  if (order) return { code: "ORDER", index, message: order };
  const duration = weeklyDurationMinutes(row);
  if (duration < MIN_WINDOW_MINUTES || duration > MAX_WINDOW_MINUTES) {
    return { code: "DURATION", index, message: durationMessage(index) };
  }
  return gridRefusal(
    !isOnGridMinute(row.startTimeUtc) || !isOnGridMinute(row.endTimeUtc),
    index,
  );
}

/**
 * Validate a consultant's whole weekly set. Empty is refused unless the caller
 * says otherwise (a per-row route validates one row, not the set).
 */
export function validateWeeklyWindows(
  rows: readonly WeeklyWindowInput[],
  opts: { allowEmpty?: boolean } = {},
): AvailabilityRefusal | null {
  if (rows.length === 0) {
    return opts.allowEmpty
      ? null
      : {
          code: "EMPTY",
          message: "Add at least one weekly availability window",
        };
  }
  for (let i = 0; i < rows.length; i++) {
    const refusal = validateWeeklyWindow(rows[i], i);
    if (refusal) return refusal;
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (slotsOverlap(rows[i], rows[j])) {
        return {
          code: "OVERLAP",
          index: j,
          message: `Windows ${i + 1} and ${j + 1} overlap`,
        };
      }
    }
  }
  return null;
}

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Validate one custom (concrete) window on its own. */
export function validateCustomWindow(
  row: CustomWindowInput,
  index = 0,
  now: Date = new Date(),
): AvailabilityRefusal | null {
  const startMs = toMs(row.startsAt);
  const endMs = toMs(row.endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return {
      code: "RANGE",
      index,
      message: `Window ${index + 1}: start and end must be valid instants`,
    };
  }
  if (startMs >= endMs) {
    return {
      code: "ORDER",
      index,
      message: `Window ${index + 1}: start must be before end`,
    };
  }
  const duration = (endMs - startMs) / 60_000;
  if (duration < MIN_WINDOW_MINUTES || duration > MAX_WINDOW_MINUTES) {
    return { code: "DURATION", index, message: durationMessage(index) };
  }
  // A window that has already ended can never be booked; one still in
  // progress is kept so an edit made mid-window does not erase today.
  if (endMs <= now.getTime()) {
    return {
      code: "PAST",
      index,
      message: `Window ${index + 1} has already ended`,
    };
  }
  // A custom row has the same defect as a weekly one and for the same reason:
  // `matchCustomSlotToDay` hands the allocator the row's raw `startsAt`, so an
  // off-grid row mints off-grid candidate starts that checkout refuses.
  return gridRefusal(
    !isOnSchedulingGrid(startMs) || !isOnSchedulingGrid(endMs),
    index,
  );
}

/** Validate a consultant's whole custom set; same empty rule as weekly. */
export function validateCustomWindows(
  rows: readonly CustomWindowInput[],
  opts: { allowEmpty?: boolean; now?: Date } = {},
): AvailabilityRefusal | null {
  if (rows.length === 0) {
    return opts.allowEmpty
      ? null
      : { code: "EMPTY", message: "Add at least one availability window" };
  }
  const now = opts.now ?? new Date();
  for (let i = 0; i < rows.length; i++) {
    const refusal = validateCustomWindow(rows[i], i, now);
    if (refusal) return refusal;
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (
        toMs(rows[i].startsAt) < toMs(rows[j].endsAt) &&
        toMs(rows[j].startsAt) < toMs(rows[i].endsAt)
      ) {
        return {
          code: "OVERLAP",
          index: j,
          message: `Windows ${i + 1} and ${j + 1} overlap`,
        };
      }
    }
  }
  return null;
}

export function assertWeeklyWindows(
  rows: readonly WeeklyWindowInput[],
  opts?: { allowEmpty?: boolean },
): void {
  const refusal = validateWeeklyWindows(rows, opts);
  if (refusal) throw new AvailabilityContractError(refusal);
}

export function assertCustomWindows(
  rows: readonly CustomWindowInput[],
  opts?: { allowEmpty?: boolean; now?: Date },
): void {
  const refusal = validateCustomWindows(rows, opts);
  if (refusal) throw new AvailabilityContractError(refusal);
}
