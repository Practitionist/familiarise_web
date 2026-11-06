import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import type { UserRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";

const MANAGE_LIST_LIMIT = 100;

/**
 * GET /api/announcements/manage
 * Every announcement, newest first, for the admin page; the public GET returns
 * only live ones, so an inactive or expired row could never be edited there.
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
    const announcements = await prisma.announcement.findMany({
      orderBy: { createdAt: "desc" },
      take: MANAGE_LIST_LIMIT,
    });
    return NextResponse.json(
      { success: true, data: announcements },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    return NextResponse.json(
      { success: false, error: "Failed to fetch announcements" },
      { status: 500 },
    );
  }
}
