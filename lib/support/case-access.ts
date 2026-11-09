import type {
  Prisma,
  SupportCaseOwnership,
  SupportCaseStatus,
  SupportIssueType,
  UserRole,
} from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";
import {
  deliveringPartiesByAppointment,
  presenterAppointmentWhere,
} from "./evidence-parties";

/**
 * Personal-case categories that complain about an organization or its people,
 * or report a safety risk; organization views count them but never show who raised them.
 */
export const ORG_SENSITIVE_PERSONAL_CATEGORIES = [
  "ORG_ADMIN_DISPUTE",
  "QUALITY_COMPLAINT",
  "SAFETY_CONCERN",
  "CONDUCT_REMOVAL",
  "GRIEVANCE",
  "CONSULTANT_NO_SHOW",
  "CONSULTANT_LATE",
  "SESSION_ENDED_EARLY",
  "SESSION_QUALITY_POOR",
  "WRONG_CONSULTANT",
] as const;

/** The SupportIssueType half of the same sensitive set. */
export const ORG_SENSITIVE_PERSONAL_ISSUE_TYPES = [
  "CONSULTANT_NO_SHOW",
  "CONSULTANT_LATE",
  "SESSION_ENDED_EARLY",
  "SESSION_QUALITY_POOR",
  "WRONG_CONSULTANT",
] as const satisfies readonly SupportIssueType[];

const SENSITIVE_CATEGORIES = new Set<string>(ORG_SENSITIVE_PERSONAL_CATEGORIES);
const SENSITIVE_ISSUE_TYPES = new Set<string>(
  ORG_SENSITIVE_PERSONAL_ISSUE_TYPES,
);

/** A complaint about delivery, or a safety risk, must never reach its presenter. */
export function isSensitivePresenterCase(supportCase: {
  category?: string | null;
  issueType?: SupportIssueType | null;
}): boolean {
  return (
    (typeof supportCase.category === "string" &&
      SENSITIVE_CATEGORIES.has(supportCase.category)) ||
    (typeof supportCase.issueType === "string" &&
      SENSITIVE_ISSUE_TYPES.has(supportCase.issueType))
  );
}

interface PresenterCaseFields {
  externalRequesterEmail: string | null;
  category: string | null;
  issueType: SupportIssueType | null;
  appointmentId: string | null;
}

/** Presenters read ordinary thread content only, never anonymous complaints. */
export function presenterSeesCaseThread(supportCase: {
  externalRequesterEmail: string | null;
  category: string | null;
  issueType: SupportIssueType | null;
}): boolean {
  return (
    !supportCase.externalRequesterEmail &&
    !isSensitivePresenterCase(supportCase)
  );
}

/** The list predicate for a presenter's ordinary cases, without materialising IDs. */
function presenterVisibleCaseWhere(
  userId: string,
): Prisma.SupportCaseWhereInput {
  return {
    externalRequesterEmail: null,
    AND: [
      { appointment: { is: presenterAppointmentWhere(userId) } },
      {
        OR: [
          { category: null },
          { category: { notIn: [...ORG_SENSITIVE_PERSONAL_CATEGORIES] } },
        ],
      },
      {
        OR: [
          { issueType: null },
          {
            issueType: { notIn: [...ORG_SENSITIVE_PERSONAL_ISSUE_TYPES] },
          },
        ],
      },
    ],
  };
}

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

/** Accepted PRESENTER collaborators on the case's appointment; crew never. */
export async function casePresenterIds(
  supportCase: PresenterCaseFields,
  db: Pick<Tx, "appointment" | "consultantProfile"> = prisma,
): Promise<string[]> {
  if (!supportCase.appointmentId || !presenterSeesCaseThread(supportCase))
    return [];
  const parties = await deliveringPartiesByAppointment(db, [
    supportCase.appointmentId,
  ]);
  return [...(parties.get(supportCase.appointmentId)?.presenterIds ?? [])];
}

export async function isPresenterOnCase(
  supportCase: PresenterCaseFields,
  userId: string,
  db: Pick<Tx, "appointment" | "consultantProfile"> = prisma,
): Promise<boolean> {
  return (await casePresenterIds(supportCase, db)).includes(userId);
}

/**
 * Everyone who receives thread notices: case correspondents plus accepted
 * presenters. Decision and refund fanout stays on caseCorrespondentIds.
 */
export async function caseThreadPartyIds(
  supportCase: {
    ownershipScope: SupportCaseOwnership;
    organizationId: string | null;
    submitterUserId: string;
  } & PresenterCaseFields,
  db: Pick<Tx, "appointment" | "consultantProfile" | "membership"> = prisma,
): Promise<string[]> {
  if (supportCase.externalRequesterEmail) return [];
  const correspondents = await caseCorrespondentIds(supportCase, db);
  const presenters = await casePresenterIds(supportCase, db);
  return [...new Set([...correspondents, ...presenters])];
}

/**
 * The cases a viewer may list, and whether they may correspond on each row.
 * The subject of a case someone else filed sees it (as a summary) in any scope.
 */
export async function visibleCaseAccess(viewer: {
  userId: string;
  role: UserRole | null;
}) {
  if (hasBackofficePermission(viewer.role, "tickets.manage"))
    return {
      where: { deletedAt: null },
      canCorrespond: (_row: CorrespondenceRow) => true,
      isPresenter: (_row: CorrespondenceRow) => false,
    };
  const memberships = await prisma.membership.findMany({
    where: { userId: viewer.userId, status: "ACTIVE" },
    select: { organizationId: true, role: true },
  });
  const holds = (surface: OrgSurface, organizationId: string | null) =>
    organizationId !== null &&
    memberships.some(
      (m) =>
        m.organizationId === organizationId &&
        hasOrgPermission(m.role, surface),
    );
  const isPresenter = (
    row: CorrespondenceRow,
    presenterAppointmentIds: ReadonlySet<string>,
  ) =>
    typeof row.appointmentId === "string" &&
    presenterAppointmentIds.has(row.appointmentId) &&
    presenterSeesCaseThread(row);
  return {
    where: {
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
        {
          requesterUserId: viewer.userId,
          NOT: { submitterUserId: viewer.userId },
        },
        presenterVisibleCaseWhere(viewer.userId),
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
    },
    canCorrespond: (
      row: CorrespondenceRow,
      presenterAppointmentIds: ReadonlySet<string> = new Set(),
    ) => {
      if (isPresenter(row, presenterAppointmentIds)) return true;
      const permission = caseOwnershipPermission(row.ownershipScope);
      return permission
        ? holds(permission, row.organizationId)
        : row.submitterUserId === viewer.userId;
    },
    isPresenter,
  };
}

interface CorrespondenceRow {
  ownershipScope: SupportCaseOwnership;
  organizationId: string | null;
  submitterUserId: string;
  appointmentId?: string | null;
  externalRequesterEmail: string | null;
  category: string | null;
  issueType: SupportIssueType | null;
}

export async function visibleCaseWhere(viewer: {
  userId: string;
  role: UserRole | null;
}) {
  return (await visibleCaseAccess(viewer)).where;
}

export const ORG_FILED_CASE_TITLE = "Organization support case";

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
  if (canCorrespond || viewerUserId === row.submitterUserId)
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
