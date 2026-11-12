import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  getStreamChatClient,
  getStreamVideoClient,
  isExpectedStreamError,
  isStreamConfigured,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { MAX_CALL_DURATION_MS } from "@/lib/meetings/duration-cap";
import { streamLogger } from "@/lib/stream-logger";
import type { RunFailureReporter } from "@/lib/observability/run-failures";
import { markMembership } from "@/lib/stream-cache";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "@/lib/stream-channel-ids";
import { bookingOrgId, getDmChannelId } from "@/lib/stream-utils";
import { dmEligibleStatusFilter } from "@/lib/stream/dm-eligibility-statuses";
import { queryOrgTaggedChannels } from "@/lib/stream/channel-administration";
import { liveParticipant } from "@/lib/booking/participants";

export const STREAM_REVOCATION_RETRY_WINDOW_HOURS = 72;
export const ORG_STREAM_SURFACE_LIMIT = 5_000;

export interface OrgStreamSurfaces {
  webinarIds: string[];
  classIds: string[];
  dmChannelIds: string[];
  truncated: boolean;
}

function buildOrgWebinarSurfaceWhere(
  orgId: string,
  userId: string | undefined,
  onlyUnfrozen: boolean,
): Prisma.WebinarWhereInput {
  return {
    deletedAt: null,
    ...(onlyUnfrozen ? { chatFrozenAt: null } : {}),
    AND: [
      {
        OR: [
          { webinarPlan: { organizationId: orgId } },
          { appointment: { organizationId: orgId, deletedAt: null } },
        ],
      },
      ...(userId
        ? [
            {
              OR: [
                {
                  appointment: {
                    deletedAt: null,
                    participants: { some: liveParticipant(userId) },
                  },
                },
                { webinarPlan: { consultantProfile: { userId } } },
                {
                  webinarPlan: {
                    collaborators: {
                      some: {
                        consultantProfile: { userId },
                        status: "ACCEPTED" as const,
                      },
                    },
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
}

function buildOrgClassSurfaceWhere(
  orgId: string,
  userId: string | undefined,
  onlyUnfrozen: boolean,
): Prisma.ClassWhereInput {
  return {
    deletedAt: null,
    ...(onlyUnfrozen ? { chatFrozenAt: null } : {}),
    AND: [
      {
        OR: [
          { classPlan: { organizationId: orgId } },
          { appointment: { organizationId: orgId, deletedAt: null } },
        ],
      },
      ...(userId
        ? [
            {
              OR: [
                {
                  appointment: {
                    deletedAt: null,
                    participants: { some: liveParticipant(userId) },
                  },
                },
                { classPlan: { consultantProfile: { userId } } },
                {
                  classPlan: {
                    collaborators: {
                      some: {
                        consultantProfile: { userId },
                        status: "ACCEPTED" as const,
                      },
                    },
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
}

function addOneToOneOrgDmChannels(
  dmChannelIds: Set<string>,
  orgId: string,
  rows: {
    plan: {
      organizationId: string | null;
      consultantProfile: { userId: string } | null;
    };
    requestedBy: { userId: string } | null;
    appointment: { organizationId: string | null } | null;
  }[],
): void {
  for (const row of rows) {
    const a = row.plan.consultantProfile?.userId;
    const b = row.requestedBy?.userId;
    if (!a || !b || a === b) continue;
    const resolvedOrgId = bookingOrgId({
      consultationPlan: row.plan,
      appointment: row.appointment,
    });
    if (resolvedOrgId !== orgId) continue;
    dmChannelIds.add(getDmChannelId(a, b, orgId));
  }
}

export async function loadOrgStreamSurfaces(
  orgId: string,
  opts: { userId?: string; onlyUnfrozen?: boolean } = {},
): Promise<OrgStreamSurfaces> {
  const { userId, onlyUnfrozen = false } = opts;

  const webinars = await prisma.webinar.findMany({
    where: buildOrgWebinarSurfaceWhere(orgId, userId, onlyUnfrozen),
    select: { id: true },
    take: ORG_STREAM_SURFACE_LIMIT + 1,
  });

  const classes = await prisma.class.findMany({
    where: buildOrgClassSurfaceWhere(orgId, userId, onlyUnfrozen),
    select: { id: true },
    take: ORG_STREAM_SURFACE_LIMIT + 1,
  });

  const consultations = await prisma.consultation.findMany({
    where: {
      status: dmEligibleStatusFilter(),
      ...(userId
        ? {
            OR: [
              { consultationPlan: { consultantProfile: { userId } } },
              { requestedBy: { userId } },
            ],
          }
        : {}),
      AND: [
        {
          OR: [
            { consultationPlan: { organizationId: orgId } },
            { appointment: { organizationId: orgId, deletedAt: null } },
          ],
        },
      ],
    },
    take: ORG_STREAM_SURFACE_LIMIT + 1,
    select: {
      consultationPlan: {
        select: {
          organizationId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
      requestedBy: { select: { userId: true } },
      appointment: { select: { organizationId: true } },
    },
  });

  const subscriptions = await prisma.subscription.findMany({
    where: {
      status: dmEligibleStatusFilter(),
      ...(userId
        ? {
            OR: [
              { subscriptionPlan: { consultantProfile: { userId } } },
              { requestedBy: { userId } },
            ],
          }
        : {}),
      AND: [
        {
          OR: [
            { subscriptionPlan: { organizationId: orgId } },
            { appointment: { organizationId: orgId, deletedAt: null } },
          ],
        },
      ],
    },
    take: ORG_STREAM_SURFACE_LIMIT + 1,
    select: {
      subscriptionPlan: {
        select: {
          organizationId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
      requestedBy: { select: { userId: true } },
      appointment: { select: { organizationId: true } },
    },
  });

  const dmChannelIds = new Set<string>();
  addOneToOneOrgDmChannels(
    dmChannelIds,
    orgId,
    consultations.slice(0, ORG_STREAM_SURFACE_LIMIT).map((c) => ({
      plan: c.consultationPlan,
      requestedBy: c.requestedBy,
      appointment: c.appointment,
    })),
  );
  addOneToOneOrgDmChannels(
    dmChannelIds,
    orgId,
    subscriptions.slice(0, ORG_STREAM_SURFACE_LIMIT).map((s) => ({
      plan: s.subscriptionPlan,
      requestedBy: s.requestedBy,
      appointment: s.appointment,
    })),
  );

  return {
    webinarIds: webinars.slice(0, ORG_STREAM_SURFACE_LIMIT).map((w) => w.id),
    classIds: classes.slice(0, ORG_STREAM_SURFACE_LIMIT).map((c) => c.id),
    dmChannelIds: Array.from(dmChannelIds),
    truncated: [webinars, classes, consultations, subscriptions].some(
      (rows) => rows.length > ORG_STREAM_SURFACE_LIMIT,
    ),
  };
}

export interface RevokeMemberStreamResult {
  channelsRemoved: number;
  tokenRevoked: boolean;
  complete: boolean;
  failures: string[];
}

async function populateOrgTaggedMemberTargets(
  chat: ReturnType<typeof getStreamChatClient>,
  orgId: string,
  userId: string,
  targets: Map<string, "team" | "messaging">,
  failures: string[],
  deadlineMs: number,
): Promise<void> {
  try {
    const { channels: taggedChannels, truncated } =
      await queryOrgTaggedChannels(
        chat,
        orgId,
        {
          members: { $in: [userId] },
        },
        { deadlineMs },
      );
    if (truncated) {
      failures.push("queryChannels:truncated");
      streamLogger.warn(
        "Org-tagged Stream channel query truncated during member removal",
        { userId, orgId, examined: taggedChannels.length },
      );
    }
    for (const ch of taggedChannels) {
      if (ch.id) {
        targets.set(ch.id, ch.type === "team" ? "team" : "messaging");
      }
    }
  } catch (err) {
    if (!isExpectedStreamError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`queryChannels:${msg}`);
      streamLogger.warn(
        "Failed to query org-tagged Stream channels during member removal",
        {
          userId,
          orgId,
          error: msg,
        },
      );
    }
  }
}

async function removeMemberFromTargetChannels(
  chat: ReturnType<typeof getStreamChatClient>,
  orgId: string,
  userId: string,
  targets: Map<string, "team" | "messaging">,
  failures: string[],
  deadlineMs: number,
): Promise<number> {
  let channelsRemoved = 0;
  for (const [cid, type] of targets) {
    if (Date.now() >= deadlineMs) {
      failures.push("removeMembers:time-budget");
      break;
    }
    try {
      await chat.channel(type, cid).removeMembers([userId]);
      markMembership(cid, userId, false);
      channelsRemoved++;
    } catch (err) {
      markMembership(cid, userId, false);
      if (isExpectedStreamError(err)) continue;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`removeMembers:${cid}:${msg}`);
      streamLogger.warn("Failed to remove org member from Stream channel", {
        userId,
        orgId,
        channelId: cid,
        error: msg,
      });
    }
  }
  return channelsRemoved;
}

function readMemberCallPage(
  orgId: string,
  userId: string,
  cursor: string | undefined,
) {
  return prisma.appointmentOccurrence.findMany({
    where: {
      deletedAt: null,
      endsAt: { gt: new Date(Date.now() - MAX_CALL_DURATION_MS) },
      meeting: { is: { endedAt: null } },
      appointment: {
        deletedAt: null,
        participants: { some: { userId } },
        OR: [
          { organizationId: orgId },
          { webinar: { webinarPlan: { organizationId: orgId } } },
          { class: { classPlan: { organizationId: orgId } } },
          { consultation: { consultationPlan: { organizationId: orgId } } },
          { subscription: { subscriptionPlan: { organizationId: orgId } } },
        ],
      },
    },
    select: { id: true, meeting: { select: { streamCallId: true } } },
    orderBy: { id: "asc" },
    take: MAX_ORG_CALLS_PER_REVOCATION,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}
async function removeMemberCallPage(
  video: ReturnType<typeof getStreamVideoClient>["video"],
  occurrences: Awaited<ReturnType<typeof readMemberCallPage>>,
  userId: string,
  failures: string[],
  deadlineMs: number,
): Promise<boolean> {
  for (const { meeting } of occurrences) {
    if (Date.now() >= deadlineMs) {
      failures.push("removeCallMember:time-budget");
      return false;
    }
    if (!meeting) continue;
    try {
      await video
        .call(STREAM_CALL_TYPE, toCallId(meeting.streamCallId))
        .updateCallMembers({ remove_members: [userId] });
    } catch (err) {
      if (isExpectedStreamError(err)) continue;
      failures.push(
        `removeCallMember:${meeting.streamCallId}:${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return true;
}

/** Drops the removed member from the org's live and upcoming calls; `/join` re-adds anyone Postgres still admits. */
async function removeMemberFromOrgCalls(
  orgId: string,
  userId: string,
  failures: string[],
  deadlineMs: number,
): Promise<void> {
  try {
    const video = getStreamVideoClient().video;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_ORG_CALL_PAGES; page++) {
      const occurrences = await readMemberCallPage(orgId, userId, cursor);
      if (
        !(await removeMemberCallPage(
          video,
          occurrences,
          userId,
          failures,
          deadlineMs,
        ))
      )
        return;
      if (occurrences.length < MAX_ORG_CALLS_PER_REVOCATION) return;
      cursor = occurrences.at(-1)?.id;
    }
    // More open org calls than one pass covers: report incomplete so the retry sweep re-drives it.
    failures.push(`removeCallMember:truncated:${userId}`);
  } catch (err) {
    failures.push(
      `loadOrgCalls:${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Pages of open org calls one revocation pass walks before reporting incomplete. */
const MAX_ORG_CALL_PAGES = 2;
const MAX_ORG_CALLS_PER_REVOCATION = 50;

/**
 * Removes the member from the org's channels and calls and revokes their Stream
 * tokens issued before the removal; their own session re-mints on its next request.
 */
export async function revokeMemberStreamAccess(input: {
  userId: string;
  orgId: string;
  failureReporter?: RunFailureReporter;
  revokeTokensIssuedBefore?: Date;
  deadlineMs?: number;
}): Promise<RevokeMemberStreamResult> {
  const { userId, orgId } = input;
  const deadlineMs = input.deadlineMs ?? Infinity;
  // Nothing was revoked, so the removal stays owed to the retry sweep.
  if (!isStreamConfigured()) {
    return {
      channelsRemoved: 0,
      tokenRevoked: false,
      complete: false,
      failures: ["Stream is not configured"],
    };
  }

  const chat = getStreamChatClient();
  const failures: string[] = [];
  let tokenRevoked = false;
  try {
    await chat.revokeUserToken(
      userId,
      input.revokeTokensIssuedBefore ?? new Date(),
    );
    tokenRevoked = true;
  } catch (err) {
    failures.push(
      `revokeUserToken:${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let surfaces: OrgStreamSurfaces;
  try {
    surfaces = await loadOrgStreamSurfaces(orgId, { userId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`loadOrgStreamSurfaces:${msg}`);
    if (input.failureReporter) {
      input.failureReporter.add("wind-down-member-removal", err, {
        userId,
        orgId,
      });
    } else {
      streamLogger.error(
        "Failed to load org Stream surfaces for member removal",
        err,
        { userId, orgId },
      );
    }
    return {
      channelsRemoved: 0,
      tokenRevoked,
      complete: false,
      failures,
    };
  }

  if (surfaces.truncated) failures.push("loadOrgStreamSurfaces:truncated");
  const targets = new Map<string, "team" | "messaging">();
  for (const id of surfaces.webinarIds) {
    targets.set(`${WEBINAR_PREFIX}${id}`, "team");
  }
  for (const id of surfaces.classIds) {
    targets.set(`${CLASS_PREFIX}${id}`, "team");
  }
  for (const cid of surfaces.dmChannelIds) {
    targets.set(cid, "messaging");
  }

  await populateOrgTaggedMemberTargets(
    chat,
    orgId,
    userId,
    targets,
    failures,
    deadlineMs,
  );
  const channelsRemoved = await removeMemberFromTargetChannels(
    chat,
    orgId,
    userId,
    targets,
    failures,
    deadlineMs,
  );
  await removeMemberFromOrgCalls(orgId, userId, failures, deadlineMs);

  return {
    channelsRemoved,
    tokenRevoked,
    complete: failures.length === 0,
    failures,
  };
}
