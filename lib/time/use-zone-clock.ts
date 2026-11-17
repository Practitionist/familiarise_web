"use client";

import { useMemo } from "react";

import { useViewerZone } from "./use-viewer-zone";
import { zoneClock, type ZoneClock } from "./zone-clock";
import { useProvidedZone } from "./zoned-format";

/**
 * The clock of the nearest `DisplayZoneProvider`: IST in the back office (its
 * layout pins it) and the viewer's profile zone on a customer support page.
 * Without a provider (a sheet opened over any page) it reads the session's
 * zone, else UTC, labelled; never the browser's zone.
 */
export function useZoneClock(): ZoneClock {
  const provided = useProvidedZone();
  const viewer = useViewerZone();
  const zone = provided ?? viewer.zone;
  return useMemo(() => zoneClock(zone), [zone]);
}
