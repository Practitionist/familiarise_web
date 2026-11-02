"use client";

import { useQuery } from "@tanstack/react-query";
import { DashboardFacetsResponseSchema } from "@/lib/navigation/dashboard-facets-schema";
import type { RemoteFacets } from "@/lib/navigation/account-menu";

async function fetchDashboardFacets() {
  const res = await fetch("/api/user/dashboard-facets");
  if (!res.ok) throw new Error("Failed to load dashboards");
  return DashboardFacetsResponseSchema.parse(await res.json());
}

interface FacetUser {
  id?: string;
  role?: string | null;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
  orgWorkspaceProfileId?: string | null;
  staffProfileId?: string | null;
  organizationMemberships?: readonly { organizationId: string; role: string }[];
}

/**
 * The viewer's dashboard facets, fetched when the menu opens. The key carries
 * what the session knows (profiles, role, active memberships), so a change the
 * session sees refetches at once; the 30 s window bounds changes it does not
 * carry (pending or suspended memberships), re-read on the next open.
 */
export function useDashboardFacets(
  user: FacetUser | undefined,
  enabled: boolean,
): RemoteFacets {
  const memberships = (user?.organizationMemberships ?? [])
    .map((m) => `${m.organizationId}:${m.role}`)
    .join(",");
  const query = useQuery({
    queryKey: [
      "dashboard-facets",
      user?.id,
      user?.role,
      user?.consultantProfileId,
      user?.consulteeProfileId,
      user?.orgWorkspaceProfileId,
      user?.staffProfileId,
      memberships,
    ],
    queryFn: fetchDashboardFacets,
    enabled: enabled && !!user?.id,
    staleTime: 30_000,
    retry: false,
  });
  if (query.data) return { status: "ready", facets: query.data.facets };
  return query.isError ? { status: "error" } : { status: "loading" };
}
