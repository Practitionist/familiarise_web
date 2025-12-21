/**
 * Stream User Synchronization Job
 *
 * This module handles Stream user synchronization - removing stale users
 * from Stream that no longer exist in the database.
 *
 * Can be used:
 * 1. As an import: import { performStreamUserSync } from './stream-sync'
 * 2. As a CLI script: npx ts-node jobs/stream-sync.ts
 */

import { StreamChat, UserResponse } from "stream-chat";
import prisma from "../lib/prisma";

// Types
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

export interface SyncOptions {
  /** Number of users to fetch per page (default: 100) */
  pageLimit?: number;
  /** Dry run mode - identify but don't delete (default: false) */
  dryRun?: boolean;
  /** Additional user IDs to exclude from deletion */
  excludeUserIds?: string[];
}

// User IDs that should never be deleted
const DEFAULT_EXCLUDED_USER_IDS = new Set(["system", "teetangh"]);

// System user prefixes that should be excluded
const SYSTEM_USER_PREFIXES = ["system-", "recording-egress-"];

/**
 * Check if a user ID should be excluded from deletion
 */
function shouldExcludeUser(
  userId: string,
  additionalExclusions?: string[],
): boolean {
  // Check default exclusions
  if (DEFAULT_EXCLUDED_USER_IDS.has(userId)) {
    return true;
  }

  // Check system prefixes
  if (SYSTEM_USER_PREFIXES.some((prefix) => userId.startsWith(prefix))) {
    return true;
  }

  // Check additional exclusions
  if (additionalExclusions?.includes(userId)) {
    return true;
  }

  return false;
}

/**
 * Get Stream Chat client instance
 * @throws Error if API keys are not configured
 */
function getStreamClient(): StreamChat {
  const streamApiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
  const streamApiSecret = process.env.STREAM_API_SECRET;

  if (!streamApiKey || !streamApiSecret) {
    throw new Error(
      "Stream API Key or Secret not configured. Set NEXT_PUBLIC_STREAM_API_KEY and STREAM_API_SECRET environment variables.",
    );
  }

  return StreamChat.getInstance(streamApiKey, streamApiSecret, {
    timeout: 30000, // 30 seconds timeout
  });
}

/**
 * Perform Stream user synchronization
 *
 * This function:
 * 1. Fetches all users from Stream (paginated)
 * 2. Compares against database users
 * 3. Deletes stale users from Stream that don't exist in database
 *
 * @param options Sync configuration options
 * @returns Summary of the synchronization operation
 */
export async function performStreamUserSync(
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const { pageLimit = 100, dryRun = false, excludeUserIds = [] } = options;

  console.log("[Stream Sync] Starting synchronization...");
  if (dryRun) {
    console.log("[Stream Sync] DRY RUN MODE - No deletions will be performed");
  }

  const serverStreamClient = getStreamClient();

  let totalStreamUsersProcessed = 0;
  let totalStaleUsersIdentified = 0;
  let totalStaleUsersDeleted = 0;
  const allFailedDeletions: FailedDeletionEntry[] = [];
  let lastStreamUserId: string | undefined = undefined;

  try {
    // Paginate through all Stream users
    // eslint-disable-next-line no-constant-condition
    while (true) {
      console.log(
        `[Stream Sync] Fetching users (after: ${lastStreamUserId || "start"})...`,
      );

      const streamUsersResponse = await serverStreamClient.queryUsers(
        lastStreamUserId ? { id: { $gt: lastStreamUserId } } : {},
        { id: 1 }, // Sort by ID for consistent pagination
        { limit: pageLimit, presence: false },
      );

      const currentPageUsers: UserResponse[] = streamUsersResponse.users;

      if (currentPageUsers.length === 0) {
        console.log("[Stream Sync] No more users to process.");
        break;
      }

      totalStreamUsersProcessed += currentPageUsers.length;
      lastStreamUserId = currentPageUsers[currentPageUsers.length - 1].id;

      console.log(
        `[Stream Sync] Processing ${currentPageUsers.length} users. Total: ${totalStreamUsersProcessed}`,
      );

      // Get IDs from current page
      const streamUserIds = currentPageUsers.map((user) => user.id);

      // Find which users exist in our database
      const activePrismaUsers = await prisma.user.findMany({
        where: { id: { in: streamUserIds } },
        select: { id: true },
      });

      const activeUserIdSet = new Set(activePrismaUsers.map((u) => u.id));

      console.log(
        `[Stream Sync] ${activeUserIdSet.size}/${streamUserIds.length} users exist in database`,
      );

      // Identify stale users (in Stream but not in database)
      const staleUsers = streamUserIds.filter((userId) => {
        if (activeUserIdSet.has(userId)) return false;
        if (shouldExcludeUser(userId, excludeUserIds)) return false;
        return true;
      });

      if (staleUsers.length === 0) {
        console.log("[Stream Sync] No stale users in this page.");
        continue;
      }

      totalStaleUsersIdentified += staleUsers.length;
      console.log(
        `[Stream Sync] Found ${staleUsers.length} stale users: ${staleUsers.slice(0, 5).join(", ")}${staleUsers.length > 5 ? "..." : ""}`,
      );

      if (dryRun) {
        console.log("[Stream Sync] Skipping deletion (dry run mode)");
        continue;
      }

      // Delete stale users from Stream
      try {
        const deleteResponse = await serverStreamClient.deleteUsers(staleUsers, {
          user: "hard",
          messages: "hard",
        });

        // Check for failed deletions
        const sdkFailedDeletions: FailedDeletionFromSDK[] =
          (deleteResponse as { failed_delete_users?: FailedDeletionFromSDK[] })
            .failed_delete_users || [];

        if (sdkFailedDeletions.length > 0) {
          const failures = sdkFailedDeletions.map((f) => ({
            id: f.user_id,
            error: f.message || "Unknown error",
          }));
          allFailedDeletions.push(...failures);
          console.warn(
            `[Stream Sync] ${failures.length} deletions failed:`,
            failures.map((f) => f.id).join(", "),
          );
        }

        const successfullyDeleted = staleUsers.length - sdkFailedDeletions.length;
        totalStaleUsersDeleted += successfullyDeleted;

        console.log(
          `[Stream Sync] Deleted ${successfullyDeleted}/${staleUsers.length} users`,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Batch deletion failed";
        console.error(`[Stream Sync] Batch deletion error: ${errorMessage}`);

        const failures = staleUsers.map((id) => ({
          id,
          error: errorMessage,
        }));
        allFailedDeletions.push(...failures);
      }
    }

    console.log("[Stream Sync] Synchronization completed successfully.");

    return {
      totalStreamUsersProcessed,
      totalStaleUsersIdentified,
      totalStaleUsersDeleted,
      totalFailedDeletions: allFailedDeletions.length,
      failedDeletionDetails: allFailedDeletions,
    };
  } catch (error) {
    console.error("[Stream Sync] Synchronization failed:", error);
    throw error;
  }
}

/**
 * Print sync summary to console
 */
export function printSyncSummary(summary: SyncSummary): void {
  console.log("\n=== Stream Sync Summary ===");
  console.log(`Total Users Processed: ${summary.totalStreamUsersProcessed}`);
  console.log(`Stale Users Identified: ${summary.totalStaleUsersIdentified}`);
  console.log(`Users Deleted: ${summary.totalStaleUsersDeleted}`);
  console.log(`Failed Deletions: ${summary.totalFailedDeletions}`);

  if (summary.failedDeletionDetails.length > 0) {
    console.log("\n--- Failed Deletions ---");
    summary.failedDeletionDetails.forEach((failure) => {
      console.log(`  ${failure.id}: ${failure.error}`);
    });
  }
}

/**
 * CLI entry point
 * Only runs when this file is executed directly
 */
async function main(): Promise<void> {
  console.log("[Stream Sync CLI] Starting...\n");

  // Validate environment
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  // Check for dry run flag
  const dryRun = process.argv.includes("--dry-run");

  try {
    const summary = await performStreamUserSync({ dryRun });
    printSyncSummary(summary);

    if (summary.totalFailedDeletions > 0) {
      console.log("\n[Stream Sync CLI] Completed with some failures.");
      process.exit(2); // Partial success
    }

    console.log("\n[Stream Sync CLI] Completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error("\n[Stream Sync CLI] Fatal error:", error);
    process.exit(1);
  }
}

// Only run main() when executed directly (not when imported)
// Check if this module is the main module being run
if (require.main === module) {
  main();
}
