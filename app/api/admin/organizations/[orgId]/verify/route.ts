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

  const { action, reason } = parsed.data;
  const newStatus = action === "APPROVE" ? "ACTIVE" : "DEACTIVATED";

  // Atomic check-and-update — prevents double-approve/reject race where two
  // admins act on the same org concurrently. The WHERE status='PENDING_VERIFICATION'
  // clause ensures count=0 if already actioned, and the update is one round-trip.
  const claimed = await prisma.organizationProfile.updateMany({
    where: {
      organization: { id: orgId },
      status: "PENDING_VERIFICATION",
    },
    data: { status: newStatus },
  });

  if (claimed.count === 0) {
    return NextResponse.json(
      { error: "Organization not found or not pending verification." },
      { status: 404 },
    );
  }

  // Non-critical read for response display — happens after the atomic update.
  const orgProfile = await prisma.organizationProfile.findFirst({
    where: { organization: { id: orgId } },
    include: { organization: { select: { name: true } } },
  });
  const orgName = orgProfile?.organization.name ?? "Unknown";

  return NextResponse.json({
    success: true,
    status: newStatus,
    message:
      action === "APPROVE"
        ? `Organization "${orgName}" has been approved.`
        : `Organization "${orgName}" has been rejected.`,
    ...(action === "REJECT" && { reason: reason || null }),
  });
}
