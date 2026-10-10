import "server-only";

import type { AppointmentStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { sumPaise } from "@/lib/payments/utils/money";
import { UNTOUCHED_PLAN } from "@/lib/offerings/delete-guard";
import {
  offeringStatKey,
  type OfferingPlanType,
  type OfferingStat,
  type OfferingStats,
} from "@/lib/offerings/stats";

/**
 * #1527 §7.2 / #1827 — per-offering Bookings and Earnings for the owner's
 * Offerings cards and the Earnings "By offering" table, and the one answer to
 * "may this plan be deleted". Reads run in sequence: PG_POOL_MAX=1 serialises
 * them anyway, and each is a lean grouped or id-keyed read.
 */

/** A request that became a booking; PENDING/REJECTED/EXPIRED never did. */
const BOOKED: ReadonlySet<AppointmentStatus> = new Set([
  "APPROVED",
  "SCHEDULED",
  "COMPLETED",
]);

interface PlanHead {
  id: string;
  title: string;
  consultantProfileId: string | null;
  organizationId: string | null;
  archivedAt: Date | null;
}

const PLAN_HEAD = {
  id: true,
  title: true,
  consultantProfileId: true,
  organizationId: true,
  archivedAt: true,
} as const;

type Tally = { bookings: number };
const emptyTally = (): Tally => ({ bookings: 0 });

async function readRequestTallies(
  consultationPlanIds: string[],
  subscriptionPlanIds: string[],
  tallies: Map<string, Tally>,
) {
  const add = (key: string, status: AppointmentStatus, count: number) => {
    const t = tallies.get(key) ?? emptyTally();
    if (BOOKED.has(status)) t.bookings += count;
    tallies.set(key, t);
  };
  if (consultationPlanIds.length > 0) {
    const rows = await prisma.consultation.groupBy({
      by: ["consultationPlanId", "status"],
      where: { consultationPlanId: { in: consultationPlanIds } },
      _count: { _all: true },
    });
    for (const r of rows) {
      add(
        offeringStatKey("consultation", r.consultationPlanId),
        r.status,
        r._count._all,
      );
    }
  }
  if (subscriptionPlanIds.length > 0) {
    const rows = await prisma.subscription.groupBy({
      by: ["subscriptionPlanId", "status"],
      where: { subscriptionPlanId: { in: subscriptionPlanIds } },
      _count: { _all: true },
    });
    for (const r of rows) {
      add(
        offeringStatKey("subscription", r.subscriptionPlanId),
        r.status,
        r._count._all,
      );
    }
  }
}

const SEAT_COUNTS = {
  select: {
    _count: {
      select: {
        participants: { where: { ...liveParticipant(), role: "CONSULTEE" } },
      },
    },
  },
} as const;

/** Group events: live seats per instance, rolled up to the plan. */
async function readEventTallies(
  webinarPlanIds: string[],
  classPlanIds: string[],
  tallies: Map<string, Tally>,
) {
  const add = (key: string, counts: { participants: number } | undefined) => {
    const t = tallies.get(key) ?? emptyTally();
    t.bookings += counts?.participants ?? 0;
    tallies.set(key, t);
  };
  if (webinarPlanIds.length > 0) {
    const webinars = await prisma.webinar.findMany({
      where: { webinarPlanId: { in: webinarPlanIds } },
      select: { id: true, webinarPlanId: true, appointment: SEAT_COUNTS },
    });
    for (const w of webinars) {
      const key = offeringStatKey("webinar", w.webinarPlanId);
      add(key, w.appointment?._count);
    }
  }
  if (classPlanIds.length > 0) {
    const classes = await prisma.class.findMany({
      where: { classPlanId: { in: classPlanIds } },
      select: { id: true, classPlanId: true, appointment: SEAT_COUNTS },
    });
    for (const c of classes) {
      const key = offeringStatKey("class", c.classPlanId);
      add(key, c.appointment?._count);
    }
  }
}

/**
 * Which owned plans the DELETE routes would accept right now. The same
 * `UNTOUCHED_PLAN` guard they carry in their WHERE runs here as a query, so
 * the card offers Delete only when the server would not refuse it.
 */
async function readDeletablePlanIds(ids: {
  consultation: string[];
  subscription: string[];
  webinar: string[];
  class: string[];
}): Promise<Set<string>> {
  const pick = { select: { id: true } } as const;
  const rows = [
    ...(await prisma.consultationPlan.findMany({
      where: { id: { in: ids.consultation }, ...UNTOUCHED_PLAN.consultation },
      ...pick,
    })),
    ...(await prisma.subscriptionPlan.findMany({
      where: { id: { in: ids.subscription }, ...UNTOUCHED_PLAN.subscription },
      ...pick,
    })),
    ...(await prisma.webinarPlan.findMany({
      where: { id: { in: ids.webinar }, ...UNTOUCHED_PLAN.webinar },
      ...pick,
    })),
    ...(await prisma.classPlan.findMany({
      where: { id: { in: ids.class }, ...UNTOUCHED_PLAN.class },
      ...pick,
    })),
  ];
  return new Set(rows.map((row) => row.id));
}

/** Consultant net share per plan key (owned + co-hosted), plus lifetime total. */
async function readEarningsByPlan(consultantProfileId: string): Promise<{
  byPlan: Map<string, number>;
  lifetime: number;
  paidWebinarPlanIds: string[];
  paidClassPlanIds: string[];
}> {
  const byPlan = new Map<string, number>();
  const paidWebinarPlanIds = new Set<string>();
  const paidClassPlanIds = new Set<string>();

  const grouped = await prisma.consultantEarnings.groupBy({
    by: ["paymentId"],
    where: { consultantProfileId },
    _sum: { consultantSharePaise: true, refundedShareAmount: true },
  });
  if (grouped.length === 0) {
    return {
      byPlan,
      lifetime: 0,
      paidWebinarPlanIds: [],
      paidClassPlanIds: [],
    };
  }

  const netByPayment = new Map<string, number>();
  let lifetime = 0;
  for (const g of grouped) {
    const net =
      sumPaise(g._sum.consultantSharePaise) -
      sumPaise(g._sum.refundedShareAmount);
    netByPayment.set(g.paymentId, net);
    lifetime += net;
  }

  const payments = await prisma.payment.findMany({
    where: { id: { in: [...netByPayment.keys()] } },
    select: {
      id: true,
      appointment: {
        select: {
          consultation: { select: { consultationPlanId: true } },
          subscription: { select: { subscriptionPlanId: true } },
          webinar: { select: { webinarPlanId: true } },
          class: { select: { classPlanId: true } },
        },
      },
    },
  });
  for (const p of payments) {
    const a = p.appointment;
    let key: string | undefined;
    if (a?.consultation) {
      key = offeringStatKey("consultation", a.consultation.consultationPlanId);
    } else if (a?.subscription) {
      key = offeringStatKey("subscription", a.subscription.subscriptionPlanId);
    } else if (a?.webinar?.webinarPlanId) {
      paidWebinarPlanIds.add(a.webinar.webinarPlanId);
      key = offeringStatKey("webinar", a.webinar.webinarPlanId);
    } else if (a?.class?.classPlanId) {
      paidClassPlanIds.add(a.class.classPlanId);
      key = offeringStatKey("class", a.class.classPlanId);
    }
    if (!key) continue;
    byPlan.set(key, (byPlan.get(key) ?? 0) + (netByPayment.get(p.id) ?? 0));
  }
  return {
    byPlan,
    lifetime,
    paidWebinarPlanIds: [...paidWebinarPlanIds],
    paidClassPlanIds: [...paidClassPlanIds],
  };
}

export async function readOfferingStats(
  consultantProfileId: string,
): Promise<OfferingStats> {
  const { byPlan, lifetime, paidWebinarPlanIds, paidClassPlanIds } =
    await readEarningsByPlan(consultantProfileId);

  const ownedWhere = { consultantProfileId };
  const consultationPlans = await prisma.consultationPlan.findMany({
    where: ownedWhere,
    select: PLAN_HEAD,
  });
  const subscriptionPlans = await prisma.subscriptionPlan.findMany({
    where: ownedWhere,
    select: PLAN_HEAD,
  });
  const webinarPlans = await prisma.webinarPlan.findMany({
    where: {
      OR: [
        { consultantProfileId },
        {
          collaborators: {
            some: { consultantProfileId, status: "ACCEPTED" },
          },
        },
        ...(paidWebinarPlanIds.length > 0
          ? [
              {
                id: { in: paidWebinarPlanIds },
                collaborators: { some: { consultantProfileId } },
              },
            ]
          : []),
      ],
    },
    select: PLAN_HEAD,
  });
  const classPlans = await prisma.classPlan.findMany({
    where: {
      OR: [
        { consultantProfileId },
        {
          collaborators: {
            some: { consultantProfileId, status: "ACCEPTED" },
          },
        },
        ...(paidClassPlanIds.length > 0
          ? [
              {
                id: { in: paidClassPlanIds },
                collaborators: { some: { consultantProfileId } },
              },
            ]
          : []),
      ],
    },
    select: PLAN_HEAD,
  });

  const ids = (plans: PlanHead[]) => plans.map((p) => p.id);
  const ownedIds = (plans: PlanHead[]) =>
    plans
      .filter((p) => p.consultantProfileId === consultantProfileId)
      .map((p) => p.id);

  const tallies = new Map<string, Tally>();
  await readRequestTallies(
    ids(consultationPlans),
    ids(subscriptionPlans),
    tallies,
  );
  await readEventTallies(ids(webinarPlans), ids(classPlans), tallies);

  const deletable = await readDeletablePlanIds({
    consultation: ownedIds(consultationPlans),
    subscription: ownedIds(subscriptionPlans),
    webinar: ownedIds(webinarPlans),
    class: ownedIds(classPlans),
  });

  const toRows = (planType: OfferingPlanType, plans: PlanHead[]) =>
    plans.map((plan): OfferingStat => {
      const key = offeringStatKey(planType, plan.id);
      const tally = tallies.get(key) ?? emptyTally();
      const earningsPaise = byPlan.get(key) ?? 0;
      return {
        planType,
        planId: plan.id,
        title: plan.title,
        bookings: tally.bookings,
        earningsPaise,
        canDelete:
          plan.consultantProfileId === consultantProfileId &&
          deletable.has(plan.id),
        orgGoverned: plan.organizationId !== null,
        archived: plan.archivedAt !== null,
      };
    });

  return {
    rows: [
      ...toRows("consultation", consultationPlans),
      ...toRows("subscription", subscriptionPlans),
      ...toRows("webinar", webinarPlans),
      ...toRows("class", classPlans),
    ],
    lifetimePaise: lifetime,
  };
}
