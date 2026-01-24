/**
 * Staff Moderation Profile Verification Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole, ProfileVerificationStatus } from "@prisma/client";

interface RouteParams {
  params: Promise<{ verificationId: string }>;
}

/**
 * GET /api/staff/moderation/profiles/[verificationId]
 * Get verification request details
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { verificationId } = await params;

    const verification = await prisma.consultantProfileVerification.findUnique({
      where: { id: verificationId },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: { id: true, name: true, email: true, image: true },
            },
            domain: { select: { id: true, name: true } },
            subDomains: { select: { id: true, name: true } },
            workExperiences: true,
            certifications: true,
            education: true,
          },
        },
        documents: true,
      },
    });

    if (!verification) {
      return NextResponse.json(
        { error: "Verification not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ verification });
  } catch (error) {
    console.error("Error fetching verification:", error);
    return NextResponse.json(
      { error: "Failed to fetch verification" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/staff/moderation/profiles/[verificationId]
 * Review profile verification (approve/reject)
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { verificationId } = await params;
    const body = await req.json();
    const { status, reviewNotes } = body;

    // Validate status
    const validStatuses: ProfileVerificationStatus[] = [
      "APPROVED",
      "REJECTED",
      "NEEDS_INFO",
    ];

    if (!status || !validStatuses.includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    // Get verification with profile
    const verification = await prisma.consultantProfileVerification.findUnique({
      where: { id: verificationId },
      select: { consultantProfileId: true },
    });

    if (!verification) {
      return NextResponse.json(
        { error: "Verification not found" },
        { status: 404 },
      );
    }

    // Update verification and optionally update consultant profile
    const [updatedVerification] = await prisma.$transaction([
      prisma.consultantProfileVerification.update({
        where: { id: verificationId },
        data: {
          status,
          reviewedAt: new Date(),
          reviewedById: session.user.id,
          reviewNotes,
        },
      }),
      // If approved, update consultant profile isVerified
      ...(status === "APPROVED"
        ? [
            prisma.consultantProfile.update({
              where: { id: verification.consultantProfileId },
              data: { isVerified: true },
            }),
          ]
        : status === "REJECTED"
          ? [
              prisma.consultantProfile.update({
                where: { id: verification.consultantProfileId },
                data: { isVerified: false },
              }),
            ]
          : []),
    ]);

    return NextResponse.json({
      verification: updatedVerification,
      message:
        status === "APPROVED"
          ? "Profile approved and verified"
          : status === "REJECTED"
            ? "Profile verification rejected"
            : "More information requested",
    });
  } catch (error) {
    console.error("Error reviewing verification:", error);
    return NextResponse.json(
      { error: "Failed to review verification" },
      { status: 500 },
    );
  }
}
