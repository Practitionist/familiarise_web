/**
 * Org-affiliated learners (BUYER + HYBRID).
 *
 * GET — any active member. Lists OrganizationMemberProfile rows where
 * role === ORG_LEARNER. Used by the learners page on BUYER dashboards.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId);
    if (access.error) return access.error;

    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
    const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0"), 0);

    const where = {
      organizationProfileId: access.org.id,
      role: "ORG_LEARNER" as const,
    };

    const [learners, total] = await Promise.all([
      prisma.organizationMemberProfile.findMany({
        where,
        include: {
          member: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.organizationMemberProfile.count({ where }),
    ]);

    return NextResponse.json({
      learners: learners.map((l) => ({
        id: l.id,
        memberId: l.memberId,
        status: l.status,
        seatAssignedAt: l.seatAssignedAt,
        createdAt: l.createdAt,
        user: l.member.user,
      })),
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error("[API /organizations/[orgId]/learners GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch learners" },
      { status: 500 },
    );
  }
}
