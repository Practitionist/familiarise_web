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
  soldTermsOf,
  subscriptionEntitlement,
  subscriptionTranches,
  type EntitlementOccurrence,
  type SoldTermsShape,
} from "./entitlement";

type SettleTx = Pick<Tx, "appointment" | "consultantEarnings"> &
  NonNullable<TriggerOptions["tx"]>;

/** Tranches the accrual parked and nothing has stamped yet. */
const UNSTAMPED_STATUSES = ["PENDING", "PENDING_TRUST"] as const;
/** A held tranche is stamped too: its hold keeps it HELD, and its release then finds a date to wait for. */
const UNSTAMPED = {
  OR: [
    { status: { in: [...UNSTAMPED_STATUSES] } },
    { status: "HELD" as const, preHoldStatus: { in: [...UNSTAMPED_STATUSES] } },
  ],
};

type DeliverySub = SoldTermsShape & {
  schedulingPeriodStartsAt: Date;
  schedulingTimezone: string;
  planEndsAt: Date | null;
};

/**
 * The plan's tranches as sold and the highest one its delivered sessions have
 * matured (-1 for none). Once every session the buyer kept is delivered, every
 * tranche has matured, including one a session-count refund cut short.
 */
function deliveredTranches(
  sub: DeliverySub,
  occurrences: EntitlementOccurrence[],
  now: Date,
) {
  const terms = soldTermsOf(sub);
  const entitlement = subscriptionEntitlement({
    ...terms,
    occurrences,
    schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
    schedulingTimezone: sub.schedulingTimezone,
    planEndsAt: sub.planEndsAt,
    now,
  });
  const tranches = subscriptionTranches(terms, terms.sessionsTotal);
  const matured =
    entitlement.total > 0 && entitlement.completed >= entitlement.total
      ? tranches.count - 1
      : maturedTrancheOrdinal(tranches, entitlement.completed);
  return { terms, entitlement, tranches, matured };
}

/**
 * A live plan's tranche keeps its stamp only while its cycle is delivered.
 * Called in the transaction that voided a delivered session: every unreleased
 * tranche above the matured ordinal returns to unstamped, for the next
 * completion to stamp. A READY, BATCHED or PAID tranche is left alone.
 */
export async function unstampUndeliveredTranches(
  tx: Pick<Tx, "appointment" | "consultantEarnings">,
  args: { appointmentId: string; now: Date },
): Promise<number> {
  const wrapper = await tx.appointment.findUnique({
    where: { id: args.appointmentId },
    select: {
      payment: {
        where: { paymentStatus: "SUCCEEDED", deletedAt: null },
        select: { id: true },
      },
      subscription: {
        select: {
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
  });
  if (
    wrapper?.subscription?.status !== "APPROVED" ||
    wrapper.payment.length === 0
  ) {
    return 0;
  }
  const { matured } = deliveredTranches(
    wrapper.subscription,
    wrapper.occurrences,
    args.now,
  );
  const { count } = await tx.consultantEarnings.updateMany({
    where: {
      paymentId: { in: wrapper.payment.map((p) => p.id) },
      cycleOrdinal: { gt: matured },
      holdUntil: { not: null },
      ...UNSTAMPED,
    },
    data: { holdUntil: null },
  });
  return count;
}

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
          ...UNSTAMPED,
        },
        holdUntil,
      )
    : 0;
  await tx.organizationEarnings?.updateMany?.({
    where: {
      paymentId: args.paymentId,
      holdUntil: null,
      ...UNSTAMPED,
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
          sessionsPerWeek: true,
          sessionsRefunded: true,
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
  if (wrapper?.subscription?.status !== "APPROVED") {
    return { bells: [], emailArgs: null };
  }
  const sub = wrapper.subscription;

  // The money half: every tranche up to the highest matured one that is
  // still unstamped starts its hold now, anchored on the last delivered end.
  // Tranches follow the sessions sold, as they were minted at capture.
  const { terms, entitlement, tranches, matured } = deliveredTranches(
    sub,
    wrapper.occurrences,
    args.now,
  );
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
        ...UNSTAMPED,
      },
      holdUntil,
    );
    if (matured >= tranches.count - 1) {
      await tx.organizationEarnings?.updateMany?.({
        where: {
          paymentId: { in: wrapper.payment.map((p) => p.id) },
          holdUntil: null,
          ...UNSTAMPED,
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
          sessionsPerWeek: terms.sessionsPerWeek,
          durationInMonths: terms.durationInMonths,
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
