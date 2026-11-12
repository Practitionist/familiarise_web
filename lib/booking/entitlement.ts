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
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

import { formatDateLabel, formatDateRangeLabel } from "@/lib/time/display";
import { dayStartInstant } from "@/lib/time/grid-zone";

/** Plans are paced in plan weeks; `sessionsPerWeek` is a whole number ≥ 1 at every door. */
export type CycleUnit = "week";

export interface EntitlementOccurrence {
  /** Present where a caller must name rows (a reschedule's released ones). */
  id?: string;
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
  /** Sessions sold at purchase. */
  sessionsTotal: number;
  /** Sessions a support partial refund removed; never schedulable. */
  sessionsRefunded: number;
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
  /** Plan weeks (calendar weeks from the plan start) up to the plan end. */
  count: number;
  /** Zero-based plan week being filled: this week, or next week once this one is full. */
  ordinal: number;
  /** Sessions held in that plan week (completed or scheduled there). */
  filled: number;
  /** Sessions the allocator may place now; 0 once the plan has ended. */
  nextBatch: number;
  windowStart: Date;
  /** Exclusive: a session may end exactly here. */
  windowEnd: Date;
}

export interface SubscriptionEntitlement {
  /** Schedulable sessions: sold less those a support refund removed. */
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

/** Sessions one plan week holds; a legacy zero cadence still paces at one a week. */
function cycleCapacity(plan: EntitlementPlanShape): number {
  return Math.max(1, plan.sessionsPerWeek);
}

/** Midnight of the calendar day that holds `instant`, read in `tz`, as a
 * local-field Date (only its year/month/day are meaningful). */
function zoneDayOf(instant: Date, tz: string): Date {
  const wall = toZonedTime(instant, tz);
  return new Date(wall.getFullYear(), wall.getMonth(), wall.getDate());
}

/** Exclusive end of the plan week that starts on `start`'s zone-day: midnight
 * after its seventh zone-day. */
function cycleEnd(start: Date, tz: string): Date {
  const day = zoneDayOf(start, tz);
  return fromZonedTime(
    new Date(day.getFullYear(), day.getMonth(), day.getDate() + 7),
    tz,
  );
}

/** The last instant inside a half-open window ending at `end`, for labels. */
export function lastInstantBefore(end: Date): Date {
  return new Date(end.getTime() - 1);
}

type WallDate = { y: number; m: number; d: number };

/** `start` moved to another calendar date at the same wall time in `tz`. */
function shiftWallDate(
  start: Date,
  tz: string,
  shift: (from: WallDate) => WallDate,
): Date {
  // An unreadable start has no end; callers treat an invalid Date as "open".
  if (!Number.isFinite(start.getTime())) return new Date(Number.NaN);
  const wall = formatInTimeZone(start, tz, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  const [y, m, d] = wall.slice(0, 10).split("-").map(Number);
  const to = shift({ y, m, d });
  const pad = (n: number) => String(n).padStart(2, "0");
  const target = `${to.y}-${pad(to.m)}-${pad(to.d)}${wall.slice(10)}`;
  const end = fromZonedTime(target, tz);
  if (!Number.isFinite(end.getTime())) return end;
  // A wall time inside a spring-forward gap resolves before the gap; move it
  // past the gap instead so the plan is never shortened.
  const landed = formatInTimeZone(end, tz, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  const gapMs = Date.parse(`${target}Z`) - Date.parse(`${landed}Z`);
  return gapMs > 0 ? new Date(end.getTime() + gapMs) : end;
}

/** Fixed plan end: `start` plus `months` on the consultant's wall clock,
 * clamped to the month's last day (Jan 31 + 1 → Feb 28/29), exclusive. */
export function planEndOf(start: Date, months: number, tz: string): Date {
  return shiftWallDate(start, tz, ({ y, m, d }) => {
    const monthIndex = m - 1 + Math.max(1, Math.trunc(months));
    const year = y + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { y: year, m: month, d: Math.min(d, lastDay) };
  });
}

/**
 * Weeks-plan end: the zone midnight that closes plan week `weeks - 1`, i.e. the
 * start of zone-day `day0 + 7 × weeks` where day0 is the purchase's zone-day.
 * Plan weeks are whole zone-days from day0, so ending on that midnight leaves no
 * sub-day stub week after the last one. Exclusive; a midnight the clocks skip
 * resolves to the first minute of that day.
 */
export function weeksPlanEndOf(start: Date, weeks: number, tz: string): Date {
  if (!Number.isFinite(start.getTime())) return new Date(Number.NaN);
  const [y, m, d] = formatInTimeZone(start, tz, "yyyy-MM-dd")
    .split("-")
    .map(Number);
  // A local-noon date names the calendar day; dayStartInstant reads its fields.
  return dayStartInstant(
    new Date(y, m - 1, d + 7 * Math.max(1, Math.trunc(weeks)), 12),
    tz,
  );
}

export interface PlanEndShape {
  planEndsAt: Date | string | null;
  schedulingPeriodStartsAt: Date | string;
  schedulingTimezone: string;
  subscriptionPlan: { durationInMonths: number };
}

/** The one plan-end reader for sweeps, admin, documents, incidents and
 * renewals: the stored end, else start + durationInMonths. Every weeks-plan
 * row stamps its end at purchase, so the fallback only sees months plans. */
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
  const capacity = cycleCapacity(plan);
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

export interface SubscriptionPlanLength {
  durationInMonths: number;
  /** Null for a months plan. */
  durationInWeeks: number | null;
}

/** A plan's length in weeks: the weeks picker's value, else months × 4. */
export function planWeeksOf(plan: SubscriptionPlanLength): number {
  return plan.durationInWeeks ?? plan.durationInMonths * 4;
}

/** The months label a weeks plan derives (26 weeks → 6), at least 1. */
export function monthsForWeeks(weeks: number): number {
  return Math.max(1, Math.round((weeks * 7) / (365.25 / 12)));
}

/** "26 weeks · 78 sessions" for a weeks plan; "6 months · 72 sessions" otherwise. */
export function planLengthLabel(
  plan: SubscriptionPlanLength & { sessionsPerWeek: number },
): string {
  const sessions = planWeeksOf(plan) * plan.sessionsPerWeek;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const length =
    plan.durationInWeeks !== null
      ? unit(plan.durationInWeeks, "week")
      : unit(plan.durationInMonths, "month");
  return `${length} · ${unit(sessions, "session")}`;
}

export interface PurchasePlanShape extends SubscriptionPlanLength {
  sessionsPerWeek: number;
  sessionDurationInHours: number;
}

/**
 * The derived columns a plan row stores: a weeks plan derives its months
 * label, and both store sessions = weeks × sessions a week.
 */
export function subscriptionPlanTotals(plan: PurchasePlanShape): {
  durationInMonths: number;
  totalSessions: number;
  totalHours: number;
} {
  const durationInMonths =
    plan.durationInWeeks !== null
      ? monthsForWeeks(plan.durationInWeeks)
      : plan.durationInMonths;
  const totalSessions = planWeeksOf(plan) * plan.sessionsPerWeek;
  return {
    durationInMonths,
    totalSessions,
    totalHours: totalSessions * plan.sessionDurationInHours,
  };
}

/**
 * The terms a purchase freezes onto the subscription: the weekly cap, the
 * session length, the sessions sold and the fixed plan end.
 */
export function purchaseTermsOf(
  plan: PurchasePlanShape,
  start: Date,
  tz: string,
): {
  sessionsPerWeek: number;
  sessionMinutes: number;
  sessionsTotal: number;
  planEndsAt: Date;
} {
  return {
    sessionsPerWeek: plan.sessionsPerWeek,
    sessionMinutes: Math.round(plan.sessionDurationInHours * 60),
    sessionsTotal: planWeeksOf(plan) * plan.sessionsPerWeek,
    planEndsAt:
      plan.durationInWeeks !== null
        ? weeksPlanEndOf(start, plan.durationInWeeks, tz)
        : planEndOf(start, plan.durationInMonths, tz),
  };
}

/**
 * Sessions a sold plan can still hold, for display reads: sold (frozen, else
 * the plan's) less what a support refund removed; null when neither is known.
 */
export function schedulableSessionsOf(sub: {
  sessionsTotal?: number | null;
  sessionsRefunded?: number | null;
  subscriptionPlan?: { totalSessions?: number | null } | null;
}): number | null {
  const sold = sub.sessionsTotal ?? sub.subscriptionPlan?.totalSessions ?? null;
  return sold === null ? null : Math.max(0, sold - (sub.sessionsRefunded ?? 0));
}

/** A session count's share of a plan payment, in paise: floor(A × k / T). */
export function sessionShareOf(
  amountPaise: number,
  sessions: number,
  sessionsTotal: number,
): number {
  if (sessionsTotal <= 0 || sessions <= 0) return 0;
  return Math.floor(
    (amountPaise * Math.min(sessions, sessionsTotal)) / sessionsTotal,
  );
}

/** "3 active clients keep their current terms. …" or null with none. */
export function activeClientsNotice(count: number): string | null {
  if (count <= 0) return null;
  const clients =
    count === 1 ? "1 active client keeps" : `${count} active clients keep`;
  return `${clients} their current terms. Changes apply to new buyers only.`;
}

/** The weekly cap a sold subscription runs on: frozen at purchase, else the plan's. */
export function soldSessionsPerWeek(sub: {
  sessionsPerWeek: number | null;
  subscriptionPlan: { sessionsPerWeek: number };
}): number {
  return sub.sessionsPerWeek ?? sub.subscriptionPlan.sessionsPerWeek;
}

/** The session length a sold subscription runs on, in minutes. */
export function soldSessionMinutes(sub: {
  sessionMinutes: number | null;
  subscriptionPlan: { sessionDurationInHours: number };
}): number {
  return (
    sub.sessionMinutes ??
    Math.round(sub.subscriptionPlan.sessionDurationInHours * 60)
  );
}

export interface SoldTermsShape {
  sessionsTotal: number | null;
  sessionsPerWeek: number | null;
  sessionsRefunded: number;
  subscriptionPlan: {
    totalSessions: number;
    sessionsPerWeek: number;
    durationInMonths: number;
  };
}

/** The entitlement terms of a sold subscription, frozen columns first. */
export function soldTermsOf(
  sub: SoldTermsShape,
): Pick<
  SubscriptionEntitlementInput,
  "sessionsTotal" | "sessionsRefunded" | "sessionsPerWeek" | "durationInMonths"
> {
  return {
    sessionsTotal: sessionsTotalOf(sub),
    sessionsRefunded: sub.sessionsRefunded,
    sessionsPerWeek: soldSessionsPerWeek(sub),
    durationInMonths: sub.subscriptionPlan.durationInMonths,
  };
}

/** The scheduling window checkout persists: the FIRST cycle only. */
export function firstCycleWindow(
  plan: EntitlementPlanShape,
  start: Date,
  tz: string,
): { start: Date; end: Date } {
  return { start, end: cycleEnd(start, tz) };
}

/** The frozen entitlement, or the plan's total for a pre-#1766 row. */
export function sessionsTotalOf(sub: {
  sessionsTotal: number | null;
  subscriptionPlan: { totalSessions: number };
}): number {
  return sub.sessionsTotal ?? sub.subscriptionPlan.totalSessions;
}

/**
 * The start of plan week `k`: the plan's first zone-day plus k weeks, at
 * zone-midnight. Plan weeks are fixed calendar weeks anchored on the plan
 * start, never a window that floats with delivery.
 */
function planCycleStart(day0: Date, k: number, tz: string): Date {
  return fromZonedTime(
    new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + 7 * k),
    tz,
  );
}

/** Zero-based plan week holding `instant` (negative before the plan starts). */
function planCycleIndex(day0: Date, instant: Date, tz: string): number {
  const day = zoneDayOf(instant, tz);
  const days = Math.round(
    (Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) -
      Date.UTC(day0.getFullYear(), day0.getMonth(), day0.getDate())) /
      86_400_000,
  );
  return Math.floor(days / 7);
}

/** The 1-based plan week (or month) `instant` falls in, for "Week N of W". */
export function planWeekNumber(
  input: Pick<
    SubscriptionEntitlementInput,
    | "sessionsPerWeek"
    | "durationInMonths"
    | "schedulingPeriodStartsAt"
    | "schedulingTimezone"
  >,
  instant: Date,
): number {
  const tz = input.schedulingTimezone;
  const day0 = zoneDayOf(toDate(input.schedulingPeriodStartsAt), tz);
  return Math.max(0, planCycleIndex(day0, instant, tz)) + 1;
}

/** When plan week (or month) `k` (zero-based) starts, at zone-midnight. */
export function planWeekStartsAt(
  input: Pick<
    SubscriptionEntitlementInput,
    | "sessionsPerWeek"
    | "durationInMonths"
    | "schedulingPeriodStartsAt"
    | "schedulingTimezone"
  >,
  k: number,
): Date {
  const tz = input.schedulingTimezone;
  const day0 = zoneDayOf(toDate(input.schedulingPeriodStartsAt), tz);
  return planCycleStart(day0, k, tz);
}

export function subscriptionEntitlement(
  input: SubscriptionEntitlementInput,
): SubscriptionEntitlement {
  const total = Math.max(0, input.sessionsTotal - input.sessionsRefunded);
  const live = input.occurrences.filter(isLiveOccurrence);
  const completed = live.filter(isCompleted).length;
  const scheduled = live.filter(isScheduled).length;
  const rescheduling = input.occurrences.filter(
    isReschedulingOccurrence,
  ).length;
  const held = completed + scheduled;
  const remaining = Math.max(0, total - held);

  const tz = input.schedulingTimezone;
  const unit: CycleUnit = "week";
  const capacity = cycleCapacity(input);
  const now = input.now ?? new Date();
  const planStart = toDate(input.schedulingPeriodStartsAt);
  const planEndsAt = subscriptionPlanEnd({
    planEndsAt: input.planEndsAt ?? null,
    schedulingPeriodStartsAt: input.schedulingPeriodStartsAt,
    schedulingTimezone: tz,
    subscriptionPlan: { durationInMonths: input.durationInMonths },
  });
  const planEndMs = planEndsAt.getTime();

  // Fixed plan cycles from the plan start's zone-day: week k is
  // [day0 + 7k, day0 + 7k + 7). A start that cannot be read is one open cycle.
  const startOk = Number.isFinite(planStart.getTime());
  const day0 = zoneDayOf(startOk ? planStart : now, tz);
  const indexOf = (instant: Date) => planCycleIndex(day0, instant, tz);
  const startOf = (k: number) => planCycleStart(day0, k, tz);
  const count = Number.isFinite(planEndMs)
    ? Math.max(1, indexOf(new Date(planEndMs - 1)) + 1)
    : Math.max(1, Math.ceil(total / capacity));
  const heldIn = (k: number) =>
    live.filter(
      (o) =>
        (isCompleted(o) || isScheduled(o)) && indexOf(toDate(o.startsAt)) === k,
    ).length;

  // The current plan week, and the next one once it is full: a consultant
  // may schedule a week ahead, never further, and never pack two weeks into one.
  const current = Math.min(Math.max(0, indexOf(now)), count - 1);
  const candidates = [current, current + 1].filter((k) => k < count);
  const ordinal =
    candidates.find((k) => heldIn(k) < capacity) ??
    candidates[candidates.length - 1];
  const filled = heldIn(ordinal);

  const windowStart = new Date(
    Math.max(
      startOf(ordinal).getTime(),
      startOk ? planStart.getTime() : 0,
      now.getTime(),
    ),
  );
  const windowEnd = new Date(
    Math.min(
      startOf(ordinal + 1).getTime(),
      Number.isFinite(planEndMs) ? planEndMs : Infinity,
    ),
  );
  const nextBatch =
    windowEnd > windowStart
      ? Math.max(0, Math.min(capacity - filled, remaining))
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
 * The window a subscription reschedule may target: the allocator's own window
 * (the auto-confirm runs it), computed with the sessions being moved released.
 * The picker clamps to it, so a pick the server would drop is never offered.
 */
export function rescheduleWindow(
  input: SubscriptionEntitlementInput,
  releasingIds: readonly string[],
): { start: Date; end: Date } {
  const releasing = new Set(releasingIds);
  const { cycle } = subscriptionEntitlement({
    ...input,
    occurrences: input.occurrences.map((o) =>
      o.id && releasing.has(o.id)
        ? { ...o, completionStatus: "RESCHEDULED", isTentative: true }
        : o,
    ),
  });
  return { start: cycle.windowStart, end: cycle.windowEnd };
}

/**
 * The allocate-page footer and the Home row read one short sentence:
 * "Week 3 of 26 · pick 3 for 16 – 22 Mar · 6 of 72 booked" while the open
 * week has room, "Week 4 of 26 is set · next opens 30 Mar · 9 of 72 booked"
 * once this week and the next are full, "All 72 sessions booked" at the end,
 * and "Plan ended on 31 May" once the plan end has passed with sessions unplaced.
 */
export function subscriptionCycleHeading(
  entitlement: SubscriptionEntitlement,
  opts: { zone?: string; locale?: string } = {},
): string {
  const { nextBatch, windowStart, windowEnd, ordinal, count } =
    entitlement.cycle;
  const { held, total, remaining, rescheduling } = entitlement;
  const booked = `${held} of ${total} booked`;
  const targetBatch = rescheduling > 0 ? rescheduling : nextBatch;
  const lastDay = lastInstantBefore(windowEnd);
  const which = `Week ${ordinal + 1} of ${count}`;
  if (remaining === 0 && targetBatch === 0)
    return `All ${total} sessions booked`;
  if (windowEnd <= windowStart)
    return `Plan ended on ${formatDateLabel(lastDay, opts)} · ${booked}`;
  if (targetBatch === 0)
    return `${which} is set · next opens ${formatDateLabel(windowEnd, opts)} · ${booked}`;
  const window = formatDateRangeLabel(windowStart, lastDay, opts);
  return `${which} · pick ${targetBatch} for ${window} · ${booked}`;
}
