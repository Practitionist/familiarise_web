/**
 * #1766 — the consultee's "your cycle is done" bell.
 *
 * Staged from the completion path (Stream webhook or the auto-complete
 * sweep) when the last live occurrence of a subscription completes with
 * entitlement left: the consultant's Home row appears at read time; this is
 * the consultee's half. No job — the caller runs it inside the transaction
 * that moved the occurrence and attempts the staged row after commit (ADR 27).
 */
import { notifySubscriptionRenewed } from "@/lib/novu/service";
import type { StagedTrigger, TriggerOptions } from "@/lib/novu";
import { notificationHref } from "@/lib/novu/resolve-href";
import type { Tx } from "@/lib/prisma";

import { sessionsTotalOf, subscriptionEntitlement } from "./entitlement";

type SettleTx = Pick<Tx, "appointment"> & NonNullable<TriggerOptions["tx"]>;

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
  if (!wrapper || !sub || sub.status !== "APPROVED") return [];

  const entitlement = subscriptionEntitlement({
    sessionsTotal: sessionsTotalOf(sub),
    sessionsPerWeek: sub.subscriptionPlan.sessionsPerWeek,
    durationInMonths: sub.subscriptionPlan.durationInMonths,
    occurrences: wrapper.occurrences,
    schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
    schedulingTimezone: sub.schedulingTimezone,
    now: args.now,
  });
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
