/**
 * Staff Moderation Profile Verification Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ConsultantVerificationStatus } from "@prisma/client";
import { attemptTrigger, notifyVerificationStatusChanged } from "@/lib/novu";
import {
  attemptOnboardingEmail,
  stageVerificationDecidedEmail,
} from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import { ReviewVerificationSchema } from "@/schemas/verifications";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";
import * as Sentry from "@sentry/nextjs";
import { recomputeProfileCompletion } from "@/lib/profiles/profile-completion";
interface RouteParams {
  params: Promise<{ verificationId: string }>;
}

/**
 * GET /api/staff/moderation/profiles/[verificationId]
 * Get verification request details
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching verification:", error);
    return NextResponse.json(
      { error: "Failed to fetch verification" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/staff/moderation/profiles/[verificationId]
 * Review profile verification (approve/reject) with structured feedback
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { verificationId } = await params;
    const body = await req.json();
    const result = ReviewVerificationSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const {
      status,
      reviewNotes,
      rejectionReason,
      feedbackDetails,
      documentFeedback,
    } = result.data;

    // Get verification with profile and user info (for notification)
    const verification = await prisma.consultantProfileVerification.findUnique({
      where: { id: verificationId },
      select: {
        consultantProfileId: true,
        consultantProfile: {
          select: {
            id: true,
            user: { select: { id: true } },
          },
        },
      },
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

    const consultantUserId = verification.consultantProfile?.user?.id;
    const profileStatus = profileStatusMap[status] || status;
    const verificationPayload = {
      status: profileStatus,
      reason: rejectionReason || feedbackDetails || undefined,
      dashboardUrl: `/dashboard/consultant/${verification.consultantProfile?.id}/settings`,
    };
    const emailStatus =
      profileStatus === "VERIFIED" ||
      profileStatus === "REJECTED" ||
      profileStatus === "PENDING_VERIFICATION"
        ? profileStatus
        : null;

    // Update verification, documents and the consultant profile, and stage
    // the consultant's bell + email in the SAME transaction (review round 2
    // on #1700): the notice rows exist iff the decision does. Vendor
    // attempts run in after() below.
    const { updatedVerification, bell, stagedEmail } =
      await prisma.$transaction(async (tx) => {
        const updatedVerification =
          await tx.consultantProfileVerification.update({
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
          });
        for (const df of documentFeedback ?? []) {
          await tx.profileVerificationDocument.update({
            where: { id: df.documentId },
            data: {
              isValid: df.isValid,
              staffFeedback: df.staffFeedback || null,
            },
          });
        }
        await tx.consultantProfile.update({
          where: { id: verification.consultantProfileId },
          data: {
            verificationStatus: profileStatusMap[status],
            ...(status === "APPROVED"
              ? { isVerified: true }
              : status === "REJECTED"
                ? { isVerified: false }
                : {}),
          },
        });
        const bell = consultantUserId
          ? await notifyVerificationStatusChanged(
              consultantUserId,
              verificationPayload,
              { tx },
            )
          : null;
        const stagedEmail =
          consultantUserId && emailStatus
            ? await stageVerificationDecidedEmail(
                {
                  userId: consultantUserId,
                  verificationId,
                  status: emailStatus,
                  reason: verificationPayload.reason,
                  dashboardUrl: verificationPayload.dashboardUrl,
                },
                tx,
              )
            : null;
        return { updatedVerification, bell, stagedEmail };
      });

    // Same publish switch as the admin verification route: VERIFIED puts the
    // consultant on the public surfaces, anything else takes them off.
    purgeExpertSurfaces(verification.consultantProfileId);
    // #698 OB-1 — the verified bit of the completion score flips here.
    await recomputeProfileCompletion(prisma, verification.consultantProfileId);

    scheduleAfter(async () => {
      if (bell?.success && bell.staged) await attemptTrigger(bell.staged);
      if (stagedEmail) await attemptOnboardingEmail(stagedEmail);
    });

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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error reviewing verification:", error);
    return NextResponse.json(
      { error: "Failed to review verification" },
      { status: 500 },
    );
  }
}
