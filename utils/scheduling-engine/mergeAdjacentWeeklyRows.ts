import type { DayOfWeek, Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { MAX_DURATION_MINUTES } from "@/utils/scheduling-engine/interval-validation";
import {
  crossesLocalMidnight,
  DAY_BY_INDEX,
  dayIndexOf,
  hasWeeklyRowLocalColumns,
  type WeeklyRowLocalColumns,
} from "@/utils/schedule/weekly-projection";

/**
 * #1320 — availability is one row per contiguous published window, so two
 * back-to-back entries ("3:30–4:30" + "4:30–5:30") are stored as one row and
 * the generator and checkout never depend on row boundaries.
 */

export interface WeeklyRowShape {
  startDay: DayOfWeek;
  endDay: DayOfWeek;
  startTimeUtc: number;
  endTimeUtc: number;
  timezone?: string | null;
  localStartDay?: DayOfWeek | null;
  localStartMinutes?: number | null;
  localEndMinutes?: number | null;
  localEndDay?: DayOfWeek | null;
}

type LocalRow<T> = T & WeeklyRowLocalColumns;

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function hasLocal<T extends WeeklyRowShape>(row: T): row is LocalRow<T> {
  return hasWeeklyRowLocalColumns({
    timezone: row.timezone ?? null,
    localStartDay: row.localStartDay ?? null,
    localStartMinutes: row.localStartMinutes ?? null,
    localEndMinutes: row.localEndMinutes ?? null,
    localEndDay: row.localEndDay ?? null,
  });
}

/**
 * Merge exactly-adjacent rows of one zone and one local day, compared on the
 * local columns (`prev.localEndMinutes === row.localStartMinutes`). Overnight
 * rows and rows without local columns are left untouched. The fold stops at
 * MAX_DURATION_MINUTES, the longest window `isValidTimeRange` accepts. The UTC
 * writer columns of a merged row take the later end. Pure; stable ordering.
 */
export function mergeAdjacentWeeklyRows<T extends WeeklyRowShape>(
  rows: T[],
): T[] {
  const local: LocalRow<T>[] = [];
  const untouched: T[] = [];
  for (const row of rows) {
    if (hasLocal(row)) local.push(row);
    else untouched.push({ ...row });
  }
  local.sort(
    (a, b) =>
      compareStrings(a.timezone, b.timezone) ||
      dayIndexOf(a.localStartDay) - dayIndexOf(b.localStartDay) ||
      a.localStartMinutes - b.localStartMinutes,
  );
  const out: LocalRow<T>[] = [];
  for (const row of local) {
    const prev = out[out.length - 1];
    const canMerge =
      prev?.timezone === row.timezone &&
      prev.localStartDay === row.localStartDay &&
      !crossesLocalMidnight(prev) &&
      !crossesLocalMidnight(row) &&
      prev.localEndMinutes === row.localStartMinutes &&
      row.localEndMinutes - prev.localStartMinutes <= MAX_DURATION_MINUTES;
    if (canMerge) {
      const startIndex = dayIndexOf(prev.startDay);
      const crossesUtcMidnight = row.endTimeUtc <= prev.startTimeUtc;
      out[out.length - 1] = {
        ...prev,
        endTimeUtc: row.endTimeUtc,
        endDay:
          crossesUtcMidnight && startIndex !== -1
            ? DAY_BY_INDEX[(startIndex + 1) % 7]
            : prev.startDay,
        localEndMinutes: row.localEndMinutes,
        localEndDay: row.localEndDay,
      };
    } else {
      out.push({ ...row });
    }
  }
  return [...out, ...untouched];
}

/**
 * Rewrite one consultant's weekly rows as their merged form. No-op when
 * nothing is adjacent, so it is safe after every write path. Returns how many
 * rows were folded away. Runs inside the caller's transaction when given one.
 */
export async function coalesceConsultantWeeklyRows(
  db: Pick<Tx, "availabilityWindowWeekly">,
  consultantProfileId: string,
): Promise<{ before: number; after: number }> {
  const rows = await db.availabilityWindowWeekly.findMany({
    where: { consultantProfileId },
    select: {
      id: true,
      startDay: true,
      endDay: true,
      startTimeUtc: true,
      endTimeUtc: true,
      utcOffsetMinutes: true,
      timezone: true,
      localStartDay: true,
      localStartMinutes: true,
      localEndMinutes: true,
      localEndDay: true,
    },
  });
  const merged = mergeAdjacentWeeklyRows(rows);
  if (merged.length === rows.length) {
    return { before: rows.length, after: rows.length };
  }
  // Delete-then-recreate, so every column a reader needs is carried across.
  const data: Prisma.AvailabilityWindowWeeklyCreateManyInput[] = merged.map(
    (r) => ({
      consultantProfileId,
      startDay: r.startDay,
      endDay: r.endDay,
      startTimeUtc: r.startTimeUtc,
      endTimeUtc: r.endTimeUtc,
      utcOffsetMinutes: r.utcOffsetMinutes,
      timezone: r.timezone,
      localStartDay: r.localStartDay,
      localStartMinutes: r.localStartMinutes,
      localEndMinutes: r.localEndMinutes,
      localEndDay: r.localEndDay,
    }),
  );
  await db.availabilityWindowWeekly.deleteMany({
    where: { consultantProfileId },
  });
  await db.availabilityWindowWeekly.createMany({ data });
  return { before: rows.length, after: merged.length };
}

/**
 * After a single-row create/update: fold adjacent rows and return the row that
 * now covers the written window (its id changes when it was merged).
 *
 * `localEndDay` is part of the window because the minute comparison below is
 * only a containment test within one day pair: an overnight row stores
 * `localEndMinutes < localStartMinutes`, so a same-day row would otherwise
 * answer for an edit that was never its own.
 *
 * A miss throws rather than returning null: the fold only ever extends the row
 * holding the written window, so nothing covering it means the rewrite dropped it.
 */
export async function coalesceAndResolve<
  Db extends Pick<Tx, "availabilityWindowWeekly">,
>(
  db: Db,
  consultantProfileId: string,
  window: Pick<
    WeeklyRowLocalColumns,
    "localStartDay" | "localEndDay" | "localStartMinutes" | "localEndMinutes"
  >,
) {
  await coalesceConsultantWeeklyRows(db, consultantProfileId);
  const covering = await db.availabilityWindowWeekly.findFirst({
    where: {
      consultantProfileId,
      localStartDay: window.localStartDay,
      localEndDay: window.localEndDay,
      localStartMinutes: { lte: window.localStartMinutes },
      localEndMinutes: { gte: window.localEndMinutes },
    },
    orderBy: [{ localStartMinutes: "asc" }, { id: "asc" }],
    include: {
      consultantProfile: {
        select: { id: true, user: { select: { name: true, email: true } } },
      },
    },
  });
  if (!covering) {
    throw new Error(
      `coalesceAndResolve: no weekly row covers the saved window for consultant ${consultantProfileId}`,
    );
  }
  return covering;
}

/**
 * #1320 — the CUSTOM twin of everything above. Custom rows are date-anchored
 * absolute instants and purely additive (there is no isAvailable / deletedAt
 * column, so a row is never a blackout), which makes the merge rule simpler
 * than the weekly one: no day, offset or overnight predicate is needed, only
 * the instants themselves.
 */
export interface CustomRowShape {
  startsAt: Date;
  endsAt: Date;
}

/** The weekly bound in the units custom rows are stored in. */
const MAX_DURATION_MS = MAX_DURATION_MINUTES * 60_000;

/**
 * Fold b into a when b starts exactly where a ends (exact adjacency, no
 * tolerance) or inside a (an overlap the bulk save paths already reject but
 * older rows can still carry), keeping the later end. Pure; stable ordering by
 * start.
 *
 * A fold that would push the surviving row past MAX_DURATION_MS starts a new
 * row instead, for the same reason as the weekly twin. A row already contained
 * in its predecessor still collapses: it extends nothing, so it cannot cross
 * the bound, and leaving it out is the whole point of the pass.
 */
export function mergeAdjacentCustomRows<T extends CustomRowShape>(
  rows: T[],
): T[] {
  const sorted = [...rows].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
  const out: T[] = [];
  for (const row of sorted) {
    const prev = out[out.length - 1];
    if (prev !== undefined && row.startsAt.getTime() <= prev.endsAt.getTime()) {
      if (row.endsAt.getTime() <= prev.endsAt.getTime()) {
        continue;
      }
      if (row.endsAt.getTime() - prev.startsAt.getTime() <= MAX_DURATION_MS) {
        out[out.length - 1] = { ...prev, endsAt: row.endsAt };
        continue;
      }
    }
    out.push({ ...row });
  }
  return out;
}

/**
 * Rewrite one consultant's custom rows as their merged form. No-op when
 * nothing touches, so it is safe after every write path. Unlike the weekly
 * twin this keeps the surviving row's id — a booking names a custom row, so
 * re-creating every row would orphan ids that are still in flight.
 */
export async function coalesceConsultantCustomRows(
  db: Pick<Tx, "availabilityWindowCustom">,
  consultantProfileId: string,
): Promise<{ before: number; after: number }> {
  const rows = await db.availabilityWindowCustom.findMany({
    where: { consultantProfileId },
    select: { id: true, startsAt: true, endsAt: true },
  });
  const merged = mergeAdjacentCustomRows(rows);
  if (merged.length === rows.length) {
    return { before: rows.length, after: rows.length };
  }
  const survivors = new Map(merged.map((r) => [r.id, r]));
  const foldedIds = rows.filter((r) => !survivors.has(r.id)).map((r) => r.id);
  await db.availabilityWindowCustom.deleteMany({
    where: { id: { in: foldedIds } },
  });
  for (const original of rows) {
    const survivor = survivors.get(original.id);
    if (survivor && survivor.endsAt.getTime() !== original.endsAt.getTime()) {
      await db.availabilityWindowCustom.update({
        where: { id: original.id },
        data: { endsAt: survivor.endsAt },
      });
    }
  }
  return { before: rows.length, after: merged.length };
}

/**
 * After a single custom-row create/update: fold touching rows and return the
 * row that now covers the written window. A miss throws, for the reason the
 * weekly twin gives.
 */
export async function coalesceAndResolveCustom<
  Db extends Pick<Tx, "availabilityWindowCustom">,
>(db: Db, consultantProfileId: string, window: CustomRowShape) {
  await coalesceConsultantCustomRows(db, consultantProfileId);
  const covering = await db.availabilityWindowCustom.findFirst({
    where: {
      consultantProfileId,
      startsAt: { lte: window.startsAt },
      endsAt: { gte: window.endsAt },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    include: {
      consultantProfile: {
        select: { id: true, user: { select: { name: true, email: true } } },
      },
    },
  });
  if (!covering) {
    throw new Error(
      `coalesceAndResolveCustom: no custom row covers the saved window for consultant ${consultantProfileId}`,
    );
  }
  return covering;
}
