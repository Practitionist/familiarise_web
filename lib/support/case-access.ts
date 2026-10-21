import type {
  SupportCaseOwnership,
  SupportCaseStatus,
  UserRole,
} from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";

/**
 * Personal-case categories that complain about an organization or its people;
 * organization views count them but never show who raised them.
 */
export const ORG_SENSITIVE_PERSONAL_CATEGORIES = [
  "ORG_ADMIN_DISPUTE",
  "QUALITY_COMPLAINT",
  "GRIEVANCE",
  "CONSULTANT_NO_SHOW",
  "CONSULTANT_LATE",
  "SESSION_ENDED_EARLY",
  "SESSION_QUALITY_POOR",
  "WRONG_CONSULTANT",
] as const;

export function caseOwnershipPermission(
  scope: SupportCaseOwnership,
): OrgSurface | null {
  if (scope === "ORG_OPERATIONS") return "supportCases.operations.manage";
  if (scope === "ORG_BILLING") return "supportCases.billing.manage";
  return null;
}

export async function canCorrespondOnCase(
  supportCase: {
    externalRequesterEmail?: string | null;
    ownershipScope: SupportCaseOwnership;
    organizationId: string | null;
    submitterUserId: string;
    requesterUserId: string;
  },
  viewer: { userId: string; role: UserRole | null },
  db: Pick<Tx, "membership"> = prisma,
): Promise<boolean> {
  if (hasBackofficePermission(viewer.role, "tickets.manage")) return true;
  if (supportCase.externalRequesterEmail) return false;
  const permission = caseOwnershipPermission(supportCase.ownershipScope);
  if (!permission) return viewer.userId === supportCase.submitterUserId;
  if (!supportCase.organizationId) return false;
  const member = await db.membership.findUnique({
    where: {
      userId_organizationId: {
        userId: viewer.userId,
        organizationId: supportCase.organizationId,
      },
    },
    select: { role: true, status: true },
  });
  return (
    member?.status === "ACTIVE" && hasOrgPermission(member.role, permission)
  );
}

export async function caseCorrespondentIds(
  supportCase: {
    ownershipScope: SupportCaseOwnership;
    organizationId: string | null;
    submitterUserId: string;
    externalRequesterEmail?: string | null;
  },
  db: Pick<Tx, "membership"> = prisma,
): Promise<string[]> {
  if (supportCase.externalRequesterEmail) return [];
  const permission = caseOwnershipPermission(supportCase.ownershipScope);
  if (!permission) return [supportCase.submitterUserId];
  if (!supportCase.organizationId) return [];
  const members = await db.membership.findMany({
    where: { organizationId: supportCase.organizationId, status: "ACTIVE" },
    select: { userId: true, role: true },
  });
  return members
    .filter((member) => hasOrgPermission(member.role, permission))
    .map((member) => member.userId);
}

export async function visibleCaseWhere(viewer: {
  userId: string;
  role: UserRole | null;
}) {
  if (hasBackofficePermission(viewer.role, "tickets.manage"))
    return { deletedAt: null };
  const memberships = await prisma.membership.findMany({
    where: { userId: viewer.userId, status: "ACTIVE" },
    select: { organizationId: true, role: true },
  });
  return {
    deletedAt: null,
    externalRequesterEmail: null,
    OR: [
      {
        ownershipScope: "PERSONAL" as const,
        OR: [
          { submitterUserId: viewer.userId },
          { requesterUserId: viewer.userId },
        ],
      },
      ...memberships.flatMap((m) => [
        ...(hasOrgPermission(m.role, "supportCases.operations.manage")
          ? [
              {
                ownershipScope: "ORG_OPERATIONS" as const,
                organizationId: m.organizationId,
              },
            ]
          : []),
        ...(hasOrgPermission(m.role, "supportCases.billing.manage")
          ? [
              {
                ownershipScope: "ORG_BILLING" as const,
                organizationId: m.organizationId,
              },
            ]
          : []),
      ]),
    ],
  };
}

/**
 * For a row already filtered by `visibleCaseWhere`: org-scope rows passed the
 * membership grant there, so only personal rows need the submitter check.
 */
export function canCorrespondOnVisibleCase(
  supportCase: {
    ownershipScope: SupportCaseOwnership;
    submitterUserId: string;
  },
  viewerUserId: string,
): boolean {
  return (
    supportCase.ownershipScope !== "PERSONAL" ||
    supportCase.submitterUserId === viewerUserId
  );
}

export const ORG_FILED_CASE_TITLE = "Organization support request";

export interface OrgFiledCaseSummary {
  id: string;
  referenceNumber: string;
  status: SupportCaseStatus;
  category: string | null;
  createdAt: Date;
  organizationId: string | null;
  requesterUserId: string;
  submitterUserId: null;
  title: typeof ORG_FILED_CASE_TITLE;
  filedByOrganizationNotice: true;
}

/**
 * The one non-staff projection rule: a member who is the subject of a case
 * someone else filed, and cannot correspond on it, sees only a summary.
 */
export function projectCaseForViewer<
  T extends {
    id: string;
    referenceNumber: string;
    status: SupportCaseStatus;
    category: string | null;
    createdAt: Date;
    organizationId: string | null;
    requesterUserId: string;
    submitterUserId: string;
  },
>(
  row: T,
  viewerUserId: string,
  canCorrespond: boolean,
):
  | { summaryOnly: true; summary: OrgFiledCaseSummary }
  | {
      summaryOnly: false;
      row: T;
    } {
  if (
    canCorrespond ||
    row.requesterUserId === row.submitterUserId ||
    viewerUserId === row.submitterUserId
  )
    return { summaryOnly: false, row };
  return {
    summaryOnly: true,
    summary: {
      id: row.id,
      referenceNumber: row.referenceNumber,
      status: row.status,
      category: row.category,
      createdAt: row.createdAt,
      organizationId: row.organizationId,
      requesterUserId: row.requesterUserId,
      submitterUserId: null,
      title: ORG_FILED_CASE_TITLE,
      filedByOrganizationNotice: true,
    },
  };
}
