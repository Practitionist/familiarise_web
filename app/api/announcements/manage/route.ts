import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readPageParams } from "@/lib/backoffice/list-paging";
import type { AnnouncementPageInput } from "@/lib/backoffice/people-list-schemas";

/**
 * GET /api/announcements/manage
 * One page of every announcement, newest first, for the admin page; the public
 * GET returns only live ones, so an inactive or expired row could never be edited there.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("announcements.manage");
  if (auth.error) return auth.error;
  const { page, limit, skip } = readPageParams(req.nextUrl.searchParams, 20);
  try {
    const [announcements, total] = await Promise.all([
      prisma.announcement.findMany({
        // The id breaks a tie so a page never repeats a row.
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: limit,
      }),
      prisma.announcement.count(),
    ]);
    const body: AnnouncementPageInput = {
      success: true,
      data: announcements,
      total,
      page,
      limit,
    };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
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
