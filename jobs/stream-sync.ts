import { StreamChat, UserResponse } from "stream-chat";
import prisma from "@/lib/prisma"; // Assuming prisma client is in lib, adjust if different

interface FailedDeletionFromSDK {
  user_id: string;
  message: string;
}

export interface FailedDeletionEntry {
  id: string;
  error: string;
}

export interface SyncSummary {
  totalStreamUsersProcessed: number;
  totalStaleUsersIdentified: number;
  totalStaleUsersDeleted: number;
  totalFailedDeletions: number;
  failedDeletionDetails: FailedDeletionEntry[];
}

const EXCLUDED_USER_IDS = new Set(["system", "teetangh"]); // Add any specific user IDs to always exclude

// Function to initialize Stream client - ensures env vars are checked
function getStreamClient() {
  const streamApiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
  const streamApiSecret = process.env.STREAM_API_SECRET;

  if (!streamApiKey || !streamApiSecret) {
    console.error(
      "[Stream Sync Job] Critical: Stream API Key or Secret is not defined in environment variables.",
    );
    throw new Error("Stream API Key or Secret not configured for sync job.");
  }

  return StreamChat.getInstance(streamApiKey!, streamApiSecret!, {
    timeout: 30000, // 30 seconds timeout
  });
}

export async function performStreamUserSync(): Promise<SyncSummary> {
  console.log("[Stream Sync Job] Starting Stream user synchronization...");
  const serverStreamClient = getStreamClient(); // Get initialized client

  let totalStreamUsersProcessed = 0;
  let totalStaleUsersIdentified = 0;
  let totalStaleUsersDeleted = 0;
  const allFailedDeletions: FailedDeletionEntry[] = [];
  let lastStreamUserId: string | undefined = undefined;
  const streamPageLimit = 100;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      console.log(
        `[Stream Sync Job] Fetching next page of Stream users (after ID: ${lastStreamUserId || "start"})...`,
      );
      const streamUsersResponse = await serverStreamClient.queryUsers(
        lastStreamUserId ? { id: { $gt: lastStreamUserId } } : {},
        { id: 1 }, // Sort by ID for consistent pagination
        { limit: streamPageLimit, presence: false },
      );

      const currentStreamPageUsers: UserResponse[] = streamUsersResponse.users;
      if (currentStreamPageUsers.length === 0) {
        console.log("[Stream Sync Job] No more Stream users to process.");
        break;
      }
      totalStreamUsersProcessed += currentStreamPageUsers.length;
      lastStreamUserId =
        currentStreamPageUsers[currentStreamPageUsers.length - 1].id;
      console.log(
        `[Stream Sync Job] Fetched ${currentStreamPageUsers.length} users in this page. Total processed so far: ${totalStreamUsersProcessed}.`,
      );

      const currentStreamUserIdsOnPage = currentStreamPageUsers.map(
        (user) => user.id,
      );

      const activePrismaUsersOnPage = await prisma.user.findMany({
        where: {
          id: { in: currentStreamUserIdsOnPage },
        },
        select: { id: true },
      });
      const activePrismaUserIdsOnPageSet = new Set(
        activePrismaUsersOnPage.map((user) => user.id),
      );
      console.log(
        `[Stream Sync Job] Found ${activePrismaUserIdsOnPageSet.size} active Prisma users among the current Stream page.`,
      );

      const staleUsersInPage: string[] = [];
      for (const streamUserId of currentStreamUserIdsOnPage) {
        if (!activePrismaUserIdsOnPageSet.has(streamUserId)) {
          if (
            !streamUserId.startsWith("system-") &&
            !streamUserId.startsWith("recording-egress-") &&
            !EXCLUDED_USER_IDS.has(streamUserId)
          ) {
            staleUsersInPage.push(streamUserId);
          }
        }
      }

      if (staleUsersInPage.length > 0) {
        totalStaleUsersIdentified += staleUsersInPage.length;
        console.log(
          `[Stream Sync Job] Identified ${staleUsersInPage.length} stale users in this page. Attempting deletion...`,
        );
        try {
          const deleteResponse = await serverStreamClient.deleteUsers(
            staleUsersInPage,
            { user: "hard", messages: "hard" },
          );

          const sdkFailedDeletions: FailedDeletionFromSDK[] =
            (deleteResponse as any).failed_delete_users || [];
          if (sdkFailedDeletions.length > 0) {
            const failures = sdkFailedDeletions.map(
              (f: FailedDeletionFromSDK) => ({
                id: f.user_id,
                error: f.message || "Unknown error",
              }),
            );
            allFailedDeletions.push(...failures);
            console.warn(
              `[Stream Sync Job] Failed to delete ${failures.length} users in this batch:`,
              failures,
            );
          }
          const successfullyDeletedInBatch =
            staleUsersInPage.length - sdkFailedDeletions.length;
          totalStaleUsersDeleted += successfullyDeletedInBatch;
          console.log(
            `[Stream Sync Job] Deletion task for batch completed. Targeted: ${staleUsersInPage.length}, Successful: ${successfullyDeletedInBatch}, Failed: ${sdkFailedDeletions.length}`,
          );
        } catch (error: any) {
          console.error(
            `[Stream Sync Job] Error during batch deletion of Stream users:`,
            error.message,
          );
          const failures = staleUsersInPage.map((id) => ({
            id,
            error: error.message || "Batch deletion API call failed",
          }));
          allFailedDeletions.push(...failures);
        }
      } else {
        console.log("[Stream Sync Job] No stale users found in this page.");
      }
    }

    console.log(
      "[Stream Sync Job] Synchronization process completed successfully.",
    );
    return {
      totalStreamUsersProcessed,
      totalStaleUsersIdentified,
      totalStaleUsersDeleted,
      totalFailedDeletions: allFailedDeletions.length,
      failedDeletionDetails: allFailedDeletions,
    };
  } catch (error: any) {
    console.error(
      "[Stream Sync Job] Overall error in synchronization process:",
      error,
    );
    // In case of an error that aborts the loop, return current stats
    // Also, rethrow or handle error appropriately for the calling context (API route vs. direct script)
    // For a direct script, you might want to process.exit(1). For an API route, this will be caught by the route handler.
    throw error; // Rethrow to be handled by the caller
  }
}
