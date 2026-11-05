/**
 * Support partial refunds on a 1:1 plan: k sessions come off the plan along
 * with their share of the price, so the expert never delivers a session whose
 * earnings were already reversed. `Subscription.sessionsRefunded` records them.
 */
import type { Tx } from "@/lib/prisma";
import {
  soldTermsOf,
  subscriptionEntitlement,
  subscriptionIsOver,
} from "@/lib/booking/entitlement";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/booking/transitions";

export interface PlanRefundBasis {
  subscriptionId: string;
  /** Sessions sold at purchase (T in the refund formula). */
  sessionsTotal: number;
  sessionsRefunded: number;
  /**
   * Live, before its end and with no owed refund marker: only then can a
   * session-count remedy take sessions off it. A cancelled, ended or settling
   * plan is paid by its own settlement.
   */
  open: boolean;
  /** Not yet completed or cancelled: a void can still give sessions back. */
  live: boolean;
  /** Sessions neither delivered, booked nor already removed; 0 unless open. */
  removable: number;
}

/** The plan a payment bought, as a partial refund sees it; null for any other payment. */
export async function planRefundBasis(
  tx: Pick<Tx, "payment">,
  paymentId: string,
  now = new Date(),
): Promise<PlanRefundBasis | null> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      refundOwedKey: true,
      appointment: {
        select: {
          subscription: {
            select: {
              id: true,
              status: true,
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
  const live = LIVE_SUBSCRIPTION_STATUSES.includes(sub.status);
  const open =
    live && !subscriptionIsOver(sub, now) && payment.refundOwedKey === null;
  const entitlement = subscriptionEntitlement({
    ...terms,
    occurrences: payment.appointment.occurrences,
    schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
    schedulingTimezone: sub.schedulingTimezone,
    planEndsAt: sub.planEndsAt,
    now,
  });
  return {
    subscriptionId: sub.id,
    sessionsTotal: terms.sessionsTotal,
    sessionsRefunded: sub.sessionsRefunded,
    open,
    live,
    removable: open ? entitlement.remaining : 0,
  };
}

export type PlanSessionsChange =
  | { ok: true; sessionsRefunded: number }
  | {
      ok: false;
      reason:
        | "NOT_A_PLAN"
        | "PLAN_CLOSED"
        | "EXCEEDS_REMOVABLE"
        | "NOT_REMOVED"
        | "PLAN_SETTLED"
        | "RACED";
      removable: number;
    };

/**
 * Removes `sessions` from the open plan behind `paymentId` inside the caller's
 * tx, by CAS on the count it read. A legacy row's entitlement is stamped with it.
 */
export async function removePlanSessions(
  tx: Pick<Tx, "payment" | "subscription">,
  paymentId: string,
  sessions: number,
): Promise<PlanSessionsChange> {
  const basis = await planRefundBasis(tx, paymentId);
  if (!basis) return { ok: false, reason: "NOT_A_PLAN", removable: 0 };
  if (!basis.open) return { ok: false, reason: "PLAN_CLOSED", removable: 0 };
  if (sessions > basis.removable)
    return {
      ok: false,
      reason: "EXCEEDS_REMOVABLE",
      removable: basis.removable,
    };
  const next = basis.sessionsRefunded + sessions;
  const moved = await tx.subscription.updateMany({
    where: {
      id: basis.subscriptionId,
      sessionsRefunded: basis.sessionsRefunded,
    },
    data: { sessionsRefunded: next, sessionsTotal: basis.sessionsTotal },
  });
  if (moved.count !== 1)
    return { ok: false, reason: "RACED", removable: basis.removable };
  return { ok: true, sessionsRefunded: next };
}

/**
 * Puts back sessions a withdrawn remedy removed, by CAS on the count it read.
 * A plan that completed or was cancelled settled without those sessions, so
 * their refund is still owed: the void is refused. Fewer removed than asked too.
 */
export async function restorePlanSessions(
  tx: Pick<Tx, "payment" | "subscription">,
  paymentId: string,
  sessions: number,
): Promise<PlanSessionsChange> {
  const basis = await planRefundBasis(tx, paymentId);
  if (!basis) return { ok: false, reason: "NOT_A_PLAN", removable: 0 };
  if (!basis.live)
    return { ok: false, reason: "PLAN_SETTLED", removable: 0 };
  if (basis.sessionsRefunded < sessions)
    return { ok: false, reason: "NOT_REMOVED", removable: basis.removable };
  const next = basis.sessionsRefunded - sessions;
  const moved = await tx.subscription.updateMany({
    where: {
      id: basis.subscriptionId,
      sessionsRefunded: basis.sessionsRefunded,
    },
    data: { sessionsRefunded: next },
  });
  if (moved.count !== 1)
    return { ok: false, reason: "RACED", removable: basis.removable };
  return { ok: true, sessionsRefunded: next };
}
