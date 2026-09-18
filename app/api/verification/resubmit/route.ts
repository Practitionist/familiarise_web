/**
 * Verification Resubmission API
 * POST /api/verification/resubmit
 * Re-files a REJECTED consultant's request with the previous request's
 * unflagged documents carried forward. Same writer as /submit
 * (lib/verification/submit-request.ts); kept as its own route because the
 * dashboard's REJECTED gate links here with notes only.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { UserRole, ConsultantVerificationStatus } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, verificationSubmitLimiter } from "@/lib/rate-limit";
import { getAppUrl } from "@/lib/url";
import {
  submitVerificationRequest,
  SUBMIT_REFUSAL_STATUS,
} from "@/lib/verification/submit-request";
import { attemptBellsAfterResponse } from "@/lib/verification/notify-admins";

const resubmitSchema = z.object({
  notes: z.string().max(2000).optional(),
  documentIds: z.array(z.string().min(1)).max(10).optional(),
});

export async function POST(req: NextRequest) {
  try {
    // Force-fresh (see documents route): revocation must bite immediately.
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Shares the submit bucket: resubmit is the same review-queue write.
    const rateLimited = await applyRateLimit(
      verificationSubmitLimiter,
      `verification-submit:${session.user.id}`,
    );
    if (rateLimited) return rateLimited;

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        role: true,
        consultantProfile: { select: { id: true, verificationStatus: true } },
      },
    });
    if (user?.role !== UserRole.CONSULTANT) {
      return NextResponse.json(
        { error: "Only consultants can resubmit verification" },
        { status: 403 },
      );
    }
    if (!user.consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }
    if (
      user.consultantProfile.verificationStatus !==
      ConsultantVerificationStatus.REJECTED
    ) {
      return NextResponse.json(
        { error: "Verification can only be resubmitted after rejection" },
        { status: 400 },
      );
    }

    const raw: unknown = await req.json().catch(() => undefined);
    const parseResult = resubmitSchema.safeParse(raw);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }
    const { notes, documentIds } = parseResult.data;

    const outcome = await submitVerificationRequest({
      userId: session.user.id,
      consultantProfileId: user.consultantProfile.id,
      notes: notes || "Resubmission after addressing feedback",
      documentIds: documentIds ?? [],
      carryOver: true,
      adminDashboardUrl: `${getAppUrl()}/dashboard/admin/verification`,
    });
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.message, code: outcome.code },
        { status: SUBMIT_REFUSAL_STATUS[outcome.code] },
      );
    }

    // Admin bells were staged inside the submission transaction.
    attemptBellsAfterResponse(outcome.staged);

    return NextResponse.json({
      success: true,
      message: "Verification resubmitted successfully",
      verificationId: outcome.verificationId,
      round: outcome.round,
    });
  } catch (error) {
    console.error("Error resubmitting verification:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "verification" } },
    );
    return NextResponse.json(
      { error: "Failed to resubmit verification" },
      { status: 500 },
    );
  }
}
