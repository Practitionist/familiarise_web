import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { computeSubscriberHash, syncSubscriber } from "@/lib/novu/subscriber";

import { getSession } from "@/lib/auth-server";

/** Syncs the current authenticated user to Novu and returns HMAC subscriberHash when configured. */
export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const synced = await syncSubscriber(user.id);
    if (!synced)
      return NextResponse.json(
        { error: "Notifications temporarily unavailable" },
        { status: 503 },
      );

    const subscriberHash = computeSubscriberHash(user.id);
    return NextResponse.json({
      success: true,
      ...(subscriberHash ? { subscriberHash } : {}),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Failed to sync Novu subscriber:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
