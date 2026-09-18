import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { VerificationSubmitSchema } from "@/schemas/verifications";
import { canSubmitVerification } from "@/utils/onboarding-shared";
import { applyRateLimit, verificationSubmitLimiter } from "@/lib/rate-limit";
import { notifyNewConsultantApplication } from "@/lib/novu/service";
import { attemptTrigger } from "@/lib/novu";
import { scheduleAfter } from "@/lib/api/after-safe";
import { getAppUrl } from "@/lib/url";
/**
 * POST /api/verification/submit
 * Submit verification request during onboarding or from settings
 */
export async function POST(request: NextRequest) {
  try {
    // Force-fresh (see documents route): revocation must bite immediately.
    const session = await getSession(true);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // Each submit mutates the review queue + notifies admins: 10/hr fits the
    // human submit → fix → resubmit cadence and stops queue flooding.
    const rateLimited = await applyRateLimit(
      verificationSubmitLimiter,
      `verification-submit:${session.user.id}`,
    );
    if (rateLimited) return rateLimited;

    // A malformed or empty body is the caller's fault: answer the same
    // generic 400 as a shape failure instead of letting the parser throw
    // into the 500 path (review comment on #1698).
    const raw: unknown = await request.json().catch(() => undefined);
    const parsed = VerificationSubmitSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid request body" },
        { status: 400 },
      );
    }
    const { linkedinUrl, notes, documentIds } = parsed.data;

    // Get the consultant profile, with the live role: a profile row can
    // outlive a role change, so existence alone must not authorize a
    // review-queue write (mirrors resubmit; review comment on #1698).
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: {
        user: { select: { role: true } },
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

    if (
      !canSubmitVerification({
        role: consultantProfile.user.role,
        hasConsultantProfile: true,
      })
    ) {
      return NextResponse.json(
        { success: false, error: "Only consultants can submit verification" },
        { status: 403 },
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

    // Validate document ownership before connecting — prevents reassigning
    // another consultant's documents to this verification request.
    // Deduplicate IDs first to avoid false 403 when duplicates are passed.
    const uniqueDocumentIds: string[] = documentIds?.length
      ? Array.from(new Set(documentIds as string[]))
      : [];
    if (uniqueDocumentIds.length) {
      const ownedDocs = await prisma.profileVerificationDocument.findMany({
        where: {
          id: { in: uniqueDocumentIds },
          verification: { consultantProfileId: consultantProfile.id },
        },
        select: { id: true },
      });
      if (ownedDocs.length !== uniqueDocumentIds.length) {
        return NextResponse.json(
          {
            success: false,
            error:
              "One or more document IDs do not belong to your verification request",
          },
          { status: 403 },
        );
      }
    }

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
          // Connect new documents if provided (using deduplicated + validated IDs)
          ...(uniqueDocumentIds.length && {
            documents: {
              connect: uniqueDocumentIds.map((id) => ({ id })),
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
          // Connect existing documents if provided (using deduplicated + validated IDs)
          ...(uniqueDocumentIds.length && {
            documents: {
              connect: uniqueDocumentIds.map((id) => ({ id })),
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

    // Notify admin/staff about the new verification request: the outbox
    // rows are staged before the response (two reads + one insert per
    // batch, no vendor call) and attempted in `after()`, so the response
    // never waits on the Novu budget and the rows survive without it.
    try {
      const admins = await prisma.user.findMany({
        where: { role: { in: [UserRole.ADMIN, UserRole.STAFF] } },
        select: { id: true },
      });
      const adminIds = admins.map((a) => a.id);
      if (adminIds.length > 0) {
        const user = await prisma.user.findUnique({
          where: { id: session.user.id },
          select: { name: true, email: true },
        });
        const results = await notifyNewConsultantApplication(
          adminIds,
          {
            applicantName: user?.name ?? "Unknown",
            applicantEmail: user?.email ?? "",
            dashboardUrl: `${getAppUrl()}/dashboard/admin/verification`,
          },
          { tx: prisma },
        );
        const staged = new Map(
          results.flatMap((r) =>
            r.success && r.staged ? [[r.staged.id, r.staged] as const] : [],
          ),
        );
        scheduleAfter(async () => {
          for (const row of staged.values()) await attemptTrigger(row);
        });
      }
    } catch (error) {
      console.error(
        "[verification/submit] Failed to stage notification:",
        error,
      );
    }

    return NextResponse.json({
      success: true,
      data: verification,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    console.error("Verification submit error:", error);
    // Generic on purpose: the message is Sentry's, not the client's.
    return NextResponse.json(
      { success: false, error: "Failed to submit verification" },
      { status: 500 },
    );
  }
}
