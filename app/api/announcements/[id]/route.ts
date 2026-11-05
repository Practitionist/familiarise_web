import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import prisma from "@/lib/prisma";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { UserRole } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import { UpdateAnnouncementSchema } from "@/schemas/announcements";
import { assertBodySize } from "@/lib/validation/limits";
import {
  cancelAnnouncementBells,
  stageAnnouncementBell,
} from "@/lib/announcements/notifications";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { ANNOUNCEMENTS_TAG } from "@/lib/cache-tags";
interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/announcements/[id]
 * Update an announcement (admin/staff only)
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
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

    const { id } = await params;
    const tooLarge = assertBodySize(request);
    if (tooLarge) return tooLarge;
    const parsed = UpdateAnnouncementSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      return NextResponse.json(
        {
          success: false,
          error: "Validation failed",
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.announcement.findUnique({ where: { id } });
      if (!existing) return { kind: "not_found" } as const;
      const { startDate, endDate, ...fields } = parsed.data;
      const start =
        startDate === undefined
          ? existing.startDate
          : startDate
            ? new Date(startDate)
            : null;
      const end =
        endDate === undefined
          ? existing.endDate
          : endDate
            ? new Date(endDate)
            : null;
      if (start && end && end <= start)
        return { kind: "invalid_window" } as const;
      const announcement = await tx.announcement.update({
        where: { id },
        data: { ...fields, startDate: start, endDate: end },
      });
      const staged = await stageAnnouncementBell(tx, announcement, existing);
      return { kind: "updated", announcement, staged } as const;
    });
    if (result.kind === "not_found")
      return NextResponse.json(
        { success: false, error: "Announcement not found" },
        { status: 404 },
      );
    if (result.kind === "invalid_window")
      return NextResponse.json(
        { success: false, error: "End must be after start" },
        { status: 400 },
      );
    const announcement = result.announcement;
    await flushNotificationsAfter(
      { bells: [result.staged] },
      "announcements.update",
    );

    // Invalidate the cached banner read so the edit shows immediately.
    revalidateTag(ANNOUNCEMENTS_TAG);

    return NextResponse.json({
      success: true,
      data: announcement,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Update announcement error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update announcement" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/announcements/[id]
 * Delete an announcement (admin/staff only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
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

    const { id } = await params;

    const deleted = await prisma.$transaction(async (tx) => {
      const result = await tx.announcement.deleteMany({ where: { id } });
      if (result.count === 0) return false;
      await cancelAnnouncementBells(tx, id);
      return true;
    });
    if (!deleted)
      return NextResponse.json(
        { success: false, error: "Announcement not found" },
        { status: 404 },
      );

    // Invalidate the cached banner read so the removal shows immediately.
    revalidateTag(ANNOUNCEMENTS_TAG);

    return NextResponse.json({
      success: true,
      message: "Announcement deleted successfully",
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Delete announcement error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to delete announcement" },
      { status: 500 },
    );
  }
}
