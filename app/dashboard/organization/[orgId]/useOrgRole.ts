"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { FundingSource, MemberRole } from "@prisma/client";
import {
  flattenOrgDetails,
  type OrgDetailsResponse,
  type RawOrgDetailsResponse,
} from "@/types/org-details";

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
 * Full-shape fallback returned when the API is unreachable or refuses
 * the request. Every field the layout reads (`name`, `logo`, `status`,
 * etc.) is present so the shared `["organization", orgId]` cache never
 * gets a sparse payload — a race where `useOrgRole` wins a background
 * refetch must not poison the layout's subsequent reads.
 *
 * All capability booleans are `false` so role-gated UI (invite button,
 * billing tab) stays hidden in the degraded state. `role = LEARNER` is
 * the least-privileged option, matching `isAtLeast` semantics.
 */
function failClosedOrgDetails(orgId: string): OrgDetailsResponse {
  return {
    organization: {
      id: orgId,
      name: "",
      slug: "",
      logo: null,
      status: "PENDING_VERIFICATION",
      canSponsor: false,
      canHost: false,
      fundingSource: null,
    },
    membership: { role: "LEARNER", status: "ACTIVE" },
  };
}

async function fetchOrgDetails(orgId: string): Promise<OrgDetailsResponse> {
  const res = await fetch(`/api/organizations/${orgId}`);
  // Fail closed: any error degrades to a zero-capability LEARNER view so
  // the UI hides admin-only controls rather than rendering them and
  // letting the API return 403/404 on click. We still return the full
  // `OrgDetailsResponse` shape so the shared react-query cache (keyed
  // on `["organization", orgId]`, also consumed by the org layout)
  // doesn't get a sparse payload.
  if (!res.ok) return failClosedOrgDetails(orgId);

  const raw = (await res.json()) as RawOrgDetailsResponse;
  return flattenOrgDetails(raw);
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

  const role: MemberRole = data?.membership.role ?? "LEARNER";
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
