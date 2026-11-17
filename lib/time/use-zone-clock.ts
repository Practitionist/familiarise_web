"use client";

import { useMemo, useSyncExternalStore } from "react";

import { UTC_ZONE } from "./viewer-zone";
import { zoneClock, type ZoneClock } from "./zone-clock";
import { useProvidedZone } from "./zoned-format";

const noSubscription = () => () => {};
const browserZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || null;
const noServerZone = () => null;

/**
 * The clock of the nearest `DisplayZoneProvider`: IST in the back office, the
 * viewer's profile zone on every customer dashboard (each layout mounts
 * `ViewerZone`, read on the server, so hydration prints the same text). With
 * no provider at all it reads the browser zone through Intl once hydrated,
 * labelled UTC until then.
 */
export function useZoneClock(): ZoneClock {
  const provided = useProvidedZone();
  const browser = useSyncExternalStore(
    noSubscription,
    browserZone,
    noServerZone,
  );
  const zone = provided ?? browser ?? UTC_ZONE;
  return useMemo(() => zoneClock(zone), [zone]);
}
