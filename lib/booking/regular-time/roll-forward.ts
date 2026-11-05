/**
 * The hourly roll-forward: every live 1:1 plan with a Regular time has its
 * next four plan weeks filled at the projected times, a bounded batch per run
 * in fair rotation (least recently rolled first). A slot already holding a
 * session is skipped, so a duplicate or overlapping run never double-places;
 * the per-host EXCLUDE constraint backs that up.
 */
import { formatInTimeZone } from "date-fns-tz";
import type { Prisma } from "@prisma/client";
import prisma, { type PrismaLike } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import {
  subscriptionEntitlement,
  soldTermsOf,
} from "@/lib/booking/entitlement";
import { conflictCount } from "@/lib/booking/regular-time/conflicts";
import {
  LIVE_PLAN_STATUSES,
  REGULAR_TIME_PLAN_SELECT,
  placeRegularWeeks,
  readRegularTimeView,
  strikeUnresolvedHoursChanged,
} from "@/lib/booking/regular-time/service";
import {
  nudgeRegularTimeConflicts,
  type RegularConflictPlan,
} from "@/lib/booking/week-nudge";
import { getAppUrl } from "@/lib/url";

/** Plans rolled per run. */
export const ROLL_FORWARD_BATCH = 25;

export interface RollForwardResult {
  scanned: number;
  placed: number;
  conflicts: number;
  /** Sessions struck as the consultant's miss (HOURS_CHANGED unresolved at start). */
  misses: number;
  errors: number;
  hasMore: boolean;
}

/** Live plans the roll-forward fills: running, not paused, with a live Regular time, nothing moving. */
export function rollablePlanWhere(now: Date): Prisma.SubscriptionWhereInput {
  return {
    status: { in: LIVE_PLAN_STATUSES },
    deletedAt: null,
    rollPausedAt: null,
    OR: [{ planEndsAt: null }, { planEndsAt: { gt: now } }],
    regularTimes: { some: { validUntil: null } },
    appointment: {
      deletedAt: null,
      occurrences: { none: { isTentative: true, deletedAt: null } },
    },
  };
}

/** The ticker's idle probe: the claim query's own predicate, admitted by the deadline. */
export async function hasRollForwardWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.subscription.findFirst({
    where: rollablePlanWhere(now),
    select: { id: true },
  });
  return row !== null;
}

export async function rollForwardRegularTime(
  options: { limit?: number; now?: Date } = {},
): Promise<RollForwardResult> {
  return withCronLock(
    "roll-forward-regular-time",
    { failMode: "closed" },
    async () => {
      const failures = createRunFailureReporter("booking");
      try {
        return await rollForwardUnlocked(options, failures);
      } finally {
        failures.flush();
      }
    },
  );
}

async function rollForwardUnlocked(
  options: { limit?: number; now?: Date },
  failures: ReturnType<typeof createRunFailureReporter>,
): Promise<RollForwardResult> {
  const now = options.now ?? new Date();
  const outOfTime = startDeadline();
  const limit = Math.max(
    1,
    Math.min(options.limit ?? ROLL_FORWARD_BATCH, ROLL_FORWARD_BATCH),
  );
  const rows = await prisma.subscription.findMany({
    where: rollablePlanWhere(now),
    orderBy: [{ lastRolledAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: limit + 1,
    select: { id: true, lastRolledAt: true },
  });
  const batch = rows.slice(0, limit);
  const result: RollForwardResult = {
    scanned: 0,
    placed: 0,
    conflicts: 0,
    misses: 0,
    errors: 0,
    hasMore: rows.length > limit,
  };
  const toNudge = new Map<
    string,
    { userId: string; zone: string; plans: RegularConflictPlan[] }
  >();

  for (const row of batch) {
    if (outOfTime()) {
      result.hasMore = true;
      break;
    }
    result.scanned += 1;
    try {
      const plan = await prisma.subscription.findUnique({
        where: { id: row.id },
        select: REGULAR_TIME_PLAN_SELECT,
      });
      if (!plan) continue;
      const entitlement = subscriptionEntitlement({
        ...soldTermsOf(plan),
        occurrences: plan.appointment?.occurrences ?? [],
        schedulingPeriodStartsAt: plan.schedulingPeriodStartsAt,
        schedulingTimezone: plan.schedulingTimezone,
        planEndsAt: plan.planEndsAt,
        hasRegularTime: true,
        now,
      });
      const placed = await placeRegularWeeks(
        plan,
        entitlement.horizon.map((w) => w.weekIndex),
        { now, deadline: outOfTime },
      );
      result.placed += placed.placed;
      // The rotation stamp: a concurrent run that already stamped it wins.
      await prisma.subscription.updateMany({
        where: { id: row.id, lastRolledAt: row.lastRolledAt },
        data: { lastRolledAt: now },
      });

      const fresh = await prisma.subscription.findUnique({
        where: { id: row.id },
        select: REGULAR_TIME_PLAN_SELECT,
      });
      if (!fresh) continue;
      result.misses += await strikeUnresolvedHoursChanged(fresh, now);
      const view = await readRegularTimeView(fresh, now);
      const toFix = conflictCount(view.weeks);
      result.conflicts += toFix;
      if (toFix > 0) {
        const consultant = fresh.subscriptionPlan.consultantProfile;
        const entry = toNudge.get(
          fresh.subscriptionPlan.consultantProfileId,
        ) ?? {
          userId: consultant.user.id,
          zone: consultant.user.timezone ?? fresh.schedulingTimezone,
          plans: [],
        };
        entry.plans.push({
          consulteeName: fresh.requestedBy.user.name ?? "Your client",
          planTitle: fresh.subscriptionPlan.title,
          toFix,
          url: `${getAppUrl()}/dashboard/consultant/${fresh.subscriptionPlan.consultantProfileId}/requests/${encodeURIComponent(fresh.id)}/allocate?type=subscription`,
        });
        toNudge.set(fresh.subscriptionPlan.consultantProfileId, entry);
      }
    } catch (error) {
      result.errors += 1;
      failures.add("roll-forward-regular-time.plan", error, {
        subscriptionId: row.id,
      });
    }
  }

  const nudged = await nudgeRegularTimeConflicts(
    [...toNudge].map(([consultantProfileId, c]) => ({
      consultantProfileId,
      ...c,
      localDay: formatInTimeZone(now, c.zone, "yyyy-MM-dd"),
    })),
    now,
  );
  for (const error of nudged.errors) {
    result.errors += 1;
    failures.add("roll-forward-regular-time.nudge", error);
  }
  return result;
}
