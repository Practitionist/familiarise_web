import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

/**
 * POST /api/verification/submit
 * Submit verification request during onboarding or from settings
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { linkedinUrl, notes, documentIds } = body;

    // Get the consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: {
        verificationRequests: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { success: false, error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Update user's LinkedIn URL if provided
    if (linkedinUrl) {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { linkedinUrl },
      });
    }

    // Check for the latest verification request
    const latestVerification = consultantProfile.verificationRequests[0];

    // Determine if we should update existing or create new
    const shouldUpdate =
      latestVerification &&
      (latestVerification.status === "PENDING" ||
        latestVerification.status === "NEEDS_INFO");

    let verification;

    if (shouldUpdate) {
      // Update the existing request
      verification = await prisma.consultantProfileVerification.update({
        where: { id: latestVerification.id },
        data: {
          status: "PENDING", // Reset to PENDING for review
          notes,
          reviewedAt: null, // Reset review details
          reviewedById: null,
          reviewNotes: null,
          rejectionReason: null,
          feedbackDetails: null,
          // Connect new documents if provided
          ...(documentIds?.length && {
            documents: {
              connect: documentIds.map((id: string) => ({ id })),
            },
          }),
        },
        include: {
          documents: true,
        },
      });
    } else {
      // Create a new verification request (for initial or after REJECTED/APPROVED)
      verification = await prisma.consultantProfileVerification.create({
        data: {
          consultantProfileId: consultantProfile.id,
          notes,
          status: "PENDING",
          // Connect existing documents if provided
          ...(documentIds?.length && {
            documents: {
              connect: documentIds.map((id: string) => ({ id })),
            },
          }),
        },
        include: {
          documents: true,
        },
      });
    }

    // Update consultant profile verification status
    await prisma.consultantProfile.update({
      where: { id: consultantProfile.id },
      data: {
        verificationStatus: "UNDER_REVIEW",
        isVerified: false,
      },
    });

    // TODO: Send email notification to staff about new verification request

    return NextResponse.json({
      success: true,
      data: verification,
    });
  } catch (error) {
    console.error("Verification submit error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to submit verification",
      },
      { status: 500 },
    );
  }
}
