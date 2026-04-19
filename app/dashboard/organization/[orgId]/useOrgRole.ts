"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { MemberRole } from "@prisma/client";

/**
 * Numeric rank per MemberRole — higher = more privileged. Used for the
 * `isAtLeast` helper. Kept strictly typed via `Record<MemberRole, number>`
 * so that adding a new role to the Prisma enum surfaces a TS error here
 * rather than silently defaulting to rank 0.
 *
 * MEMBER is the default for any user whose role row hasn't been fetched
 * yet; it's the least-privileged role and matches the /members endpoint
 * default for self-service invitations.
 */
const RANKS: Record<MemberRole, number> = {
  OWNER: 100,
  MAINTAINER: 80,
  MANAGER: 60,
  EXPERT: 40,
  SUPPORT: 30,
  LEARNER: 20,
};

interface OrgDetailsResponse {
  membership: { role: MemberRole } | null;
}

async function fetchOrgRole(orgId: string): Promise<MemberRole> {
  const res = await fetch(`/api/organizations/${orgId}`);
  // Fail closed: any error degrades to the least-privileged role so the
  // UI hides admin-only controls rather than rendering them and letting
  // the API return 403 on click.
  if (!res.ok) return "LEARNER";
  const data = (await res.json()) as OrgDetailsResponse;
  return data.membership?.role ?? "LEARNER";
}

/**
 * Hook that returns the current user's role in the org and an `isAtLeast`
 * helper for role-based UI guards. Cached via react-query for 60 seconds
 * so sidebar / header re-renders don't thrash the API.
 */
export function useOrgRole(orgId: string) {
  const { data: role } = useQuery({
    queryKey: ["org-role", orgId],
    queryFn: () => fetchOrgRole(orgId),
    staleTime: 60_000,
  });

  const currentRole: MemberRole = role ?? "LEARNER";
  const isAtLeast = useCallback(
    (min: MemberRole) => RANKS[currentRole] >= RANKS[min],
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
export function useRequireOrgRole(orgId: string, minRole: MemberRole) {
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
