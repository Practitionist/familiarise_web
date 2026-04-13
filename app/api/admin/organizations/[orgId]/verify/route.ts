/**
 * Admin Organization Verification
 *
 * POST /api/admin/organizations/[orgId]/verify
 *
 * Approves or rejects a PENDING_VERIFICATION organization (PROVIDER/HYBRID).
 * Admin-only endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";

const verifySchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().max(500).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;

  const { orgId } = await params;

  const body = await req.json();
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const orgProfile = await prisma.organizationProfile.findFirst({
    where: {
      organization: { id: orgId },
      status: "PENDING_VERIFICATION",
    },
    include: {
      organization: { select: { name: true } },
      members: {
        where: { role: "ORG_OWNER" },
        include: {
          member: {
            include: {
              user: { select: { email: true, name: true } },
            },
          },
        },
        take: 1,
      },
    },
  });

  if (!orgProfile) {
    return NextResponse.json(
      { error: "Organization not found or not pending verification." },
      { status: 404 },
    );
  }

  const { action, reason } = parsed.data;

  if (action === "APPROVE") {
    await prisma.organizationProfile.update({
      where: { id: orgProfile.id },
      data: { status: "ACTIVE" },
    });

    return NextResponse.json({
      success: true,
      status: "ACTIVE",
      message: `Organization "${orgProfile.organization.name}" has been approved.`,
    });
  } else {
    await prisma.organizationProfile.update({
      where: { id: orgProfile.id },
      data: { status: "DEACTIVATED" },
    });

    return NextResponse.json({
      success: true,
      status: "DEACTIVATED",
      message: `Organization "${orgProfile.organization.name}" has been rejected.`,
      reason: reason || null,
    });
  }
}
