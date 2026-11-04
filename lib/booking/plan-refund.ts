/**
 * Support partial refunds on a 1:1 plan: k sessions come off the plan along
 * with their share of the price, so the expert never delivers a session whose
 * earnings were already reversed. `Subscription.sessionsRefunded` records them.
 */
import type { Tx } from "@/lib/prisma";
import { soldTermsOf, subscriptionEntitlement } from "@/lib/booking/entitlement";

/** A session count's share of a plan payment, in paise: floor(A × k / T). */
export function sessionShareOf(
  amountPaise: number,
  sessions: number,
  sessionsTotal: number,
): number {
  if (sessionsTotal <= 0 || sessions <= 0) return 0;
  return Math.floor((amountPaise * Math.min(sessions, sessionsTotal)) / sessionsTotal);
}

export interface PlanRefundBasis {
  subscriptionId: string;
  /** Sessions sold at purchase (T in the refund formula). */
  sessionsTotal: number;
  sessionsRefunded: number;
  /** Sessions neither delivered, booked nor already removed. */
  removable: number;
}

/** The plan a payment bought, as a partial refund sees it; null for any other payment. */
export async function planRefundBasis(
  tx: Pick<Tx, "payment">,
  paymentId: string,
): Promise<PlanRefundBasis | null> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      appointment: {
        select: {
          subscription: {
            select: {
              id: true,
              sessionsTotal: true,
              sessionsPerWeek: true,
              sessionsRefunded: true,
              schedulingPeriodStartsAt: true,
              schedulingTimezone: true,
              planEndsAt: true,
              subscriptionPlan: {
                select: {
                  totalSessions: true,
                  sessionsPerWeek: true,
                  durationInMonths: true,
                },
              },
            },
          },
          occurrences: {
            select: {
              startsAt: true,
              endsAt: true,
              completionStatus: true,
              isTentative: true,
              deletedAt: true,
            },
          },
        },
      },
    },
  });
  const sub = payment?.appointment?.subscription;
  if (!sub || !payment?.appointment) return null;
  const terms = soldTermsOf(sub);
  const entitlement = subscriptionEntitlement({
    ...terms,
    occurrences: payment.appointment.occurrences,
    schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
    schedulingTimezone: sub.schedulingTimezone,
    planEndsAt: sub.planEndsAt,
  });
  return {
    subscriptionId: sub.id,
    sessionsTotal: terms.sessionsTotal,
    sessionsRefunded: sub.sessionsRefunded,
    removable: entitlement.remaining,
  };
}

export type PlanSessionsChange =
  | { ok: true; sessionsRefunded: number }
  | { ok: false; reason: "NOT_A_PLAN" | "EXCEEDS_REMOVABLE" | "RACED"; removable: number };

/**
 * Removes `sessions` from the plan behind `paymentId` inside the caller's tx,
 * by CAS on the count it read. A legacy row's entitlement is stamped with it.
 */
export async function removePlanSessions(
  tx: Pick<Tx, "payment" | "subscription">,
  paymentId: string,
  sessions: number,
): Promise<PlanSessionsChange> {
  const basis = await planRefundBasis(tx, paymentId);
  if (!basis) return { ok: false, reason: "NOT_A_PLAN", removable: 0 };
  if (sessions > basis.removable)
    return { ok: false, reason: "EXCEEDS_REMOVABLE", removable: basis.removable };
  const next = basis.sessionsRefunded + sessions;
  const moved = await tx.subscription.updateMany({
    where: { id: basis.subscriptionId, sessionsRefunded: basis.sessionsRefunded },
    data: { sessionsRefunded: next, sessionsTotal: basis.sessionsTotal },
  });
  if (moved.count !== 1)
    return { ok: false, reason: "RACED", removable: basis.removable };
  return { ok: true, sessionsRefunded: next };
}

/** Puts back sessions a withdrawn remedy removed, by CAS on the count it read. */
export async function restorePlanSessions(
  tx: Pick<Tx, "payment" | "subscription">,
  paymentId: string,
  sessions: number,
): Promise<PlanSessionsChange> {
  const basis = await planRefundBasis(tx, paymentId);
  if (!basis) return { ok: false, reason: "NOT_A_PLAN", removable: 0 };
  const next = Math.max(0, basis.sessionsRefunded - sessions);
  const moved = await tx.subscription.updateMany({
    where: { id: basis.subscriptionId, sessionsRefunded: basis.sessionsRefunded },
    data: { sessionsRefunded: next },
  });
  if (moved.count !== 1)
    return { ok: false, reason: "RACED", removable: basis.removable };
  return { ok: true, sessionsRefunded: next };
}
