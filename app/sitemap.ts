import type { MetadataRoute } from "next";

import { listIndexableEventPlanIds } from "@/lib/data/indexable-plans";
import { reportSentryError } from "@/lib/observability/report";
import {
  supportArticles,
  supportCategories,
} from "./support/_data/support-content";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// Read at request time: prerendering would query the shared database at build.
export const dynamic = "force-dynamic";

/** Plan pages for events still on sale; a database failure leaves only the static routes. */
async function eventPlanRoutes(): Promise<
  { path: string; priority: number }[]
> {
  try {
    const { webinarPlanIds, classPlanIds } = await listIndexableEventPlanIds(
      new Date(),
    );
    return [
      ...webinarPlanIds.map((id) => ({
        path: `/explore/programs/plans/webinars/${id}`,
        priority: 0.6,
      })),
      ...classPlanIds.map((id) => ({
        path: `/explore/programs/plans/classes/${id}`,
        priority: 0.6,
      })),
    ];
  } catch (error) {
    reportSentryError(error, { subsystem: "seo", op: "sitemap-plans" });
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: { path: string; priority: number }[] = [
    { path: "/", priority: 1.0 },
    { path: "/explore/experts", priority: 0.9 },
    { path: "/explore/programs", priority: 0.9 },
    { path: "/explore/enterprise/organisations", priority: 0.8 },
    { path: "/explore/products", priority: 0.7 },
    { path: "/become-an-expert", priority: 0.8 },
    { path: "/enterprise", priority: 0.8 },
    { path: "/enterprise/team-training", priority: 0.7 },
    { path: "/enterprise/corporate-mentorship", priority: 0.7 },
    { path: "/use-cases/mentorship", priority: 0.7 },
    { path: "/use-cases/early-career", priority: 0.7 },
    { path: "/use-cases/college-students", priority: 0.7 },
    { path: "/use-cases/career-switchers", priority: 0.7 },
    { path: "/about", priority: 0.8 },
    { path: "/pricing", priority: 0.8 },
    { path: "/contactus", priority: 0.7 },
    { path: "/support", priority: 0.8 },
    { path: "/terms", priority: 0.4 },
    { path: "/privacy", priority: 0.4 },
    { path: "/refund", priority: 0.4 },
    { path: "/reviews-policy", priority: 0.3 },
    { path: "/how-we-rank", priority: 0.3 },
    { path: "/grievance", priority: 0.3 },
    ...supportCategories.map((c) => ({
      path: `/support/${c.slug}`,
      priority: 0.7,
    })),
    ...supportArticles.map((a) => ({
      path: `/support/${a.category}/${a.slug}`,
      priority: 0.6,
    })),
  ];

  return [...staticRoutes, ...(await eventPlanRoutes())].map(
    ({ path, priority }) => ({
      url: `${BASE_URL}${path}`,
      changeFrequency: "weekly",
      priority,
    }),
  );
}
