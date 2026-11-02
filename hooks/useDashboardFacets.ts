"use client";

import { useQuery } from "@tanstack/react-query";
import { DashboardFacetsResponseSchema } from "@/lib/navigation/dashboard-facets-schema";
import type { RemoteFacets } from "@/lib/navigation/account-menu";

async function fetchDashboardFacets() {
  const res = await fetch("/api/user/dashboard-facets");
  if (!res.ok) throw new Error("Failed to load dashboards");
  return DashboardFacetsResponseSchema.parse(await res.json());
}

/** The viewer's dashboard facets, fetched the first time `enabled` turns true and kept for the session. */
export function useDashboardFacets(
  userId: string | undefined,
  enabled: boolean,
): RemoteFacets {
  const query = useQuery({
    queryKey: ["dashboard-facets", userId],
    queryFn: fetchDashboardFacets,
    enabled: enabled && !!userId,
    staleTime: Infinity,
    retry: false,
  });
  if (query.data) return { status: "ready", facets: query.data.facets };
  return query.isError ? { status: "error" } : { status: "loading" };
}
