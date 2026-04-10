/**
 * Single invitation — DELETE (revoke).
 *
 * Auth: ORG_ADMIN+. Sets status="revoked" rather than hard-deleting so the
 * audit trail survives.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string; invitationId: string }> },
) {
  try {
    const { orgId, invitationId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const invitation = await prisma.invitation.findFirst({
      where: { id: invitationId, organizationId: orgId },
    });
    if (!invitation) {
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }
    if (invitation.status !== "pending") {
      return NextResponse.json(
        { error: `Invitation is already ${invitation.status}` },
        { status: 400 },
      );
    }

    await prisma.invitation.update({
      where: { id: invitationId },
      data: { status: "revoked" },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/invitations/[invitationId] DELETE] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to revoke invitation" },
      { status: 500 },
    );
  }
}
