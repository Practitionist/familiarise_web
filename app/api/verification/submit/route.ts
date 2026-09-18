import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { VerificationSubmitSchema } from "@/schemas/verifications";
import { canSubmitVerification } from "@/utils/onboarding-shared";
import { applyRateLimit, verificationSubmitLimiter } from "@/lib/rate-limit";
import { getAppUrl } from "@/lib/url";
import {
  submitVerificationRequest,
  SUBMIT_REFUSAL_STATUS,
} from "@/lib/verification/submit-request";
import {
  attemptBellsAfterResponse,
  stageNewApplicationBells,
} from "@/lib/verification/notify-admins";

/**
 * POST /api/verification/submit
 * File (or re-file after NEEDS_INFO / REJECTED) a verification request from
 * Settings → Verification. One writer for the transition lives in
 * lib/verification/submit-request.ts; this route is auth, rate limit, body
 * shape and the notices.
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

    // A malformed body is the caller's fault: a generic 400, not a 500.
    const raw: unknown = await request.json().catch(() => undefined);
    const parsed = VerificationSubmitSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid request body" },
        { status: 400 },
      );
    }
    const { linkedinUrl, notes, documentIds } = parsed.data;

    // A profile row can outlive a role change, so existence alone must not
    // authorize a review-queue write (review comment on #1698).
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: {
        id: true,
        verificationStatus: true,
        user: { select: { role: true, name: true, email: true } },
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

    // A re-file after NEEDS_INFO or REJECTED carries the unflagged documents
    // of the previous request forward, so only what was flagged is re-uploaded.
    const outcome = await submitVerificationRequest({
      userId: session.user.id,
      consultantProfileId: consultantProfile.id,
      notes: notes ?? null,
      linkedinUrl: linkedinUrl ?? null,
      documentIds: documentIds ?? [],
      carryOver: consultantProfile.verificationStatus !== "UNDER_REVIEW",
    });
    if (!outcome.ok) {
      return NextResponse.json(
        { success: false, error: outcome.message, code: outcome.code },
        { status: SUBMIT_REFUSAL_STATUS[outcome.code] },
      );
    }

    // Admin bells: staged before the response, attempted in after().
    const staged = await stageNewApplicationBells({
      name: consultantProfile.user.name,
      email: consultantProfile.user.email,
      dashboardUrl: `${getAppUrl()}/dashboard/admin/verification`,
    });
    attemptBellsAfterResponse(staged);

    const verification = await prisma.consultantProfileVerification.findUnique({
      where: { id: outcome.verificationId },
      include: { documents: true },
    });
    return NextResponse.json({
      success: true,
      data: verification,
      round: outcome.round,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "verification" } },
    );
    console.error("Verification submit error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to submit verification" },
      { status: 500 },
    );
  }
}
