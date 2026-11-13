import { eventPlanDiscoverableWhere } from "@/lib/api/plans/visibility";
import prisma from "@/lib/prisma";

/** One sitemap file holds 50,000 URLs; the static routes use a few dozen. */
const MAX_PLANS_PER_KIND = 5_000;

/** An instance a visitor can still buy or join; a draft has no public page. */
const SELLING_STATUSES = ["SCHEDULED"] as const;

/**
 * The webinar and class plan ids a search engine should index: publicly
 * discoverable (the same filter as the marketplace list), owned by a profile
 * that is not erased, and still holding a session that has not finished.
 */
export async function listIndexableEventPlanIds(now: Date): Promise<{
  webinarPlanIds: string[];
  classPlanIds: string[];
}> {
  const live = {
    status: { in: [...SELLING_STATUSES] },
    deletedAt: null,
    appointment: {
      occurrences: { some: { endsAt: { gt: now }, deletedAt: null } },
    },
  };
  const common = {
    ...eventPlanDiscoverableWhere(),
    OR: [
      { consultantProfile: null },
      { consultantProfile: { deletedAt: null } },
    ],
  };
  const [webinars, classes] = await Promise.all([
    prisma.webinarPlan.findMany({
      where: { ...common, webinars: { some: live } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: MAX_PLANS_PER_KIND,
    }),
    prisma.classPlan.findMany({
      where: { ...common, classes: { some: live } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: MAX_PLANS_PER_KIND,
    }),
  ]);
  return {
    webinarPlanIds: webinars.map((plan) => plan.id),
    classPlanIds: classes.map((plan) => plan.id),
  };
}
