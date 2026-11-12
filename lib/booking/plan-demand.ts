/**
 * What an expert's sold 1:1 plans already ask of their week, and how many
 * people hold one. Checkout reads both under the expert's `request-cap:` key,
 * so two buyers never pass on the same room.
 *
 * A plan counts while it holds its buyer: a live status, and not a checkout
 * hold whose payment lapsed (`buildDeadHoldFilter`, the occupancy twin), so an
 * abandoned checkout stops counting the moment its hold expires.
 */

import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import {
  soldSessionMinutes,
  soldTermsOf,
  subscriptionEntitlement,
  subscriptionPlanEnd,
} from "@/lib/booking/entitlement";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/booking/transitions";
import { buildDeadHoldFilter } from "@/utils/scheduling-engine/occupancyPolicy";

/** The expert's plans that hold a buyer at `now`: paid, or a checkout hold still open. */
export function heldPlanWhere(
  consultantProfileId: string,
  now: Date,
): Prisma.SubscriptionWhereInput {
  return {
    deletedAt: null,
    status: { in: LIVE_SUBSCRIPTION_STATUSES },
    subscriptionPlan: { consultantProfileId },
    NOT: { appointment: buildDeadHoldFilter(now) },
  };
}

/**
 * Minutes of sold sessions not yet placed, per assessed week: for each held
 * plan whose window overlaps the week, its frozen weekly cadence less the
 * sessions it already holds there, never more than its unplaced entitlement.
 * Placed sessions are busy time already, so they are not counted again here.
 */
export async function readUnplacedPlanMinutes(
  db: Pick<Tx, "subscription">,
  params: {
    consultantProfileId: string;
    /** Week boundaries, `weeks + 1` instants. */
    weekStarts: readonly number[];
    excludeSubscriptionIds: readonly string[];
    now: Date;
  },
): Promise<number[]> {
  const { weekStarts, now } = params;
  const reserved = new Array<number>(weekStarts.length - 1).fill(0);
  if (reserved.length === 0) return reserved;
  const rows = await db.subscription.findMany({
    where: {
      ...heldPlanWhere(params.consultantProfileId, now),
      id: { notIn: [...params.excludeSubscriptionIds] },
      schedulingPeriodStartsAt: { lt: new Date(weekStarts[reserved.length]) },
      OR: [
        { planEndsAt: null },
        { planEndsAt: { gt: new Date(weekStarts[0]) } },
      ],
    },
    select: {
      schedulingPeriodStartsAt: true,
      schedulingTimezone: true,
      planEndsAt: true,
      sessionsTotal: true,
      sessionsPerWeek: true,
      sessionMinutes: true,
      sessionsRefunded: true,
      subscriptionPlan: {
        select: {
          totalSessions: true,
          sessionsPerWeek: true,
          durationInMonths: true,
          sessionDurationInHours: true,
        },
      },
      appointment: {
        select: {
          occurrences: {
            select: {
              startsAt: true,
              endsAt: true,
              completionStatus: true,
              isTentative: true,
              deletedAt: true,
              hostCancelledAt: true,
            },
          },
        },
      },
    },
  });

  for (const row of rows) {
    const occurrences = row.appointment?.occurrences ?? [];
    const terms = soldTermsOf(row);
    const planStartMs = row.schedulingPeriodStartsAt.getTime();
    const planEndMs = subscriptionPlanEnd(row).getTime();
    let unplaced = subscriptionEntitlement({
      ...terms,
      occurrences,
      schedulingPeriodStartsAt: row.schedulingPeriodStartsAt,
      schedulingTimezone: row.schedulingTimezone,
      planEndsAt: row.planEndsAt,
      now,
    }).remaining;
    const minutes = soldSessionMinutes(row);
    for (let week = 0; week < reserved.length && unplaced > 0; week += 1) {
      const from = weekStarts[week];
      const to = weekStarts[week + 1];
      if (planStartMs >= to || planEndMs <= from) continue;
      // The same rows readFeasibilitySpans counts as busy (OCCUPYING_OCCURRENCE_WHERE).
      const placed = occurrences.filter(
        (o) =>
          !o.deletedAt &&
          !o.hostCancelledAt &&
          o.completionStatus !== "CANCELLED" &&
          o.startsAt.getTime() >= from &&
          o.startsAt.getTime() < to,
      ).length;
      const owed = Math.min(
        Math.max(0, terms.sessionsPerWeek - placed),
        unplaced,
      );
      reserved[week] += owed * minutes;
      unplaced -= owed;
    }
  }
  return reserved;
}

/** Distinct buyers holding one of this expert's plans at `now`. */
export async function activePlanClientIds(
  db: Pick<Tx, "subscription">,
  consultantProfileId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db.subscription.findMany({
    where: heldPlanWhere(consultantProfileId, now),
    distinct: ["requestedById"],
    select: { requestedById: true },
  });
  return rows.map((row) => row.requestedById);
}

/** The storefront's "Fully booked" flag; the limit itself never leaves the server. */
export async function planClientsFull(
  db: Pick<Tx, "consultantProfile" | "subscription">,
  consultantProfileId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const profile = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: { maxActivePlanClients: true },
  });
  const limit = profile?.maxActivePlanClients ?? null;
  if (limit === null) return false;
  const clients = await activePlanClientIds(db, consultantProfileId, now);
  return clients.length >= limit;
}

/**
 * Refuses a new plan client once the expert's limit is reached. A buyer who
 * already holds a plan with this expert (a renewal, a second plan) is not a
 * new client, and lowering the limit never touches plans already sold.
 */
export async function assertPlanClientRoom(
  tx: Pick<Tx, "consultantProfile" | "subscription">,
  params: {
    consultantProfileId: string;
    consulteeProfileId: string;
    now?: Date;
  },
): Promise<void> {
  const profile = await tx.consultantProfile.findUnique({
    where: { id: params.consultantProfileId },
    select: { maxActivePlanClients: true },
  });
  const limit = profile?.maxActivePlanClients ?? null;
  if (limit === null) return;
  const clients = await activePlanClientIds(
    tx,
    params.consultantProfileId,
    params.now,
  );
  if (clients.includes(params.consulteeProfileId)) return;
  if (clients.length >= limit) {
    throw new BookingRuleError(
      "PLAN_CLIENTS_FULL",
      "This expert's mentorship plans are fully booked right now. Pick another expert, or try again later. You have not been charged.",
    );
  }
}
