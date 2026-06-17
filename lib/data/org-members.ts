/**
 * Shared read for the organization members list.
 *
 * Single source of truth for the members table the org Members page
 * renders. The org members server page calls this directly in its SSR
 * prefetch (queryKey ["org-members", orgId]) so hydration applies without
 * a fetch waterfall, and the payload matches the client useQuery shape.
 *
 * Returns a fully plain/JSON-safe object: the only non-scalar is the
 * membership `createdAt`, mapped to an ISO string here. The selected
 * relations (membership + user) are not money models, so no result
 * extension touches them and no inspect symbol is present — toPlain is
 * unnecessary.
 */

import type { MemberRole, MemberStatus } from "@prisma/client";
import prisma from "@/lib/prisma";

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

export async function getOrgMembers(
  orgId: string,
): Promise<{ members: MemberRow[] }> {
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
