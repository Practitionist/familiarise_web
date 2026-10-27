/**
 * The subscription quota painted over the availability grid: how much of the
 * current cycle is held, which days already carry the per-day cap, and the
 * footer sentence. Pure and Prisma-free so the client parses and paints it
 * with the same rules the route used.
 */
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";

import type {
  CycleUnit,
  EntitlementOccurrence,
  SubscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { formatDayLabel } from "@/lib/time/display";
import { MAX_SUBSCRIPTION_SESSIONS_PER_DAY } from "@/utils/scheduling-engine/sessionCaps";

export interface GridQuota {
  unit: CycleUnit;
  /** Sessions one cycle holds. */
  capacity: number;
  /** Sessions held against this cycle. */
  filled: number;
  /** Sessions that may still be placed in this cycle (the reschedule batch while one is open). */
  remainingThisCycle: number;
  /** True once every session of the plan is held, so no later cycle opens. */
  allBooked: boolean;
  /** ISO start of the cycle window. */
  windowStart: string;
  /** ISO end of the cycle window, as the entitlement gives it. */
  windowEnd: string;
  perDayCap: number;
  /** yyyy-MM-dd days in `schedulingTimezone` that already hold `perDayCap` live sessions. */
  fullDays: string[];
  schedulingTimezone: string;
}

export const gridQuotaSchema: z.ZodType<GridQuota> = z.object({
  unit: z.enum(["week", "month"]),
  capacity: z.number().int().nonnegative(),
  filled: z.number().int().nonnegative(),
  remainingThisCycle: z.number().int().nonnegative(),
  allBooked: z.boolean(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
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
    .sort();

  return {
    unit: cycle.unit,
    capacity: cycle.capacity,
    filled: Math.max(0, cycle.filled),
    remainingThisCycle: rescheduling > 0 ? rescheduling : cycle.nextBatch,
    allBooked: remaining === 0 && rescheduling === 0,
    windowStart: cycle.windowStart.toISOString(),
    windowEnd: cycle.windowEnd.toISOString(),
    perDayCap,
    fullDays,
    schedulingTimezone,
  };
}

/**
 * True when a cell [startMs,endMs) must paint "Limit reached": every session
 * of the plan is held, or the cell is inside a full cycle's window, or on a
 * full day.
 */
export function cellLimitReached(
  quota: GridQuota,
  startMs: number,
  endMs: number,
): boolean {
  if (quota.allBooked) return true;
  const windowStartMs = Date.parse(quota.windowStart);
  const windowEndMs = Date.parse(quota.windowEnd);
  if (
    quota.remainingThisCycle === 0 &&
    startMs <= windowEndMs &&
    endMs > windowStartMs
  ) {
    return true;
  }
  return quota.fullDays.includes(
    quotaDayKey(startMs, quota.schedulingTimezone),
  );
}

/** Footer copy, e.g. "2 of 3 this week · next opens Sun 8 Mar" (when full) / "2 of 3 this week" (room left). */
export function quotaFooterText(quota: GridQuota, zone: string): string {
  const held = `${quota.filled} of ${quota.capacity} this ${quota.unit}`;
  if (quota.remainingThisCycle > 0 || quota.allBooked) return held;
  // The entitlement's window ends one millisecond before the next cycle starts.
  const nextOpens = new Date(Date.parse(quota.windowEnd) + 1);
  return `${held} · next opens ${formatDayLabel(nextOpens, { zone })}`;
}
