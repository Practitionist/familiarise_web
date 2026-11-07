import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { computeSubscriberHash } from "@/lib/novu/subscriber";

import { getSession } from "@/lib/auth-server";

/**
 * Returns the Inbox HMAC for the session user. No Novu call: Novu creates the
 * subscriber on the first Inbox session or trigger, and holds no profile data.
 */
export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const subscriberHash = computeSubscriberHash(session.user.id);
    if (!subscriberHash) {
      console.error("[Novu] Inbox secret key is not configured");
      return NextResponse.json(
        { error: "Notifications unavailable" },
        { status: 503 },
      );
    }
    return NextResponse.json({ success: true, subscriberHash });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    return NextResponse.json({ error: "Inbox auth failed" }, { status: 500 });
  }
}
