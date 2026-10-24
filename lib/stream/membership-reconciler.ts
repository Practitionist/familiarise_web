import type { Channel } from "stream-chat";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
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
  isDMChannel,
  isManagedChannel,
  WEBINAR_PREFIX,
} from "@/lib/stream-channel-ids";
import { getDmChannelId } from "@/lib/stream-utils";
import {
  forEachChunk,
  STREAM_BATCH_LIMIT,
  STREAM_QUERY_CHANNELS_LIMIT,
} from "@/lib/stream/batch";
import { isDmContextEligible } from "@/lib/stream/dm-eligibility";
import { isSupportStreamUser } from "@/lib/stream/support-user";

export const MEMBERSHIP_RECONCILE_JOB = "reconcile-stream-memberships";

/** Channels examined per run; each costs a Postgres read and at most one removal. */
export const DEFAULT_CHANNELS_PER_RUN = 50;

export interface MembershipReconcileResult {
  success: boolean;
  channelsScanned: number;
  /** Managed channels whose roster Postgres cannot derive (unknown row or id form). */
  channelsSkipped: number;
  membersRemoved: number;
  failures: number;
  /** `created_at` of the last channel examined; null once the walk reached the newest channel. */
  checkpoint: string | null;
  errors: string[];
}

const PRIVILEGED_ROLES = ["ADMIN", "STAFF"] as const;

const acceptedCollaboratorSelect = {
  where: {
    status: "ACCEPTED" as const,
    consultantProfile: { deletedAt: null },
  },
  select: { consultantProfile: { select: { userId: true } } },
};

const planRosterSelect = {
  consultantProfile: { select: { userId: true, deletedAt: true } },
  collaborators: acceptedCollaboratorSelect,
};

type PlanRoster = {
  consultantProfile: { userId: string; deletedAt: Date | null } | null;
  collaborators: { consultantProfile: { userId: string } }[];
};

function planMembers(plan: PlanRoster): string[] {
  const host =
    plan.consultantProfile && !plan.consultantProfile.deletedAt
      ? [plan.consultantProfile.userId]
      : [];
  return [
    ...host,
    ...plan.collaborators.map((c) => c.consultantProfile.userId),
  ];
}

/** Service identities Stream needs in a channel that Postgres never lists. */
function isExemptStreamUser(userId: string): boolean {
  return isSupportStreamUser(userId) || userId.startsWith("system-");
}

async function eventRoster(
  type: "webinar" | "class",
  eventId: string,
): Promise<Set<string> | null> {
  const appointmentSelect = {
    select: {
      participants: { where: liveParticipant(), select: { userId: true } },
    },
  };
  const row =
    type === "webinar"
      ? await prisma.webinar.findUnique({
          where: { id: eventId },
          select: {
            webinarPlan: { select: planRosterSelect },
            appointment: appointmentSelect,
          },
        })
      : await prisma.class.findUnique({
          where: { id: eventId },
          select: {
            classPlan: { select: planRosterSelect },
            appointment: appointmentSelect,
          },
        });
  if (!row) return null;
  const plan = "webinarPlan" in row ? row.webinarPlan : row.classPlan;
  return new Set([
    ...planMembers(plan),
    ...(row.appointment?.participants.map((p) => p.userId) ?? []),
  ]);
}

async function collabRoster(channelId: string): Promise<Set<string> | null> {
  const rest = channelId.slice(COLLAB_PREFIX.length);
  const type = rest.startsWith("webinar-")
    ? "webinar"
    : rest.startsWith("class-")
      ? "class"
      : null;
  if (!type) return null;
  const planId = rest.slice(type.length + 1);
  const plan =
    type === "webinar"
      ? await prisma.webinarPlan.findUnique({
          where: { id: planId },
          select: planRosterSelect,
        })
      : await prisma.classPlan.findUnique({
          where: { id: planId },
          select: planRosterSelect,
        });
  return plan ? new Set(planMembers(plan)) : null;
}

/** A DM keeps both members while the pair shares a booking in the channel's scope, and neither otherwise. */
async function dmRoster(
  channel: Channel,
  humans: string[],
): Promise<Set<string> | null> {
  if (humans.length !== 2 || !channel.id) return null;
  const [a, b] = humans;
  const rawOrg = channel.data?.organization_id;
  const orgId = typeof rawOrg === "string" && rawOrg ? rawOrg : null;
  // An id this pair and scope would not mint is a legacy form: left alone, never guessed at.
  if (getDmChannelId(a, b, orgId) !== channel.id) return null;
  return (await isDmContextEligible(a, b, orgId)) ? new Set(humans) : new Set();
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

async function rosterFor(
  channel: Channel,
  humans: string[],
): Promise<Set<string> | null> {
  const id = channel.id ?? "";
  if (id.startsWith(WEBINAR_PREFIX)) {
    return eventRoster("webinar", id.slice(WEBINAR_PREFIX.length));
  }
  if (id.startsWith(CLASS_PREFIX)) {
    return eventRoster("class", id.slice(CLASS_PREFIX.length));
  }
  if (id.startsWith(COLLAB_PREFIX)) return collabRoster(id);
  if (isDMChannel(id)) return dmRoster(channel, humans);
  return null;
}

async function reconcileChannel(
  channel: Channel,
  result: MembershipReconcileResult,
  failureSample: string[],
): Promise<void> {
  const humans = (await channelMemberIds(channel)).filter(
    (id) => !isExemptStreamUser(id),
  );
  const roster = await rosterFor(channel, humans);
  if (!roster) {
    result.channelsSkipped++;
    return;
  }
  const candidates = humans.filter((id) => !roster.has(id));
  if (candidates.length === 0) return;
  const staff = await prisma.user.findMany({
    where: { id: { in: candidates }, role: { in: [...PRIVILEGED_ROLES] } },
    select: { id: true },
  });
  const staffIds = new Set(staff.map((u) => u.id));
  const ineligible = candidates.filter((id) => !staffIds.has(id));
  await forEachChunk(ineligible, async (batch) => {
    try {
      await withStreamCircuitBreaker(() => channel.removeMembers(batch));
      result.membersRemoved += batch.length;
    } catch (error) {
      if (isExpectedStreamError(error)) return;
      result.failures += batch.length;
      if (failureSample.length < 10) {
        failureSample.push(
          `${channel.id}: ${error instanceof Error ? error.message : String(error)}`,
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
  // One event per run: removals mean an inline revocation was missed, failures need a retry.
  if (result.membersRemoved > 0 || result.failures > 0) {
    reportSentryError(
      new Error(
        `Stream membership reconcile removed ${result.membersRemoved} member(s), ${result.failures} failure(s)`,
      ),
      {
        subsystem: "stream",
        op: "reconcile-memberships",
        level: result.failures > 0 ? "error" : "warning",
        fingerprint: ["stream", "reconcile-memberships"],
        extra: {
          channelsScanned: result.channelsScanned,
          membersRemoved: result.membersRemoved,
          failures: result.failures,
          sample: failureSample,
        },
      },
    );
  }
  return result;
}
