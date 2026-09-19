import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";

/**
 * GET /api/trials/stats
 * Returns summary counts of trial sessions grouped by status
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");

  if (!consultantProfileId) {
    return NextResponse.json(
      { error: "consultantProfileId is required" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // Non-privileged users can only view their own trial stats
  if (
    !isPrivileged(session.user.role) &&
    session.user.consultantProfileId !== consultantProfileId
  ) {
    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const counts = await prisma.trial.groupBy({
      by: ["status"],
      where: { consultantProfileId },
      _count: { status: true },
    });

    const data = Object.fromEntries(
      counts.map((c) => [c.status, c._count.status]),
    );

    return NextResponse.json({ data }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "trials" } },
    );
    console.error("Error fetching trial stats:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial stats" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
