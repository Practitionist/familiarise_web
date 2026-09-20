import prisma from "@/lib/prisma";
import { AppointmentStatus, BookingHistoryEntity } from "@prisma/client";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";
import {
  LAPSED_PAY_LINK_VISIBLE_MS,
  toLapsedPayLinks,
  type ExpiredRequestRow,
  type LapsedPayLink,
} from "@/lib/dashboard/lapsed-pay-links";

/**
 * #1675 — the Home widget's read of the last week's lapsed pay-links; the
 * discriminator lives in lib/dashboard/lapsed-pay-links.ts.
 */

const PLAN_SELECT = {
  select: {
    title: true,
    consultantProfileId: true,
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;

/**
 * Personal-pinned like the pending-payments read it rides with (ADR 19).
 * Two reads, not a history join: the history row is keyed on the polymorphic
 * entityId, and a subscription that never got its wrapper has no appointment
 * to join through.
 */
export async function readLapsedPayLinks(
  consulteeId: string,
  now: Date = new Date(),
): Promise<LapsedPayLink[]> {
  const since = new Date(now.getTime() - LAPSED_PAY_LINK_VISIBLE_MS);
  const personalOrgPin = scopeToWhereOrgId({ kind: "personal" });
  const recentlyExpired = {
    requestedById: consulteeId,
    status: AppointmentStatus.EXPIRED,
    // The EXPIRED flip bumps updatedAt, so this bounds the read; the exact
    // clock is the history row's, applied in toLapsedPayLinks.
    updatedAt: { gte: since },
  } as const;
  const [consultations, subscriptions] = await Promise.all([
    prisma.consultation.findMany({
      where: { ...recentlyExpired, appointment: { is: personalOrgPin } },
      select: { id: true, consultationPlan: PLAN_SELECT },
    }),
    prisma.subscription.findMany({
      where: { ...recentlyExpired, appointment: personalOrgPin },
      select: { id: true, subscriptionPlan: PLAN_SELECT },
    }),
  ]);
  if (consultations.length === 0 && subscriptions.length === 0) return [];

  const history = await prisma.bookingStatusHistory.findMany({
    where: {
      entity: {
        in: [
          BookingHistoryEntity.CONSULTATION,
          BookingHistoryEntity.SUBSCRIPTION,
        ],
      },
      entityId: { in: [...consultations, ...subscriptions].map((r) => r.id) },
      toStatus: AppointmentStatus.EXPIRED,
    },
    select: {
      entityId: true,
      fromStatus: true,
      toStatus: true,
      createdAt: true,
    },
  });
  const historyById = new Map<string, ExpiredRequestRow["history"]>();
  for (const h of history) {
    const list = historyById.get(h.entityId) ?? [];
    list.push(h);
    historyById.set(h.entityId, list);
  }

  const rows: ExpiredRequestRow[] = [
    ...consultations.map((c) => ({
      id: c.id,
      type: "consultation" as const,
      title: c.consultationPlan.title,
      consultantName:
        c.consultationPlan.consultantProfile.user.name ?? "your expert",
      consultantProfileId: c.consultationPlan.consultantProfileId,
      history: historyById.get(c.id) ?? [],
    })),
    ...subscriptions.map((s) => ({
      id: s.id,
      type: "subscription" as const,
      title: s.subscriptionPlan.title,
      consultantName:
        s.subscriptionPlan.consultantProfile.user.name ?? "your expert",
      consultantProfileId: s.subscriptionPlan.consultantProfileId,
      history: historyById.get(s.id) ?? [],
    })),
  ];
  return toLapsedPayLinks(rows, now);
}
