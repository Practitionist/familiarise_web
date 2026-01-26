/**
 * Staff Moderation Profile Verification Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import {
  UserRole,
  ProfileVerificationStatus,
  ConsultantVerificationStatus,
} from "@prisma/client";

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
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                workExperiences: true,
                certifications: true,
                education: true,
              },
            },
            domain: { select: { id: true, name: true } },
            subDomains: { select: { id: true, name: true } },
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

interface DocumentFeedback {
  documentId: string;
  isValid: boolean;
  staffFeedback?: string;
}

/**
 * PATCH /api/staff/moderation/profiles/[verificationId]
 * Review profile verification (approve/reject) with structured feedback
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
    const {
      status,
      reviewNotes,
      rejectionReason,
      feedbackDetails,
      documentFeedback,
    } = body as {
      status: ProfileVerificationStatus;
      reviewNotes?: string;
      rejectionReason?: string;
      feedbackDetails?: string;
      documentFeedback?: DocumentFeedback[];
    };

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

    // Map verification status to consultant profile verification status
    const profileStatusMap: Record<string, ConsultantVerificationStatus> = {
      APPROVED: "VERIFIED",
      REJECTED: "REJECTED",
      NEEDS_INFO: "PENDING_VERIFICATION",
    };

    // Prepare document feedback updates
    const documentUpdates =
      documentFeedback?.map((df) =>
        prisma.profileVerificationDocument.update({
          where: { id: df.documentId },
          data: {
            isValid: df.isValid,
            staffFeedback: df.staffFeedback || null,
          },
        }),
      ) || [];

    // Update verification, documents, and optionally update consultant profile
    const [updatedVerification] = await prisma.$transaction([
      prisma.consultantProfileVerification.update({
        where: { id: verificationId },
        data: {
          status,
          reviewedAt: new Date(),
          reviewedById: session.user.id,
          reviewNotes,
          // Store rejection feedback (shown to consultant)
          rejectionReason:
            status === "REJECTED" || status === "NEEDS_INFO"
              ? rejectionReason
              : null,
          feedbackDetails:
            status === "REJECTED" || status === "NEEDS_INFO"
              ? feedbackDetails
              : null,
        },
      }),
      // Update document feedback
      ...documentUpdates,
      // Update consultant profile isVerified and verificationStatus
      ...(status === "APPROVED"
        ? [
            prisma.consultantProfile.update({
              where: { id: verification.consultantProfileId },
              data: {
                isVerified: true,
                verificationStatus: profileStatusMap[status],
              },
            }),
          ]
        : status === "REJECTED"
          ? [
              prisma.consultantProfile.update({
                where: { id: verification.consultantProfileId },
                data: {
                  isVerified: false,
                  verificationStatus: profileStatusMap[status],
                },
              }),
            ]
          : status === "NEEDS_INFO"
            ? [
                prisma.consultantProfile.update({
                  where: { id: verification.consultantProfileId },
                  data: {
                    verificationStatus: profileStatusMap[status],
                  },
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
