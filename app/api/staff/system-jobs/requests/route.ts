/**
 * GET /api/staff/system-jobs/requests — the latest admin run requests, which the
 * System Jobs panel polls while one is still REQUESTED or CLAIMED.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

const LATEST_REQUESTS = 10;

export async function GET(): Promise<NextResponse> {
  try {
    const auth = await requireBackofficeSurface("systemJobs.manage");
    if (auth.error) return auth.error;
    const requests = await prisma.adminRunRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: LATEST_REQUESTS,
      select: {
        id: true,
        job: true,
        status: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        claimedAt: true,
        finishedAt: true,
        runId: true,
      },
    });
    return NextResponse.json({ requests });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    return NextResponse.json(
      { error: "Failed to fetch run requests" },
      { status: 500 },
    );
  }
}
