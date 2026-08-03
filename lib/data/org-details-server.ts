import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { flattenOrgDetails, type OrgDetailsResponse } from "@/types/org-details";

/**
 * The org-details include, shared by GET /api/organizations/[orgId] and the
 * server-side seed below so the two cannot drift.
 */
export const orgDetailsInclude = {
      billingAccount: {
        select: {
          id: true,
          fundingSource: true,
          currency: true,
          walletBalance: true,
          creditLimit: true,
        },
      },
      payoutAccount: {
        select: {
          id: true,
          status: true,
          accountNumberLast4: true,
          bankName: true,
        },
      },
      _count: {
        select: {
          memberships: true,
          contracts: true,
          invoices: true,
          purchaseOrders: true,
          auditLogs: true,
        },
      },
} as const;

/**
 * Server-side org details, shaped exactly like what the client caches.
 *
 * Exists so app/dashboard/organization/[orgId]/layout.tsx can SEED
 * `orgDetailsQueryKey(orgId)`. Without that seed `useOrgRole` reads
 * `data?.membership.role ?? "LEARNER"` during SSR, fails closed, and ~15
 * components under the org tree hit `if (!allowed) return null` — so the org
 * dashboard emits no markup at all, and the prefetches already written in
 * analytics/page.tsx and members/page.tsx are dead on arrival behind that gate.
 *
 * Returns null rather than throwing when the viewer lacks access: a failed seed
 * must degrade to the client fetch, never 500 the route. Authorization is NOT
 * skipped — requireOrgAccess runs exactly as the API route runs it.
 */
export async function getOrgDetailsForSeed(
  orgId: string,
): Promise<OrgDetailsResponse | null> {
  const access = await requireOrgAccess(orgId, "LEARNER");
  if (access.error) return null;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: orgDetailsInclude,
  });
  if (!org) return null;

  return flattenOrgDetails({
    organization: org,
    membership: {
      role: access.member.role,
      status: access.member.status,
      consultantProfileId: access.member.consultantProfileId,
    },
  });
}
