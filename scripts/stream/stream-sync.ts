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
 * Schedule: Daily at 03:40 UTC (09:10 IST; #709 minute map)
 */

import { StreamChat, UserResponse } from "stream-chat";
import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

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
  totalHardDeletedUsers?: number;
  totalFailedDeletions: number;
  failedDeletionDetails: FailedDeletionEntry[];
  timestamp: string;
}

export interface SyncOptions {
  /** Number of users to fetch per page (default: 100, capped at 100) */
  pageLimit?: number;
  /** Dry run mode - identify but don't delete (default: false) */
  dryRun?: boolean;
  /** Additional user IDs to exclude from deletion */
  excludeUserIds?: string[];
  /** Delay between batch deletions in ms (default: 10000 for 6/min DeleteUsers cap) */
  batchDelayMs?: number;
}

/**
 * Stream's DeleteUsers endpoint is capped at 6 requests/minute app-wide,
 * requiring at least 10 seconds between consecutive batch calls.
 */
export const DELETE_USERS_PACING_MS = 10_000;

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

// Distributed lock configuration. The key itself is now derived by
// `withCronLock` from the job name ("cron:lock:stream-sync"); only the TTL
// is still ours to choose.
// #1134 P1-21 — was 10 minutes, which is SHORTER than the run it guards. At
// 100k users this walks 1,000 pages with a 500ms sleep between deletions (8
// minutes of sleep alone) plus a Stream round-trip and a Prisma query per page:
// 15-30 minutes realistically. The lock expired mid-run and a second scheduled
// run could start deleting concurrently. Matched to the workflow's own
// timeout-minutes so the lock outlives any run that can exist.
const SYNC_LOCK_TTL = 40 * 60 * 1000;

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
 * Runs under the fleet cron lock, then fetches every Stream user page by page,
 * compares each against the database and soft-deletes the ones that no longer
 * exist here. Throws `CronLockHeldError` when another runner already holds the
 * lock, which `runJob` treats as a clean skip rather than a failure.
 *
 * @param options Sync configuration options
 * @returns Summary of the synchronization operation
 */
export async function performStreamUserSync(
  options: SyncOptions = {},
): Promise<SyncSummary> {
  return withCronLock(
    "stream-sync",
    {
      failMode: "closed",
      ttlMs: SYNC_LOCK_TTL,
    },
    () => performStreamUserSyncUnlocked(options),
  );
}

async function performStreamUserSyncUnlocked(
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const {
    pageLimit = 100,
    dryRun = false,
    excludeUserIds = [],
    batchDelayMs = DELETE_USERS_PACING_MS,
  } = options;
  const effectivePageLimit = Math.min(Math.max(pageLimit, 1), 100);

  const excludedSet = getExcludedUserIds();

  console.log("🔄 Starting Stream user synchronization...");
  if (dryRun) {
    console.log("🧪 DRY RUN MODE - No deletions will be performed");
  }

  const serverStreamClient = getStreamClient();

  let totalStreamUsersProcessed = 0;
  let totalStaleUsersIdentified = 0;
  let totalStaleUsersDeleted = 0;
  let totalHardDeletedUsers = 0;
  const allFailedDeletions: FailedDeletionEntry[] = [];
  let lastStreamUserId: string | undefined = undefined;
  let deleteCallsIssued = 0;

  const runDeleteUsersBatch = async (
    userIds: string[],
    mode: "soft" | "hard",
  ) => {
    for (let i = 0; i < userIds.length; i += 100) {
      const batch = userIds.slice(i, i + 100);
      if (deleteCallsIssued > 0 && batchDelayMs > 0) {
        await sleep(batchDelayMs);
      }
      deleteCallsIssued++;
      try {
        const deleteResponse = await serverStreamClient.deleteUsers(batch, {
          user: mode,
          messages: mode,
        });

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
            `   ⚠️ ${failures.length} ${mode}-deletions failed:`,
            failures.map((f) => f.id).join(", "),
          );
        }

        const succeeded = batch.length - sdkFailedDeletions.length;
        totalStaleUsersDeleted += succeeded;
        if (mode === "hard") {
          totalHardDeletedUsers += succeeded;
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Batch deletion failed";
        console.error(`   ❌ Batch ${mode}-deletion error: ${errorMessage}`);
        allFailedDeletions.push(
          ...batch.map((id) => ({ id, error: errorMessage })),
        );
      }
    }
  };

  try {
    // Paginate through all Stream users (including deactivated/soft-deleted)
    while (true) {
      console.log(
        `   Fetching users (after: ${lastStreamUserId || "start"})...`,
      );

      const streamUsersResponse = await serverStreamClient.queryUsers(
        lastStreamUserId ? { id: { $gt: lastStreamUserId } } : {},
        { id: 1 }, // Sort by ID for consistent pagination
        {
          limit: effectivePageLimit,
          presence: false,
          include_deactivated_users: true,
        },
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

      const streamUserIds = currentPageUsers.map((user) => user.id);

      const dbUsers = await prisma.user.findMany({
        where: { id: { in: streamUserIds } },
        select: { id: true, erasedAt: true },
      });

      const activeUserIdSet = new Set(
        dbUsers.filter((u) => !u.erasedAt).map((u) => u.id),
      );
      const erasedUserIdSet = new Set(
        dbUsers.filter((u) => Boolean(u.erasedAt)).map((u) => u.id),
      );

      console.log(
        `   ${activeUserIdSet.size}/${streamUserIds.length} active users exist in database`,
      );

      const softDeleteUsers: string[] = [];
      const hardDeleteUsers: string[] = [];

      for (const streamUser of currentPageUsers) {
        const userId = streamUser.id;
        if (activeUserIdSet.has(userId)) continue;
        if (shouldExcludeUser(userId, excludedSet, excludeUserIds)) continue;

        const raw = streamUser as UserResponse & {
          deactivated_at?: string;
          deleted_at?: string;
        };
        const isAlreadyDeactivatedOrSoftDeleted = Boolean(
          raw.deactivated_at || raw.deleted_at,
        );
        if (erasedUserIdSet.has(userId)) {
          hardDeleteUsers.push(userId);
        } else if (!isAlreadyDeactivatedOrSoftDeleted) {
          softDeleteUsers.push(userId);
        }
      }

      const staleCount = softDeleteUsers.length + hardDeleteUsers.length;
      if (staleCount === 0) {
        console.log("   No stale users in this page.");
        continue;
      }

      totalStaleUsersIdentified += staleCount;

      if (dryRun) {
        console.log("   Skipping deletion (dry run mode)");
        continue;
      }

      if (softDeleteUsers.length > 0) {
        await runDeleteUsersBatch(softDeleteUsers, "soft");
      }
      if (hardDeleteUsers.length > 0) {
        await runDeleteUsersBatch(hardDeleteUsers, "hard");
      }
    }

    console.log("\n✅ Synchronization completed successfully.");

    return {
      success: allFailedDeletions.length === 0,
      totalStreamUsersProcessed,
      totalStaleUsersIdentified,
      totalStaleUsersDeleted,
      totalHardDeletedUsers,
      totalFailedDeletions: allFailedDeletions.length,
      failedDeletionDetails: allFailedDeletions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error("❌ Synchronization failed:", error);
    throw error;
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
