"use client";

import { useMemo } from "react";

import { UTC_ZONE } from "./viewer-zone";
import { zoneClock, type ZoneClock } from "./zone-clock";
import { useProvidedZone } from "./zoned-format";

/**
 * The clock of the nearest `DisplayZoneProvider`: IST in the back office (its
 * layout pins it) and the viewer's profile zone on a customer support page.
 * Without a provider it prints UTC, labelled, never the browser's zone.
 */
export function useZoneClock(): ZoneClock {
  const zone = useProvidedZone() ?? UTC_ZONE;
  return useMemo(() => zoneClock(zone), [zone]);
}
