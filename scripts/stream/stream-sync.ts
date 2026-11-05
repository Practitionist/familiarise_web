/** A bounded, checkpointed comparison of Stream principals against database ownership. */

import { StreamChat, type UserResponse } from "stream-chat";
import prisma from "../../lib/prisma";
import { readJobCheckpoint, withCronLock } from "@/lib/cron/with-cron-lock";
import { SUPPORT_STREAM_USER_ID } from "@/lib/stream/support-user";
import { assertStreamKeyAllowedHere } from "@/lib/stream/environment-guard";
import { scriptClientOptions } from "./target";

export interface FailedDeletionEntry {
  id: string;
  error: string;
}

export interface SyncSummary {
  success: boolean;
  totalStreamUsersProcessed: number;
  totalStaleUsersIdentified: number;
  totalDeletionRequestsAccepted: number;
  totalHardDeletionRequestsAccepted?: number;
  totalFailedDeletions: number;
  failedDeletionDetails: FailedDeletionEntry[];
  timestamp: string;
  deletionTaskIds: string[];
  checkpoint: string | null;
  hasMore: boolean;
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
  // Familiarise Support is a Stream-only user with no DB row by design.
  const excluded = new Set(["system", SUPPORT_STREAM_USER_ID]);

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

const SYNC_LOCK_TTL = 15 * 60 * 1000;
const MAX_PAGES_PER_RUN = 5;

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

  assertStreamKeyAllowedHere(streamApiKey, scriptClientOptions());

  return StreamChat.getInstance(streamApiKey, streamApiSecret, {
    timeout: 15000,
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
 * Runs under a Postgres lease, then fetches at most five Stream user pages,
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
  let totalDeletionRequestsAccepted = 0;
  let totalHardDeletionRequestsAccepted = 0;
  const allFailedDeletions: FailedDeletionEntry[] = [];
  const priorCheckpoint = await readJobCheckpoint("stream-sync");
  let lastStreamUserId: string | undefined = priorCheckpoint ?? undefined;
  let hasMore = false;
  const deletionTaskIds: string[] = [];
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

        deletionTaskIds.push(deleteResponse.task_id);
        totalDeletionRequestsAccepted += batch.length;
        if (mode === "hard") totalHardDeletionRequestsAccepted += batch.length;
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
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
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
        lastStreamUserId = undefined;
        hasMore = false;
        break;
      }

      hasMore = currentPageUsers.length === effectivePageLimit;
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

        const isAlreadyDeactivatedOrSoftDeleted = Boolean(
          streamUser.deactivated_at || streamUser.deleted_at,
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
      totalDeletionRequestsAccepted,
      totalHardDeletionRequestsAccepted,
      totalFailedDeletions: allFailedDeletions.length,
      failedDeletionDetails: allFailedDeletions,
      timestamp: new Date().toISOString(),
      deletionTaskIds,
      checkpoint: dryRun ? priorCheckpoint : (lastStreamUserId ?? null),
      hasMore,
    };
  } catch (error) {
    console.error("❌ Synchronization failed:", error);
    throw error;
  }
}
