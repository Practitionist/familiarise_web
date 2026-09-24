import { getCachedSession } from "@/lib/auth-server";

import { describeViewerZone, type ViewerZone } from "./viewer-zone";

/**
 * The viewer's zone for an RSC page, read off the same session field the
 * client hook reads. Pass the result down as a prop so the server render and
 * the hydrating client format every instant from one value.
 */
export async function getViewerZone(
  fallbackZone?: string | null,
): Promise<ViewerZone> {
  // Cosmetic display value (the viewer's own timezone preference): the
  // explicit cached read, not a missed force-fresh — see getCachedSession.
  const session = await getCachedSession();
  return describeViewerZone({
    userTimezone: session?.user?.timezone ?? null,
    fallbackZone,
  });
}
