/**
 * Admin Verification Detail API
 * GET /api/admin/verification/[verificationId] - Get verification details
 * PATCH /api/admin/verification/[verificationId] - Review verification (approve/reject)
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import {
  reviewVerificationDoor,
  withDownloadUrls,
} from "@/lib/verification/review-route";

interface RouteParams {
  params: Promise<{ verificationId: string }>;
}

/**
 * GET /api/admin/verification/[verificationId]
 * A request's details, with each document's ACL'd download path.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireBackofficeSurface("users.verify");
    if (auth.error) return auth.error;

    const { verificationId } = await params;

    const verification = await prisma.consultantProfileVerification.findUnique({
      where: { id: verificationId },
      include: {
        consultantProfile: {
          select: {
            ...consultantPublicScalars,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                linkedinUrl: true,
                bio: true,
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
      { tags: { subsystem: "admin" } },
    );
    console.error("Error fetching verification:", error);
    return NextResponse.json(
      { error: "Failed to fetch verification" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/admin/verification/[verificationId]
 * Decide a request (approve, reject or ask for more): an audited door with a reason.
 */
export const PATCH = reviewVerificationDoor;
