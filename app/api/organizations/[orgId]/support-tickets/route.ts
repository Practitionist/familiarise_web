/**
 * GET /api/organizations/[orgId]/support-tickets — the org Support page's
 * "Organization requests" tab (#1527): platform requests a member tagged
 * "About: <this org>". Gated on `supportRequests.org` (operations.read OR
 * billing.read); `page`, `pageSize`.
 */

import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { parsePagination } from "@/lib/enterprise/validators";
import { OrgIdParams } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";

const ORG_TICKETS_ROUTE = "organizations.support-tickets";

// ADR 20: subject and metadata only — the thread stays with the requester and the platform team.
const ORG_TICKET_SELECT = {
  id: true,
  referenceNumber: true,
  title: true,
  issueType: true,
  ownershipScope: true,
  category: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  requester: { select: { name: true } },
} satisfies Prisma.SupportCaseSelect;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const id = await parseRouteParams(OrgIdParams, params, {
    route: ORG_TICKETS_ROUTE,
  });
  if (!id.ok) return id.response;
  const { orgId } = id.data;
  try {
    const access = await requireOrgAccess(orgId, {
      readOnly: true,
      permission: "supportRequests.org",
    });
    if (access.error) return access.error;

    const { page, pageSize } = parsePagination(new URL(req.url));
    const scopes = [
      ...(hasOrgPermission(access.member.role, "supportCases.operations.manage")
        ? ["ORG_OPERATIONS" as const]
        : []),
      ...(hasOrgPermission(access.member.role, "supportCases.billing.manage")
        ? ["ORG_BILLING" as const]
        : []),
    ];
    const where: Prisma.SupportCaseWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ownershipScope: { in: scopes },
    };
    const [total, tickets] = await prisma.$transaction([
      prisma.supportCase.count({ where }),
      prisma.supportCase.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: ORG_TICKET_SELECT,
      }),
    ]);

    return NextResponse.json({
      data: tickets.map(({ requester, ...t }) => ({
        ...t,
        requesterName: requester.name,
      })),
      total,
      page,
      pageSize,
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: ORG_TICKETS_ROUTE, action: "list" },
    });
  }
}
