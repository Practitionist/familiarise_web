/**
 * @deprecated Use GET/PUT /api/novu/preferences instead. This legacy narrow
 * API (allNotifications + mentions/directMessages/updates) has no Novu sync,
 * so edits here never reach the bell — the split-brain behind "I turned email
 * off but still got notified". Kept read-only-compatible for old clients;
 * new UI must use `components/notifications/NotificationPreferencesPanel`.
 */
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import { z } from "zod";

const DEPRECATION_HEADERS = {
  Deprecation: "true",
  Sunset: "Sat, 01 Aug 2026 00:00:00 GMT",
  Link: '</api/novu/preferences>; rel="successor-version"',
} as const;

const UpdateNotificationPreferencesSchema = z.object({
  allNotifications: z.boolean(),
  mentions: z.boolean(),
  directMessages: z.boolean(),
  updates: z.boolean(),
});

export async function GET() {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const prefs = await prisma.notificationPreference.findUnique({
      where: { userId: session.user.id },
    });

    if (!prefs) {
      return NextResponse.json(
        {
          data: {
            allNotifications: true,
            mentions: false,
            directMessages: false,
            updates: false,
          },
        },
        { status: 200, headers: DEPRECATION_HEADERS },
      );
    }

    return NextResponse.json(
      {
        data: {
          allNotifications: prefs.allNotifications,
          mentions: prefs.mentions,
          directMessages: prefs.directMessages,
          updates: prefs.updates,
        },
      },
      { headers: DEPRECATION_HEADERS },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Error fetching notification preferences:", error);
    return NextResponse.json(
      { error: "Failed to fetch notification preferences" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body" },
      { status: 400 },
    );
  }

  try {
    const result = UpdateNotificationPreferencesSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }

    const prefs = await prisma.notificationPreference.upsert({
      where: { userId: session.user.id },
      update: {
        allNotifications: result.data.allNotifications,
        mentions: result.data.mentions,
        directMessages: result.data.directMessages,
        updates: result.data.updates,
      },
      create: {
        userId: session.user.id,
        allNotifications: result.data.allNotifications,
        mentions: result.data.mentions,
        directMessages: result.data.directMessages,
        updates: result.data.updates,
      },
    });

    const response = NextResponse.json(
      {
        data: {
          allNotifications: prefs.allNotifications,
          mentions: prefs.mentions,
          directMessages: prefs.directMessages,
          updates: prefs.updates,
        },
      },
      { headers: DEPRECATION_HEADERS },
    );
    console.warn(
      "[Notifications] Legacy PUT /api/user/notification-preferences used — migrate caller to /api/novu/preferences",
    );
    return response;
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Error updating notification preferences:", error);
    return NextResponse.json(
      { error: "Failed to update notification preferences" },
      { status: 500 },
    );
  }
}
