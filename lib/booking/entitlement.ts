/**
 * Subscription entitlement — the ONE counter every surface reads (#1766).
 *
 * A subscription plan is an entitlement plus a duration: `sessionsTotal` is
 * snapshotted from the plan at purchase (`Subscription.sessionsTotal`) and
 * everything else is derived here from the wrapper's live occurrences. There
 * is no consumed counter, no per-surface arithmetic and no time bucket: the
 * cycles are fill-order tranches ranked over completed rows, so a reschedule
 * across a calendar boundary changes nothing and the allocator can never
 * place into a future cycle because it only ever accepts `nextBatch`.
 *
 * Prisma-free on purpose — client components import it.
 */
import { fromZonedTime, toZonedTime } from "date-fns-tz";

import { formatDateLabel } from "@/lib/time/display";
import { addMonthsSafely } from "@/utils/dateUtils";

export type CycleUnit = "week" | "month";

export interface EntitlementOccurrence {
  startsAt: Date | string;
  endsAt: Date | string;
  completionStatus: string | null;
  isTentative?: boolean | null;
  deletedAt?: Date | string | null;
}

export interface EntitlementPlanShape {
  sessionsPerWeek: number;
  durationInMonths: number;
}

export interface SubscriptionEntitlementInput extends EntitlementPlanShape {
  sessionsTotal: number;
  occurrences: EntitlementOccurrence[];
  schedulingPeriodStartsAt: Date | string;
  schedulingTimezone: string;
  now?: Date;
}

export interface SubscriptionCycle {
  unit: CycleUnit;
  /** Sessions one full cycle holds. */
  capacity: number;
  /** Cycles in the plan; the last one may be short. */
  count: number;
  /** Zero-based index of the cycle being filled. */
  ordinal: number;
  /** Sessions already held against this cycle (completed in it + scheduled). */
  filled: number;
  /** Sessions the allocator may place now. */
  nextBatch: number;
  windowStart: Date;
  windowEnd: Date;
}

export interface SubscriptionEntitlement {
  total: number;
  completed: number;
  scheduled: number;
  held: number;
  remaining: number;
  cycle: SubscriptionCycle;
}

const COMPLETED_STATUSES = new Set(["COMPLETED", "UNVERIFIED"]);

/** Twin of `isDeadOccurrence` (lib/appointments/occurrences.ts), kept
 * Prisma-free: a tombstone or a released/cancelled status counts nothing. */
function isLiveOccurrence(o: EntitlementOccurrence): boolean {
  if (o.deletedAt) return false;
  return (
    o.completionStatus !== "CANCELLED" && o.completionStatus !== "RESCHEDULED"
  );
}

function isCompleted(o: EntitlementOccurrence): boolean {
  return !!o.completionStatus && COMPLETED_STATUSES.has(o.completionStatus);
}

function isScheduled(o: EntitlementOccurrence): boolean {
  return (o.completionStatus ?? "SCHEDULED") === "SCHEDULED" && !o.isTentative;
}

const toDate = (d: Date | string): Date =>
  d instanceof Date ? d : new Date(d);

/**
 * `sessionsPerWeek` is `Int @default(1)` so the month arm is degenerate
 * today; it stays so a hand-zeroed plan still cycles instead of dividing by 0.
 */
function cycleUnit(plan: EntitlementPlanShape): CycleUnit {
  return plan.sessionsPerWeek >= 1 ? "week" : "month";
}

function cycleCapacity(plan: EntitlementPlanShape, total: number): number {
  return cycleUnit(plan) === "week"
    ? plan.sessionsPerWeek
    : Math.max(1, Math.ceil(total / Math.max(1, plan.durationInMonths)));
}

/** Midnight of the calendar day that holds `instant`, read in `tz`, as a
 * local-field Date (only its year/month/day are meaningful). */
function zoneDayOf(instant: Date, tz: string): Date {
  const wall = toZonedTime(instant, tz);
  return new Date(wall.getFullYear(), wall.getMonth(), wall.getDate());
}

/** Last instant of the cycle that starts on `start`'s zone-day: the end of
 * the seventh zone-day for a week, the day before the same date next month
 * for a month. */
function cycleEnd(start: Date, unit: CycleUnit, tz: string): Date {
  const day = zoneDayOf(start, tz);
  const nextCycleDay =
    unit === "week"
      ? new Date(day.getFullYear(), day.getMonth(), day.getDate() + 7)
      : addMonthsSafely(day, 1);
  return new Date(fromZonedTime(nextCycleDay, tz).getTime() - 1);
}

/** The scheduling window checkout persists: the FIRST cycle only. */
export function firstCycleWindow(
  plan: EntitlementPlanShape,
  start: Date,
  tz: string,
): { start: Date; end: Date } {
  return { start, end: cycleEnd(start, cycleUnit(plan), tz) };
}

/** The frozen entitlement, or the plan's total for a pre-#1766 row. */
export function sessionsTotalOf(sub: {
  sessionsTotal: number | null;
  subscriptionPlan: { totalSessions: number };
}): number {
  return sub.sessionsTotal ?? sub.subscriptionPlan.totalSessions;
}

export function subscriptionEntitlement(
  input: SubscriptionEntitlementInput,
): SubscriptionEntitlement {
  const total = Math.max(0, input.sessionsTotal);
  const live = input.occurrences.filter(isLiveOccurrence);
  const completed = live.filter(isCompleted).length;
  const scheduled = live.filter(isScheduled).length;
  const held = completed + scheduled;
  const remaining = Math.max(0, total - held);

  const unit = cycleUnit(input);
  const capacity = cycleCapacity(input, total);
  const count = Math.max(1, Math.ceil(total / capacity));
  const ordinal = Math.min(Math.floor(completed / capacity), count - 1);
  const capThisCycle =
    ordinal === count - 1 ? total - (count - 1) * capacity : capacity;
  const filled = completed - ordinal * capacity + scheduled;
  const nextBatch = Math.max(0, Math.min(capThisCycle - filled, remaining));

  const now = input.now ?? new Date();
  const lastHeldEndsAt = live
    .filter((o) => isCompleted(o) || isScheduled(o))
    .reduce<number>((max, o) => Math.max(max, toDate(o.endsAt).getTime()), 0);
  const windowStart = new Date(
    Math.max(
      toDate(input.schedulingPeriodStartsAt).getTime(),
      lastHeldEndsAt,
      now.getTime(),
    ),
  );
  const windowEnd = cycleEnd(windowStart, unit, input.schedulingTimezone);

  return {
    total,
    completed,
    scheduled,
    held,
    remaining,
    cycle: {
      unit,
      capacity,
      count,
      ordinal,
      filled,
      nextBatch,
      windowStart,
      windowEnd,
    },
  };
}

/** The allocate-page footer and the Home row read one sentence. */
export function subscriptionCycleHeading(
  entitlement: SubscriptionEntitlement,
  opts: { zone?: string; locale?: string } = {},
): string {
  const { nextBatch, windowStart, windowEnd } = entitlement.cycle;
  const window = `${formatDateLabel(windowStart, opts)} – ${formatDateLabel(windowEnd, opts)}`;
  return `Schedule the next ${nextBatch} session${nextBatch === 1 ? "" : "s"} · this cycle ${window} · ${entitlement.held} of ${entitlement.total} scheduled`;
}
