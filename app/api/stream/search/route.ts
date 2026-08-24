import * as Sentry from "@sentry/nextjs";
import {
  searchUsersWithRelationships,
  upsertUsersToStream,
} from "@/actions/stream/chat/user.action";
import { NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { streamLogger } from "@/lib/stream-logger";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401 },
      );
    }

    const url = new URL(req.url);
    const searchTerm = url.searchParams.get("term");

    if (!searchTerm) {
      return NextResponse.json(
        { success: false, error: "Search term is required" },
        { status: 400 },
      );
    }

    streamLogger.debug("Searching users", { searchTerm });

    // Always use relationship-scoped search to prevent global user enumeration.
    // The action now derives identity from the session itself — the second
    // argument it used to take was a client-controlled impersonation handle.
    const users = await searchUsersWithRelationships(searchTerm);

    streamLogger.debug("Search results", { count: users.length });

    // If users are found, upsert them to Stream Chat
    if (users.length > 0) {
      try {
        const userIds = users.map((user) => user.id);
        await upsertUsersToStream(userIds);
        streamLogger.debug("Users upserted to Stream", {
          count: users.length,
        });
      } catch (upsertError) {
        Sentry.captureException(upsertError instanceof Error ? upsertError : new Error(String(upsertError)), { tags: { subsystem: "stream" } });
        streamLogger.error("User upsert to Stream failed", upsertError);
        // Continue even if upserting fails
      }
    }

    return NextResponse.json({
      success: true,
      users,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    streamLogger.error("User search failed", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
