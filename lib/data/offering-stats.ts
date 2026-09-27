import "server-only";

import type { AppointmentStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  canDeleteOffering,
  offeringStatKey,
  type OfferingHistory,
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
  organizationId: string | null;
  archivedAt: Date | null;
}

const PLAN_HEAD = {
  id: true,
  title: true,
  organizationId: true,
  archivedAt: true,
} as const;

type Tally = Omit<OfferingHistory, "earningsPaise"> & { bookings: number };
const emptyTally = (): Tally => ({
  requestRows: 0,
  payments: 0,
  seats: 0,
  bookings: 0,
});

async function readRequestTallies(
  consultationPlanIds: string[],
  subscriptionPlanIds: string[],
  tallies: Map<string, Tally>,
) {
  const add = (key: string, status: AppointmentStatus, count: number) => {
    const t = tallies.get(key) ?? emptyTally();
    t.requestRows += count;
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
        payment: true,
        participants: { where: { ...liveParticipant(), role: "CONSULTEE" } },
      },
    },
  },
} as const;

/** Group events: seats and payments per instance, rolled up to the plan. */
async function readEventTallies(
  webinarPlanIds: string[],
  classPlanIds: string[],
  tallies: Map<string, Tally>,
  instancePlan: Map<string, string>,
) {
  const add = (
    key: string,
    counts: { payment: number; participants: number } | undefined,
  ) => {
    const t = tallies.get(key) ?? emptyTally();
    t.payments += counts?.payment ?? 0;
    t.seats += counts?.participants ?? 0;
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
      instancePlan.set(`webinar:${w.id}`, key);
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
      instancePlan.set(`class:${c.id}`, key);
      add(key, c.appointment?._count);
    }
  }
}

/** The owner's net share per plan key, plus the lifetime total. */
async function readEarningsByPlan(
  consultantProfileId: string,
  instancePlan: Map<string, string>,
): Promise<{ byPlan: Map<string, number>; lifetime: number }> {
  const byPlan = new Map<string, number>();
  const grouped = await prisma.consultantEarnings.groupBy({
    by: ["paymentId"],
    where: { consultantProfileId },
    _sum: { consultantSharePaise: true, refundedShareAmount: true },
  });
  if (grouped.length === 0) return { byPlan, lifetime: 0 };

  const netByPayment = new Map<string, number>();
  let lifetime = 0;
  for (const g of grouped) {
    // #780 — _sum bypasses the result extension: bigint until sumPaise'd.
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
          webinarId: true,
          classId: true,
          consultation: { select: { consultationPlanId: true } },
          subscription: { select: { subscriptionPlanId: true } },
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
    } else if (a?.webinarId) {
      key = instancePlan.get(`webinar:${a.webinarId}`);
    } else if (a?.classId) {
      key = instancePlan.get(`class:${a.classId}`);
    }
    // A collaborator's share on someone else's plan counts toward lifetime only.
    if (!key) continue;
    byPlan.set(key, (byPlan.get(key) ?? 0) + (netByPayment.get(p.id) ?? 0));
  }
  return { byPlan, lifetime };
}

export async function readOfferingStats(
  consultantProfileId: string,
): Promise<OfferingStats> {
  const where = { consultantProfileId };
  const consultationPlans = await prisma.consultationPlan.findMany({
    where,
    select: PLAN_HEAD,
  });
  const subscriptionPlans = await prisma.subscriptionPlan.findMany({
    where,
    select: PLAN_HEAD,
  });
  const webinarPlans = await prisma.webinarPlan.findMany({
    where,
    select: PLAN_HEAD,
  });
  const classPlans = await prisma.classPlan.findMany({
    where,
    select: PLAN_HEAD,
  });

  const ids = (plans: PlanHead[]) => plans.map((p) => p.id);
  const tallies = new Map<string, Tally>();
  const instancePlan = new Map<string, string>();
  await readRequestTallies(
    ids(consultationPlans),
    ids(subscriptionPlans),
    tallies,
  );
  await readEventTallies(
    ids(webinarPlans),
    ids(classPlans),
    tallies,
    instancePlan,
  );
  const { byPlan, lifetime } = await readEarningsByPlan(
    consultantProfileId,
    instancePlan,
  );

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
        canDelete: canDeleteOffering({ ...tally, earningsPaise }),
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
