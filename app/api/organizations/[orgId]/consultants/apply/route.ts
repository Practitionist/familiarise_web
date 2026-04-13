/**
 * Consultant Application to PROVIDER org.
 *
 * POST /api/organizations/[orgId]/consultants/apply
 *
 * Allows an authenticated consultant to apply to join a PROVIDER/HYBRID org.
 * If org.autoApproveConsultants is true, the consultant is activated immediately.
 * Otherwise, they enter PENDING status for admin approval.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";

const applySchema = z.object({
  note: z.string().max(1000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!ENABLE_PROVIDER_ORGS) {
    return NextResponse.json(
      {
        error: "PROVIDER organizations are not yet available.",
        flag: "ENABLE_PROVIDER_ORGS",
      },
      { status: 501 },
    );
  }

  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  const { orgId } = await params;

  const body = await req.json().catch(() => ({}));
  const parsed = applySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Verify the org exists and is PROVIDER/HYBRID + ACTIVE
  const orgProfile = await prisma.organizationProfile.findFirst({
    where: {
      organization: { id: orgId },
      kind: { in: ["PROVIDER", "HYBRID"] },
      status: "ACTIVE",
    },
    include: {
      organization: { select: { id: true, name: true } },
    },
  });

  if (!orgProfile) {
    return NextResponse.json(
      { error: "Organization not found or not accepting consultant applications." },
      { status: 404 },
    );
  }

  // Verify the caller is a verified consultant
  const consultantProfile = await prisma.consultantProfile.findFirst({
    where: {
      userId: auth.session.user.id,
      isVerified: true,
    },
  });

  if (!consultantProfile) {
    return NextResponse.json(
      { error: "You must be a verified consultant to apply." },
      { status: 403 },
    );
  }

  // Check if already a member of this org
  const existingMembership = await prisma.organizationMemberProfile.findFirst({
    where: {
      organizationProfileId: orgProfile.id,
      member: { userId: auth.session.user.id },
    },
  });

  if (existingMembership) {
    return NextResponse.json(
      {
        error: "You are already a member of this organization.",
        status: existingMembership.status,
      },
      { status: 409 },
    );
  }

  const autoApprove = orgProfile.autoApproveConsultants;
  const memberStatus = autoApprove ? "ACTIVE" : "PENDING";
  const now = new Date();

  try {
  await prisma.$transaction(async (tx) => {
    // Find or create the BetterAuth Member row inside the transaction
    // to prevent TOCTOU race on concurrent applications.
    let member = await tx.member.findFirst({
      where: {
        organizationId: orgProfile.organization.id,
        userId: auth.session.user.id,
      },
    });

    if (!member) {
      member = await tx.member.create({
        data: {
          organizationId: orgProfile.organization.id,
          userId: auth.session.user.id,
          role: "member",
        },
      });
    }

    await tx.organizationMemberProfile.create({
      data: {
        memberId: member.id,
        organizationProfileId: orgProfile.id,
        role: "ORG_CONSULTANT",
        status: memberStatus,
        consultantProfileId: consultantProfile.id,
        applicationNote: parsed.data.note || null,
        appliedAt: now,
        ...(autoApprove && {
          approvedAt: now,
          approvedBy: null, // auto-approved
        }),
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationProfileId: orgProfile.id,
        actorMemberId: null, // self-application — no acting member yet
        action: autoApprove ? "CONSULTANT_APPROVED" : "CONSULTANT_APPLIED",
        description: autoApprove
          ? `Consultant ${auth.session.user.id} auto-approved`
          : `Consultant ${auth.session.user.id} applied`,
        details: {
          consultantProfileId: consultantProfile.id,
          userId: auth.session.user.id,
          autoApproved: autoApprove,
          note: parsed.data.note || null,
        },
      },
    });
  });
  } catch (error) {
    // Handle unique constraint violation from concurrent applications
    if (
      error instanceof (await import("@prisma/client")).Prisma
        .PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "You are already a member of this organization.", status: "DUPLICATE" },
        { status: 409 },
      );
    }
    throw error;
  }

  return NextResponse.json(
    {
      success: true,
      status: memberStatus,
      message: autoApprove
        ? "Application approved automatically. You are now a consultant in this organization."
        : "Application submitted. The organization admin will review your application.",
    },
    { status: 201 },
  );
}
