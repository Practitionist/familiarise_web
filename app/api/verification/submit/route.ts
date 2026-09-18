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

    // Every write and the admin bells' outbox rows in ONE transaction
    // (review round 2 on #1700): the queue item and its notice exist
    // together or not at all. Vendor attempts run in after() below.
    const { verification, staged } = await prisma.$transaction(async (tx) => {
      if (linkedinUrl) {
        await tx.user.update({
          where: { id: session.user.id },
          data: { linkedinUrl },
        });
      }
      const documentsConnect = uniqueDocumentIds.length
        ? { documents: { connect: uniqueDocumentIds.map((id) => ({ id })) } }
        : {};
      const verification = shouldUpdate
        ? await tx.consultantProfileVerification.update({
            where: { id: latestVerification.id },
            data: {
              status: "PENDING", // Reset to PENDING for review
              notes,
              reviewedAt: null, // Reset review details
              reviewedById: null,
              reviewNotes: null,
              rejectionReason: null,
              feedbackDetails: null,
              ...documentsConnect,
            },
            include: { documents: true },
          })
        : await tx.consultantProfileVerification.create({
            data: {
              consultantProfileId: consultantProfile.id,
              notes,
              status: "PENDING",
              ...documentsConnect,
            },
            include: { documents: true },
          });
      await tx.consultantProfile.update({
        where: { id: consultantProfile.id },
        data: { verificationStatus: "UNDER_REVIEW", isVerified: false },
      });

      const admins = await tx.user.findMany({
        where: { role: { in: [UserRole.ADMIN, UserRole.STAFF] } },
        select: { id: true },
      });
      const applicant = await tx.user.findUnique({
        where: { id: session.user.id },
        select: { name: true, email: true },
      });
      const results =
        admins.length > 0
          ? await notifyNewConsultantApplication(
              admins.map((a) => a.id),
              {
                applicantName: applicant?.name ?? "Unknown",
                applicantEmail: applicant?.email ?? "",
                dashboardUrl: `${getAppUrl()}/dashboard/admin/verification`,
              },
              { tx },
            )
          : [];
      const staged = new Map(
        results.flatMap((r) =>
          r.success && r.staged ? [[r.staged.id, r.staged] as const] : [],
        ),
      );
      return { verification, staged: Array.from(staged.values()) };
    });

    scheduleAfter(async () => {
      for (const row of staged) await attemptTrigger(row);
    });

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
