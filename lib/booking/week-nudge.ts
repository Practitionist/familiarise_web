// The consultant's reminder ladder for plan weeks that still have sessions to
// place. Daytime only: the ladder starts at 09:00 on the week's first day in
// the consultant's zone, runs on that day, the next and the third (+0/+1/+3
// days), and anything due outside 08:00–21:00 local (or inside the
// consultant's quiet hours) waits for the next run. One bell and one email
// per consultant per local day list every plan due; the outbox rows dedupe.

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { AppointmentStatus, type Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  lastInstantBefore,
  planWeekNumber,
  planWeekStartsAt,
  sessionsTotalOf,
  subscriptionEntitlement,
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
import { computeQuietHoursNotBefore } from "@/lib/novu/quiet-hours";
import { formatDateRangeLabel } from "@/lib/time/display";
import { getAppUrl } from "@/lib/url";

/** Days after the week's first morning on which the consultant is reminded. */
export const WEEK_NUDGE_DAYS = [0, 1, 3] as const;
/** The ladder's first reminder, local time on the week's first day. */
const LADDER_START_HOUR = 9;
/** Reminders go out only inside these local hours [start, end). */
export const WAKING_HOURS = { start: 8, end: 21 } as const;
/** Plans read per page and pages per run (keyset over id, a fair rotation). */
const NUDGE_PAGE = 200;
const NUDGE_PAGES = 5;

export interface WeekNudge {
  weekNumber: number;
  weekCount: number;
  sessionsToPlace: number;
  weekStartsAt: Date;
  weekEndsAt: Date;
}

const localHour = (instant: Date, zone: string) =>
  Number(formatInTimeZone(instant, zone, "H"));

/** Whether `now` is inside the waking hours of `zone`. */
export function inWakingHours(now: Date, zone: string): boolean {
  const hour = localHour(now, zone);
  return hour >= WAKING_HOURS.start && hour < WAKING_HOURS.end;
}

/**
 * The plan week the consultant is reminded about today, or null. Only the
 * CURRENT plan week counts (a next week opened early is the consultant being
 * ahead), and only on a ladder day from 09:00 local on the week's first day.
 */
export function weekNudgeFor(
  input: SubscriptionEntitlementInput,
  now: Date,
  consultantZone: string,
): WeekNudge | null {
  const entitlement = subscriptionEntitlement({ ...input, now });
  const { nextBatch, ordinal, count, windowEnd } = entitlement.cycle;
  if (nextBatch === 0) return null;
  if (ordinal !== planWeekNumber(input, now) - 1) return null;
  const weekStartsAt = planWeekStartsAt(input, ordinal);
  // The first local morning at or after the week opens, in the consultant's zone.
  const morningOf = (day: string) =>
    fromZonedTime(
      `${day}T${String(LADDER_START_HOUR).padStart(2, "0")}:00:00`,
      consultantZone,
    );
  let firstDay = formatInTimeZone(weekStartsAt, consultantZone, "yyyy-MM-dd");
  if (morningOf(firstDay) < weekStartsAt) {
    firstDay = formatInTimeZone(
      new Date(weekStartsAt.getTime() + 86_400_000),
      consultantZone,
      "yyyy-MM-dd",
    );
  }
  const ladderStart = morningOf(firstDay);
  if (now < ladderStart) return null;
  const today = formatInTimeZone(now, consultantZone, "yyyy-MM-dd");
  const daysIn = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) /
      86_400_000,
  );
  if (!(WEEK_NUDGE_DAYS as readonly number[]).includes(daysIn)) return null;
  return {
    weekNumber: ordinal + 1,
    weekCount: count,
    sessionsToPlace: nextBatch,
    weekStartsAt,
    weekEndsAt: windowEnd,
  };
}

/** The outbox key for one consultant's reminder on one local day. */
export function weekNudgeDedupeKey(
  consultantProfileId: string,
  localDay: string,
): string {
  return `subscription-weeks:${consultantProfileId}:${localDay}`;
}

interface DuePlan {
  consulteeName: string;
  planTitle: string;
  url: string;
  nudge: WeekNudge;
  zone: string;
}

/** Plans a consultant may be reminded about: live, scheduled, nothing moving. */
const nudgeablePlans = (now: Date): Prisma.SubscriptionWhereInput => ({
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
});

/**
 * Where this run's read starts: plans in id order from an offset that moves
 * by one budget every hour, wrapping, so a run that reads `budget` plans
 * reaches every plan within ceil(total / budget) hours however many there are.
 */
export function rotationOffset(
  total: number,
  budget: number,
  now: Date,
): number {
  if (total <= budget) return 0;
  return (Math.floor(now.getTime() / 3_600_000) * budget) % total;
}

/**
 * Remind consultants whose plans have an open week with sessions left to
 * place. Plans never scheduled are the 48 h cohort's; a plan with a move in
 * flight (a tentative row) waits for it. Reads at most a budget of plans by
 * keyset on id from a rotating start (see `rotationOffset`); writes only the
 * outbox.
 */
export async function nudgeUnplacedPlanWeeks(limits: {
  maxRequests: number;
}): Promise<{ nudged: number; errors: string[] }> {
  const errors: string[] = [];
  const now = new Date();
  const byConsultant = new Map<
    string,
    { userId: string; zone: string; plans: DuePlan[] }
  >();
  try {
    const where = nudgeablePlans(now);
    const budget =
      Math.min(
        NUDGE_PAGES,
        Math.max(1, Math.ceil(limits.maxRequests / NUDGE_PAGE)),
      ) * NUDGE_PAGE;
    const total = await prisma.subscription.count({ where });
    const offset = rotationOffset(total, budget, now);
    const pivot =
      offset > 0
        ? (
            await prisma.subscription.findFirst({
              where,
              orderBy: { id: "asc" },
              skip: offset,
              select: { id: true },
            })
          )?.id
        : undefined;
    // From the pivot to the end, then from the start up to the pivot.
    const segments: Prisma.SubscriptionWhereInput[] = pivot
      ? [{ id: { gte: pivot } }, { id: { lt: pivot } }]
      : [{}];
    let read = 0;
    for (const segment of segments) {
      let cursor: string | undefined;
      while (read < budget) {
        const take = Math.min(NUDGE_PAGE, budget - read);
        const plans = await prisma.subscription.findMany({
          where: {
            AND: [where, segment, ...(cursor ? [{ id: { gt: cursor } }] : [])],
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
                  select: {
                    id: true,
                    user: { select: { id: true, timezone: true } },
                  },
                },
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
                  },
                },
              },
            },
          },
          orderBy: { id: "asc" },
          take,
        });
        read += plans.length;
        for (const sub of plans) {
          const plan = sub.subscriptionPlan;
          const consultant = plan.consultantProfile;
          const zone = consultant.user.timezone ?? sub.schedulingTimezone;
          if (!inWakingHours(now, zone)) continue;
          const nudge = weekNudgeFor(
            {
              sessionsTotal: sessionsTotalOf(sub),
              sessionsPerWeek: plan.sessionsPerWeek,
              durationInMonths: plan.durationInMonths,
              occurrences: sub.appointment?.occurrences ?? [],
              schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
              schedulingTimezone: sub.schedulingTimezone,
              planEndsAt: sub.planEndsAt,
            },
            now,
            zone,
          );
          if (!nudge) continue;
          const entry = byConsultant.get(consultant.id) ?? {
            userId: consultant.user.id,
            zone,
            plans: [],
          };
          entry.plans.push({
            consulteeName: sub.requestedBy.user.name ?? "Your client",
            planTitle: plan.title,
            // The allocate page, where "Auto-schedule this week" is one tap.
            url: `${getAppUrl()}/dashboard/consultant/${consultant.id}/requests/${encodeURIComponent(sub.id)}/allocate?type=subscription`,
            nudge,
            zone: sub.schedulingTimezone,
          });
          byConsultant.set(consultant.id, entry);
        }
        if (plans.length < take) break;
        cursor = plans[plans.length - 1].id;
      }
    }
  } catch (error) {
    errors.push(`Failed to read plan weeks: ${error}`);
    return { nudged: 0, errors };
  }
  if (byConsultant.size === 0) return { nudged: 0, errors };

  // Quiet hours on top of the waking window, for the email as for the bell.
  const prefs = await prisma.notificationPreference.findMany({
    where: { userId: { in: [...byConsultant.values()].map((c) => c.userId) } },
    select: {
      userId: true,
      quietHoursEnabled: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      quietHoursTimezone: true,
    },
  });
  const quietUntil = new Map(
    prefs.map((p) => [
      p.userId,
      computeQuietHoursNotBefore(
        {
          quietHoursEnabled: p.quietHoursEnabled,
          quietHoursStart: p.quietHoursStart,
          quietHoursEnd: p.quietHoursEnd,
          quietHoursTimezone: p.quietHoursTimezone,
        },
        now,
      ),
    ]),
  );

  const due = [...byConsultant].flatMap(([consultantProfileId, c]) => {
    const notBefore = quietUntil.get(c.userId);
    if (notBefore && notBefore > now) return [];
    const localDay = formatInTimeZone(now, c.zone, "yyyy-MM-dd");
    const dedupeKey = weekNudgeDedupeKey(consultantProfileId, localDay);
    return [
      {
        ...c,
        consultantProfileId,
        dedupeKey,
        transactionId: deriveTransactionId(
          NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
          [c.userId],
          {},
          dedupeKey,
        ),
        entityRef: unplacedWeekNudgeEntityRef(consultantProfileId, localDay),
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
    const weeks = d.plans.map((p) => ({
      consulteeName: p.consulteeName,
      planTitle: p.planTitle,
      number: p.nudge.weekNumber,
      count: p.nudge.weekCount,
      sessions: p.nudge.sessionsToPlace,
      range: formatDateRangeLabel(
        p.nudge.weekStartsAt,
        lastInstantBefore(p.nudge.weekEndsAt),
        { zone: p.zone },
      ),
      url: p.url,
    }));
    try {
      if (!bellDone) {
        await notifyUnplacedWeekNudge(
          d.userId,
          {
            ...notificationScope(null),
            consulteeName: weeks[0].consulteeName,
            planTitle: weeks[0].planTitle,
            appointmentType: "SUBSCRIPTION",
            dashboardUrl:
              weeks.length === 1
                ? weeks[0].url
                : `${getAppUrl()}/dashboard/consultant/${d.consultantProfileId}/requests?type=subscription`,
            weekSummary: weekSummary(weeks),
          },
          d.dedupeKey,
        );
      }
      if (!emailDone) {
        const mailed = await sendUnplacedWeekNudgeEmail(
          {
            consultantProfileId: d.consultantProfileId,
            consultantUserId: d.userId,
            localDay: formatInTimeZone(now, d.zone, "yyyy-MM-dd"),
            weeks,
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
        `Week nudge failed for consultant ${d.consultantProfileId}: ${error}`,
      );
    }
  }
  console.log(`✅ Sent ${nudged} plan-week reminders`);
  return { nudged, errors };
}

/** "Priya's week 5 (2 sessions) and 2 more plans need session times this week." */
export function weekSummary(
  weeks: ReadonlyArray<{
    consulteeName: string;
    number: number;
    sessions: number;
  }>,
): string {
  const [first, ...rest] = weeks;
  const sessions =
    first.sessions === 1 ? "1 session" : `${first.sessions} sessions`;
  const head = `${first.consulteeName}'s week ${first.number} (${sessions})`;
  if (rest.length === 0) return `${head} still needs session times.`;
  const more = rest.length === 1 ? "1 more plan" : `${rest.length} more plans`;
  return `${head} and ${more} need session times this week.`;
}
