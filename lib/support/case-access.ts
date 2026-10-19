import type { SupportCaseOwnership, UserRole } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";

export function caseOwnershipPermission(scope: SupportCaseOwnership): OrgSurface | null {
  if (scope === "ORG_OPERATIONS") return "supportCases.operations.manage";
  if (scope === "ORG_BILLING") return "supportCases.billing.manage";
  return null;
}

export async function canCorrespondOnCase(
  supportCase: {
    ownershipScope: SupportCaseOwnership;
    organizationId: string | null;
    submitterUserId: string;
    requesterUserId: string;
  },
  viewer: { userId: string; role: UserRole },
  db: Pick<Tx, "membership"> = prisma,
): Promise<boolean> {
  if (hasBackofficePermission(viewer.role, "tickets.manage")) return true;
  const permission = caseOwnershipPermission(supportCase.ownershipScope);
  if (!permission) return viewer.userId === supportCase.submitterUserId;
  if (!supportCase.organizationId) return false;
  const member = await db.membership.findUnique({
    where: { userId_organizationId: { userId: viewer.userId, organizationId: supportCase.organizationId } },
    select: { role: true, status: true },
  });
  return member?.status === "ACTIVE" && hasOrgPermission(member.role, permission);
}

export async function visibleCaseWhere(viewer: { userId: string; role: UserRole }) {
  if (hasBackofficePermission(viewer.role, "tickets.manage")) return { deletedAt: null };
  const memberships = await prisma.membership.findMany({
    where: { userId: viewer.userId, status: "ACTIVE" },
    select: { organizationId: true, role: true },
  });
  return {
    deletedAt: null,
    OR: [
      { ownershipScope: "PERSONAL" as const, OR: [{ submitterUserId: viewer.userId }, { requesterUserId: viewer.userId }] },
      ...memberships.flatMap((m) => [
        ...(hasOrgPermission(m.role, "supportCases.operations.manage") ? [{ ownershipScope: "ORG_OPERATIONS" as const, organizationId: m.organizationId }] : []),
        ...(hasOrgPermission(m.role, "supportCases.billing.manage") ? [{ ownershipScope: "ORG_BILLING" as const, organizationId: m.organizationId }] : []),
      ]),
    ],
  };
}
