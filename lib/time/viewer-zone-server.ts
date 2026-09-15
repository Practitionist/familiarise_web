import { getSession } from "@/lib/auth-server";

import { describeViewerZone, type ViewerZone } from "./viewer-zone";

/**
 * The viewer's zone for an RSC page, read off the same session field the
 * client hook reads. Pass the result down as a prop so the server render and
 * the hydrating client format every instant from one value.
 */
export async function getViewerZone(
  fallbackZone?: string | null,
): Promise<ViewerZone> {
  const session = await getSession();
  return describeViewerZone({
    userTimezone: session?.user?.timezone ?? null,
    fallbackZone,
  });
}
