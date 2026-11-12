// Which prior subscription a renewal may anchor to, and when a plan starts.

import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import {
  firstCycleWindow,
  subscriptionPlanEnd,
  type EntitlementPlanShape,
} from "@/lib/booking/entitlement";
import { PaymentError } from "@/lib/payments/core/types";
import type { Tx } from "@/lib/prisma";
import { AppointmentStatus, type Prisma } from "@prisma/client";

const DAY_MS = 86_400_000;
/** How far ahead a buyer may start a plan. */
export const PLAN_START_HORIZON_DAYS = 90;

const PLAN_END_SELECT = {
  planEndsAt: true,
  schedulingPeriodStartsAt: true,
  schedulingTimezone: true,
  subscriptionPlan: { select: { durationInMonths: true } },
} satisfies Prisma.SubscriptionSelect;

/**
 * The plan's start: the buyer's pick (any time today up to the horizon),
 * never before now, and for a renewal never before the prior plan's end.
 * A pick more than a day old or past the horizon is refused.
 */
export function resolvePlanStart(
  requestedStart: string | undefined,
  priorPlanEnd: Date | null,
  now: Date,
): Date {
  const requested = requestedStart ? new Date(requestedStart) : now;
  if (
    Number.isNaN(requested.getTime()) ||
    requested.getTime() < now.getTime() - DAY_MS ||
    requested.getTime() > now.getTime() + PLAN_START_HORIZON_DAYS * DAY_MS
  ) {
    throw new BookingRuleError(
      "INVALID_PLAN_START",
      `Pick a start date between today and ${PLAN_START_HORIZON_DAYS} days from now.`,
      400,
    );
  }
  return new Date(
    Math.max(requested.getTime(), now.getTime(), priorPlanEnd?.getTime() ?? 0),
  );
}

/**
 * #1743 — only an active or completed subscription may be renewed; a PENDING /
 * APPROVED_PENDING_PAYMENT / SCHEDULED request has not run yet and cannot
 * anchor a successor cycle.
 */
export const RENEWABLE_SUBSCRIPTION_STATUSES: ReadonlySet<AppointmentStatus> =
  new Set([AppointmentStatus.APPROVED, AppointmentStatus.COMPLETED]);

/** The renewable prior plan's end, or null when there is none to anchor to. */
export async function resolvePriorPlanEnd(
  tx: Tx,
  renewsSubscriptionId: string | undefined,
  consulteeProfileId: string,
  planId: string,
): Promise<Date | null> {
  if (
    !renewsSubscriptionId ||
    typeof tx.subscription?.findUnique !== "function"
  ) {
    return null;
  }
  const priorSub = await tx.subscription.findUnique({
    where: { id: renewsSubscriptionId },
    select: {
      ...PLAN_END_SELECT,
      status: true,
      deletedAt: true,
      requestedById: true,
      subscriptionPlanId: true,
    },
  });
  if (
    !priorSub ||
    priorSub?.deletedAt !== null ||
    priorSub.requestedById !== consulteeProfileId ||
    priorSub.subscriptionPlanId !== planId ||
    !RENEWABLE_SUBSCRIPTION_STATUSES.has(priorSub.status)
  ) {
    return null;
  }
  return subscriptionPlanEnd(priorSub);
}

export async function resolvePriorSubscriptionForRenewal(
  tx: Tx,
  renewsSubscriptionId: string | undefined,
  consulteeProfileId: string,
  planId: string,
) {
  if (!renewsSubscriptionId) return null;

  const priorSubscription = await tx.subscription.findUnique({
    where: { id: renewsSubscriptionId },
    select: {
      id: true,
      subscriptionPlanId: true,
      requestedById: true,
      status: true,
      ...PLAN_END_SELECT,
      deletedAt: true,
      renewal: {
        select: { id: true, status: true, deletedAt: true },
      },
    },
  });

  if (
    !priorSubscription ||
    priorSubscription?.deletedAt !== null ||
    priorSubscription.requestedById !== consulteeProfileId ||
    priorSubscription.subscriptionPlanId !== planId ||
    !RENEWABLE_SUBSCRIPTION_STATUSES.has(priorSubscription.status)
  ) {
    throw Object.assign(
      new Error(
        "The subscription being renewed was not found or cannot be renewed.",
      ),
      { httpStatus: 400, code: "INVALID_RENEWAL_SOURCE" },
    );
  }

  if (priorSubscription.renewal) {
    const child = priorSubscription.renewal;
    const isChildDead =
      child?.deletedAt !== null ||
      child.status === AppointmentStatus.CANCELLED ||
      child.status === AppointmentStatus.REJECTED ||
      child.status === AppointmentStatus.EXPIRED;
    if (!isChildDead) {
      throw Object.assign(
        new Error("This subscription has already been renewed."),
        { httpStatus: 409, code: "ALREADY_RENEWED" },
      );
    }
    // Clear unique FK on a dead/cancelled renewal attempt via CAS so a
    // concurrent reactivation cannot lose its renewedFromSubscriptionId link.
    const cleared = await tx.subscription.updateMany({
      where: {
        id: child.id,
        OR: [
          { deletedAt: { not: null } },
          {
            status: {
              in: [
                AppointmentStatus.CANCELLED,
                AppointmentStatus.REJECTED,
                AppointmentStatus.EXPIRED,
              ],
            },
          },
        ],
      },
      data: { renewedFromSubscriptionId: null },
    });
    if (cleared.count !== 1) {
      throw Object.assign(
        new PaymentError(
          "This subscription has already been renewed.",
          "ALREADY_RENEWED",
        ),
        { httpStatus: 409 },
      );
    }
  }

  return priorSubscription;
}

/**
 * The first cycle a subscription checkout books, in the expert's zone, or null
 * when the request names neither a start nor a plan it renews.
 */
export async function resolveSubscriptionCheckoutPeriod(
  tx: Tx,
  input: {
    schedulingPeriodStartsAt: string | undefined;
    renewsSubscriptionId: string | undefined;
    consulteeProfileId: string;
    plan: EntitlementPlanShape & { id: string };
    schedulingTimezone: string;
    now?: Date;
  },
): Promise<{ startsAt: Date; endsAt: Date } | null> {
  if (!input.schedulingPeriodStartsAt && !input.renewsSubscriptionId) {
    return null;
  }
  const priorPlanEnd = await resolvePriorPlanEnd(
    tx,
    input.renewsSubscriptionId,
    input.consulteeProfileId,
    input.plan.id,
  );
  const effectiveStart = resolvePlanStart(
    input.schedulingPeriodStartsAt,
    priorPlanEnd,
    input.now ?? new Date(),
  );
  const { start, end } = firstCycleWindow(
    input.plan,
    effectiveStart,
    input.schedulingTimezone,
  );
  return { startsAt: start, endsAt: end };
}
