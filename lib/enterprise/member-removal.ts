import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { transitionMembership } from "@/lib/enterprise/transitions";
import { revokeOrgManagedUserSessions } from "@/lib/sso/session-sweeps";
import {
  assertNotLastOwner,
  assertRemovable,
  countRemovalObligations,
  MembershipGuardError,
  type GuardedMembership,
  type RemovalObligations,
} from "@/lib/enterprise/membership-guards";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";
import { recomputeConsultantIsIndependent } from "@/lib/api/organizations/membership-transitions";
import {
  notifyCollaboratorWithdrawn,
  notifyOrgExpertRemoved,
} from "@/lib/novu/service";
import { notifyOrgMemberRemoved } from "@/lib/novu/org-workflows";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import type { OrgExpertRemovedPayload } from "@/lib/novu/workflows";
import { goHref } from "@/lib/dashboard/go";
import {
  attemptOnboardingEmail,
  EMAIL_BUDGET_MS,
  stageOrgMembershipChangedEmail,
  type StagedOnboardingEmail,
} from "@/lib/email";
import { sendCollaboratorWithdrawnEmail } from "@/lib/email/senders/collaborators";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  getStreamChatClient,
  getStreamVideoClient,
  isExpectedStreamError,
  isStreamConfigured,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { MAX_CALL_DURATION_MS } from "@/lib/meetings/duration-cap";
import {
  enqueueCollaboratorRevocationRetry,
  enqueueOrgMemberRevocationRetry,
} from "@/lib/stream/access-revocation";
import { streamLogger } from "@/lib/stream-logger";
import { markMembership } from "@/lib/stream-cache";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "@/lib/stream-channel-ids";
import { bookingOrgId, getDmChannelId } from "@/lib/stream-utils";
import { dmEligibleStatusFilter } from "@/lib/stream/dm-eligibility-statuses";
import { queryOrgTaggedChannels } from "@/lib/stream/event-channel-service";
import {
  liveParticipant,
  transitionParticipant,
} from "@/lib/booking/participants";
import { getAppUrl } from "@/lib/url";
import {
  revokeCollaboratorAccess,
  type PlanType,
} from "@/lib/collaborators/service";

export const STREAM_REVOCATION_RETRY_WINDOW_HOURS = 72;

export interface RemoveMemberInput {
  orgId: string;
  memberId: string;
  actor:
    | { membershipId: string; role: GuardedMembership["role"] }
    | { kind: "self"; membershipId: string; role: GuardedMembership["role"] };
  actorUserId: string;
  force: boolean;
  releaseActiveSeats?: boolean;
}

export type RemoveMemberResult = { removed: boolean };

interface RevokedOrgCollaboration {
  collaboratorId: string;
  planType: PlanType;
  planId: string;
  planTitle: string;
  collaboratorName: string;
  role: string;
  revenueShareBps: number;
  hostUserId: string | null;
}

interface PostCommit {
  removedUserId: string | null;
  expertNotice: { userId: string; payload: OrgExpertRemovedPayload } | null;
  memberBells: StagedTrigger[];
  email: StagedOnboardingEmail | null;
  revokedCollaborations: RevokedOrgCollaboration[];
}

async function validateSelfLeaveObligations(
  tx: Tx,
  current: GuardedMembership & { id: string; userId: string },
  input: RemoveMemberInput,
  now: Date,
): Promise<RemovalObligations> {
  if (
    input.actor.membershipId !== input.memberId ||
    current.userId !== input.actorUserId
  ) {
    throw Object.assign(new Error("Cannot leave on behalf of another member"), {
      httpStatus: 403,
    });
  }
  if (current.role === "OWNER" && current.status === "ACTIVE") {
    await assertNotLastOwner(tx, input.orgId, input.memberId);
  }
  const rawObligations = await countRemovalObligations(tx, current, now);
  const obligations = input.releaseActiveSeats
    ? { ...rawObligations, liveSeats: 0 }
    : rawObligations;
  const total = Object.values(obligations).reduce((sum, n) => sum + n, 0);
  if (total > 0) {
    throw new MembershipGuardError(
      "MEMBER_HAS_OBLIGATIONS",
      "You still have upcoming sessions or money in progress under this organization. Settle or cancel those before leaving.",
      409,
      { ...obligations },
    );
  }
  return obligations;
}

async function collectAndCancelOrgCollaborations(
  tx: Tx,
  orgId: string,
  userId: string,
  now: Date,
): Promise<RevokedOrgCollaboration[]> {
  if (!tx.collaborator?.findMany) return [];
  const orgCollabs = await tx.collaborator.findMany({
    where: {
      status: { in: ["PENDING", "ACCEPTED"] },
      consultantProfile: { userId },
      OR: [
        { webinarPlan: { organizationId: orgId } },
        { classPlan: { organizationId: orgId } },
      ],
    },
    include: {
      consultantProfile: {
        select: { user: { select: { name: true, email: true } } },
      },
      webinarPlan: {
        select: {
          id: true,
          title: true,
          consultantProfile: {
            select: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      },
      classPlan: {
        select: {
          id: true,
          title: true,
          consultantProfile: {
            select: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      },
    },
  });
  if (orgCollabs.length === 0) return [];

  await tx.collaborator.updateMany({
    where: {
      id: { in: orgCollabs.map((c) => c.id) },
      status: { in: ["PENDING", "ACCEPTED"] },
    },
    data: { status: "REMOVED" },
  });
  // Through the participant map, so a REFUNDED seat stays terminal.
  await transitionParticipant(
    tx,
    {
      userId,
      role: "COLLABORATOR",
      appointment: {
        deletedAt: null,
        occurrences: {
          some: { startsAt: { gt: now }, deletedAt: null },
        },
        OR: [
          { webinar: { webinarPlan: { organizationId: orgId } } },
          { class: { classPlan: { organizationId: orgId } } },
        ],
      },
    },
    "CANCELLED",
  );

  const revoked: RevokedOrgCollaboration[] = [];
  for (const c of orgCollabs) {
    const plan = c.webinarPlan ?? c.classPlan;
    if (!plan) continue;
    const planType: PlanType = c.webinarPlan ? "webinar" : "class";
    revoked.push({
      collaboratorId: c.id,
      planType,
      planId: plan.id,
      planTitle: plan.title,
      collaboratorName:
        c.consultantProfile.user.name ??
        c.consultantProfile.user.email ??
        "Collaborator",
      role: String(c.role),
      revenueShareBps: c.revenueShareBps,
      hostUserId: plan.consultantProfile?.user.id ?? null,
    });
  }
  return revoked;
}

async function removeInTx(
  tx: Tx,
  input: RemoveMemberInput,
): Promise<PostCommit & RemoveMemberResult> {
  const { orgId, memberId, actor, actorUserId, force } = input;
  const current = await tx.membership.findFirst({
    where: { id: memberId, organizationId: orgId },
  });
  if (!current) {
    throw Object.assign(new Error("Member not found"), { httpStatus: 404 });
  }
  if (current.status === "REMOVED" || current.status === "ERASED") {
    return {
      removed: false,
      removedUserId: null,
      expertNotice: null,
      memberBells: [],
      email: null,
      revokedCollaborations: [],
    };
  }

  const now = new Date();
  const isSelfLeave = "kind" in actor && actor.kind === "self";
  let obligations: RemovalObligations;
  let forced = false;

  if (isSelfLeave) {
    obligations = await validateSelfLeaveObligations(tx, current, input, now);
  } else {
    const res = await assertRemovable(tx, {
      membership: current,
      actor: {
        kind: "member",
        membershipId: actor.membershipId,
        role: actor.role,
      },
      force,
      now,
    });
    obligations = res.obligations;
    forced = res.forced;
  }

  await transitionMembership(tx, {
    where: { id: memberId, organizationId: orgId },
    to: "REMOVED",
  });
  if (!isSelfLeave) {
    await revokeOrgManagedUserSessions(tx, orgId, current.userId);
  }
  if (current.role === "EXPERT" && current.consultantProfileId) {
    await recomputeConsultantIsIndependent(tx, current.consultantProfileId);
  }

  const revokedCollaborations = await collectAndCancelOrgCollaborations(
    tx,
    orgId,
    current.userId,
    now,
  );

  const terminated = await tx.programAssignment.updateMany({
    where: {
      membershipId: memberId,
      periodEnd: { gte: now },
      status: { in: ["ACTIVE", "PAUSED"] },
    },
    data: { periodEnd: now, status: "CANCELLED" },
  });
  await releaseSeatsForTerminatedAssignments(tx, [memberId], now);

  await tx.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: actor.membershipId,
      targetMembershipId: memberId,
      category: "MEMBER",
      action: AUDIT_ACTIONS.MEMBER.MEMBER_REMOVED,
      description: isSelfLeave
        ? "Member left the organization"
        : `Removed member ${memberId}`,
      details: {
        role: current.role,
        previousStatus: current.status,
        assignmentsTerminated: terminated.count,
        ...(isSelfLeave && { selfLeave: true }),
        ...(forced && { forced: true, obligations: { ...obligations } }),
      },
    },
  });

  await dispatchWebhookEvent({
    prisma: tx,
    organizationId: orgId,
    eventType: "member.removed",
    payload: {
      membershipId: memberId,
      userId: current.userId,
      role: current.role,
      previousStatus: current.status,
    },
  });

  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: { name: true, slug: true },
  });
  const actorUser = await tx.user.findUnique({
    where: { id: actorUserId },
    select: { name: true, email: true },
  });
  if (!org) {
    return {
      removed: true,
      removedUserId: current.userId,
      expertNotice: null,
      memberBells: [],
      email: null,
      revokedCollaborations,
    };
  }
  const actorName = actorUser?.name ?? actorUser?.email ?? "An operator";
  const dashboardUrl =
    current.role === "EXPERT"
      ? `${getAppUrl()}${goHref("expert")}`
      : "/dashboard";
  const email = await stageOrgMembershipChangedEmail(
    {
      userId: current.userId,
      membershipId: memberId,
      kind: "REMOVED",
      orgName: org.name,
      roleBefore: current.role,
      actorName,
      dashboardUrl,
    },
    tx,
  );

  if (current.role === "EXPERT") {
    return {
      removed: true,
      removedUserId: current.userId,
      email,
      memberBells: [],
      revokedCollaborations,
      expertNotice: {
        userId: current.userId,
        payload: {
          orgName: org.name,
          orgSlug: org.slug,
          removedByName: actorName,
          reason: null,
          dashboardUrl,
        },
      },
    };
  }
  const memberBells =
    (await notifyOrgMemberRemoved(
      current.userId,
      {
        organizationId: orgId,
        orgName: org.name,
        removedByName: actorName,
        reason: null,
        dashboardUrl,
      },
      { tx },
    )) ?? [];
  return {
    removed: true,
    removedUserId: current.userId,
    expertNotice: null,
    memberBells,
    email,
    revokedCollaborations,
  };
}

export interface OrgStreamSurfaces {
  webinarIds: string[];
  classIds: string[];
  dmChannelIds: string[];
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
  });

  const classes = await prisma.class.findMany({
    where: buildOrgClassSurfaceWhere(orgId, userId, onlyUnfrozen),
    select: { id: true },
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
    consultations.map((c) => ({
      plan: c.consultationPlan,
      requestedBy: c.requestedBy,
      appointment: c.appointment,
    })),
  );
  addOneToOneOrgDmChannels(
    dmChannelIds,
    orgId,
    subscriptions.map((s) => ({
      plan: s.subscriptionPlan,
      requestedBy: s.requestedBy,
      appointment: s.appointment,
    })),
  );

  return {
    webinarIds: webinars.map((w) => w.id),
    classIds: classes.map((c) => c.id),
    dmChannelIds: Array.from(dmChannelIds),
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
): Promise<void> {
  try {
    const { channels: taggedChannels, truncated } =
      await queryOrgTaggedChannels(chat, orgId, {
        members: { $in: [userId] },
      });
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
): Promise<number> {
  let channelsRemoved = 0;
  for (const [cid, type] of targets) {
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

/** Drops the removed member from the org's live and upcoming calls; `/join` re-adds anyone Postgres still admits. */
async function removeMemberFromOrgCalls(
  orgId: string,
  userId: string,
  failures: string[],
): Promise<void> {
  try {
    const video = getStreamVideoClient().video;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_ORG_CALL_PAGES; page++) {
      const occurrences = await prisma.appointmentOccurrence.findMany({
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
      for (const { meeting } of occurrences) {
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
  revokeTokensIssuedBefore?: Date;
}): Promise<RevokeMemberStreamResult> {
  const { userId, orgId } = input;
  if (!isStreamConfigured()) {
    return {
      channelsRemoved: 0,
      tokenRevoked: false,
      complete: true,
      failures: [],
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
    streamLogger.error(
      "Failed to load org Stream surfaces for member removal",
      err,
      { userId, orgId },
    );
    return {
      channelsRemoved: 0,
      tokenRevoked,
      complete: false,
      failures,
    };
  }

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

  await populateOrgTaggedMemberTargets(chat, orgId, userId, targets, failures);
  const channelsRemoved = await removeMemberFromTargetChannels(
    chat,
    orgId,
    userId,
    targets,
    failures,
  );
  await removeMemberFromOrgCalls(orgId, userId, failures);

  return {
    channelsRemoved,
    tokenRevoked,
    complete: failures.length === 0,
    failures,
  };
}

async function dispatchRevokedCollaborationNotices(
  revokedCollaborations: Awaited<
    ReturnType<typeof removeInTx>
  >["revokedCollaborations"],
): Promise<void> {
  for (const c of revokedCollaborations) {
    if (!c.hostUserId) continue;
    const hostUserId = c.hostUserId;
    const dashboardUrl = `${getAppUrl()}${goHref("expert", "collaborations")}`;
    await scheduleAfter(async () => {
      await notifyCollaboratorWithdrawn(hostUserId, {
        collaboratorName: c.collaboratorName,
        planTitle: c.planTitle,
        planType: c.planType,
        dashboardUrl,
      }).catch((e) => Sentry.captureException(e));
      await sendCollaboratorWithdrawnEmail(
        {
          recipientUserId: hostUserId,
          actorName: c.collaboratorName,
          collaboratorName: c.collaboratorName,
          planTitle: c.planTitle,
          planType: c.planType,
          role: c.role,
          revenueShareBps: c.revenueShareBps,
          collaboratorId: c.collaboratorId,
        },
        EMAIL_BUDGET_MS.REQUEST,
      ).catch((e) => Sentry.captureException(e));
    }, "org.member-removal.collaborator-withdrawn");
  }
}

async function revokeRemovedMemberStream(
  orgId: string,
  removedUserId: string,
): Promise<void> {
  try {
    const revocation = await revokeMemberStreamAccess({
      userId: removedUserId,
      orgId,
    });
    if (!revocation.complete) {
      await enqueueOrgMemberRevocationRetry(orgId, removedUserId);
      Sentry.captureException(
        new Error(
          `Partial Stream revocation on org member removal: ${revocation.failures.join("; ")}`,
        ),
        {
          tags: { subsystem: "stream", op: "org.member-removal" },
          extra: { orgId, userId: removedUserId },
        },
      );
    }
  } catch (streamErr) {
    Sentry.captureException(
      streamErr instanceof Error ? streamErr : new Error(String(streamErr)),
      {
        tags: { subsystem: "stream", op: "org.member-removal" },
        extra: { orgId, userId: removedUserId },
      },
    );
  }
}

/**
 * Runs the removal Serializable (the last-OWNER count must not write-skew)
 * and fires the notices after commit. Throws `MembershipGuardError` or an
 * `httpStatus`-tagged error for the caller to map.
 */
export async function removeMember(
  input: RemoveMemberInput,
): Promise<RemoveMemberResult> {
  const result = await withSerializableRetry(() =>
    prisma.$transaction((tx) => removeInTx(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  );

  // Fire-and-forget after commit: a failed notice must not undo a removal.
  if (result.expertNotice) {
    const notice = result.expertNotice;
    try {
      await notifyOrgExpertRemoved(notice.userId, notice.payload);
    } catch (notifyErr) {
      Sentry.captureException(
        notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
        { tags: { subsystem: "organizations" } },
      );
    }
  }
  if (result.email || result.memberBells.length > 0) {
    const staged = result.email;
    const bells = result.memberBells;
    await scheduleAfter(async () => {
      for (const row of bells) await attemptTrigger(row);
      if (staged) await attemptOnboardingEmail(staged);
    }, "org.member-removal.onboarding-email");
  }
  if (result.removedUserId) {
    const removedUserId = result.removedUserId;
    for (const c of result.revokedCollaborations) {
      const { success } = await revokeCollaboratorAccess(
        c.planType,
        c.planId,
        removedUserId,
      );
      if (!success) {
        await enqueueCollaboratorRevocationRetry(
          c.planType,
          c.planId,
          removedUserId,
        );
      }
    }
    await dispatchRevokedCollaborationNotices(result.revokedCollaborations);
    await revokeRemovedMemberStream(input.orgId, removedUserId);
  }
  return { removed: result.removed };
}
