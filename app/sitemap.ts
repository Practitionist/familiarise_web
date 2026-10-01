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
    { path: "/explore/recordings", priority: 0.7 },
    { path: "/about", priority: 0.8 },
    { path: "/pricing", priority: 0.8 },
    { path: "/contactus", priority: 0.7 },
    { path: "/blog", priority: 0.6 },
    { path: "/support", priority: 0.8 },
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
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority,
  }));
}
