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

// Cache the active-announcements read. The banner is polled frequently and the
// data only changes on the admin writes below (which revalidate the tag), so this
// keeps the high-frequency GET off the cross-region pooler hot path (#932). `now`
// is computed inside the cached fn — not in the key — so the active-window filter
// is re-evaluated on each revalidation rather than frozen at first call.
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
    // The announcements banner is non-critical and polled often. A transient
    // pooler connect/read timeout (cross-region cold connect) should degrade to
    // an empty banner, not a 500 + error-noise — report it as a warning and
    // fail open. Real defects still surface as exceptions + 500. (FAMILIARISE_WEB-9)
    if (isTransientDbError(error)) {
      reportTransient("announcements read", error, {
        subsystem: "notifications",
      });
      // `no-store` on the degraded branch only, matching
      // app/api/user/consultants/route.ts. Not load-bearing today — the success
      // path sets no cache header and Next 15 leaves Route Handlers uncached —
      // but the two siblings disagreed and this is the safe half of the
      // disagreement. Whoever adds an s-maxage to the success path should not
      // have to also remember that a cached empty banner outlives the outage
      // that caused it. (#1125)
      const management = request.nextUrl.searchParams.get("view") === "manage";
      return NextResponse.json(
        management
          ? { success: false, error: "Announcements temporarily unavailable" }
          : { success: true, data: [] },
        {
          status: management ? 503 : 200,
          headers: management
            ? { "Cache-Control": "private, no-store", Vary: "Cookie" }
            : { "Cache-Control": "no-store" },
        },
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
