/**
 * The subscription quota painted over the availability grid: how much of the
 * current cycle is held, which days already carry the per-day cap, and the
 * footer sentence. Pure and Prisma-free so the client parses and paints it
 * with the same rules the route used.
 */
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";

import { lastInstantBefore } from "@/lib/booking/entitlement";
import type {
  CycleUnit,
  EntitlementOccurrence,
  SubscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { formatDayLabel } from "@/lib/time/display";
import { MAX_SUBSCRIPTION_SESSIONS_PER_DAY } from "@/utils/scheduling-engine/sessionCaps";
import { byCodeUnit } from "@/lib/scheduling/code-unit-order";

export interface GridQuota {
  unit: CycleUnit;
  /** Sessions one plan week holds. */
  capacity: number;
  /** 1-based plan week the window covers, of `weekCount`: "Week 3 of 26". */
  weekNumber: number;
  weekCount: number;
  /** Sessions held in that plan week. */
  filled: number;
  /** Sessions that may still be placed in this cycle (the reschedule batch while one is open). */
  remainingThisCycle: number;
  /** True once every session of the plan is held, so no later cycle opens. */
  allBooked: boolean;
  /** ISO start of the cycle window. */
  windowStart: string;
  /** ISO end of the cycle window, exclusive: a session may end exactly here. */
  windowEnd: string;
  /** ISO fixed plan end, exclusive; incident extensions move it. Nothing is placed at or after it. */
  planEndsAt: string;
  perDayCap: number;
  /** yyyy-MM-dd days in `schedulingTimezone` that already hold `perDayCap` live sessions. */
  fullDays: string[];
  schedulingTimezone: string;
}

export const gridQuotaSchema: z.ZodType<GridQuota> = z.object({
  unit: z.literal("week"),
  capacity: z.number().int().nonnegative(),
  weekNumber: z.number().int().positive(),
  weekCount: z.number().int().positive(),
  filled: z.number().int().nonnegative(),
  remainingThisCycle: z.number().int().nonnegative(),
  allBooked: z.boolean(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  planEndsAt: z.string().datetime(),
  perDayCap: z.number().int().positive(),
  fullDays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  schedulingTimezone: z.string().min(1),
});

/** The yyyy-MM-dd day `instant` falls on in `zone`. */
export function quotaDayKey(instant: Date | number, zone: string): string {
  return formatInTimeZone(instant, zone, "yyyy-MM-dd");
}

/** A session that still occupies its day: not a tombstone, released or cancelled, and not tentative. */
function holdsItsDay(o: EntitlementOccurrence): boolean {
  return (
    !o.deletedAt &&
    !o.isTentative &&
    o.completionStatus !== "CANCELLED" &&
    o.completionStatus !== "RESCHEDULED"
  );
}

export function computeGridQuota(input: {
  entitlement: SubscriptionEntitlement;
  occurrences: EntitlementOccurrence[];
  schedulingTimezone: string;
}): GridQuota {
  const { entitlement, occurrences, schedulingTimezone } = input;
  const { cycle, rescheduling, remaining } = entitlement;
  const perDayCap = MAX_SUBSCRIPTION_SESSIONS_PER_DAY;

  const perDay = new Map<string, number>();
  for (const o of occurrences) {
    if (!holdsItsDay(o)) continue;
    const key = quotaDayKey(new Date(o.startsAt), schedulingTimezone);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const fullDays = [...perDay]
    .filter(([, count]) => count >= perDayCap)
    .map(([key]) => key)
    .sort(byCodeUnit);

  return {
    unit: cycle.unit,
    capacity: cycle.capacity,
    weekNumber: cycle.ordinal + 1,
    weekCount: cycle.count,
    filled: Math.max(0, cycle.filled),
    remainingThisCycle: rescheduling > 0 ? rescheduling : cycle.nextBatch,
    allBooked: remaining === 0 && rescheduling === 0,
    windowStart: cycle.windowStart.toISOString(),
    windowEnd: cycle.windowEnd.toISOString(),
    planEndsAt: entitlement.planEndsAt.toISOString(),
    perDayCap,
    fullDays,
    schedulingTimezone,
  };
}

/**
 * True when a cell [startMs,endMs) must paint "Limit reached": the plan has
 * ended for it, every session of the plan is held, it lies before the open
 * plan week (a full week), the open week is full too, or it falls on a full day.
 */
export function cellLimitReached(
  quota: GridQuota,
  startMs: number,
  endMs: number,
): boolean {
  if (endMs > Date.parse(quota.planEndsAt)) return true;
  if (quota.allBooked) return true;
  const windowStartMs = Date.parse(quota.windowStart);
  const windowEndMs = Date.parse(quota.windowEnd);
  // Before the open plan week: an earlier week that is full (or already past).
  if (endMs <= windowStartMs) return true;
  if (
    quota.remainingThisCycle === 0 &&
    startMs < windowEndMs &&
    endMs > windowStartMs
  ) {
    return true;
  }
  return quota.fullDays.includes(
    quotaDayKey(startMs, quota.schedulingTimezone),
  );
}

/**
 * Footer copy: "Week 3 of 26 · 2 of 3 booked" while the open week has room,
 * "Week 4 of 26 is set · next opens Mon 16 Mar" once this week and the next
 * are both full, "Plan ended on Fri 6 Mar" once it is over.
 */
export function quotaFooterText(
  quota: GridQuota,
  zone: string,
  nowMs: number = Date.now(),
): string {
  const planEndMs = Date.parse(quota.planEndsAt);
  if (nowMs >= planEndMs) {
    return `Plan ended on ${formatDayLabel(lastInstantBefore(new Date(planEndMs)), { zone })}`;
  }
  const which = `Week ${quota.weekNumber} of ${quota.weekCount}`;
  const held = `${which} · ${quota.filled} of ${quota.capacity} booked`;
  if (quota.remainingThisCycle > 0 || quota.allBooked) return held;
  const nextOpensMs = Date.parse(quota.windowEnd);
  if (nextOpensMs >= planEndMs) return `${which} is set`;
  return `${which} is set · next opens ${formatDayLabel(new Date(nextOpensMs), { zone })}`;
}
