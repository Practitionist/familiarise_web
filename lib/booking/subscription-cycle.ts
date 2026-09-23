/**
 * #1766 — what the completion path settles for a subscription.
 *
 * Two things, in the transaction that moved the occurrence (Stream webhook
 * or the auto-complete sweep). First the money: every earnings tranche whose
 * cycle is now delivered in full gets its hold stamped, so the escrow the
 * accrual opened (`holdUntil` NULL) starts running only once the sessions it
 * pays for have happened. Then the consultee's "your cycle is done" bell,
 * staged when the last live occurrence completes with entitlement left; the
 * caller attempts the staged row after commit (ADR 27).
 */
import { notifySubscriptionRenewed } from "@/lib/novu/service";
import type { StagedTrigger, TriggerOptions } from "@/lib/novu";
import { notificationHref } from "@/lib/novu/resolve-href";
import {
  computeHoldUntil,
  holdHoursFor,
} from "@/lib/payments/payouts/earnings-hold";
import type { Tx } from "@/lib/prisma";

import {
  isCompletedOccurrence,
  maturedTrancheOrdinal,
  sessionsTotalOf,
  subscriptionEntitlement,
  subscriptionTranches,
} from "./entitlement";

type SettleTx = Pick<Tx, "appointment" | "consultantEarnings"> &
  NonNullable<TriggerOptions["tx"]>;

/** Tranches the accrual parked and nothing has stamped yet. */
const UNSTAMPED_STATUSES = ["PENDING", "PENDING_TRUST"] as const;

/**
 * Terminal stamp on cancellation: whatever tranche value the refund leaves
 * behind (a half-delivered cycle, the kept share of a late cancel) must still
 * reach the consultant, and no further completion will ever stamp it. The
 * refund cascade that follows caps each row at share − refunded, so stamping
 * first changes nothing about what it claws back.
 */
export async function stampTranchesOnCancel(
  tx: Pick<Tx, "consultantEarnings">,
  args: { paymentId: string; now: Date },
): Promise<number> {
  const { count } = await tx.consultantEarnings.updateMany({
    where: {
      paymentId: args.paymentId,
      cycleOrdinal: { not: null },
      holdUntil: null,
      status: { in: [...UNSTAMPED_STATUSES] },
    },
    data: {
      holdUntil: computeHoldUntil({
        capturedAt: args.now,
        lastOccurrenceEndsAt: null,
        holdHours: holdHoursFor("SUBSCRIPTION"),
      }),
    },
  });
  return count;
}

export async function settleSubscriptionCycle(
  tx: SettleTx,
  args: { appointmentId: string; now: Date },
): Promise<StagedTrigger[]> {
  // One read, sequential by construction (PG_POOL_MAX=1): the wrapper, its
  // subscription with plan and both parties, and every occurrence row.
  const wrapper = await tx.appointment.findUnique({
    where: { id: args.appointmentId },
    select: {
      organizationId: true,
      payment: {
        where: { paymentStatus: "SUCCEEDED", deletedAt: null },
        select: { id: true },
      },
      subscription: {
        select: {
          id: true,
          status: true,
          sessionsTotal: true,
          schedulingPeriodStartsAt: true,
          schedulingTimezone: true,
          requestedBy: { select: { userId: true } },
          subscriptionPlan: {
            select: {
              title: true,
              totalSessions: true,
              sessionsPerWeek: true,
              durationInMonths: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
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
  });
  const sub = wrapper?.subscription;
  if (!sub || sub.status !== "APPROVED") return [];

  const entitlement = subscriptionEntitlement({
    sessionsTotal: sessionsTotalOf(sub),
    sessionsPerWeek: sub.subscriptionPlan.sessionsPerWeek,
    durationInMonths: sub.subscriptionPlan.durationInMonths,
    occurrences: wrapper.occurrences,
    schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
    schedulingTimezone: sub.schedulingTimezone,
    now: args.now,
  });

  // The money half: every tranche up to the highest matured one that is
  // still unstamped starts its hold now, anchored on the last delivered end.
  const matured = maturedTrancheOrdinal(
    subscriptionTranches(sub.subscriptionPlan, entitlement.total),
    entitlement.completed,
  );
  if (matured >= 0 && wrapper.payment.length > 0) {
    const lastCompletedEnd = wrapper.occurrences
      .filter((o) => !o.deletedAt && isCompletedOccurrence(o))
      .reduce<Date | null>(
        (max, o) => (!max || o.endsAt > max ? o.endsAt : max),
        null,
      );
    await tx.consultantEarnings.updateMany({
      where: {
        paymentId: { in: wrapper.payment.map((p) => p.id) },
        cycleOrdinal: { lte: matured },
        holdUntil: null,
        status: { in: [...UNSTAMPED_STATUSES] },
      },
      data: {
        holdUntil: computeHoldUntil({
          capturedAt: args.now,
          lastOccurrenceEndsAt: lastCompletedEnd,
          holdHours: holdHoursFor("SUBSCRIPTION"),
        }),
      },
    });
  }

  // Nothing live and something owed: the cycle just closed.
  if (entitlement.scheduled !== 0 || entitlement.remaining === 0) return [];

  const consulteeUserId = sub.requestedBy?.userId;
  if (!consulteeUserId) return [];
  // 1-based number of the cycle the delivered sessions belong to: at a
  // boundary the zero-based ordinal has already advanced, so it IS that
  // number; mid-cycle (a cancelled row) the current cycle is ordinal + 1.
  // The same key across a second pass over the same state dedupes.
  const { ordinal, filled } = entitlement.cycle;
  const cycleOrdinal = Math.max(1, ordinal + (filled > 0 ? 1 : 0));
  const result = await notifySubscriptionRenewed(
    consulteeUserId,
    {
      subscriptionId: sub.id,
      planTitle: sub.subscriptionPlan.title,
      consultantName:
        sub.subscriptionPlan.consultantProfile?.user?.name ?? "Your consultant",
      cycleOrdinal,
      remainingSessions: entitlement.remaining,
      nextBatch: entitlement.cycle.nextBatch,
      dashboardUrl: notificationHref(wrapper.organizationId, "appointments"),
    },
    `sub:${sub.id}:cycle:${cycleOrdinal}`,
    { tx },
  );
  return result.staged ? [result.staged] : [];
}
