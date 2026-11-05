import { marketingConsentWhere } from "@/lib/compliance/marketing-policy";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  grantMarketingConsent,
  withdrawMarketingConsent,
} from "@/lib/compliance/marketing-consent";
import {
  attemptSubscriberSync,
  subscriberSyncMark,
} from "@/lib/novu/subscriber";
import {
  NotificationPreferenceSchema,
  NotificationPreferenceUpdateSchema,
} from "@/schemas/user";

import { getSession } from "@/lib/auth-server";
/**
 * GET /api/novu/preferences
 * Returns the current user's notification preferences.
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

    const response = NotificationPreferenceSchema.parse(preferences ?? {});
    if (response.marketingEmails)
      response.marketingEmails =
        (await prisma.consentArtifact.findFirst({
          where: { userId: session.user.id, ...marketingConsentWhere() },
          select: { id: true },
        })) !== null;
    return NextResponse.json(response);
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

/**
 * PUT /api/novu/preferences
 * Updates the current user's notification preferences.
 */
export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const result = NotificationPreferenceUpdateSchema.strict().safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }

    const validatedData = { ...result.data, ...subscriberSyncMark() };

    const updated = await prisma.$transaction(async (tx) => {
      if (result.data.marketingEmails === true)
        await grantMarketingConsent(tx, session.user.id);
      if (result.data.marketingEmails === false)
        await withdrawMarketingConsent(tx, session.user.id);
      const saved = await tx.notificationPreference.upsert({
        where: { userId: session.user.id },
        update: validatedData,
        create: { userId: session.user.id, ...validatedData },
      });
      const response = NotificationPreferenceSchema.parse(saved);
      if (response.marketingEmails)
        response.marketingEmails =
          (await tx.consentArtifact.findFirst({
            where: { userId: session.user.id, ...marketingConsentWhere() },
            select: { id: true },
          })) !== null;
      return response;
    });

    await attemptSubscriberSync(session.user.id).catch((error: unknown) => {
      Sentry.captureException(error, {
        level: "warning",
        tags: { subsystem: "notifications", op: "preferences.sync" },
      });
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
