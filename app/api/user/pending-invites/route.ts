/**
 * GET /api/user/pending-invites
 *
 * #840 — checks whether the authenticated user's email has any pending
 * organization invitation. The onboarding role-picker fetches this before
 * rendering: if there's a pending invite, the invitee sees "You've been
 * invited" instead of being forced through Consultant/Consultee/OrgOwner
 * tiles that create unwanted profiles.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";

export async function GET() {
  const session = await getSession();
  if (!session?.user?.email) {
    return NextResponse.json({ invites: [] });
  }

  const invites = await prisma.invitation.findMany({
    where: {
      email: session.user.email.toLowerCase(),
      status: "pending",
    },
    select: {
      id: true,
      organizationId: true,
      role: true,
      createdAt: true,
      organization: {
        select: { id: true, name: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return NextResponse.json({
    invites: invites.map((inv) => ({
      invitationId: inv.id,
      organizationId: inv.organizationId,
      organizationName: inv.organization?.name ?? "Unknown",
      role: inv.role,
    })),
  });
}
