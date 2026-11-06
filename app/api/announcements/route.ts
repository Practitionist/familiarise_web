import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { unstable_cache, revalidateTag } from "next/cache";
import prisma from "@/lib/prisma";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { stageAnnouncementBell } from "@/lib/announcements/notifications";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import {
  CreateAnnouncementSchema,
  AnnouncementListQuerySchema,
} from "@/schemas/announcements";
import { ANNOUNCEMENTS_TAG } from "@/lib/cache-tags";
import { isTransientDbError, reportTransient } from "@/lib/data/fail-open";

import { getSession } from "@/lib/auth-server";
import { assertBodySize } from "@/lib/validation/limits";

// Revalidation recomputes the active window and writes invalidate this shared banner cache.
const getActiveAnnouncements = unstable_cache(
  async () => {
    const now = new Date();
    return prisma.announcement.findMany({
      where: {
        isActive: true,
        OR: [
          { startDate: null, endDate: null },
          { startDate: { lte: now }, endDate: null },
          { startDate: null, endDate: { gt: now } },
          { startDate: { lte: now }, endDate: { gt: now } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        title: true,
        content: true,
        isActive: true,
        startDate: true,
        endDate: true,
        backgroundColor: true,
        textColor: true,
        linkUrl: true,
        linkText: true,
        createdAt: true,
      },
    });
  },
  ["active-announcements"],
  { revalidate: 60, tags: [ANNOUNCEMENTS_TAG] },
);

async function getManagedAnnouncements() {
  const session = await getSession();
  if (!session?.user?.id)
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
      },
    );
  const role = z.nativeEnum(UserRole).safeParse(session.user.role);
  if (
    !role.success ||
    !hasBackofficePermission(role.data, "announcements.manage")
  )
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      {
        status: 403,
        headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
      },
    );
  const announcements = await prisma.announcement.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json(
    { success: true, data: announcements },
    { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } },
  );
}

/**
 * GET /api/announcements
 * Public endpoint to get active announcements
 */
export async function GET(request: NextRequest) {
  try {
    const query = AnnouncementListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success)
      return NextResponse.json(
        { success: false, error: "Invalid query" },
        { status: 400 },
      );
    if (query.data.view === "manage") {
      return await getManagedAnnouncements();
    }
    const announcements = await getActiveAnnouncements();

    return NextResponse.json(
      {
        success: true,
        data: announcements,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    // Public banners degrade to an empty uncached feed; management errors stay visible.
    if (isTransientDbError(error)) {
      reportTransient("announcements read", error, {
        subsystem: "notifications",
      });
      if (request.nextUrl.searchParams.get("view") === "manage")
        return NextResponse.json(
          { success: false, error: "Announcements temporarily unavailable" },
          {
            status: 503,
            headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
          },
        );
      return NextResponse.json(
        { success: true, data: [] },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Get announcements error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch announcements" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * POST /api/announcements
 * Create a new announcement (admin/staff only)
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // Announcements fan out to every user and require announcement-management permission.
    const role = z.nativeEnum(UserRole).safeParse(session.user.role);
    if (
      !role.success ||
      !hasBackofficePermission(role.data, "announcements.manage")
    ) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    // #831 — cap request body before parsing
    const tooLarge = assertBodySize(request);
    if (tooLarge) return tooLarge;

    const body = await request.json().catch(() => null);
    const result = CreateAnnouncementSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Validation failed",
          details: result.error.issues,
        },
        { status: 400 },
      );
    }
    const validatedData = result.data;

    const { announcement, staged } = await prisma.$transaction(async (tx) => {
      const announcement = await tx.announcement.create({
        data: {
          title: validatedData.title,
          content: validatedData.content,
          isActive: validatedData.isActive,
          startDate: validatedData.startDate
            ? new Date(validatedData.startDate)
            : null,
          endDate: validatedData.endDate
            ? new Date(validatedData.endDate)
            : null,
          backgroundColor: validatedData.backgroundColor,
          textColor: validatedData.textColor,
          linkUrl: validatedData.linkUrl,
          linkText: validatedData.linkText,
          createdBy: session.user.id,
        },
      });

      const staged = await stageAnnouncementBell(tx, announcement);
      return { announcement, staged };
    });
    revalidateTag(ANNOUNCEMENTS_TAG);
    await flushNotificationsAfter({ bells: [staged] }, "announcements.create");

    return NextResponse.json({
      success: true,
      data: announcement,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Create announcement error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create announcement" },
      { status: 500 },
    );
  }
}
