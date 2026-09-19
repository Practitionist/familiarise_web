import * as Sentry from "@sentry/nextjs";
import { searchUsersWithRelationships } from "@/actions/stream/chat/user.action";
import { NextRequest, NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";

import { getSession } from "@/lib/auth-server";
import { streamLogger } from "@/lib/stream-logger";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }

    const url = new URL(req.url);
    const searchTerm = url.searchParams.get("term");

    if (!searchTerm) {
      return NextResponse.json(
        { success: false, error: "Search term is required" },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    streamLogger.debug("Searching users", { searchTerm });

    // Always use relationship-scoped search to prevent global user enumeration.
    // The action now derives identity from the session itself — the second
    // argument it used to take was a client-controlled impersonation handle.
    const users = await searchUsersWithRelationships(searchTerm);

    streamLogger.debug("Search results", { count: users.length });

    // #1280 — search results are deliberately NOT upserted to Stream.
    //
    // Stream bills chat by monthly active users, and an MAU is any user who has
    // opened a WebSocket. Upserting every SEARCH RESULT put people on the meter
    // who had taken no action at all — the searcher had merely typed their
    // name. Nothing was gained by it either: every path that actually needs a
    // user to exist on Stream upserts them itself, immediately before naming
    // them, because Stream refuses an operation that references a user it does
    // not hold. See actions/stream/chat/channel.action.ts and, since #1271,
    // the video mint in actions/stream/meetings/meeting.action.ts.

    return NextResponse.json(
      {
        success: true,
        users,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("User search failed", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
