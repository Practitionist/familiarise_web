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
import type { SubscriptionLifecycleEmailArgs } from "@/lib/email/senders/booking";
import {
  computeHoldUntil,
  holdHoursFor,
  stampConsultantHolds,
} from "@/lib/payments/payouts/earnings-hold";
import type { Tx } from "@/lib/prisma";

import {
  isCompletedOccurrence,
  planWeekNumber,
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
  tx: {
    consultantEarnings?: Pick<
      Tx["consultantEarnings"],
      "findMany" | "findFirst" | "aggregate" | "updateMany"
    >;
    organizationEarnings?: Pick<Tx["organizationEarnings"], "updateMany">;
  },
  args: { paymentId: string; now: Date },
): Promise<number> {
  const holdUntil = computeHoldUntil({
    capturedAt: args.now,
    lastOccurrenceEndsAt: null,
    holdHours: holdHoursFor("SUBSCRIPTION"),
  });
  const stamped = tx.consultantEarnings
    ? await stampConsultantHolds(
        { consultantEarnings: tx.consultantEarnings },
        {
          paymentId: args.paymentId,
          cycleOrdinal: { not: null },
          holdUntil: null,
          status: { in: [...UNSTAMPED_STATUSES] },
        },
        holdUntil,
      )
    : 0;
  await tx.organizationEarnings?.updateMany?.({
    where: {
      paymentId: args.paymentId,
      holdUntil: null,
      status: { in: [...UNSTAMPED_STATUSES] },
    },
    data: { holdUntil },
  });
  return stamped;
}

export async function settleSubscriptionCycleWithNotice(
  tx: SettleTx & {
    organizationEarnings?: Pick<Tx["organizationEarnings"], "updateMany">;
  },
  args: { appointmentId: string; now: Date },
): Promise<{
  bells: StagedTrigger[];
  emailArgs: SubscriptionLifecycleEmailArgs | null;
}> {
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
          planEndsAt: true,
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
  if (!sub || (sub.status !== "APPROVED" && sub.status !== "SCHEDULED")) {
    return { bells: [], emailArgs: null };
  }

  const entitlement = subscriptionEntitlement({
    sessionsTotal: sessionsTotalOf(sub),
    sessionsPerWeek: sub.subscriptionPlan.sessionsPerWeek,
    durationInMonths: sub.subscriptionPlan.durationInMonths,
    occurrences: wrapper.occurrences,
    schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
    schedulingTimezone: sub.schedulingTimezone,
    planEndsAt: sub.planEndsAt,
    now: args.now,
  });

  // The money half: every tranche up to the highest matured one that is
  // still unstamped starts its hold now, anchored on the last delivered end.
  const tranches = subscriptionTranches(
    sub.subscriptionPlan,
    entitlement.total,
  );
  const matured = maturedTrancheOrdinal(tranches, entitlement.completed);
  if (matured >= 0 && wrapper.payment.length > 0) {
    const lastCompletedEnd = wrapper.occurrences
      .filter((o) => !o.deletedAt && isCompletedOccurrence(o))
      .reduce<Date | null>(
        (max, o) => (!max || o.endsAt > max ? o.endsAt : max),
        null,
      );
    const holdUntil = computeHoldUntil({
      capturedAt: args.now,
      lastOccurrenceEndsAt: lastCompletedEnd,
      holdHours: holdHoursFor("SUBSCRIPTION"),
    });
    await stampConsultantHolds(
      tx,
      {
        paymentId: { in: wrapper.payment.map((p) => p.id) },
        cycleOrdinal: { lte: matured },
        holdUntil: null,
        status: { in: [...UNSTAMPED_STATUSES] },
      },
      holdUntil,
    );
    if (matured >= tranches.count - 1) {
      await tx.organizationEarnings?.updateMany?.({
        where: {
          paymentId: { in: wrapper.payment.map((p) => p.id) },
          holdUntil: null,
          status: { in: [...UNSTAMPED_STATUSES] },
        },
        data: { holdUntil },
      });
    }
  }

  // Nothing live and something owed: the cycle just closed.
  if (entitlement.scheduled !== 0 || entitlement.remaining === 0) {
    return { bells: [], emailArgs: null };
  }

  const consulteeUserId = sub.requestedBy?.userId;
  if (!consulteeUserId) return { bells: [], emailArgs: null };
  // The 1-based plan week the last delivered session sits in: the same key
  // across a second pass over the same state dedupes.
  const lastDelivered = wrapper.occurrences
    .filter((o) => !o.deletedAt && isCompletedOccurrence(o))
    .reduce<Date | null>((latest, o) => {
      const at = new Date(o.startsAt);
      return !latest || at > latest ? at : latest;
    }, null);
  const cycleOrdinal = lastDelivered
    ? planWeekNumber(
        {
          sessionsPerWeek: sub.subscriptionPlan.sessionsPerWeek,
          durationInMonths: sub.subscriptionPlan.durationInMonths,
          schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
          schedulingTimezone: sub.schedulingTimezone,
        },
        lastDelivered,
      )
    : 1;
  const dashboardUrl = notificationHref(wrapper.organizationId, "appointments");
  const consultantName =
    sub.subscriptionPlan.consultantProfile?.user?.name ?? "Your consultant";
  const result = await notifySubscriptionRenewed(
    consulteeUserId,
    {
      subscriptionId: sub.id,
      planTitle: sub.subscriptionPlan.title,
      consultantName,
      cycleOrdinal,
      remainingSessions: entitlement.remaining,
      nextBatch: entitlement.cycle.nextBatch,
      dashboardUrl,
    },
    `sub:${sub.id}:cycle:${cycleOrdinal}`,
    { tx },
  );
  return {
    bells: result.staged ? [result.staged] : [],
    emailArgs: {
      subscriptionId: sub.id,
      userIds: [consulteeUserId],
      kind: "SUBSCRIPTION_RENEWED",
      planTitle: sub.subscriptionPlan.title,
      consultantName,
      cycleOrdinal,
      nextBatch: entitlement.cycle.nextBatch,
      remainingSessions: entitlement.remaining,
      dashboardUrl,
    },
  };
}

export async function settleSubscriptionCycle(
  tx: SettleTx & {
    organizationEarnings?: Pick<Tx["organizationEarnings"], "updateMany">;
  },
  args: { appointmentId: string; now: Date },
): Promise<StagedTrigger[]> {
  const { bells } = await settleSubscriptionCycleWithNotice(tx, args);
  return bells;
}
