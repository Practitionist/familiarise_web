/**
 * Staff Moderation Stats API
 * Moderation dashboard statistics
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  PENDING_CONSULTANT_VERIFICATION_WHERE,
  PENDING_REPORT_WHERE,
} from "@/lib/backoffice/queue-predicates";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import type { ModerationStatsBody } from "@/lib/backoffice/moderation-schemas";
import { operatorPeriodStarts } from "@/lib/time/operator-zone";
import { z } from "zod";

// The ?days= window of the breakdowns: a bad value reads as 7, at most a year.
const daysSchema = z.coerce
  .number()
  .int()
  .min(1)
  .catch(7)
  .transform((n) => Math.min(n, 365));
/**
 * GET /api/staff/moderation/stats
 * Get moderation statistics
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("moderation.manage");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const days = daysSchema.parse(searchParams.get("days") ?? undefined);
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // "Resolved Today" counts from 00:00 IST, like every operator "today", not
    // from the ?days= window that drives the breakdowns below.
    const startOfToday = operatorPeriodStarts(now).day;

    // The four counters behind the stat cards. Names match the card labels and
    // the shared `ModerationStats` type exactly — they used to differ from
    // both, which is half of why every card rendered 0.
    const [pendingReports, resolvedToday, pendingProfiles, pendingReviews] =
      await Promise.all([
        // #1527 — the Moderation nav badge counts this same predicate.
        prisma.moderationReport.count({ where: PENDING_REPORT_WHERE }),
        prisma.moderationReport.count({
          where: {
            status: { in: ["DISMISSED", "ACTION_TAKEN"] },
            resolvedAt: { gte: startOfToday },
          },
        }),
        prisma.consultantProfileVerification.count({
          where: PENDING_CONSULTANT_VERIFICATION_WHERE,
        }),
        // "Reviews to Check" is a moderation queue, and a review only enters
        // one by being reported — `ConsultantReview` carries no status, flag
        // or moderatedAt column of its own. This used to be an unfiltered
        // count of every review row ever written, which is not a queue and
        // would never reach zero.
        prisma.moderationReport.count({
          where: { status: "PENDING", type: "REVIEW" },
        }),
      ]);

    // Get report type breakdown
    const reportsByType = await prisma.moderationReport.groupBy({
      by: ["type"],
      where: {
        createdAt: { gte: startDate },
      },
      _count: { id: true },
    });

    // Get action type breakdown
    const actionsByType = await prisma.moderationAction.groupBy({
      by: ["actionType"],
      where: {
        createdAt: { gte: startDate },
      },
      _count: { id: true },
    });

    const body: ModerationStatsBody = {
      stats: {
        pendingReports,
        pendingProfiles,
        pendingReviews,
        resolvedToday,
      },
      reportsByType: reportsByType.map((r) => ({
        type: r.type,
        count: r._count.id,
      })),
      actionsByType: actionsByType.map((a) => ({
        actionType: a.actionType,
        count: a._count.id,
      })),
      period: { days, startDate, endDate: now },
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error("Error fetching moderation stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch stats" },
      { status: 500 },
    );
  }
}
