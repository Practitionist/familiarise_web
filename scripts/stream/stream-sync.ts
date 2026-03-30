/**
 * Stream User Sync - Core Logic
 *
 * Identifies and soft-deletes stale Stream Chat users that no longer exist in the database.
 * Uses distributed locking via Redis to prevent concurrent runs.
 *
 * Features:
 * - Pagination for large user sets
 * - Dry-run mode for testing
 * - Comprehensive error handling
 * - Rate limiting between batch deletions
 *
 * This module exports the core function.
 * It is imported by:
 * - jobs/stream/stream-sync.ts (GitHub Actions)
 * - app/api/cleanup/stream-sync/route.ts (API endpoint)
 *
 * Schedule: Daily at 03:30 UTC (9:00 AM IST)
 */

import { StreamChat, UserResponse } from "stream-chat";
import prisma from "../../lib/prisma";
import { acquireLock, releaseLock, withCircuitBreaker } from "../../lib/redis";

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
  success: boolean;
  totalStreamUsersProcessed: number;
  totalStaleUsersIdentified: number;
  totalStaleUsersDeleted: number;
  totalFailedDeletions: number;
  failedDeletionDetails: FailedDeletionEntry[];
  timestamp: string;
}

export interface SyncOptions {
  /** Number of users to fetch per page (default: 100) */
  pageLimit?: number;
  /** Dry run mode - identify but don't delete (default: false) */
  dryRun?: boolean;
  /** Additional user IDs to exclude from deletion */
  excludeUserIds?: string[];
  /** Delay between batch deletions in ms (default: 500) */
  batchDelayMs?: number;
  /** Fail if lock cannot be acquired (default: false) */
  requireLock?: boolean;
}

// User IDs that should never be deleted (from env or defaults)
function getExcludedUserIds(): Set<string> {
  const envExcluded = process.env.STREAM_SYNC_EXCLUDED_USERS || "";
  const excluded = new Set(["system"]);

  if (envExcluded) {
    envExcluded.split(",").forEach((id) => {
      const trimmed = id.trim();
      if (trimmed) excluded.add(trimmed);
    });
  }

  return excluded;
}

// System user prefixes that should be excluded
const SYSTEM_USER_PREFIXES = ["system-", "recording-egress-"];

// Distributed lock configuration
const SYNC_LOCK_KEY = "stream-sync:lock";
const SYNC_LOCK_TTL = 10 * 60 * 1000; // 10 minutes max runtime

/**
 * Check if a user ID should be excluded from deletion
 */
function shouldExcludeUser(
  userId: string,
  excludedSet: Set<string>,
  additionalExclusions?: string[],
): boolean {
  // Check default exclusions
  if (excludedSet.has(userId)) {
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
  const streamApiKey = process.env.STREAM_API_KEY;
  const streamApiSecret = process.env.STREAM_API_SECRET;

  if (!streamApiKey || !streamApiSecret) {
    throw new Error(
      "Stream API Key or Secret not configured. Set STREAM_API_KEY and STREAM_API_SECRET environment variables.",
    );
  }

  return StreamChat.getInstance(streamApiKey, streamApiSecret, {
    timeout: 30000, // 30 seconds timeout
  });
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform Stream user synchronization
 *
 * This function:
 * 1. Acquires distributed lock to prevent concurrent runs
 * 2. Fetches all users from Stream (paginated)
 * 3. Compares against database users
 * 4. Deletes stale users from Stream that don't exist in database
 * 5. Releases lock on completion
 *
 * @param options Sync configuration options
 * @returns Summary of the synchronization operation
 */
export async function performStreamUserSync(
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const {
    pageLimit = 100,
    dryRun = false,
    excludeUserIds = [],
    batchDelayMs = 500,
    requireLock = false,
  } = options;

  const excludedSet = getExcludedUserIds();

  // Acquire distributed lock to prevent concurrent runs
  let lockToken: string | null = null;
  try {
    lockToken = await withCircuitBreaker(
      () => acquireLock(SYNC_LOCK_KEY, SYNC_LOCK_TTL),
      () => null, // Fallback if Redis is down
    );
  } catch (error) {
    console.warn(
      "⚠️ Failed to acquire lock, proceeding without distributed lock:",
      error,
    );
  }

  if (lockToken === null) {
    const message =
      "Could not acquire lock - sync may already be in progress or Redis unavailable";
    if (requireLock) {
      throw new Error(message);
    }
    console.warn(`⚠️ ${message}`);
  } else {
    console.log("🔒 Acquired distributed lock");
  }

  console.log("🔄 Starting Stream user synchronization...");
  if (dryRun) {
    console.log("🧪 DRY RUN MODE - No deletions will be performed");
  }

  const serverStreamClient = getStreamClient();

  let totalStreamUsersProcessed = 0;
  let totalStaleUsersIdentified = 0;
  let totalStaleUsersDeleted = 0;
  const allFailedDeletions: FailedDeletionEntry[] = [];
  let lastStreamUserId: string | undefined = undefined;

  try {
    // Paginate through all Stream users
    while (true) {
      console.log(
        `   Fetching users (after: ${lastStreamUserId || "start"})...`,
      );

      const streamUsersResponse = await serverStreamClient.queryUsers(
        lastStreamUserId ? { id: { $gt: lastStreamUserId } } : {},
        { id: 1 }, // Sort by ID for consistent pagination
        { limit: pageLimit, presence: false },
      );

      const currentPageUsers: UserResponse[] = streamUsersResponse.users;

      if (currentPageUsers.length === 0) {
        console.log("   No more users to process.");
        break;
      }

      totalStreamUsersProcessed += currentPageUsers.length;
      lastStreamUserId = currentPageUsers[currentPageUsers.length - 1].id;

      console.log(
        `   Processing ${currentPageUsers.length} users. Total: ${totalStreamUsersProcessed}`,
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
        `   ${activeUserIdSet.size}/${streamUserIds.length} users exist in database`,
      );

      // Identify stale users (in Stream but not in database)
      const staleUsers = streamUserIds.filter((userId) => {
        if (activeUserIdSet.has(userId)) return false;
        if (shouldExcludeUser(userId, excludedSet, excludeUserIds))
          return false;
        return true;
      });

      if (staleUsers.length === 0) {
        console.log("   No stale users in this page.");
        continue;
      }

      totalStaleUsersIdentified += staleUsers.length;
      console.log(
        `   Found ${staleUsers.length} stale users: ${staleUsers.slice(0, 5).join(", ")}${staleUsers.length > 5 ? "..." : ""}`,
      );

      if (dryRun) {
        console.log("   Skipping deletion (dry run mode)");
        continue;
      }

      // Soft-delete stale users from Stream (preserves data for 30-day grace period).
      // TODO: Add a separate job to hard-delete soft-deleted users older than 30 days.
      try {
        const deleteResponse = await serverStreamClient.deleteUsers(
          staleUsers,
          {
            user: "soft",
            messages: "soft",
          },
        );

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
            `   ⚠️ ${failures.length} deletions failed:`,
            failures.map((f) => f.id).join(", "),
          );
        }

        const successfullySoftDeleted =
          staleUsers.length - sdkFailedDeletions.length;
        totalStaleUsersDeleted += successfullySoftDeleted;

        console.log(
          `   ✅ Soft-deleted ${successfullySoftDeleted}/${staleUsers.length} users`,
        );

        // Rate limiting between batches
        if (batchDelayMs > 0) {
          await sleep(batchDelayMs);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Batch deletion failed";
        console.error(`   ❌ Batch soft-deletion error: ${errorMessage}`);

        const failures = staleUsers.map((id) => ({
          id,
          error: errorMessage,
        }));
        allFailedDeletions.push(...failures);
      }
    }

    console.log("\n✅ Synchronization completed successfully.");

    return {
      success: allFailedDeletions.length === 0,
      totalStreamUsersProcessed,
      totalStaleUsersIdentified,
      totalStaleUsersDeleted,
      totalFailedDeletions: allFailedDeletions.length,
      failedDeletionDetails: allFailedDeletions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error("❌ Synchronization failed:", error);
    throw error;
  } finally {
    // Always release the lock when done (success or failure)
    if (lockToken) {
      try {
        await releaseLock(SYNC_LOCK_KEY, lockToken);
        console.log("🔓 Released distributed lock");
      } catch (releaseError) {
        console.warn("⚠️ Failed to release lock:", releaseError);
        // Lock will auto-expire after TTL anyway
      }
    }
  }
}

/**
 * Print sync summary to console
 */
export function printSyncSummary(summary: SyncSummary): void {
  console.log("\n📊 Stream Sync Summary:");
  console.log(`   Total Users Processed: ${summary.totalStreamUsersProcessed}`);
  console.log(
    `   Stale Users Identified: ${summary.totalStaleUsersIdentified}`,
  );
  console.log(`   Users Soft-Deleted: ${summary.totalStaleUsersDeleted}`);
  console.log(`   Failed Deletions: ${summary.totalFailedDeletions}`);
  console.log(`   Success: ${summary.success}`);

  if (summary.failedDeletionDetails.length > 0) {
    console.log("\n⚠️ Failed Deletions:");
    summary.failedDeletionDetails.forEach((failure) => {
      console.log(`   - ${failure.id}: ${failure.error}`);
    });
  }
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
