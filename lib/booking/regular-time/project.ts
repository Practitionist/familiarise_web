/**
 * Regular time → UTC starts per fixed plan week.
 *
 * A Regular time is a weekday plus a local start in the plan's zone. Plan week
 * k is [day0 + 7k, day0 + 7k + 7) zone-days from the plan start, the same weeks
 * `subscriptionEntitlement` counts. Prisma-free: client components import it.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** Every placed start sits on the UTC half-hour lattice the grid paints. */
export const SLOT_LATTICE_MS = 30 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WALL = "yyyy-MM-dd'T'HH:mm:ss";

export interface RegularSlot {
  /** ISO weekday 1 (Mon) .. 7 (Sun), read in the plan's zone. */
  weekday: number;
  /** Minutes after local midnight, 0..1439. */
  localStartMinutes: number;
}

export interface ProjectedSlot extends RegularSlot {
  /** Zero-based plan week. */
  weekIndex: number;
  startsAt: Date;
  endsAt: Date;
  /** The session would end after the plan end; it is never placed. */
  pastPlanEnd: boolean;
}

export interface ProjectRegularSlotsInput {
  slots: readonly RegularSlot[];
  timeZone: string;
  planStartsAt: Date;
  planEndsAt: Date;
  /** First zero-based plan week to project. */
  fromWeek: number;
  weeks: number;
  sessionMinutes: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Zone-day fields of the plan start (day0). */
function planDay0(planStartsAt: Date, tz: string): Date {
  const [y, m, d] = formatInTimeZone(planStartsAt, tz, "yyyy-MM-dd")
    .split("-")
    .map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** ISO weekday of a UTC-field calendar date. */
function isoWeekday(day: Date): number {
  const d = day.getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * The instant a wall time names in `tz`. A time inside a spring-forward gap
 * resolves forward past the gap; a repeated fall-back time takes the first one.
 */
export function wallTimeToInstant(
  day: Date,
  localStartMinutes: number,
  tz: string,
): Date {
  const target = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(
    day.getUTCDate(),
  )}T${pad(Math.floor(localStartMinutes / 60))}:${pad(localStartMinutes % 60)}:00`;
  const instant = fromZonedTime(target, tz);
  const landed = formatInTimeZone(instant, tz, WALL);
  const gapMs = Date.parse(`${target}Z`) - Date.parse(`${landed}Z`);
  if (gapMs > 0) return new Date(instant.getTime() + gapMs);
  const anHourEarlier = new Date(instant.getTime() - HOUR_MS);
  return formatInTimeZone(anHourEarlier, tz, WALL) === landed
    ? anHourEarlier
    : instant;
}

/** Whether a start sits on the UTC half-hour lattice. */
export function isOnLattice(start: Date): boolean {
  return start.getTime() % SLOT_LATTICE_MS === 0;
}

/** Every slot's start and end in plan weeks [fromWeek, fromWeek + weeks), in week then time order. */
export function projectRegularSlots(
  input: ProjectRegularSlotsInput,
): ProjectedSlot[] {
  const day0 = planDay0(input.planStartsAt, input.timeZone);
  const planEndMs = input.planEndsAt.getTime();
  const out: ProjectedSlot[] = [];
  for (let k = input.fromWeek; k < input.fromWeek + input.weeks; k++) {
    for (let i = 0; i < 7; i++) {
      const day = new Date(day0.getTime());
      day.setUTCDate(day0.getUTCDate() + 7 * k + i);
      const weekday = isoWeekday(day);
      for (const slot of input.slots) {
        if (slot.weekday !== weekday) continue;
        const startsAt = wallTimeToInstant(
          day,
          slot.localStartMinutes,
          input.timeZone,
        );
        const endsAt = new Date(
          startsAt.getTime() + input.sessionMinutes * MINUTE_MS,
        );
        out.push({
          ...slot,
          weekIndex: k,
          startsAt,
          endsAt,
          pastPlanEnd:
            Number.isFinite(planEndMs) && endsAt.getTime() > planEndMs,
        });
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.weekIndex - b.weekIndex || a.startsAt.getTime() - b.startsAt.getTime(),
  );
}

/** The slots a writer may place: those that end inside the plan. */
export function placeableSlots(
  slots: readonly ProjectedSlot[],
): ProjectedSlot[] {
  return slots.filter((s) => !s.pastPlanEnd);
}

/** "09:15": local minutes as a 24-hour clock. */
export function formatLocalMinutes(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export const WEEKDAY_SHORT = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;

/** "Mon, Wed, Fri at 18:00" (one time) or "Mon 09:00, Thu 18:00" (mixed). */
export function regularTimeLabel(slots: readonly RegularSlot[]): string {
  const sorted = [...slots].sort((a, b) => a.weekday - b.weekday);
  const times = new Set(sorted.map((s) => s.localStartMinutes));
  if (times.size === 1) {
    const days = sorted.map((s) => WEEKDAY_SHORT[s.weekday - 1]).join(", ");
    return `${days} at ${formatLocalMinutes(sorted[0].localStartMinutes)}`;
  }
  return sorted
    .map(
      (s) =>
        `${WEEKDAY_SHORT[s.weekday - 1]} ${formatLocalMinutes(s.localStartMinutes)}`,
    )
    .join(", ");
}

export type RegularSlotRefusal =
  | { code: "REGULAR_TIME_SLOT_COUNT"; message: string }
  | { code: "REGULAR_TIME_SAME_DAY"; message: string }
  | {
      code: "REGULAR_TIME_OFF_GRID";
      message: string;
      nearest: [number, number];
    };

/**
 * Why a Regular time can't be saved, or null. Off-grid is checked on every
 * remaining plan week, so a zone whose offset moves later is caught now.
 */
export function regularSlotsRefusal(
  slots: readonly RegularSlot[],
  ctx: {
    perWeek: number;
    timeZone: string;
    planStartsAt: Date;
    planEndsAt: Date;
    fromWeek: number;
    weeks: number;
  },
): RegularSlotRefusal | null {
  if (slots.length !== ctx.perWeek) {
    return {
      code: "REGULAR_TIME_SLOT_COUNT",
      message: `Pick ${ctx.perWeek} ${ctx.perWeek === 1 ? "time" : "times"} a week, one for each session.`,
    };
  }
  if (new Set(slots.map((s) => s.weekday)).size !== slots.length) {
    return {
      code: "REGULAR_TIME_SAME_DAY",
      message:
        "Pick a different day for each session. Only one a day is allowed.",
    };
  }
  const projected = projectRegularSlots({
    slots,
    timeZone: ctx.timeZone,
    planStartsAt: ctx.planStartsAt,
    planEndsAt: ctx.planEndsAt,
    fromWeek: ctx.fromWeek,
    weeks: Math.max(1, ctx.weeks),
    sessionMinutes: 0,
  });
  const off = projected.find((p) => !isOnLattice(p.startsAt));
  if (off) {
    const driftMin = Math.round(
      (off.startsAt.getTime() % SLOT_LATTICE_MS) / MINUTE_MS,
    );
    const earlier = off.localStartMinutes - driftMin;
    const later =
      off.localStartMinutes + (SLOT_LATTICE_MS / MINUTE_MS - driftMin);
    return {
      code: "REGULAR_TIME_OFF_GRID",
      message: `${formatLocalMinutes(off.localStartMinutes)} doesn't line up with the booking grid in ${ctx.timeZone}. Pick ${formatLocalMinutes(earlier)} or ${formatLocalMinutes(later)} instead.`,
      nearest: [earlier, later],
    };
  }
  return null;
}
