import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import type { UserRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { bellAudience, MAX_BELL_AUDIENCE } from "@/lib/novu/policy";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";

/**
 * GET /api/announcements/audience
 * How many users an inbox post would ring right now, for the create dialog's
 * confirmation; `eligible` is null when the audience is over the cap.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  if (
    !hasBackofficePermission(
      session.user.role as UserRole,
      "announcements.manage",
    )
  ) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 },
    );
  }
  try {
    const audience = await bellAudience(
      prisma,
      NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
      MAX_BELL_AUDIENCE,
    );
    return NextResponse.json(
      {
        success: true,
        data: { eligible: audience?.length ?? null, cap: MAX_BELL_AUDIENCE },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    return NextResponse.json(
      { success: false, error: "Failed to count the inbox audience" },
      { status: 500 },
    );
  }
}
