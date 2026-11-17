import type { ReactNode } from "react";

import { getViewerZone } from "@/lib/time/viewer-zone-server";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

/**
 * Pins every support time below to the viewer's profile zone, read once on the
 * server, so the server render and hydration print the same wall clock.
 */
export async function ViewerZone({
  children,
}: Readonly<{ children: ReactNode }>) {
  const viewer = await getViewerZone();
  return (
    <DisplayZoneProvider zone={viewer.zone}>{children}</DisplayZoneProvider>
  );
}
