/**
 * Regular time: the consultant's weekly times for a 1:1 plan, the 4-week
 * horizon it opens, and the placements it drives. Placement goes through the
 * allocator's manual mode one session at a time, so a slot lost to a race or
 * the constraint is skipped (it shows as a conflict) and never rolls back the
 * others.
 */
import { AppointmentStatus, type Prisma } from "@prisma/client";
import prisma, { type PrismaLike } from "@/lib/prisma";
import {
  planWeekNumber,
  planWeekStartsAt,
  soldSessionMinutes,
  soldTermsOf,
  subscriptionEntitlement,
  subscriptionIsOver,
  type SubscriptionEntitlement,
} from "@/lib/booking/entitlement";
import {
  projectRegularSlots,
  regularSlotsRefusal,
  regularTimeLabel,
  type ProjectedSlot,
  type RegularSlot,
} from "@/lib/booking/regular-time/project";
import {
  deriveHorizonConflicts,
  slotConflictReason,
  type HorizonWeekView,
  type Interval,
} from "@/lib/booking/regular-time/conflicts";
import { hostHoursPredicate } from "@/lib/booking/regular-time/availability";
import { leadMsFor } from "@/lib/booking/lead-time";
import { isHostOrgOperatorOf } from "@/lib/booking/cancel-actor";
import { intervalStartsOf } from "@/lib/appointments/occurrences";
import { fetchEventData } from "@/lib/booking/allocation/event-data";
import { allocate } from "@/lib/booking/allocation";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { getAppUrl } from "@/lib/url";
import { withAppointmentLock } from "@/utils/appointmentlock";

/** Plans the roll-forward and the setter may place into. */
export const LIVE_PLAN_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.APPROVED,
  AppointmentStatus.SCHEDULED,
];

export const REGULAR_TIME_PLAN_SELECT = {
  id: true,
  status: true,
  deletedAt: true,
  sessionsTotal: true,
  sessionsPerWeek: true,
  sessionMinutes: true,
  sessionsRefunded: true,
  schedulingPeriodStartsAt: true,
  schedulingTimezone: true,
  planEndsAt: true,
  rollPausedAt: true,
  lastRolledAt: true,
  requestedBy: { select: { user: { select: { id: true, name: true } } } },
  subscriptionPlan: {
    select: {
      title: true,
      organizationId: true,
      consultantProfileId: true,
      totalSessions: true,
      sessionsPerWeek: true,
      durationInMonths: true,
      sessionDurationInHours: true,
      consultantProfile: {
        select: { user: { select: { id: true, name: true, timezone: true } } },
      },
    },
  },
  appointment: {
    select: {
      id: true,
      occurrences: {
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          completionStatus: true,
          isTentative: true,
          deletedAt: true,
        },
      },
    },
  },
  regularTimes: {
    select: {
      id: true,
      weekday: true,
      localStartMinutes: true,
      validFrom: true,
      validUntil: true,
    },
    orderBy: { validFrom: "asc" },
  },
} satisfies Prisma.SubscriptionSelect;

export type RegularTimePlan = Prisma.SubscriptionGetPayload<{
  select: typeof REGULAR_TIME_PLAN_SELECT;
}>;

type RegularTimeRow = RegularTimePlan["regularTimes"][number];

/** The rows in force for a week that starts at `weekStart`. */
function rowsFor(rows: readonly RegularTimeRow[], weekStart: Date) {
  return rows.filter(
    (r) =>
      r.validFrom.getTime() <= weekStart.getTime() &&
      (r.validUntil === null || r.validUntil.getTime() > weekStart.getTime()),
  );
}

/** The live (unsuperseded) rows: the Regular time a reader shows. */
export function liveRegularSlots(plan: RegularTimePlan): RegularSlot[] {
  return plan.regularTimes
    .filter((r) => r.validUntil === null)
    .map((r) => ({
      weekday: r.weekday,
      localStartMinutes: r.localStartMinutes,
    }));
}

function entitlementOf(
  plan: RegularTimePlan,
  now: Date,
): SubscriptionEntitlement {
  return subscriptionEntitlement({
    ...soldTermsOf(plan),
    occurrences: plan.appointment?.occurrences ?? [],
    schedulingPeriodStartsAt: plan.schedulingPeriodStartsAt,
    schedulingTimezone: plan.schedulingTimezone,
    planEndsAt: plan.planEndsAt,
    hasRegularTime: liveRegularSlots(plan).length > 0,
    now,
  });
}

const weekInput = (plan: RegularTimePlan) => ({
  ...soldTermsOf(plan),
  schedulingPeriodStartsAt: plan.schedulingPeriodStartsAt,
  schedulingTimezone: plan.schedulingTimezone,
});

/** Every horizon week's projected slots, each week under the rows in force then. */
export function projectHorizon(
  plan: RegularTimePlan,
  entitlement: SubscriptionEntitlement,
): ProjectedSlot[] {
  const sessionMinutes = soldSessionMinutes(plan);
  return entitlement.horizon.flatMap((week) =>
    projectRegularSlots({
      slots: rowsFor(
        plan.regularTimes,
        planWeekStartsAt(weekInput(plan), week.weekIndex),
      ),
      timeZone: plan.schedulingTimezone,
      planStartsAt: plan.schedulingPeriodStartsAt,
      planEndsAt: entitlement.planEndsAt,
      fromWeek: week.weekIndex,
      weeks: 1,
      sessionMinutes,
    }),
  );
}

/** This plan's live scheduled sessions. */
function ownSessions(plan: RegularTimePlan) {
  return (plan.appointment?.occurrences ?? [])
    .filter(
      (o) =>
        !o.deletedAt &&
        !o.isTentative &&
        o.completionStatus !== "CANCELLED" &&
        o.completionStatus !== "RESCHEDULED",
    )
    .map((o) => ({ id: o.id, startsAt: o.startsAt, endsAt: o.endsAt }));
}

/** The host's other live sessions over [from, to), any event or buyer. */
async function hostBusy(
  db: PrismaLike,
  plan: RegularTimePlan,
  from: Date,
  to: Date,
): Promise<Interval[]> {
  return db.appointmentOccurrence.findMany({
    where: {
      consultantProfileId: plan.subscriptionPlan.consultantProfileId,
      isTentative: false,
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
      startsAt: { lt: to },
      endsAt: { gt: from },
      ...(plan.appointment
        ? { appointmentId: { not: plan.appointment.id } }
        : {}),
    },
    select: { startsAt: true, endsAt: true },
  });
}

export interface RegularTimeView {
  slots: RegularSlot[];
  label: string | null;
  timeZone: string;
  weekCount: number;
  weeks: HorizonWeekView[];
  paused: boolean;
}

/** The Regular time and its derived horizon (placed sessions and conflicts per week). */
export async function readRegularTimeView(
  plan: RegularTimePlan,
  now: Date = new Date(),
  db: PrismaLike = prisma,
): Promise<RegularTimeView> {
  const slots = liveRegularSlots(plan);
  const entitlement = entitlementOf(plan, now);
  const base = {
    slots,
    label: slots.length > 0 ? regularTimeLabel(slots) : null,
    timeZone: plan.schedulingTimezone,
    weekCount: entitlement.cycle.count,
    paused: plan.rollPausedAt !== null,
  };
  if (slots.length === 0 || entitlement.horizon.length === 0) {
    return { ...base, weeks: [] };
  }
  const eventData = await fetchEventData(db, "subscription", plan.id).catch(
    () => null,
  );
  const first = entitlement.horizon[0];
  const last = entitlement.horizon[entitlement.horizon.length - 1];
  const weeks = deriveHorizonConflicts({
    weeks: entitlement.horizon,
    projected: projectHorizon(plan, entitlement),
    own: ownSessions(plan),
    hostBusy: await hostBusy(db, plan, first.startsAt, last.endsAt),
    isAvailable: eventData
      ? hostHoursPredicate(eventData.consultant)
      : () => false,
    now,
    leadMs: leadMsFor("allocate"),
  });
  return { ...base, weeks };
}

export interface PlaceResult {
  placed: number;
  skipped: number;
}

/**
 * Place the free projected slots of the given horizon weeks, one allocator
 * call per session, each week capped at its capacity. A refused slot (taken,
 * outside hours, lost race) is skipped and stays on the conflict list.
 */
export async function placeRegularWeeks(
  plan: RegularTimePlan,
  weekIndexes: readonly number[],
  opts: { now: Date; db?: PrismaLike; deadline?: () => boolean },
): Promise<PlaceResult> {
  const db = opts.db ?? prisma;
  const entitlement = entitlementOf(plan, opts.now);
  const wanted = new Set(weekIndexes);
  const weeks = entitlement.horizon.filter((w) => wanted.has(w.weekIndex));
  if (weeks.length === 0) return { placed: 0, skipped: 0 };
  const projected = projectHorizon(plan, entitlement);
  const own = ownSessions(plan);
  const busy = await hostBusy(
    db,
    plan,
    weeks[0].startsAt,
    weeks[weeks.length - 1].endsAt,
  );
  const ctx = {
    hostBusy: busy,
    // The allocator checks the hours itself; this pre-filter only spares a call.
    isAvailable: () => true,
    now: opts.now,
    leadMs: leadMsFor("allocate"),
  };
  let placed = 0;
  let skipped = 0;
  for (const week of weeks) {
    let room = Math.max(0, week.capacity - week.held);
    for (const slot of projected) {
      if (room === 0 || opts.deadline?.()) break;
      if (slot.weekIndex !== week.weekIndex) continue;
      const overlapsOwn = own.some(
        (o) => o.startsAt < slot.endsAt && slot.startsAt < o.endsAt,
      );
      if (overlapsOwn) continue;
      if (slotConflictReason(slot, ctx) !== null) {
        skipped += 1;
        continue;
      }
      const result = await allocate({
        eventType: "subscription",
        eventId: plan.id,
        mode: "manual",
        slots: intervalStartsOf(slot).map((d) => d.toISOString()),
        topUp: true,
        allowPartial: true,
        byRegularTime: true,
      });
      if (result.success) {
        placed += 1;
        room -= 1;
      } else {
        skipped += 1;
      }
    }
  }
  return { placed, skipped };
}

export type SetRegularTimeActor = {
  userId: string;
  consultantProfileId: string | null;
};

export type SetRegularTimeOutcome =
  | {
      ok: true;
      validFrom: Date;
      slots: RegularSlot[];
      placed: number;
      replayed: boolean;
    }
  | { ok: false; status: number; code: string; error: string };

const refuse = (status: number, code: string, error: string) =>
  ({ ok: false, status, code, error }) as const;

/** Whether the live rows already say exactly these slots. */
function sameSlots(a: readonly RegularSlot[], b: readonly RegularSlot[]) {
  const key = (s: RegularSlot) => `${s.weekday}:${s.localStartMinutes}`;
  const left = new Set(a.map(key));
  return a.length === b.length && b.every((s) => left.has(key(s)));
}

/**
 * Set or edit a plan's Regular time. The consultant or an operator of the
 * plan's host org may; the client never. An edit applies from the first plan
 * week with nothing placed; placed sessions never move. Only the current week
 * is placed now; the hourly roll-forward fills the rest. Same slots → no write.
 */
export async function setRegularTime(
  actor: SetRegularTimeActor,
  subscriptionId: string,
  slots: RegularSlot[],
  now: Date = new Date(),
): Promise<SetRegularTimeOutcome> {
  const plan = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: REGULAR_TIME_PLAN_SELECT,
  });
  if (!plan || plan.deletedAt) {
    return refuse(404, "NOT_FOUND", "This plan was not found.");
  }
  const consulteeId = plan.requestedBy.user.id;
  const isConsultant =
    !!actor.consultantProfileId &&
    actor.consultantProfileId === plan.subscriptionPlan.consultantProfileId;
  const allowed =
    actor.userId !== consulteeId &&
    (isConsultant ||
      (await isHostOrgOperatorOf(
        actor.userId,
        plan.subscriptionPlan.organizationId,
      )));
  if (!allowed) {
    return refuse(
      403,
      "NOT_ALLOWED",
      "Only the expert or their organisation can set the regular time.",
    );
  }
  if (
    !LIVE_PLAN_STATUSES.includes(plan.status) ||
    !plan.appointment ||
    subscriptionIsOver(plan, now)
  ) {
    return refuse(
      409,
      "PLAN_NOT_LIVE",
      "This plan isn't running, so it has no regular time to set.",
    );
  }

  const entitlement = entitlementOf(plan, now);
  const live = liveRegularSlots(plan);
  const nowWeek = planWeekNumber(weekInput(plan), now) - 1;
  const own = ownSessions(plan);
  const holdsSomething = (k: number) => {
    const from = planWeekStartsAt(weekInput(plan), k);
    const to = planWeekStartsAt(weekInput(plan), k + 1);
    return own.some((o) => o.startsAt >= from && o.startsAt < to);
  };
  // A first set starts this week; an edit starts at the first week holding nothing.
  let fromWeek = nowWeek;
  if (live.length > 0) {
    while (fromWeek < entitlement.cycle.count - 1 && holdsSomething(fromWeek))
      fromWeek += 1;
  }
  const refusal = regularSlotsRefusal(slots, {
    perWeek: soldTermsOf(plan).sessionsPerWeek,
    timeZone: plan.schedulingTimezone,
    planStartsAt: plan.schedulingPeriodStartsAt,
    planEndsAt: entitlement.planEndsAt,
    fromWeek,
    weeks: entitlement.cycle.count - fromWeek,
  });
  if (refusal) {
    return refuse(
      refusal.code === "REGULAR_TIME_SLOT_COUNT" ? 400 : 409,
      refusal.code,
      refusal.message,
    );
  }
  if (live.length > 0 && sameSlots(live, slots)) {
    const fromRow = plan.regularTimes.find((r) => r.validUntil === null);
    return {
      ok: true,
      validFrom:
        fromRow?.validFrom ?? planWeekStartsAt(weekInput(plan), fromWeek),
      slots: live,
      placed: 0,
      replayed: true,
    };
  }

  const validFrom = planWeekStartsAt(weekInput(plan), fromWeek);
  const liveIds = plan.regularTimes
    .filter((r) => r.validUntil === null)
    .map((r) => r.id);
  const appointmentId = plan.appointment.id;
  const written = await withAppointmentLock(appointmentId, async () => {
    const result = await prisma.$transaction(async (tx) => {
      const closed = await tx.regularTime.updateMany({
        where: { id: { in: liveIds }, subscriptionId, validUntil: null },
        data: { validUntil: validFrom },
      });
      if (closed.count !== liveIds.length) return "changed" as const;
      await tx.regularTime.createMany({
        data: slots.map((s) => ({
          subscriptionId,
          weekday: s.weekday,
          localStartMinutes: s.localStartMinutes,
          timezone: plan.schedulingTimezone,
          validFrom,
          createdByUserId: actor.userId,
        })),
      });
      const touched = await tx.subscription.updateMany({
        where: { id: subscriptionId, status: { in: LIVE_PLAN_STATUSES } },
        data: { rollPausedAt: null },
      });
      if (touched.count !== 1) throw new PlanNotLiveError();
      return stageBell(tx, {
        workflowId: NOVU_WORKFLOWS.SUBSCRIPTION_STARTED,
        recipients: [consulteeId],
        payload: {
          planTitle: plan.subscriptionPlan.title,
          consultantName:
            plan.subscriptionPlan.consultantProfile.user.name ?? "Your expert",
          regularTime: `${regularTimeLabel(slots)} (${plan.schedulingTimezone})`,
          dashboardUrl: `${getAppUrl()}/dashboard/consultee`,
        },
        dedupeKey: `regular-time:${subscriptionId}:${validFrom.toISOString()}`,
      });
    });
    if (result === "changed") return result;
    await flushNotificationsAfter({ bells: [result] }, "regular-time.set");
    return "written" as const;
  }).catch((error: unknown) => {
    if (error instanceof PlanNotLiveError) return "not-live" as const;
    throw error;
  });
  if (written === "not-live") {
    return refuse(
      409,
      "PLAN_NOT_LIVE",
      "This plan isn't running, so it has no regular time to set.",
    );
  }
  if (written === "changed") {
    return refuse(
      409,
      "REGULAR_TIME_CHANGED",
      "The regular time was just changed. Reload and try again.",
    );
  }

  let placed = 0;
  if (fromWeek === nowWeek) {
    const fresh = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: REGULAR_TIME_PLAN_SELECT,
    });
    if (fresh) {
      ({ placed } = await placeRegularWeeks(fresh, [fromWeek], { now }));
    }
  }
  return { ok: true, validFrom, slots, placed, replayed: false };
}

class PlanNotLiveError extends Error {}
