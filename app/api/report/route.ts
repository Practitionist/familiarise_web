/**
 * User-facing Content Report API
 * Allows users to report inappropriate content
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { ModerationReportType } from "@prisma/client";

/**
 * POST /api/report
 * Submit a content report
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const {
      type,
      reason,
      description,
      targetUserId,
      contentText,
      contentUrl,
      reviewId,
    } = body;

    // Validate required fields
    if (!type || !reason || !targetUserId) {
      return NextResponse.json(
        { error: "Type, reason, and targetUserId are required" },
        { status: 400 }
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
      return NextResponse.json({ error: "Invalid report type" }, { status: 400 });
    }

    // Prevent self-reporting
    if (targetUserId === session.user.id) {
      return NextResponse.json(
        { error: "You cannot report yourself" },
        { status: 400 }
      );
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      return NextResponse.json(
        { error: "Target user not found" },
        { status: 404 }
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
        { status: 400 }
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
      { status: 201 }
    );
  } catch (error) {
    console.error("Error submitting report:", error);
    return NextResponse.json(
      { error: "Failed to submit report" },
      { status: 500 }
    );
  }
}
