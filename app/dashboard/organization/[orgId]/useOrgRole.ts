"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

const RANKS: Record<string, number> = {
  ORG_OWNER: 100,
  ORG_ADMIN: 80,
  ORG_MANAGER: 60,
  ORG_CONSULTANT: 40,
  ORG_SUPPORT: 30,
  ORG_LEARNER: 20,
};

interface OrgDetails {
  membership: { role: string };
}

async function fetchOrgRole(orgId: string): Promise<string> {
  const res = await fetch(`/api/organizations/${orgId}`);
  if (!res.ok) return "ORG_LEARNER";
  const data: OrgDetails = await res.json();
  return data.membership?.role ?? "ORG_LEARNER";
}

/**
 * Hook that returns the current user's role in the org and an `isAtLeast`
 * helper for role-based UI guards. Cached via react-query.
 */
export function useOrgRole(orgId: string) {
  const { data: role } = useQuery({
    queryKey: ["org-role", orgId],
    queryFn: () => fetchOrgRole(orgId),
    staleTime: 60_000,
  });

  const currentRole = role ?? "ORG_LEARNER";
  const isAtLeast = useCallback(
    (min: string) => (RANKS[currentRole] ?? 0) >= (RANKS[min] ?? 0),
    [currentRole],
  );

  return { role: currentRole, isAtLeast, isLoading: !role };
}

/**
 * Hook that redirects to the org home page if the user's role is below
 * the required minimum. Deny-by-default: `allowed` is false until the
 * role check completes AND passes. This prevents the page from rendering
 * (and firing data-fetching queries) before authorization is confirmed.
 */
export function useRequireOrgRole(orgId: string, minRole: string) {
  const { isAtLeast, isLoading } = useOrgRole(orgId);
  const router = useRouter();

  const allowed = !isLoading && isAtLeast(minRole);

  useEffect(() => {
    if (!isLoading && !isAtLeast(minRole)) {
      router.replace(`/dashboard/organization/${orgId}/home`);
    }
  }, [isLoading, isAtLeast, minRole, orgId, router]);

  return { allowed, isLoading };
}
