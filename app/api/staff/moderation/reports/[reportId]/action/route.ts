/**
 * Staff Moderation Report Action API
 * Take moderation action on a report
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationActionType } from "@prisma/client";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";
interface RouteParams {
  params: Promise<{ reportId: string }>;
}

/**
 * POST /api/staff/moderation/reports/[reportId]/action
 * Take moderation action on a report
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { reportId } = await params;
    const body = await req.json();
    const { actionType, notes } = body;

    // Validate action type
    const validActions: ModerationActionType[] = [
      "WARNING_ISSUED",
      "CONTENT_REMOVED",
      "USER_SUSPENDED",
      "USER_BANNED",
      "PROFILE_UNVERIFIED",
      "NO_ACTION",
    ];

    if (!actionType || !validActions.includes(actionType)) {
      return NextResponse.json(
        { error: "Invalid action type" },
        { status: 400 },
      );
    }

    // Check report exists
    const report = await prisma.moderationReport.findUnique({
      where: { id: reportId },
      select: { id: true, status: true, targetUserId: true },
    });

    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    // Create action and update report status in a transaction
    const [action, updatedReport] = await prisma.$transaction([
      prisma.moderationAction.create({
        data: {
          reportId,
          actionType,
          notes,
          takenById: session.user.id,
        },
        include: {
          takenBy: {
            select: { id: true, name: true, email: true },
          },
        },
      }),
      prisma.moderationReport.update({
        where: { id: reportId },
        data: {
          status: actionType === "NO_ACTION" ? "DISMISSED" : "ACTION_TAKEN",
          resolvedAt: new Date(),
          resolvedBy: session.user.id,
        },
      }),
    ]);

    // TODO: Execute actual actions based on actionType
    // - WARNING_ISSUED: Send warning email to user
    // - CONTENT_REMOVED: Delete/hide the reported content
    // - USER_SUSPENDED: Temporarily disable user account
    // - USER_BANNED: Permanently disable user account
    // - PROFILE_UNVERIFIED: Set consultant isVerified to false

    return NextResponse.json({
      action,
      report: updatedReport,
      message: `Action '${actionType}' taken successfully`,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error taking moderation action:", error);
    return NextResponse.json(
      { error: "Failed to take action" },
      { status: 500 },
    );
  }
}
