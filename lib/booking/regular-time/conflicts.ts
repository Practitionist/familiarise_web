/**
 * The Regular-time conflict list, derived on read (no table): per horizon week,
 * the projected slots that hold no session and why, plus placed sessions that
 * now fall outside the consultant's hours. Prisma-free.
 */
import type { HorizonWeek } from "@/lib/booking/entitlement";
import type { ProjectedSlot } from "@/lib/booking/regular-time/project";

export const CONFLICT_REASONS = [
  "TAKEN",
  "OUTSIDE_HOURS",
  "TOO_SOON",
  "PAST_PLAN_END",
  "HOURS_CHANGED",
] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

export const CONFLICT_COPY: Record<ConflictReason, string> = {
  TAKEN: "You already have a session then.",
  OUTSIDE_HOURS: "Outside your available hours.",
  TOO_SOON: "Too close to start to book.",
  PAST_PLAN_END: "After the plan ends.",
  HOURS_CHANGED: "Booked, but now outside your available hours.",
};

export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

export interface PlacedSession extends Interval {
  id: string;
}

export interface RegularConflict extends Interval {
  reason: ConflictReason;
  /** Set for HOURS_CHANGED: the placed session to move. */
  occurrenceId?: string;
}

export interface HorizonWeekView extends HorizonWeek {
  placed: PlacedSession[];
  conflicts: RegularConflict[];
  /** Capacity not yet held this week. */
  shortBy: number;
}

export interface DeriveConflictsInput {
  weeks: readonly HorizonWeek[];
  projected: readonly ProjectedSlot[];
  /** This plan's live scheduled sessions. */
  own: readonly PlacedSession[];
  /** The host's other live sessions, any event or buyer. */
  hostBusy: readonly Interval[];
  /** Whether [start, end) sits inside the host's hours (weekly or custom rows). */
  isAvailable: (startsAt: Date, endsAt: Date) => boolean;
  now: Date;
  leadMs: number;
}

const overlaps = (a: Interval, b: Interval) =>
  a.startsAt.getTime() < b.endsAt.getTime() &&
  b.startsAt.getTime() < a.endsAt.getTime();

/** Why a projected slot can't be placed, or null when it can. */
export function slotConflictReason(
  slot: ProjectedSlot,
  ctx: Pick<
    DeriveConflictsInput,
    "hostBusy" | "isAvailable" | "now" | "leadMs"
  >,
): Exclude<ConflictReason, "HOURS_CHANGED"> | null {
  if (slot.pastPlanEnd) return "PAST_PLAN_END";
  if (slot.startsAt.getTime() <= ctx.now.getTime() + ctx.leadMs)
    return "TOO_SOON";
  if (ctx.hostBusy.some((b) => overlaps(b, slot))) return "TAKEN";
  if (!ctx.isAvailable(slot.startsAt, slot.endsAt)) return "OUTSIDE_HOURS";
  return null;
}

/**
 * Per week: an unplaced slot is a conflict only while the week is under
 * capacity (a full week needs nothing); a placed future session outside the
 * host's hours is HOURS_CHANGED whatever the count.
 */
export function deriveHorizonConflicts(
  input: DeriveConflictsInput,
): HorizonWeekView[] {
  return input.weeks.map((week) => {
    const inWeek = (i: Interval) =>
      i.startsAt.getTime() >= week.startsAt.getTime() &&
      i.startsAt.getTime() < week.endsAt.getTime();
    const placed = input.own.filter(inWeek);
    const conflicts: RegularConflict[] = [];
    if (week.held < week.capacity) {
      for (const slot of input.projected) {
        if (slot.weekIndex !== week.weekIndex) continue;
        if (placed.some((p) => overlaps(p, slot))) continue;
        const reason = slotConflictReason(slot, input);
        if (reason)
          conflicts.push({
            reason,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
          });
      }
    }
    for (const p of placed) {
      if (p.startsAt.getTime() <= input.now.getTime()) continue;
      if (!input.isAvailable(p.startsAt, p.endsAt))
        conflicts.push({
          reason: "HOURS_CHANGED",
          startsAt: p.startsAt,
          endsAt: p.endsAt,
          occurrenceId: p.id,
        });
    }
    return {
      ...week,
      placed,
      conflicts,
      shortBy: Math.max(0, week.capacity - week.held),
    };
  });
}

/** "2 to fix" count across the horizon. */
export function conflictCount(weeks: readonly HorizonWeekView[]): number {
  return weeks.reduce((n, w) => n + w.conflicts.length, 0);
}

/** A past week is missed when it ended under quota. */
export function isMissedWeek(week: HorizonWeek, now: Date): boolean {
  return week.endsAt.getTime() <= now.getTime() && week.held < week.capacity;
}
