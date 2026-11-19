import type { MemberRole } from "@prisma/client";

import prisma from "@/lib/prisma";
import { auditRowScope } from "@/lib/enterprise/audit-visibility";
import { describeAuditRows } from "@/lib/enterprise/audit-describe";

/**
 * Latest audit-log rows for an org's home activity feed.
 *
 * Shape/order mirrors GET /api/organizations/[orgId]/activity (createdAt
 * desc) so the SSR-seeded ["org-activity", orgId] cache hydrates into
 * exactly what the client fetch would have returned — the home tab renders
 * without its previous post-hydration second waterfall. The API route keeps
 * its own richer filter/cursor implementation; only the feed window is
 * shared semantics. Descriptions are in words, with dates in `zone`.
 */
export async function getOrgActivityFeed(
  orgId: string,
  role: MemberRole,
  zone: string,
  limit = 5,
) {
  // Same row scope as the route (#1527): MANAGER gets no money rows.
  const rowScope = auditRowScope(role);
  if (!rowScope) return [];
  const rows = await prisma.orgAuditLog.findMany({
    where: { organizationId: orgId, AND: [rowScope] },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const descriptions = await describeAuditRows(rows, zone);
  return rows.map((r, i) => ({
    ...r,
    description: descriptions[i] ?? r.description,
  }));
}
