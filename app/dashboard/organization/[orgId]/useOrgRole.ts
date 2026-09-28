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
  hasAnyOrgPermission,
  hasOrgPermission,
  type OrgSurface,
} from "@/lib/auth/org-permissions";

/**
 * Hook that returns the current user's role in the org and a `can` helper
 * that reads the org permission matrix, the same keys the API routes gate
 * on (#1851). Cached via react-query for 60 seconds
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
  // #1527 decision 6 — a SUSPENDED member holds no grant; the shell renders
  // only so they can reach their booked sessions.
  const suspended = data?.membership.status === "SUSPENDED";
  const canSponsor = data?.organization.canSponsor ?? false;
  const canHost = data?.organization.canHost ?? false;
  const fundingSource = data?.organization.fundingSource ?? null;

  /**
   * #1132 / #1851 — the only role check. The rank ladder cannot express the
   * operations/finance track split: BILLING_ADMIN sits at rank 70, below
   * MAINTAINER, so a rank floor on a money control hides it from the one role
   * that exists to use it, even though the route authorises it.
   */
  const can = useCallback(
    (surface: OrgSurface) => !suspended && hasOrgPermission(role, surface),
    [role, suspended],
  );

  return {
    role,
    suspended,
    canSponsor,
    canHost,
    fundingSource,
    can,
    isLoading,
  };
}

/**
 * Policy gate a page can pass to {@link useRequireOrgAccess}. Mirrors
 * `OrgCapabilityGate` in lib/auth-helpers.ts — what the UI hides, the
 * API refuses to serve, and vice-versa.
 */
export interface OrgAccessGate {
  /** Key from the org permission matrix — expresses the
   *  operations/finance track split the rank ladder cannot. A list is
   *  any-of, matching `requireOrgAccess` (#1527). */
  permission?: OrgSurface | readonly OrgSurface[];
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
  const { role, suspended, canSponsor, canHost, fundingSource, isLoading } =
    useOrgRole(orgId);
  const router = useRouter();

  // Every gated page is closed to a SUSPENDED member (#1527 decision 6).
  const passes =
    !suspended &&
    (!gate.permission || hasAnyOrgPermission(role, gate.permission)) &&
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
