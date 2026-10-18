// Which prior subscription a renewal may anchor to, and when its cycle ends.

import { PaymentError } from "@/lib/payments/core/types";
import type { Tx } from "@/lib/prisma";
import { AppointmentStatus } from "@prisma/client";

/**
 * #1743 — only an active or completed subscription may be renewed; a PENDING /
 * APPROVED_PENDING_PAYMENT / SCHEDULED request has not run yet and cannot
 * anchor a successor cycle.
 */
export const RENEWABLE_SUBSCRIPTION_STATUSES: ReadonlySet<AppointmentStatus> =
  new Set([AppointmentStatus.APPROVED, AppointmentStatus.COMPLETED]);

export async function resolvePriorRenewalEndsAt(
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
      schedulingPeriodEndsAt: true,
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
  return priorSub.schedulingPeriodEndsAt;
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
      schedulingPeriodEndsAt: true,
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
