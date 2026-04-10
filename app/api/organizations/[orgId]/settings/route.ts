/**
 * Organization settings — GET / PATCH alias of /api/organizations/[orgId].
 *
 * Kept as a separate route so the dashboard "settings" page has a stable URL
 * that doesn't tangle with the resource itself. The implementation is a thin
 * pass-through to the same Prisma logic.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId);
    if (access.error) return access.error;

    const organization = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true, logo: true },
    });
    return NextResponse.json({
      organization,
      profile: access.org,
    });
  } catch (error) {
    console.error("[API /organizations/[orgId]/settings GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 },
    );
  }
}

// PATCH delegates to the resource route by re-exporting its handler.
export { PATCH } from "../route";
