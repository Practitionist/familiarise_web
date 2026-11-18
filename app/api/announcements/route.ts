import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { unstable_cache, revalidateTag } from "next/cache";
import prisma from "@/lib/prisma";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import type { UserRole } from "@prisma/client";
import { stagePages } from "@/lib/novu/outbox";
import { bellAudience, MAX_BELL_AUDIENCE } from "@/lib/novu/policy";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { NOVU_WORKFLOWS, type AnnouncementPayload } from "@/lib/novu/workflows";
import { CreateAnnouncementSchema } from "@/schemas/announcements";
import { ANNOUNCEMENTS_TAG } from "@/lib/cache-tags";
import { isTransientDbError, reportTransient } from "@/lib/data/fail-open";

import { getSession } from "@/lib/auth-server";
import { assertBodySize } from "@/lib/validation/limits";
import { readJsonBody } from "@/lib/api/parse";

/** Pages attempted right after the response; the relay sends the rest. */
const INLINE_INBOX_PAGES = 5;

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
          { startDate: null, endDate: { gte: now } },
          { startDate: { lte: now }, endDate: { gte: now } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
  },
  ["active-announcements"],
  { revalidate: 60, tags: [ANNOUNCEMENTS_TAG] },
);

/**
 * GET /api/announcements
 * Public endpoint to get active announcements
 */
export async function GET() {
  try {
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
      return NextResponse.json(
        { success: true, data: [] },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Get announcements error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch announcements" },
      { status: 500 },
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

    // An announcement can ring every user's bell, so BACKOFFICE_PERMISSIONS
    // makes them ADMIN-only. The nav already hid the surface from staff; the
    // route accepted the call regardless.
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

    // #831 — cap request body before parsing
    const tooLarge = assertBodySize(request);
    if (tooLarge) return tooLarge;

    const read = await readJsonBody(request);
    if (read.error) return read.error;
    const body = read.body;
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
    const now = new Date();
    const startDate = validatedData.startDate
      ? new Date(validatedData.startDate)
      : null;
    const endDate = validatedData.endDate
      ? new Date(validatedData.endDate)
      : null;

    // An inbox post goes out at once and cannot be recalled, so it is only
    // allowed for an announcement that is live right now.
    if (
      validatedData.postToInbox &&
      (!validatedData.isActive ||
        (startDate && startDate > now) ||
        (endDate && endDate <= now))
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Only an active announcement that is live now can be posted to inboxes.",
        },
        { status: 400 },
      );
    }

    // One bounded user read and one multi-row insert, so a short explicit timeout.
    const created = await prisma.$transaction(
      async (tx) => {
        const audience = validatedData.postToInbox
          ? await bellAudience(
              tx,
              NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
              MAX_BELL_AUDIENCE,
            )
          : [];
        if (audience === null) return null;
        const announcement = await tx.announcement.create({
          data: {
            title: validatedData.title,
            content: validatedData.content,
            isActive: validatedData.isActive,
            startDate,
            endDate,
            backgroundColor: validatedData.backgroundColor,
            textColor: validatedData.textColor,
            linkUrl: validatedData.linkUrl,
            linkText: validatedData.linkText,
            createdBy: session.user.id,
          },
        });
        const payload: AnnouncementPayload = {
          title: announcement.title,
          content: announcement.content,
          ...(announcement.linkUrl ? { linkUrl: announcement.linkUrl } : {}),
          ...(announcement.linkText ? { linkText: announcement.linkText } : {}),
        };
        const bells = await stagePages(tx, {
          workflowId: NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
          recipients: audience,
          payload,
          dedupeKey: `announcement:${announcement.id}`,
          entityRef: `announcement:${announcement.id}`,
        });
        return { announcement, bells };
      },
      { timeout: 15_000, maxWait: 5_000 },
    );

    if (!created) {
      return NextResponse.json(
        {
          success: false,
          error: `Inbox posts are limited to ${MAX_BELL_AUDIENCE} users. Create the announcement without posting to inboxes.`,
        },
        { status: 422 },
      );
    }

    // Invalidate the cached banner read so the new announcement shows immediately.
    revalidateTag(ANNOUNCEMENTS_TAG);

    // The first pages ring now; the relay drains the rest after the lease.
    await flushNotificationsAfter(
      { bells: created.bells.slice(0, INLINE_INBOX_PAGES) },
      "announcements.create",
    );

    return NextResponse.json({
      success: true,
      data: created.announcement,
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
