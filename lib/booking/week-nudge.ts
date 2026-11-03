// The consultant's reminder ladder for a plan week that still has sessions to
// place: a bell and an email when the week opens, again at +24 h and +72 h.
// Every week, not only the first; the outbox rows are the dedupe (no column).

import { AppointmentStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  planWeekNumber,
  planWeekStartsAt,
  sessionsTotalOf,
  subscriptionEntitlement,
  lastInstantBefore,
  type SubscriptionEntitlementInput,
} from "@/lib/booking/entitlement";
import {
  EMAIL_BUDGET_MS,
  SUBSCRIPTION_WEEK_NUDGE_EMAIL_TYPE,
  sendUnplacedWeekNudgeEmail,
  unplacedWeekNudgeEntityRef,
} from "@/lib/email";
import { notifyUnplacedWeekNudge } from "@/lib/novu/service";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { deriveTransactionId } from "@/lib/novu/outbox";
import { formatDateRangeLabel } from "@/lib/time/display";
import { getAppUrl } from "@/lib/url";

export const WEEK_NUDGE_HOURS = [0, 24, 72] as const;
export type WeekNudgeStage = (typeof WEEK_NUDGE_HOURS)[number];

export interface WeekNudge {
  weekNumber: number;
  weekCount: number;
  sessionsToPlace: number;
  stage: WeekNudgeStage;
  weekStartsAt: Date;
  weekEndsAt: Date;
}

/**
 * The reminder a plan owes its consultant now, or null. Only the CURRENT plan
 * week counts: a next week opened early (this one full) is the consultant
 * being ahead, never late.
 */
export function weekNudgeFor(
  input: SubscriptionEntitlementInput,
  now: Date,
): WeekNudge | null {
  const entitlement = subscriptionEntitlement({ ...input, now });
  const { nextBatch, ordinal, count, windowEnd } = entitlement.cycle;
  if (nextBatch === 0) return null;
  const currentWeek = planWeekNumber(input, now) - 1;
  if (ordinal !== currentWeek) return null;
  const weekStartsAt = planWeekStartsAt(input, ordinal);
  const openedAt = Math.max(
    weekStartsAt.getTime(),
    new Date(input.schedulingPeriodStartsAt).getTime(),
  );
  const hours = (now.getTime() - openedAt) / 3_600_000;
  let stage: WeekNudgeStage | null = null;
  for (const hour of WEEK_NUDGE_HOURS) if (hours >= hour) stage = hour;
  if (stage === null) return null;
  return {
    weekNumber: ordinal + 1,
    weekCount: count,
    sessionsToPlace: nextBatch,
    stage,
    weekStartsAt,
    weekEndsAt: windowEnd,
  };
}

/** The outbox key for one plan week's stage; the guard and the trigger share it. */
export function weekNudgeDedupeKey(
  subscriptionId: string,
  weekNumber: number,
  stage: WeekNudgeStage,
): string {
  return `subscription-week:${subscriptionId}:w${weekNumber}:h${stage}`;
}

/**
 * Remind the consultants whose plans have an open week with sessions left to
 * place. Plans that were never scheduled are the 48 h cohort's; a plan with a
 * move in flight (a tentative row) waits for it. Reads only, plus the outbox.
 */
export async function nudgeUnplacedPlanWeeks(limits: {
  maxRequests: number;
}): Promise<{ nudged: number; errors: string[] }> {
  const errors: string[] = [];
  const now = new Date();
  try {
    const plans = await prisma.subscription.findMany({
      where: {
        status: AppointmentStatus.APPROVED,
        deletedAt: null,
        OR: [{ planEndsAt: null }, { planEndsAt: { gt: now } }],
        appointment: {
          deletedAt: null,
          occurrences: {
            some: { isTentative: false, deletedAt: null },
            none: { isTentative: true, deletedAt: null },
          },
        },
      },
      select: {
        id: true,
        sessionsTotal: true,
        schedulingPeriodStartsAt: true,
        schedulingTimezone: true,
        planEndsAt: true,
        requestedBy: { select: { user: { select: { name: true } } } },
        subscriptionPlan: {
          select: {
            title: true,
            totalSessions: true,
            sessionsPerWeek: true,
            durationInMonths: true,
            consultantProfile: {
              select: { id: true, user: { select: { id: true } } },
            },
          },
        },
        appointment: {
          select: {
            id: true,
            organizationId: true,
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
      orderBy: { updatedAt: "asc" },
      take: limits.maxRequests,
    });

    const due = plans.flatMap((sub) => {
      const appointment = sub.appointment;
      if (!appointment) return [];
      const plan = sub.subscriptionPlan;
      const nudge = weekNudgeFor(
        {
          sessionsTotal: sessionsTotalOf(sub),
          sessionsPerWeek: plan.sessionsPerWeek,
          durationInMonths: plan.durationInMonths,
          occurrences: appointment.occurrences,
          schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
          schedulingTimezone: sub.schedulingTimezone,
          planEndsAt: sub.planEndsAt,
        },
        now,
      );
      if (!nudge) return [];
      const consultantUserId = plan.consultantProfile.user.id;
      const dedupeKey = weekNudgeDedupeKey(
        sub.id,
        nudge.weekNumber,
        nudge.stage,
      );
      return [
        {
          sub,
          appointment,
          nudge,
          consultantUserId,
          dedupeKey,
          transactionId: deriveTransactionId(
            NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
            [consultantUserId],
            {},
            dedupeKey,
          ),
          entityRef: unplacedWeekNudgeEntityRef(
            sub.id,
            nudge.weekNumber,
            nudge.stage,
          ),
        },
      ];
    });
    if (due.length === 0) return { nudged: 0, errors };

    // Two outboxes, two guards, so one arm's lapse never silences the other.
    const [bellStaged, emailStaged] = await Promise.all([
      prisma.notificationOutbox
        .findMany({
          where: { transactionId: { in: due.map((d) => d.transactionId) } },
          select: { transactionId: true },
        })
        .then((rows) => new Set(rows.map((row) => row.transactionId))),
      prisma.failedEmail
        .findMany({
          where: {
            emailType: SUBSCRIPTION_WEEK_NUDGE_EMAIL_TYPE,
            entityRef: { in: due.map((d) => d.entityRef) },
          },
          select: { entityRef: true },
        })
        .then((rows) => new Set(rows.map((row) => row.entityRef))),
    ]);

    let nudged = 0;
    for (const d of due) {
      const bellDone = bellStaged.has(d.transactionId);
      const emailDone = emailStaged.has(d.entityRef);
      if (bellDone && emailDone) continue;
      try {
        const consulteeName = d.sub.requestedBy.user.name ?? "Your client";
        const planTitle = d.sub.subscriptionPlan.title;
        const zone = d.sub.schedulingTimezone;
        const weekRange = formatDateRangeLabel(
          d.nudge.weekStartsAt,
          lastInstantBefore(d.nudge.weekEndsAt),
          { zone },
        );
        const timingsUrl = `${getAppUrl()}/dashboard/consultant/${d.sub.subscriptionPlan.consultantProfile.id}/appointments/${d.appointment.id}/timings`;
        if (!bellDone) {
          await notifyUnplacedWeekNudge(
            d.consultantUserId,
            {
              ...notificationScope(d.appointment.organizationId),
              consulteeName,
              planTitle,
              appointmentType: "SUBSCRIPTION",
              dashboardUrl: timingsUrl,
              weekNumber: d.nudge.weekNumber,
              weekCount: d.nudge.weekCount,
              sessionsToPlace: d.nudge.sessionsToPlace,
              weekRange,
            },
            d.dedupeKey,
          );
        }
        if (!emailDone) {
          const mailed = await sendUnplacedWeekNudgeEmail(
            {
              subscriptionId: d.sub.id,
              consultantUserId: d.consultantUserId,
              consulteeName,
              planTitle,
              week: {
                number: d.nudge.weekNumber,
                count: d.nudge.weekCount,
                sessions: d.nudge.sessionsToPlace,
                range: weekRange,
              },
              stage: d.nudge.stage,
              timingsUrl,
            },
            EMAIL_BUDGET_MS.JOB,
          );
          if (mailed.failed > 0 && mailed.sent === 0) {
            throw new Error("week nudge email neither sent nor staged");
          }
        }
        nudged += 1;
      } catch (error) {
        errors.push(
          `Week nudge failed for subscription ${d.sub.id} (week ${d.nudge.weekNumber}, hour ${d.nudge.stage}): ${error}`,
        );
      }
    }
    console.log(`✅ Sent ${nudged} plan-week nudges`);
    return { nudged, errors };
  } catch (error) {
    errors.push(`Failed to nudge plan weeks: ${error}`);
    return { nudged: 0, errors };
  }
}
