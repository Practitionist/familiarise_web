import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  NotificationPreferenceSchema,
  NotificationPreferenceUpdateSchema,
  QUIET_HOURS_DEFAULT_END,
  QUIET_HOURS_DEFAULT_START,
  type NotificationPreferenceUpdate,
} from "@/schemas/user";

import { getSession } from "@/lib/auth-server";
/**
 * GET /api/novu/preferences
 * The current user's preferences; a user with no row gets the schema defaults.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const preferences = await prisma.notificationPreference.findUnique({
      where: { userId: session.user.id },
    });

    return NextResponse.json(
      NotificationPreferenceSchema.parse(preferences ?? {}),
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Failed to fetch notification preferences:", error);
    return NextResponse.json(
      { error: "Failed to fetch preferences" },
      { status: 500 },
    );
  }
}

/** True when the update would leave quiet hours starting and ending at the same minute. */
async function quietWindowCollapses(
  userId: string,
  update: NotificationPreferenceUpdate,
): Promise<boolean> {
  const sentStart = update.quietHoursStart !== undefined;
  const sentEnd = update.quietHoursEnd !== undefined;
  if (sentStart === sentEnd) return false; // none sent, or both checked by the schema
  const stored = await prisma.notificationPreference.findUnique({
    where: { userId },
    select: { quietHoursStart: true, quietHoursEnd: true },
  });
  const start = sentStart ? update.quietHoursStart : stored?.quietHoursStart;
  const end = sentEnd ? update.quietHoursEnd : stored?.quietHoursEnd;
  return (
    (start ?? QUIET_HOURS_DEFAULT_START) === (end ?? QUIET_HOURS_DEFAULT_END)
  );
}

/**
 * PUT /api/novu/preferences
 * Updates any subset of the current user's preferences.
 */
export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: unknown = await req.json().catch(() => null);
    const result = NotificationPreferenceUpdateSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }

    const validatedData = result.data;
    if (await quietWindowCollapses(session.user.id, validatedData)) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: [
            {
              path: ["quietHoursEnd"],
              message: "Quiet hours must start and end at different times",
            },
          ],
        },
        { status: 400 },
      );
    }

    const updated = await prisma.notificationPreference.upsert({
      where: { userId: session.user.id },
      update: validatedData,
      create: {
        userId: session.user.id,
        ...validatedData,
      },
    });

    return NextResponse.json(NotificationPreferenceSchema.parse(updated));
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Failed to update notification preferences:", error);
    return NextResponse.json(
      { error: "Failed to update preferences" },
      { status: 500 },
    );
  }
}
