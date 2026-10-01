"use client";

import { useQuery } from "@tanstack/react-query";

import type { BackofficeBadgeKey } from "@/lib/dashboard/backoffice-nav";
import { useBackofficeCapability } from "./BackofficeCapabilityProvider";

export type BackofficeNavCounts = Partial<Record<BackofficeBadgeKey, number>>;

/**
 * #1527 Q12 — the queue counts for the nav badges, mobile tabs and the admin
 * "Needs attention" tiles; one read per tree, a minute stale.
 */
export function useBackofficeNavCounts() {
  const { tree } = useBackofficeCapability();
  return useQuery({
    queryKey: ["backoffice-nav-counts", tree],
    queryFn: async (): Promise<BackofficeNavCounts> => {
      const res = await fetch(`/api/backoffice/nav-counts?tree=${tree}`);
      if (!res.ok) throw new Error("Failed to load queue counts");
      return ((await res.json()) as { counts: BackofficeNavCounts }).counts;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
