import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { computeSubscriberHash, syncSubscriber } from "@/lib/novu/subscriber";

import { getSession } from "@/lib/auth-server";

/**
 * Returns the session user's Inbox HMAC. The hash needs no network and Novu
 * creates missing subscribers itself, so a failed profile sync never withholds it.
 */
export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        image: true,
        timezone: true,
        orgWorkspaceProfile: { select: { notificationRoutingMode: true } },
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const subscriberHash = computeSubscriberHash(user.id);
    if (!subscriberHash) {
      console.error("[Novu] Inbox secret key is not configured");
      return NextResponse.json(
        { error: "Notifications unavailable" },
        { status: 503 },
      );
    }

    const nameParts = (user.name || "User").split(" ");
    try {
      await syncSubscriber({
        userId: user.id,
        email: user.email,
        firstName: nameParts[0],
        lastName: nameParts.slice(1).join(" ") || undefined,
        phone: user.phone || undefined,
        avatar: user.image || undefined,
        locale: "en",
        routingMode:
          user.orgWorkspaceProfile?.notificationRoutingMode ?? undefined,
      });
    } catch (syncError) {
      console.error("[Novu] Subscriber sync failed; returning hash", syncError);
      Sentry.captureException(
        syncError instanceof Error ? syncError : new Error(String(syncError)),
        {
          level: "warning",
          tags: { subsystem: "novu", op: "subscriber.sync" },
        },
      );
    }

    return NextResponse.json({ success: true, subscriberHash });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Failed to sync Novu subscriber:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
