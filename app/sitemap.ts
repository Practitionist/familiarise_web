import type { MetadataRoute } from "next";

import {
  supportArticles,
  supportCategories,
} from "./support/_data/support-content";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: { path: string; priority: number }[] = [
    { path: "/", priority: 1.0 },
    { path: "/explore/experts", priority: 0.9 },
    { path: "/explore/programs", priority: 0.9 },
    { path: "/explore/enterprise/organisations", priority: 0.8 },
    { path: "/explore/recordings", priority: 0.7 },
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

  return staticRoutes.map(({ path, priority }) => ({
    url: `${BASE_URL}${path}`,
    changeFrequency: "weekly",
    priority,
  }));
}
