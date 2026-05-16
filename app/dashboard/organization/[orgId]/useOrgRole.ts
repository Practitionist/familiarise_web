"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { FundingSource, MemberRole } from "@prisma/client";
import {
  fetchOrgDetails,
  orgDetailsQueryKey,
} from "@/lib/api/organizations/org-details";
import {
  isAtLeastRole,
  canSeeFinanceSurface,
  canSeeOperatorSurface,
} from "@/lib/auth/role-ranks";

/**
 * Hook that returns the current user's role in the org and an `isAtLeast`
 * helper for role-based UI guards. Cached via react-query for 60 seconds
 * so sidebar / header re-renders don't thrash the API. The capability
 * booleans are exposed as side-information for pages that want to branch
 * on them without a second fetch.
 *
 * Fails closed at the hook level — when `data` is undefined (loading or
 * error), every capability reads as `false` and `role` resolves to
 * LEARNER. This is intentional: role-gated UI stays hidden while we
 * don't know the answer, and a surfaced API error degrades to the
 * least-privileged state instead of leaking admin buttons. The earlier
 * implementation wrote a "fail-closed stub" payload into the shared
 * react-query cache on error, which could poison the org layout's
 * subsequent reads — we now keep the fallback at the consumer layer so
 * the cache only ever holds real API payloads.
 *
 * The queryFn + queryKey are imported from
 * `lib/api/organizations/org-details.ts` so this hook shares a single
 * in-flight request with the org layout. React-Query dedupes on the
 * shared key.
 */
export function useOrgRole(orgId: string) {
  const { data, isLoading } = useQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    staleTime: 60_000,
  });

  const role: MemberRole = data?.membership.role ?? "LEARNER";
  const canSponsor = data?.organization.canSponsor ?? false;
  const canHost = data?.organization.canHost ?? false;
  const fundingSource = data?.organization.fundingSource ?? null;

  const isAtLeast = useCallback(
    (min: MemberRole) => isAtLeastRole(role, min),
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

/**
 * Finance-surface page guard. Allows OWNER + MAINTAINER + BILLING_ADMIN
 * + MANAGER through. Rejects EXPERT / LEARNER / SUPPORT. Mirrors the
 * `canSeeFinanceSurface` predicate in lib/auth/role-ranks.ts.
 *
 * Why a dedicated hook rather than reusing `useRequireOrgRole`: the
 * rank ladder treats BILLING_ADMIN as above MANAGER (rank 70 vs 60),
 * so `useRequireOrgRole(orgId, "BILLING_ADMIN")` would refuse MANAGER
 * access to read-only views the role description explicitly grants.
 * The finance-surface set is governance-orthogonal, not a rank
 * floor — keeping it as its own predicate avoids that trap.
 */
export function useRequireFinanceSurface(orgId: string): {
  allowed: boolean;
  isLoading: boolean;
} {
  const { role, isLoading } = useOrgRole(orgId);
  const router = useRouter();

  const passes = canSeeFinanceSurface(role);
  const allowed = !isLoading && passes;

  useEffect(() => {
    if (!isLoading && !passes) {
      router.replace(`/dashboard/organization/${orgId}/home`);
    }
  }, [isLoading, passes, orgId, router]);

  return { allowed, isLoading };
}

/**
 * Operator-surface page guard. Allows OWNER + MAINTAINER + MANAGER +
 * SUPPORT through and rejects BILLING_ADMIN — the latter has no
 * member/booking/governance remit per the role description. Used by
 * pages that the BILLING_ADMIN sidebar fix hides; this hook is the
 * server-side counterpart so a direct URL bypass also rejects.
 */
export function useRequireOperatorSurface(orgId: string): {
  allowed: boolean;
  isLoading: boolean;
} {
  const { role, isLoading } = useOrgRole(orgId);
  const router = useRouter();

  const passes = canSeeOperatorSurface(role);
  const allowed = !isLoading && passes;

  useEffect(() => {
    if (!isLoading && !passes) {
      router.replace(`/dashboard/organization/${orgId}/home`);
    }
  }, [isLoading, passes, orgId, router]);

  return { allowed, isLoading };
}
