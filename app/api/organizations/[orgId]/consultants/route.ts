/**
 * Org-affiliated consultants (PROVIDER feature).
 *
 * GET — Lists ORG_CONSULTANT members. Supports ?status= filter for pending applications.
 * POST — Approve or reject a pending consultant application (ORG_ADMIN+).
 *
 * Gated behind ENABLE_PROVIDER_ORGS. Returns 501 when disabled.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";

function notImplemented() {
  return NextResponse.json(
    {
      error: "PROVIDER organization consultants are not yet available.",
      flag: "ENABLE_PROVIDER_ORGS",
    },
    { status: 501 },
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!ENABLE_PROVIDER_ORGS) return notImplemented();

  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const statusFilter = req.nextUrl.searchParams.get("status");
  const validStatuses = ["ACTIVE", "PENDING", "SUSPENDED", "REMOVED"] as const;
  const status =
    statusFilter && validStatuses.includes(statusFilter as (typeof validStatuses)[number])
      ? (statusFilter as (typeof validStatuses)[number])
      : undefined;

  const consultants = await prisma.organizationMemberProfile.findMany({
    where: {
      organizationProfileId: access.org.id,
      role: "ORG_CONSULTANT",
      ...(status ? { status } : {}),
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
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ consultants });
}

const approvalSchema = z.object({
  memberId: z.string().uuid(),
  action: z.enum(["APPROVE", "REJECT"]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!ENABLE_PROVIDER_ORGS) return notImplemented();

  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "ORG_ADMIN");
  if (access.error) return access.error;

  const body = await req.json();
  const parsed = approvalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { memberId, action } = parsed.data;

  // Find the pending consultant member
  const member = await prisma.organizationMemberProfile.findFirst({
    where: {
      id: memberId,
      organizationProfileId: access.org.id,
      role: "ORG_CONSULTANT",
      status: "PENDING",
    },
  });

  if (!member) {
    return NextResponse.json(
      { error: "No pending consultant application found with that ID." },
      { status: 404 },
    );
  }

  if (action === "APPROVE") {
    await prisma.organizationMemberProfile.update({
      where: { id: memberId },
      data: {
        status: "ACTIVE",
        approvedAt: new Date(),
        approvedBy: access.member.id,
      },
    });

    await prisma.orgAuditLog.create({
      data: {
        organizationProfileId: access.org.id,
        actorMemberId: access.member.id,
        action: "CONSULTANT_APPROVED",
        description: `Consultant application ${memberId} approved`,
        details: { memberId },
      },
    });

    return NextResponse.json({ success: true, status: "ACTIVE" });
  } else {
    await prisma.organizationMemberProfile.update({
      where: { id: memberId },
      data: { status: "REMOVED" },
    });

    await prisma.orgAuditLog.create({
      data: {
        organizationProfileId: access.org.id,
        actorMemberId: access.member.id,
        action: "CONSULTANT_REJECTED",
        description: `Consultant application ${memberId} rejected`,
        details: { memberId },
      },
    });

    return NextResponse.json({ success: true, status: "REMOVED" });
  }
}
