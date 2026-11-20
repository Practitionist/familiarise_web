// The consultant's reminder ladder for plan weeks that still have sessions to
// place. Daytime only: the ladder starts at 09:00 on the week's first day in
// the consultant's zone, runs on that day, the next and the third (+0/+1/+3
// days), and anything due outside 08:00–21:00 local (or inside the
// consultant's quiet hours) waits for the next run. One bell and one email per
// consultant per local day list every plan due; the outbox rows dedupe.

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { AppointmentStatus, type Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  lastInstantBefore,
  planWeekNumber,
  planWeekStartsAt,
  soldTermsOf,
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
import { DEFAULT_NOTIFICATION_TIMEZONE } from "@/lib/novu/humanize";
import { formatDateRangeLabel } from "@/lib/time/display";
import { getAppUrl } from "@/lib/url";
import {
  QUIET_HOURS_DEFAULT_END,
  QUIET_HOURS_DEFAULT_START,
} from "@/schemas/user";

/** Days after the week's first morning on which the consultant is reminded. */
export const WEEK_NUDGE_DAYS = [0, 1, 3] as const;
/** The ladder's first reminder, local time on the week's first day. */
const LADDER_START_HOUR = 9;
/** Reminders go out only inside these local hours [start, end). */
export const WAKING_HOURS = { start: 8, end: 21 } as const;
/** Consultants read per page and pages per run (keyset over id, a fair rotation). */
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
  // Every ladder day starts at the same local hour, so one consultant's plans
  // due today are all due in the same run and one daily batch carries them.
  if (localHour(now, consultantZone) < LADDER_START_HOUR) return null;
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

const NUDGE_PLAN_SELECT = {
  id: true,
  sessionsTotal: true,
  sessionsPerWeek: true,
  sessionsRefunded: true,
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
        select: { id: true, user: { select: { id: true, timezone: true } } },
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
} satisfies Prisma.SubscriptionSelect;

type NudgePlan = Prisma.SubscriptionGetPayload<{
  select: typeof NUDGE_PLAN_SELECT;
}>;

/**
 * The nudgeable plans of at most `budget` consultants, every plan of each:
 * consultants are read by keyset on id from the rotating start (see
 * `rotationOffset`), from the pivot to the end and then from the start, and
 * each selected consultant's plans are read in full, so one consultant's
 * daily reminder is never split across runs.
 */
async function readNudgeablePlans(
  now: Date,
  budget: number,
): Promise<NudgePlan[]> {
  const plans = nudgeablePlans(now);
  const where: Prisma.ConsultantProfileWhereInput = {
    subscriptionPlans: { some: { subscriptions: { some: plans } } },
  };
  const total = await prisma.consultantProfile.count({ where });
  const offset = rotationOffset(total, budget, now);
  const pivot =
    offset > 0
      ? (
          await prisma.consultantProfile.findFirst({
            where,
            orderBy: { id: "asc" },
            skip: offset,
            select: { id: true },
          })
        )?.id
      : undefined;
  const segments: Prisma.ConsultantProfileWhereInput[] = pivot
    ? [{ id: { gte: pivot } }, { id: { lt: pivot } }]
    : [{}];
  const consultantIds: string[] = [];
  for (const segment of segments) {
    let cursor: string | undefined;
    while (consultantIds.length < budget) {
      const take = Math.min(NUDGE_PAGE, budget - consultantIds.length);
      const page = await prisma.consultantProfile.findMany({
        where: {
          AND: [where, segment, ...(cursor ? [{ id: { gt: cursor } }] : [])],
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take,
      });
      consultantIds.push(...page.map((row) => row.id));
      if (page.length < take) break;
      cursor = page[page.length - 1].id;
    }
  }
  if (consultantIds.length === 0) return [];
  return prisma.subscription.findMany({
    where: {
      AND: [
        plans,
        { subscriptionPlan: { consultantProfileId: { in: consultantIds } } },
      ],
    },
    select: NUDGE_PLAN_SELECT,
    orderBy: { id: "asc" },
  });
}

/** The reminder one plan is owed now, with its consultant, or null. */
function dueNudgeFor(
  sub: NudgePlan,
  now: Date,
): {
  consultantProfileId: string;
  userId: string;
  zone: string;
  plan: DuePlan;
} | null {
  const plan = sub.subscriptionPlan;
  const consultant = plan.consultantProfile;
  const zone = consultant.user.timezone ?? sub.schedulingTimezone;
  if (!inWakingHours(now, zone)) return null;
  const nudge = weekNudgeFor(
    {
      ...soldTermsOf(sub),
      occurrences: sub.appointment?.occurrences ?? [],
      schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
      schedulingTimezone: sub.schedulingTimezone,
      planEndsAt: sub.planEndsAt,
    },
    now,
    zone,
  );
  if (!nudge) return null;
  return {
    consultantProfileId: consultant.id,
    userId: consultant.user.id,
    zone,
    plan: {
      consulteeName: sub.requestedBy.user.name ?? "Your client",
      planTitle: plan.title,
      // The allocate page, where "Auto-schedule this week" is one tap.
      url: `${getAppUrl()}/dashboard/consultant/${consultant.id}/requests/${encodeURIComponent(sub.id)}/allocate?type=subscription`,
      nudge,
      zone: sub.schedulingTimezone,
    },
  };
}

/** "HH:MM" as minutes past midnight, or null when malformed. */
function wallMinutes(value: string | null): number | null {
  const match = value ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}

function minutesNowIn(zone: string | null, now: Date): number {
  let clock: string;
  try {
    clock = formatInTimeZone(
      now,
      zone?.trim() || DEFAULT_NOTIFICATION_TIMEZONE,
      "HH:mm",
    );
  } catch {
    clock = formatInTimeZone(now, DEFAULT_NOTIFICATION_TIMEZONE, "HH:mm");
  }
  return wallMinutes(clock) ?? 0;
}

/** Users inside their quiet hours now (an overnight window wraps midnight). */
async function usersInQuietHours(
  userIds: string[],
  now: Date,
): Promise<Set<string>> {
  const prefs = await prisma.notificationPreference.findMany({
    where: { userId: { in: userIds }, quietHoursEnabled: true },
    select: {
      userId: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      quietHoursTimezone: true,
    },
  });
  const quiet = new Set<string>();
  for (const pref of prefs) {
    const start = wallMinutes(
      pref.quietHoursStart ?? QUIET_HOURS_DEFAULT_START,
    );
    const end = wallMinutes(pref.quietHoursEnd ?? QUIET_HOURS_DEFAULT_END);
    if (start === null || end === null || start === end) continue;
    const current = minutesNowIn(pref.quietHoursTimezone, now);
    const inside =
      start < end
        ? current >= start && current < end
        : current >= start || current < end;
    if (inside) quiet.add(pref.userId);
  }
  return quiet;
}

interface DueConsultant {
  consultantProfileId: string;
  userId: string;
  zone: string;
  plans: DuePlan[];
  dedupeKey: string;
  transactionId: string;
  entityRef: string;
}

/** One consultant's bell and email; each arm skipped when already staged. */
async function sendConsultantNudge(
  d: DueConsultant,
  now: Date,
  staged: { bell: boolean; email: boolean },
): Promise<void> {
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
  if (!staged.bell) {
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
  if (!staged.email) {
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
}

/**
 * Remind consultants whose plans have an open week with sessions left to
 * place. Plans never scheduled are the 48 h cohort's; a plan with a move in
 * flight (a tentative row) waits for it. Reads at most a budget of plans
 * (see `readNudgeablePlans`); writes only the outbox.
 */
export async function nudgeUnplacedPlanWeeks(limits: {
  maxRequests: number;
}): Promise<{ nudged: number; errors: string[] }> {
  const errors: string[] = [];
  // A failed read never throws into the job: the expiry stages after it run.
  try {
    return await runWeekNudges(limits, errors);
  } catch (error) {
    errors.push(`Week reminders stopped: ${error}`);
    return { nudged: 0, errors };
  }
}

async function runWeekNudges(
  limits: { maxRequests: number },
  errors: string[],
): Promise<{ nudged: number; errors: string[] }> {
  const now = new Date();
  const budget =
    Math.min(
      NUDGE_PAGES,
      Math.max(1, Math.ceil(limits.maxRequests / NUDGE_PAGE)),
    ) * NUDGE_PAGE;
  const byConsultant = new Map<
    string,
    { userId: string; zone: string; plans: DuePlan[] }
  >();
  try {
    const plans = await readNudgeablePlans(now, budget);
    for (const sub of plans) {
      const due = dueNudgeFor(sub, now);
      if (!due) continue;
      const entry = byConsultant.get(due.consultantProfileId) ?? {
        userId: due.userId,
        zone: due.zone,
        plans: [],
      };
      entry.plans.push(due.plan);
      byConsultant.set(due.consultantProfileId, entry);
    }
  } catch (error) {
    errors.push(`Failed to read plan weeks: ${error}`);
    return { nudged: 0, errors };
  }
  if (byConsultant.size === 0) return { nudged: 0, errors };

  // Quiet hours on top of the waking window, for the email as for the bell.
  const quiet = await usersInQuietHours(
    [...byConsultant.values()].map((c) => c.userId),
    now,
  );
  const due: DueConsultant[] = [...byConsultant].flatMap(
    ([consultantProfileId, c]) => {
      if (quiet.has(c.userId)) return [];
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
    },
  );
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
    const staged = {
      bell: bellStaged.has(d.transactionId),
      email: emailStaged.has(d.entityRef),
    };
    if (staged.bell && staged.email) continue;
    try {
      // Sequential, so the sends stay within the job's email budget.
      await sendConsultantNudge(d, now, staged);
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
