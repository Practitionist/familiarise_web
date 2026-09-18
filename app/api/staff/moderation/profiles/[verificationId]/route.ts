/**
 * Staff Moderation Profile Verification Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";
import {
  handleReviewPatch,
  withDownloadUrls,
} from "@/lib/verification/review-route";
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

    return NextResponse.json({
      verification: {
        ...verification,
        documents: withDownloadUrls(verification.documents),
      },
    });
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
    return await handleReviewPatch(req, verificationId, session.user.id);
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
