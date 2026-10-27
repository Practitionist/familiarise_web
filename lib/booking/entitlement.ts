/**
 * Subscription entitlement — the ONE counter every surface reads.
 *
 * A subscription plan is an entitlement plus a fixed end: `sessionsTotal` is
 * snapshotted at purchase and everything else is derived here from the
 * wrapper's live occurrences. The rolling cycle is the only weekly counter;
 * the allocator only ever accepts `nextBatch`, inside a half-open cycle
 * window that never reaches past the plan end.
 *
 * Prisma-free on purpose — client components import it.
 */
import { addMonths } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

import { formatDateLabel, formatDateRangeLabel } from "@/lib/time/display";

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
  /** The stored plan end; null falls back to `planEndOf` from the start. */
  planEndsAt?: Date | string | null;
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
  /** Sessions the allocator may place now; 0 once the plan has ended. */
  nextBatch: number;
  windowStart: Date;
  /** Exclusive: a session may end exactly here. */
  windowEnd: Date;
}

export interface SubscriptionEntitlement {
  total: number;
  completed: number;
  scheduled: number;
  rescheduling: number;
  held: number;
  remaining: number;
  /** Exclusive plan end; nothing is placed at or after it. */
  planEndsAt: Date;
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

/** Released for reschedule (tentative RESCHEDULED occurrence awaiting replacement). */
function isReschedulingOccurrence(o: EntitlementOccurrence): boolean {
  if (o.deletedAt) return false;
  return Boolean(o.isTentative) && o.completionStatus === "RESCHEDULED";
}

/** Delivered: COMPLETED, or UNVERIFIED (past, parked for a human). */
export function isCompletedOccurrence(o: {
  completionStatus?: string | null;
}): boolean {
  return !!o.completionStatus && COMPLETED_STATUSES.has(o.completionStatus);
}
const isCompleted = isCompletedOccurrence;

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

/** Exclusive end of the cycle that starts on `start`'s zone-day: midnight
 * after the seventh zone-day for a week, the same date next month for a month. */
function cycleEnd(start: Date, unit: CycleUnit, tz: string): Date {
  const day = zoneDayOf(start, tz);
  const nextCycleDay =
    unit === "week"
      ? new Date(day.getFullYear(), day.getMonth(), day.getDate() + 7)
      : addMonths(day, 1);
  return fromZonedTime(nextCycleDay, tz);
}

/** The last instant inside a half-open window ending at `end`, for labels. */
export function lastInstantBefore(end: Date): Date {
  return new Date(end.getTime() - 1);
}

/** Fixed plan end: `start` plus `months` on the consultant's wall clock,
 * clamped to the month's last day (Jan 31 + 1 → Feb 28/29), exclusive. */
export function planEndOf(start: Date, months: number, tz: string): Date {
  // An unreadable start has no end; callers treat an invalid Date as "open".
  if (!Number.isFinite(start.getTime())) return new Date(NaN);
  const wall = formatInTimeZone(start, tz, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  const [y, m, d] = wall.slice(0, 10).split("-").map(Number);
  const monthIndex = m - 1 + Math.max(1, Math.trunc(months));
  const year = y + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const pad = (n: number) => String(n).padStart(2, "0");
  const target = `${year}-${pad(month)}-${pad(day)}${wall.slice(10)}`;
  const end = fromZonedTime(target, tz);
  if (!Number.isFinite(end.getTime())) return end;
  // A wall time inside a spring-forward gap resolves before the gap; move it
  // past the gap instead so the plan is never shortened.
  const landed = formatInTimeZone(end, tz, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  const gapMs = Date.parse(`${target}Z`) - Date.parse(`${landed}Z`);
  return gapMs > 0 ? new Date(end.getTime() + gapMs) : end;
}

export interface PlanEndShape {
  planEndsAt: Date | string | null;
  schedulingPeriodStartsAt: Date | string;
  schedulingTimezone: string;
  subscriptionPlan: { durationInMonths: number };
}

/** The one plan-end reader for sweeps, admin, documents, incidents and
 * renewals: the stored end, else start + durationInMonths. */
export function subscriptionPlanEnd(sub: PlanEndShape): Date {
  if (sub.planEndsAt) return toDate(sub.planEndsAt);
  return planEndOf(
    toDate(sub.schedulingPeriodStartsAt),
    sub.subscriptionPlan.durationInMonths,
    sub.schedulingTimezone,
  );
}

export function subscriptionIsOver(sub: PlanEndShape, now: Date): boolean {
  return now.getTime() >= subscriptionPlanEnd(sub).getTime();
}

/**
 * The plan's cycles as money tranches (#1766): `count` tranches of
 * `capacity` sessions, the last one possibly short. `capacityOf(k)` is what
 * tranche `k` holds; tranche `k` has matured once `completed` covers it, or
 * once every session of the plan is delivered.
 */
export interface SubscriptionTranches {
  capacity: number;
  count: number;
  total: number;
  capacityOf: (k: number) => number;
}

export function subscriptionTranches(
  plan: EntitlementPlanShape,
  sessionsTotal: number,
): SubscriptionTranches {
  const total = Math.max(0, sessionsTotal);
  const capacity = cycleCapacity(plan, total);
  const count = Math.max(1, Math.ceil(total / capacity));
  return {
    capacity,
    count,
    total,
    capacityOf: (k) =>
      k === count - 1 ? total - (count - 1) * capacity : capacity,
  };
}

/** Highest tranche ordinal delivered in full, or -1 when none is yet. */
export function maturedTrancheOrdinal(
  tranches: SubscriptionTranches,
  completed: number,
): number {
  if (tranches.total > 0 && completed >= tranches.total)
    return tranches.count - 1;
  return Math.min(
    Math.floor(completed / tranches.capacity) - 1,
    tranches.count - 1,
  );
}

/** Sessions an N-month plan holds: sessionsPerWeek × months × 4. */
export function planTotalSessions(plan: EntitlementPlanShape): number {
  return plan.sessionsPerWeek * plan.durationInMonths * 4;
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
  const rescheduling = input.occurrences.filter(
    isReschedulingOccurrence,
  ).length;
  const held = completed + scheduled;
  const remaining = Math.max(0, total - held);

  const unit = cycleUnit(input);
  const capacity = cycleCapacity(input, total);
  const count = Math.max(1, Math.ceil(total / capacity));
  const ordinal = Math.min(Math.floor(completed / capacity), count - 1);
  const capThisCycle =
    ordinal === count - 1 ? total - (count - 1) * capacity : capacity;
  const filled = completed - ordinal * capacity + scheduled;

  const now = input.now ?? new Date();
  // During a reschedule (rescheduling > 0), remaining SCHEDULED sessions later
  // in the active cycle must NOT push windowStart past earlier days of the
  // cycle; anchor only to completed sessions so the whole active cycle stays
  // selectable.
  const anchorEndsAt = live
    .filter((o) =>
      rescheduling > 0 ? isCompleted(o) : isCompleted(o) || isScheduled(o),
    )
    .reduce<number>((max, o) => Math.max(max, toDate(o.endsAt).getTime()), 0);
  const storedStart = toDate(input.schedulingPeriodStartsAt).getTime();
  const windowStart = new Date(
    Math.max(
      Number.isFinite(storedStart) ? storedStart : 0,
      anchorEndsAt,
      now.getTime(),
    ),
  );
  const planEndsAt = subscriptionPlanEnd({
    planEndsAt: input.planEndsAt ?? null,
    schedulingPeriodStartsAt: input.schedulingPeriodStartsAt,
    schedulingTimezone: input.schedulingTimezone,
    subscriptionPlan: { durationInMonths: input.durationInMonths },
  });
  const planEndMs = planEndsAt.getTime();
  const windowEnd = new Date(
    Math.min(
      cycleEnd(windowStart, unit, input.schedulingTimezone).getTime(),
      Number.isFinite(planEndMs) ? planEndMs : Infinity,
    ),
  );
  const nextBatch =
    windowEnd > windowStart
      ? Math.max(0, Math.min(capThisCycle - filled, remaining))
      : 0;

  return {
    total,
    completed,
    scheduled,
    rescheduling,
    held,
    remaining,
    planEndsAt,
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

/**
 * The allocate-page footer and the Home row read one short sentence:
 * "Pick 4 for 2 – 8 Mar · 1 per week · 0 of 12 booked" while the cycle has
 * room, "This cycle is set · next opens after 8 Mar · 4 of 12 booked" once
 * it is full, "All 12 sessions booked" at the end, and "Plan ended on 31 May"
 * once the plan end has passed with sessions unplaced.
 */
export function subscriptionCycleHeading(
  entitlement: SubscriptionEntitlement,
  opts: { zone?: string; locale?: string } = {},
): string {
  const { nextBatch, windowStart, windowEnd, capacity, unit } =
    entitlement.cycle;
  const { held, total, remaining, rescheduling } = entitlement;
  const booked = `${held} of ${total} booked`;
  const targetBatch = rescheduling > 0 ? rescheduling : nextBatch;
  const lastDay = lastInstantBefore(windowEnd);
  if (remaining === 0 && targetBatch === 0)
    return `All ${total} sessions booked`;
  if (windowEnd <= windowStart)
    return `Plan ended on ${formatDateLabel(lastDay, opts)} · ${booked}`;
  if (targetBatch === 0)
    return `This cycle is set · next opens after ${formatDateLabel(lastDay, opts)} · ${booked}`;
  const window = formatDateRangeLabel(windowStart, lastDay, opts);
  return `Pick ${targetBatch} for ${window} · ${capacity} per ${unit} · ${booked}`;
}
