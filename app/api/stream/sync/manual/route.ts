import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { StreamChat, UserResponse } from "stream-chat"; // Added UserResponse

const streamApiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const streamApiSecret = process.env.STREAM_API_SECRET;

console.log(
  "[Stream Sync API] Stream API Key from env:",
  streamApiKey ? "Loaded" : "NOT LOADED",
);
console.log(
  "[Stream Sync API] Stream API Secret from env:",
  streamApiSecret ? "Loaded" : "NOT LOADED",
);

if (!streamApiKey || !streamApiSecret) {
  console.error(
    "Stream API Key or Secret is not defined. Ensure NEXT_PUBLIC_STREAM_API_KEY and STREAM_API_SECRET are set.",
  );
  // Consider throwing an error or exiting if these are critical for server startup
}

const serverStreamClient = StreamChat.getInstance(
  streamApiKey!,
  streamApiSecret,
  {
    timeout: 15000, // Set timeout to 15 seconds (15000 milliseconds)
  },
);

interface FailedDeletion {
  user_id: string;
  message: string;
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");
  if (secret !== process.env.STREAM_SYNC_SECRET) {
    console.warn("Unauthorized attempt to access Stream sync API route.");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log("Stream sync API route accessed successfully.");

  try {
    console.log("Fetching active users from Prisma...");
    const activePrismaUsers = await prisma.user.findMany({
      select: { id: true },
    });
    const activePrismaUserIds = new Set(
      activePrismaUsers.map((user) => user.id),
    );
    console.log(`Found ${activePrismaUserIds.size} active Prisma users.`);

    console.log("Fetching users from Stream...");
    let allStreamUsers: UserResponse[] = []; // Typed the array
    let lastStreamUserId: string | undefined = undefined;
    const limit = 100;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await serverStreamClient.queryUsers(
        lastStreamUserId ? { id: { $gt: lastStreamUserId } } : {},
        { id: 1 },
        { limit, presence: false }, // Added presence: false for efficiency
      );

      if (response.users.length === 0) break;
      allStreamUsers.push(...response.users);
      if (response.users.length < limit) break;
      lastStreamUserId = response.users[response.users.length - 1].id;
    }
    const allStreamUserIdsArray = allStreamUsers.map((user) => user.id); // Iterate over array from map
    console.log(`Found ${allStreamUserIdsArray.length} Stream users.`);

    const staleStreamUserIds: string[] = [];
    for (const streamUserId of allStreamUserIdsArray) {
      // Iterate over array
      if (!activePrismaUserIds.has(streamUserId)) {
        if (
          !streamUserId.startsWith("system-") &&
          !streamUserId.startsWith("recording-egress-")
        ) {
          staleStreamUserIds.push(streamUserId);
        }
      }
    }
    console.log(`Identified ${staleStreamUserIds.length} stale Stream users.`);

    let deletedCount = 0;
    let failedDeletions: { id: string; error: string }[] = [];

    if (staleStreamUserIds.length > 0) {
      console.log(
        `Attempting to delete ${staleStreamUserIds.length} stale users from Stream...`,
      );
      try {
        // deleteUsers returns a TaskResponse, which gives a task_id to monitor.
        // For simplicity here, we are not monitoring the task but checking immediate response if available.
        // A more robust solution would poll getTask(task_id).
        const deleteResponse = await serverStreamClient.deleteUsers(
          staleStreamUserIds,
          {
            user: "hard",
            messages: "hard",
            // conversations: 'hard' // Uncomment if 1-on-1 conversation removal is desired
          },
        );

        // The `deleteUsers` method in stream-chat SDK v8+ returns a response that includes
        // information about users that failed to be deleted directly in the response structure.
        // Example structure might be like: { ..., failed_delete_users: [{user_id: '..', message: '...'}] }
        // Let's assume `deleteResponse.failed_delete_users` is the correct path based on typical SDK patterns or simplified view.
        // If this specific field is not on TaskResponse, this part needs adjustment based on actual SDK v8 behavior.
        // For now, we count successes as total attempts minus failures reported (if any).

        const actualFailedDeletions: FailedDeletion[] =
          (deleteResponse as any).failed_delete_users || [];

        if (actualFailedDeletions.length > 0) {
          failedDeletions = actualFailedDeletions.map(
            (failure: FailedDeletion) => ({
              id: failure.user_id,
              error: failure.message || "Unknown error during deletion",
            }),
          );
        }
        deletedCount = staleStreamUserIds.length - failedDeletions.length;

        console.log(
          `Stream deletion task initiated. Successfully targeted for deletion: ${deletedCount}. Failed attempts (if reported immediately): ${failedDeletions.length}`,
        );
        if (failedDeletions.length > 0) {
          console.warn(
            "Some users could not be deleted from Stream:",
            failedDeletions,
          );
        }
      } catch (error: any) {
        Sentry.captureException(error);
        console.error(
          "Error during Stream user deletion process:",
          error.message,
        );
        // If the batch call itself fails, all are considered failed for this attempt.
        failedDeletions = staleStreamUserIds.map((id) => ({
          id,
          error: error.message || "Batch deletion API call failed",
        }));
        deletedCount = 0;
      }
    } else {
      console.log("No stale users to delete.");
    }

    return NextResponse.json(
      {
        message: "Stream user synchronization process initiated.",
        activePrismaUsers: activePrismaUserIds.size,
        totalStreamUsers: allStreamUserIdsArray.length,
        staleUsersIdentified: staleStreamUserIds.length,
        staleUsersTargetedForDeletion: deletedCount, // Renamed for clarity
        failedDeletionAttempts: failedDeletions, // Renamed for clarity
        details: {
          staleUserIdsAttempted: staleStreamUserIds,
        },
      },
      { status: 200 },
    );
  } catch (error: any) {
    Sentry.captureException(error);
    console.error("Error in Stream sync API route:", error);
    return NextResponse.json(
      { error: "Internal Server Error", details: error.message },
      { status: 500 },
    );
  }
}
