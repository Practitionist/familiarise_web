/**
 * Server-side prefetch helpers for the organization dashboard.
 *
 * `HydrationBoundary` wraps the client pages so `useQuery` can pick up
 * a cached result on first render instead of triggering a fetch waterfall.
 * Each helper either returns a real payload (when the SSR read is cheap
 * and matches the client query) or `null` — React Query treats `null` as
 * "no cached data" and the client falls back to its own fetch on mount.
 *
 * The payloads here match the API routes the client calls. Whenever an
 * API shape changes, update the interface here too so SSR and CSR stay
 * in lock-step.
 */

import type { MemberRole, MemberStatus } from "@prisma/client";

export interface MemberRow {
  id: string;
  role: MemberRole;
  status: MemberStatus;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

export async function prefetchOrgAnalytics(_orgId: string): Promise<null> {
  // Analytics is fetched client-side via /api/organizations/[id]/analytics.
  // Returning null short-circuits the SSR cache; the client hook re-reads
  // on mount. A real SSR implementation would call the same Prisma
  // aggregates the route does, but the route is cheap enough that the
  // cache-miss cost isn't worth the duplication.
  return null;
}

export async function prefetchOrgBilling(_orgId: string): Promise<null> {
  // Billing summary lives inside the analytics payload (wallet + invoices
  // blocks). This helper is kept only to preserve the existing
  // HydrationBoundary call site shape in app/.../home/page.tsx.
  return null;
}

export async function prefetchOrgMembers(
  orgId: string,
): Promise<{ members: MemberRow[] }> {
  const { default: prisma } = await import("@/lib/prisma");
  const rows = await prisma.membership.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      role: true,
      status: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return {
    members: rows.map((r) => ({
      id: r.id,
      role: r.role,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      user: r.user,
    })),
  };
}

export async function prefetchOrgDetails(_orgId: string): Promise<null> {
  return null;
}

export async function prefetchOrgInvitations(_orgId: string): Promise<null> {
  return null;
}
