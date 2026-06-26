/**
 * User-facing Content Report API
 * Allows users to report inappropriate content
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationReportType } from "@prisma/client";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import {
  assertBodySize,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/validation/limits";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";

// #831 — raw destructuring accepted unbounded strings; every user-typed
// field now carries a .max()
const CreateReportSchema = z.object({
  type: z.nativeEnum(ModerationReportType),
  reason: z.string().min(1).max(MAX_TITLE_LENGTH),
  description: z.string().max(MAX_TEXT_LENGTH).optional(),
  targetUserId: z.string().min(1).max(MAX_TITLE_LENGTH),
  contentText: z.string().max(MAX_TEXT_LENGTH).optional(),
  contentUrl: z.string().max(MAX_TITLE_LENGTH).optional(),
  reviewId: z.string().max(MAX_TITLE_LENGTH).optional(),
});

/**
 * POST /api/report
 * Submit a content report
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit: 5 reports per hour per user
    const rl = await applyRateLimit(spamLimiter, `report:${session.user.id}`);
    if (rl) return rl;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const body = await req.json();
    const parsed = CreateReportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const {
      type,
      reason,
      description,
      targetUserId,
      contentText,
      contentUrl,
      reviewId,
    } = parsed.data;

    // Validate required fields
    if (!type || !reason || !targetUserId) {
      return NextResponse.json(
        { error: "Type, reason, and targetUserId are required" },
        { status: 400 },
      );
    }

    // Validate type
    const validTypes: ModerationReportType[] = [
      "REVIEW",
      "PROFILE",
      "MESSAGE",
      "DOCUMENT",
      "OTHER",
    ];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: "Invalid report type" },
        { status: 400 },
      );
    }

    // Prevent self-reporting
    if (targetUserId === session.user.id) {
      return NextResponse.json(
        { error: "You cannot report yourself" },
        { status: 400 },
      );
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      return NextResponse.json(
        { error: "Target user not found" },
        { status: 404 },
      );
    }

    // Check for existing report from same user for same content
    const existingReport = await prisma.moderationReport.findFirst({
      where: {
        reportedById: session.user.id,
        targetUserId,
        type,
        ...(reviewId ? { reviewId } : {}),
        status: { in: ["PENDING", "UNDER_REVIEW"] },
      },
    });

    if (existingReport) {
      return NextResponse.json(
        { error: "You have already reported this content" },
        { status: 400 },
      );
    }

    // Check if there's an existing report for same content from others
    // If so, increment reportCount instead of creating new
    const similarReport = await prisma.moderationReport.findFirst({
      where: {
        targetUserId,
        type,
        ...(reviewId ? { reviewId } : {}),
        status: { in: ["PENDING", "UNDER_REVIEW"] },
      },
    });

    if (similarReport) {
      // Increment report count on existing report
      const updatedReport = await prisma.moderationReport.update({
        where: { id: similarReport.id },
        data: {
          reportCount: { increment: 1 },
        },
      });

      return NextResponse.json({
        message: "Report submitted successfully",
        reportId: updatedReport.id,
        aggregated: true,
      });
    }

    // Create new report
    const report = await prisma.moderationReport.create({
      data: {
        type,
        reason,
        description,
        reportedById: session.user.id,
        targetUserId,
        contentText,
        contentUrl,
        reviewId,
      },
    });

    return NextResponse.json(
      {
        message: "Report submitted successfully",
        reportId: report.id,
      },
      { status: 201 },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "report" } });
    console.error("Error submitting report:", error);
    return NextResponse.json(
      { error: "Failed to submit report" },
      { status: 500 },
    );
  }
}
