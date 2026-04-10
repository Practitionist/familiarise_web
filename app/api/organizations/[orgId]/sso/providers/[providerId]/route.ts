/**
 * Single SSO provider — DELETE.
 *
 * Auth: ORG_OWNER. Hard-deletes the row from BetterAuth's `ssoProvider` table.
 * The user remains signed in via their existing session — only future SSO
 * authentication attempts are affected.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string; providerId: string }> },
) {
  try {
    const { orgId, providerId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_OWNER");
    if (access.error) return access.error;

    const provider = await prisma.ssoProvider.findUnique({
      where: { id: providerId },
    });
    if (!provider || provider.organizationId !== orgId) {
      return NextResponse.json(
        { error: "Provider not found for this organization" },
        { status: 404 },
      );
    }

    await prisma.ssoProvider.delete({ where: { id: providerId } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/sso/providers/[providerId] DELETE] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to delete SSO provider" },
      { status: 500 },
    );
  }
}
