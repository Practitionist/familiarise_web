"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { FundingSource, MemberRole } from "@prisma/client";

/**
 * Numeric rank per MemberRole — higher = more privileged. Used for the
 * `isAtLeast` helper. Kept strictly typed via `Record<MemberRole, number>`
 * so that adding a new role to the Prisma enum surfaces a TS error here
 * rather than silently defaulting to rank 0.
 *
 * LEARNER is the default for any user whose role row hasn't been fetched
 * yet; it's the least-privileged role and matches the self-service
 * invitation default used elsewhere in the wizard + members API.
 */
const RANKS: Record<MemberRole, number> = {
  OWNER: 100,
  MAINTAINER: 80,
  MANAGER: 60,
  EXPERT: 40,
  SUPPORT: 30,
  LEARNER: 20,
};

/**
 * Shape returned by `GET /api/organizations/[orgId]`. Kept in one place
 * so the role hook + the capability hook don't drift: if the API shape
 * changes, every caller of these hooks compiles-errors until the type is
 * updated.
 */
interface OrgDetailsResponse {
  organization: {
    canSponsor: boolean;
    canHost: boolean;
    fundingSource: FundingSource | null;
  };
  membership: { role: MemberRole } | null;
}

async function fetchOrgDetails(orgId: string): Promise<OrgDetailsResponse> {
  const res = await fetch(`/api/organizations/${orgId}`);
  // Fail closed: any error degrades to a zero-capability LEARNER view so
  // the UI hides admin-only controls rather than rendering them and
  // letting the API return 403/404 on click.
  if (!res.ok) {
    return {
      organization: { canSponsor: false, canHost: false, fundingSource: null },
      membership: { role: "LEARNER" },
    };
  }
  return (await res.json()) as OrgDetailsResponse;
}

const ORG_DETAILS_QUERY_KEY = (orgId: string) =>
  ["organization", orgId] as const;

/**
 * Hook that returns the current user's role in the org and an `isAtLeast`
 * helper for role-based UI guards. Cached via react-query for 60 seconds
 * so sidebar / header re-renders don't thrash the API. The capability
 * booleans are exposed as side-information for pages that want to branch
 * on them without a second fetch.
 */
export function useOrgRole(orgId: string) {
  const { data, isLoading } = useQuery({
    queryKey: ORG_DETAILS_QUERY_KEY(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    staleTime: 60_000,
  });

  const role: MemberRole = data?.membership?.role ?? "LEARNER";
  const canSponsor = data?.organization.canSponsor ?? false;
  const canHost = data?.organization.canHost ?? false;
  const fundingSource = data?.organization.fundingSource ?? null;

  const isAtLeast = useCallback(
    (min: MemberRole) => RANKS[role] >= RANKS[min],
    [role],
  );

  return {
    role,
    canSponsor,
    canHost,
    fundingSource,
    isAtLeast,
    isLoading,
  };
}

/**
 * Policy gate a page can pass to {@link useRequireOrgAccess}. Mirrors
 * `OrgCapabilityGate` in lib/auth-helpers.ts — what the UI hides, the
 * API refuses to serve, and vice-versa.
 */
export interface OrgAccessGate {
  minRole: MemberRole;
  canSponsor?: true;
  canHost?: true;
  fundingSource?: FundingSource;
}

/**
 * Role + capability gate for a dashboard page. Redirects to /home on any
 * mismatch so a direct URL bypass can't render a page that the sidebar
 * correctly hides. `allowed` is `false` until the org payload arrives
 * AND every gate passes — page bodies should early-return `null` while
 * loading to avoid firing downstream queries the user can't consume.
 */
export function useRequireOrgAccess(
  orgId: string,
  gate: OrgAccessGate,
): { allowed: boolean; isLoading: boolean } {
  const { role, canSponsor, canHost, fundingSource, isLoading, isAtLeast } =
    useOrgRole(orgId);
  const router = useRouter();

  const passes =
    isAtLeast(gate.minRole) &&
    (gate.canSponsor !== true || canSponsor) &&
    (gate.canHost !== true || canHost) &&
    (!gate.fundingSource || fundingSource === gate.fundingSource);

  const allowed = !isLoading && passes;

  useEffect(() => {
    if (!isLoading && !passes) {
      router.replace(`/dashboard/organization/${orgId}/home`);
    }
  }, [isLoading, passes, orgId, router]);

  // Suppress unused-variable warning for `role` — kept in the hook's
  // return value for callers that want to branch on it directly.
  void role;

  return { allowed, isLoading };
}

/**
 * Thin wrapper around {@link useRequireOrgAccess} for the common
 * "role-only" page guard. Existing callers keep compiling; new pages
 * should prefer `useRequireOrgAccess` so capability gates stay
 * first-class instead of an afterthought.
 */
export function useRequireOrgRole(orgId: string, minRole: MemberRole) {
  return useRequireOrgAccess(orgId, { minRole });
}
