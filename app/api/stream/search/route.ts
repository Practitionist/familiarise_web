import {
  searchUsers,
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
    const withRelationships = url.searchParams.get("relationships") === "true";

    if (!searchTerm) {
      return NextResponse.json(
        { success: false, error: "Search term is required" },
        { status: 400 },
      );
    }

    streamLogger.debug("Searching users", { searchTerm, withRelationships });

    let users;

    if (withRelationships) {
      // Use enhanced search with relationship checking
      users = await searchUsersWithRelationships(searchTerm, session.user.id);
    } else {
      // Use legacy search for backward compatibility
      users = await searchUsers(searchTerm);
    }

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
        streamLogger.warn("User upsert to Stream failed", upsertError);
        // Continue even if upserting fails
      }
    }

    return NextResponse.json({
      success: true,
      users,
    });
  } catch (error) {
    streamLogger.error("User search failed", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
