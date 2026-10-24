import type { Channel } from "stream-chat";
import prisma from "@/lib/prisma";
import { isPrivileged } from "@/lib/auth-helpers";
import { readJobCheckpoint, withCronLock } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";
import { reportSentryError } from "@/lib/observability/report";
import {
  getStreamChatClient,
  isExpectedStreamError,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import {
  CLASS_PREFIX,
  COLLAB_PREFIX,
  isManagedChannel,
  WEBINAR_PREFIX,
} from "@/lib/stream-channel-ids";
import {
  forEachChunk,
  STREAM_BATCH_LIMIT,
  STREAM_QUERY_CHANNELS_LIMIT,
} from "@/lib/stream/batch";
import { collabChannelAccess } from "@/lib/stream/channel-access";
import { eventParticipantsAmong } from "@/lib/stream/event-channel-service";
import { isSupportStreamUser } from "@/lib/stream/support-user";

export const MEMBERSHIP_RECONCILE_JOB = "reconcile-stream-memberships";

/** Channels examined per run; each costs a Postgres read and at most one removal. */
export const DEFAULT_CHANNELS_PER_RUN = 50;

export interface MembershipReconcileResult {
  success: boolean;
  channelsScanned: number;
  /** DMs, which only the synchronous path revokes, and channels another job owns. */
  channelsSkipped: number;
  /** Channels left untouched because the removal would have taken more than half their people. */
  channelsSkippedSuspicious: number;
  membersRemoved: number;
  failures: number;
  /** `created_at` of the last channel examined; null once the walk reached the newest channel. */
  checkpoint: string | null;
  errors: string[];
}

/** Service identities Stream needs in a channel that Postgres never lists. */
function isExemptStreamUser(userId: string): boolean {
  return isSupportStreamUser(userId) || userId.startsWith("system-");
}

/**
 * The members the channel's own access predicate no longer admits, or null to
 * leave the channel alone. DMs are skipped: their revocation is the synchronous
 * cancellation path's, and whether a finished relationship keeps its thread is policy.
 */
async function ineligibleMembers(
  channelId: string,
  humans: string[],
): Promise<string[] | null> {
  const roles = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: humans } },
        select: { id: true, role: true },
      })
    ).map((u) => [u.id, u.role]),
  );

  const event = channelId.startsWith(WEBINAR_PREFIX)
    ? { type: "webinar" as const, id: channelId.slice(WEBINAR_PREFIX.length) }
    : channelId.startsWith(CLASS_PREFIX)
      ? { type: "class" as const, id: channelId.slice(CLASS_PREFIX.length) }
      : null;
  if (event) {
    const admitted = await eventParticipantsAmong(event.type, event.id, humans);
    // Staff join derived channels only through the audited add, which this honours.
    return humans.filter(
      (id) => !admitted.has(id) && !isPrivileged(roles.get(id)),
    );
  }

  if (!channelId.startsWith(COLLAB_PREFIX)) return null;
  const rest = channelId.slice(COLLAB_PREFIX.length);
  const planType = rest.startsWith("webinar-")
    ? "webinar"
    : rest.startsWith("class-")
      ? "class"
      : null;
  if (!planType) return null;
  const planId = rest.slice(planType.length + 1);
  const ineligible: string[] = [];
  for (const id of humans) {
    const access = await collabChannelAccess(
      id,
      roles.get(id),
      planType,
      planId,
    );
    // A missing plan or a wound-down org belongs to the lifecycle jobs, not here.
    if (access === "not_found" || access === "org_deactivated") return null;
    if (access === "forbidden") ineligible.push(id);
  }
  return ineligible;
}

async function channelMemberIds(channel: Channel): Promise<string[]> {
  const ids = new Set(Object.keys(channel.state?.members ?? {}));
  const total = channel.data?.member_count;
  if (typeof total !== "number" || total <= ids.size) return [...ids];
  ids.clear();
  let after: string | undefined;
  for (;;) {
    const { members } = await withStreamCircuitBreaker(() =>
      channel.queryMembers(
        {},
        { user_id: 1 },
        {
          limit: STREAM_BATCH_LIMIT,
          ...(after ? { user_id_gt: after } : {}),
        },
      ),
    );
    for (const m of members) if (m.user_id) ids.add(m.user_id);
    if (members.length < STREAM_BATCH_LIMIT) return [...ids];
    after = members.at(-1)?.user_id;
    if (!after) return [...ids];
  }
}

async function reconcileChannel(
  channel: Channel,
  result: MembershipReconcileResult,
  sample: string[],
): Promise<void> {
  const channelId = channel.id ?? "";
  const humans = (await channelMemberIds(channel)).filter(
    (id) => !isExemptStreamUser(id),
  );
  const ineligible =
    humans.length === 0 ? [] : await ineligibleMembers(channelId, humans);
  if (ineligible === null) {
    result.channelsSkipped++;
    return;
  }
  if (ineligible.length === 0) return;
  // Brake: a verdict that empties most of a channel is more likely a bad read than a real revocation.
  if (ineligible.length * 2 > humans.length) {
    result.channelsSkippedSuspicious++;
    if (sample.length < 10) {
      sample.push(
        `${channelId}: suspicious, ${ineligible.length} of ${humans.length} ineligible`,
      );
    }
    return;
  }
  await forEachChunk(ineligible, async (batch) => {
    try {
      await withStreamCircuitBreaker(() => channel.removeMembers(batch));
      result.membersRemoved += batch.length;
    } catch (error) {
      if (isExpectedStreamError(error)) return;
      result.failures += batch.length;
      if (sample.length < 10) {
        sample.push(
          `${channelId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });
}

/**
 * Removes members Postgres no longer justifies from every managed channel,
 * walking Stream by `created_at` and resuming from the previous run's checkpoint.
 */
export async function reconcileStreamMemberships(
  opts: { limit?: number; startedAt?: number } = {},
): Promise<MembershipReconcileResult> {
  return withCronLock(
    "reconcile-stream-memberships",
    { failMode: "closed" },
    () => reconcileUnlocked(opts),
  );
}

async function reconcileUnlocked(opts: {
  limit?: number;
  startedAt?: number;
}): Promise<MembershipReconcileResult> {
  const limit = opts.limit ?? DEFAULT_CHANNELS_PER_RUN;
  const pastDeadline = startDeadline(opts.startedAt);
  const result: MembershipReconcileResult = {
    success: true,
    channelsScanned: 0,
    channelsSkipped: 0,
    channelsSkippedSuspicious: 0,
    membersRemoved: 0,
    failures: 0,
    checkpoint: null,
    errors: [],
  };
  const failureSample: string[] = [];
  const chat = getStreamChatClient();
  let after = await readJobCheckpoint(MEMBERSHIP_RECONCILE_JOB);
  let reachedEnd = false;

  try {
    walk: while (result.channelsScanned < limit && !pastDeadline()) {
      const page = await withStreamCircuitBreaker(
        () =>
          chat.queryChannels(
            {
              type: { $in: ["messaging", "team"] },
              ...(after ? { created_at: { $gt: after } } : {}),
            },
            [{ created_at: 1 }],
            {
              limit: STREAM_QUERY_CHANNELS_LIMIT,
              state: true,
              watch: false,
              presence: false,
              message_limit: 0,
            },
          ),
        () => {
          throw new StreamUnavailableError();
        },
      );
      for (const channel of page) {
        if (result.channelsScanned >= limit || pastDeadline()) break walk;
        const createdAt = channel.data?.created_at;
        if (typeof createdAt !== "string") continue;
        after = createdAt;
        if (!isManagedChannel(channel.id)) continue;
        result.channelsScanned++;
        try {
          await reconcileChannel(channel, result, failureSample);
        } catch (error) {
          result.failures++;
          if (failureSample.length < 10) {
            failureSample.push(
              `${channel.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      if (page.length < STREAM_QUERY_CHANNELS_LIMIT) {
        reachedEnd = true;
        break;
      }
    }
  } catch (error) {
    result.failures++;
    failureSample.push(
      `queryChannels: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  result.checkpoint = reachedEnd ? null : after;
  result.errors = failureSample;
  result.success = result.failures === 0;
  // One event per run: removals mean an inline revocation was missed, a brake or failure needs a look.
  if (
    result.membersRemoved > 0 ||
    result.failures > 0 ||
    result.channelsSkippedSuspicious > 0
  ) {
    reportSentryError(
      new Error(
        `Stream membership reconcile removed ${result.membersRemoved} member(s), braked ${result.channelsSkippedSuspicious} channel(s), ${result.failures} failure(s)`,
      ),
      {
        subsystem: "stream",
        op: "reconcile-memberships",
        level: result.failures > 0 ? "error" : "warning",
        fingerprint: ["stream", "reconcile-memberships"],
        extra: {
          channelsScanned: result.channelsScanned,
          membersRemoved: result.membersRemoved,
          channelsSkippedSuspicious: result.channelsSkippedSuspicious,
          failures: result.failures,
          sample: failureSample,
        },
      },
    );
  }
  return result;
}
