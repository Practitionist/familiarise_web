/**
 * Org-affiliated consultants (PROVIDER feature).
 *
 * GET — gated behind ENABLE_PROVIDER_ORGS. Lists OrganizationMemberProfile
 * rows where role === ORG_CONSULTANT. Returns 501 with the flag name when
 * disabled.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!ENABLE_PROVIDER_ORGS) {
    return NextResponse.json(
      {
        error: "PROVIDER organization consultants are not yet available.",
        flag: "ENABLE_PROVIDER_ORGS",
      },
      { status: 501 },
    );
  }

  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const consultants = await prisma.organizationMemberProfile.findMany({
    where: {
      organizationProfileId: access.org.id,
      role: "ORG_CONSULTANT",
      status: "ACTIVE",
    },
    include: {
      member: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
      consultantProfile: {
        select: {
          id: true,
          headline: true,
          rating: true,
          isVerified: true,
        },
      },
    },
  });

  return NextResponse.json({ consultants });
}
