/**
 * Staff Moderation Report Action API
 * Take moderation action on a report — with real side-effects (#693).
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationActionType } from "@prisma/client";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  applyTransactionalEffects,
  applyBestEffortEffects,
  type SideEffectSummary,
} from "@/lib/moderation/side-effects";
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
    const { actionType, notes, suspensionDays } = body;

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

    if (actionType === "USER_SUSPENDED") {
      if (
        !Number.isInteger(suspensionDays) ||
        suspensionDays < 1 ||
        suspensionDays > 365
      ) {
        return NextResponse.json(
          { error: "suspensionDays must be an integer between 1 and 365" },
          { status: 400 },
        );
      }
    }

    // Check report exists
    const report = await prisma.moderationReport.findUnique({
      where: { id: reportId },
      select: { id: true, status: true, targetUserId: true, reviewId: true },
    });

    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    // Idempotency: a resolved report never re-runs side-effects (a staff
    // double-click on BAN must not double-refund).
    if (report.status === "ACTION_TAKEN" || report.status === "DISMISSED") {
      return NextResponse.json(
        { error: "This report has already been resolved" },
        { status: 409 },
      );
    }

    const input = {
      actionType: actionType as ModerationActionType,
      report: {
        id: report.id,
        targetUserId: report.targetUserId,
        reviewId: report.reviewId,
      },
      staffUserId: session.user.id,
      notes,
      suspensionDays,
    };

    // Account-state side-effects commit atomically with the action row —
    // the report can never read ACTION_TAKEN while the target kept access.
    const { action, updatedReport, transactional } = await prisma.$transaction(
      async (tx) => {
        // Status re-check rides the WHERE (CAS) — two staff racing the same
        // report resolve to exactly one winner.
        const moved = await tx.moderationReport.updateMany({
          where: {
            id: reportId,
            status: { in: ["PENDING", "UNDER_REVIEW", "ESCALATED"] },
          },
          data: {
            status: actionType === "NO_ACTION" ? "DISMISSED" : "ACTION_TAKEN",
            resolvedAt: new Date(),
            resolvedBy: session.user.id,
          },
        });
        if (moved.count === 0) {
          throw Object.assign(
            new Error("This report has already been resolved"),
            { httpStatus: 409 },
          );
        }

        const action = await tx.moderationAction.create({
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
        });

        const transactional = await applyTransactionalEffects(tx, input);

        const updatedReport = await tx.moderationReport.findUniqueOrThrow({
          where: { id: reportId },
        });

        return { action, updatedReport, transactional };
      },
      { maxWait: 10000, timeout: 30000 },
    );

    // Refunds, Stream revocation, and notifications are best-effort — each
    // step's outcome (including failures) is persisted for staff visibility.
    let sideEffects: SideEffectSummary = transactional;
    try {
      sideEffects = await applyBestEffortEffects(input, transactional);
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "moderation" } },
      );
    }
    await prisma.moderationAction
      .update({
        where: { id: action.id },
        data: { sideEffects: JSON.parse(JSON.stringify(sideEffects)) },
      })
      .catch((error) => {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "moderation" } },
        );
      });

    return NextResponse.json({
      action,
      report: updatedReport,
      sideEffects,
      message: `Action '${actionType}' taken successfully`,
    });
  } catch (error) {
    if (error instanceof Error && "httpStatus" in error) {
      const status =
        typeof (error as { httpStatus?: number }).httpStatus === "number"
          ? (error as { httpStatus: number }).httpStatus
          : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error taking moderation action:", error);
    return NextResponse.json(
      { error: "Failed to take action" },
      { status: 500 },
    );
  }
}
