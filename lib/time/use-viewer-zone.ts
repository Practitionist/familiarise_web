"use client";

import { useMemo } from "react";

import { useSession } from "@/lib/auth-client";

import { describeViewerZone, type ViewerZone } from "./viewer-zone";

/**
 * The viewer's zone from the client session. Until the session resolves this
 * is the fallback zone, so a component whose text is server-rendered should
 * take the zone as a prop from the RSC page (`getViewerZone`) instead: the
 * prop is the same value on both sides, this hook is not.
 */
export function useViewerZone(fallbackZone?: string | null): ViewerZone {
  const { data: session } = useSession();
  const userTimezone = session?.user?.timezone ?? null;
  return useMemo(
    () => describeViewerZone({ userTimezone, fallbackZone }),
    [userTimezone, fallbackZone],
  );
}
