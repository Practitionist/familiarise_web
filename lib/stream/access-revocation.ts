import type { CollaboratorType, StreamRevocationKind } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  getStreamChatClient,
  getStreamVideoClient,
  isExpectedStreamError,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { paidParticipant } from "@/lib/booking/participants";
import { MAX_CALL_DURATION_MS } from "@/lib/meetings/duration-cap";
import { STREAM_CALL_TYPE } from "@/lib/stream/call-cid";
import { getDmChannelId } from "@/lib/stream-utils";
import { reportSentryError } from "@/lib/observability/report";
import {
  isDmChannelIdEligible,
  isDmContextEligible,
} from "@/lib/stream/dm-eligibility";
import {
  isEventParticipant,
  removeUsersFromEventChannel,
} from "@/lib/stream/event-channel-service";

/** The revocations a mutating action owes Stream; erasure rows are written by the scrub. */
export type AccessRevocationKind = Exclude<
  StreamRevocationKind,
  "ERASURE_REVOKE"
>;

export interface AccessRevocationTarget {
  kind: AccessRevocationKind;
  userId: string;
  planId: string;
  planType?: CollaboratorType | null;
  counterpartUserId?: string | null;
}

/**
 * Queues revocations Stream refused for the moderation retry sweep. A target
 * that already has an open row is re-armed, so a capped row cannot swallow a new revocation.
 */
export async function enqueueStreamRevocationRetries(
  targets: AccessRevocationTarget[],
): Promise<void> {
  if (targets.length === 0) return;
  await prisma.streamRevocationRetry.updateMany({
    where: {
      erasureRequestId: null,
      status: { not: "SUCCEEDED" },
      OR: targets.map((t) => ({
        kind: t.kind,
        planId: t.planId,
        userId: t.userId,
      })),
    },
    data: {
      status: "PENDING",
      attempts: 0,
      nextRetryAt: null,
      lastError: null,
    },
  });
  await prisma.streamRevocationRetry.createMany({
    data: targets.map((t) => ({
      kind: t.kind,
      userId: t.userId,
      planId: t.planId,
      planType: t.planType ?? null,
      counterpartUserId: t.counterpartUserId ?? null,
    })),
    skipDuplicates: true,
  });
}

/** Enqueues and never throws: the action that owed the revocation has already committed. */
async function enqueueOrReport(
  targets: AccessRevocationTarget[],
  op: string,
): Promise<void> {
  try {
    await enqueueStreamRevocationRetries(targets);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op,
      extra: { targets: targets.length, kind: targets[0]?.kind },
    });
  }
}

async function removeFromDm(
  channelId: string,
  userId: string,
): Promise<boolean> {
  try {
    await getStreamChatClient()
      .channel("messaging", channelId)
      .removeMembers([userId]);
    return true;
  } catch (error) {
    return isExpectedStreamError(error);
  }
}

/** DM pairs checked inside the request; a larger cancellation queues the rest for the sweep. */
export const SYNC_DM_PAIR_LIMIT = 10;

export interface EndedBookingAccess {
  /** The users whose booking or seat just ended. */
  userIds: string[];
  /** The group event whose channel they lose, if the booking was a webinar or class. */
  event?: { type: "webinar" | "class"; id: string } | null;
  /** The host and presenters each user may share a DM with. */
  dmCounterpartUserIds: string[];
  /** The scope the booking's DM lives in; null is the personal thread. */
  dmOrganizationId: string | null;
}

/**
 * Removes the users from the event channel and from every DM the ended booking
 * no longer justifies. Called after the ending commit; a Stream failure queues a retry.
 */
export async function revokeEndedBookingChatAccess(
  input: EndedBookingAccess,
): Promise<void> {
  const userIds = Array.from(new Set(input.userIds.filter(Boolean)));
  if (userIds.length === 0) return;
  const retries: AccessRevocationTarget[] = [];

  if (input.event) {
    const { type, id } = input.event;
    const planType = type === "webinar" ? "WEBINAR" : "CLASS";
    let failedUserIds: string[];
    try {
      ({ failedUserIds } = await removeUsersFromEventChannel(
        type,
        id,
        userIds,
      ));
    } catch (error) {
      streamLogger.warn(
        "Event channel revocation interrupted; queued for retry",
        {
          users: userIds.length,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      failedUserIds = userIds;
    }
    for (const userId of failedUserIds) {
      retries.push({
        kind: "EVENT_CHANNEL_REMOVE",
        userId,
        planId: id,
        planType,
      });
    }
  }

  const counterparts = Array.from(new Set(input.dmCounterpartUserIds));
  const pairs = userIds.flatMap((userId) =>
    counterparts
      .filter((c) => c && c !== userId)
      .map((counterpartUserId) => ({
        userId,
        counterpartUserId,
        channelId: getDmChannelId(
          counterpartUserId,
          userId,
          input.dmOrganizationId,
        ),
      })),
  );
  for (const [index, pair] of pairs.entries()) {
    const dmRetry: AccessRevocationTarget = {
      kind: "DM_REMOVE",
      userId: pair.userId,
      planId: pair.channelId,
      counterpartUserId: pair.counterpartUserId,
    };
    if (index >= SYNC_DM_PAIR_LIMIT) {
      retries.push(dmRetry);
      continue;
    }
    // A failed check queues the pair; the sweep re-checks eligibility before removing.
    try {
      const eligible = await isDmContextEligible(
        pair.counterpartUserId,
        pair.userId,
        input.dmOrganizationId,
      );
      if (eligible) continue;
    } catch (error) {
      streamLogger.warn("DM eligibility check failed; queued for retry", {
        channelId: pair.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      retries.push(dmRetry);
      continue;
    }
    if (!(await removeFromDm(pair.channelId, pair.userId))) {
      retries.push(dmRetry);
    }
  }

  await enqueueOrReport(dedupeTargets(retries), "booking.revokeChatAccess");
}

function dedupeTargets(
  targets: AccessRevocationTarget[],
): AccessRevocationTarget[] {
  const byKey = new Map<string, AccessRevocationTarget>();
  for (const t of targets) byKey.set(`${t.kind}:${t.planId}:${t.userId}`, t);
  return Array.from(byKey.values());
}

/** Queues a collaborator revocation that `revokeCollaboratorAccess` reported as incomplete. */
export async function enqueueCollaboratorRevocationRetry(
  planType: "webinar" | "class",
  planId: string,
  userId: string,
): Promise<void> {
  await enqueueOrReport(
    [
      {
        kind: "COLLAB_REVOKE",
        userId,
        planId,
        planType: planType === "webinar" ? "WEBINAR" : "CLASS",
      },
    ],
    "collaborator.revokeAccess",
  );
}

/**
 * Removes the user from the appointment's open calls and blocks them from
 * rejoining. Returns false when Stream refused a call, so the caller queues CALL_KICK.
 */
export async function kickUserFromAppointmentCalls(
  appointmentId: string,
  userId: string,
): Promise<boolean> {
  try {
    const occurrences = await prisma.appointmentOccurrence.findMany({
      where: {
        appointmentId,
        deletedAt: null,
        endsAt: { gt: new Date(Date.now() - MAX_CALL_DURATION_MS) },
        meeting: { is: { endedAt: null } },
      },
      select: { meeting: { select: { streamCallId: true } } },
    });
    const video = getStreamVideoClient().video;
    const results = await Promise.allSettled(
      occurrences.flatMap(({ meeting }) => {
        if (!meeting) return [];
        const call = video.call(STREAM_CALL_TYPE, meeting.streamCallId);
        return [
          (async () => {
            await call.updateCallMembers({ remove_members: [userId] });
            await call.kickUser({ user_id: userId, block: true });
          })(),
        ];
      }),
    );
    const failures = results.filter(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" && !isExpectedStreamError(r.reason),
    );
    if (failures.length === 0) return true;
    reportSentryError(failures[0].reason, {
      subsystem: "stream",
      op: "participantRemoval.kickFromCalls",
      extra: { appointmentId, failed: failures.length },
    });
    return false;
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "participantRemoval.kickFromCalls",
      extra: { appointmentId },
    });
    return false;
  }
}

/** Queues a call kick that `kickUserFromAppointmentCalls` reported as incomplete. */
export async function enqueueCallKickRetry(
  appointmentId: string,
  userId: string,
): Promise<void> {
  await enqueueOrReport(
    [{ kind: "CALL_KICK", userId, planId: appointmentId }],
    "participantRemoval.callKick",
  );
}

/** Queues an org-member revocation that did not fully land. */
export async function enqueueOrgMemberRevocationRetry(
  orgId: string,
  userId: string,
): Promise<void> {
  await enqueueOrReport(
    [{ kind: "ORG_REVOKE", userId, planId: orgId }],
    "org.member-removal",
  );
}

export interface AccessRevocationRow {
  kind: AccessRevocationKind;
  userId: string;
  planId: string;
  planType: CollaboratorType | null;
  counterpartUserId: string | null;
  createdAt: Date;
}

/**
 * Re-drives one queued revocation. Returns the error to record, or null when
 * the access is gone or Postgres has since re-granted it.
 */
export async function redriveAccessRevocation(
  row: AccessRevocationRow,
): Promise<string | null> {
  switch (row.kind) {
    case "COLLAB_REVOKE":
      return redriveCollaboratorRevocation(row);
    case "EVENT_CHANNEL_REMOVE":
      return redriveEventChannelRemoval(row);
    case "DM_REMOVE":
      return redriveDmRemoval(row);
    case "ORG_REVOKE":
      return redriveOrgRevocation(row);
    case "CALL_KICK":
      return redriveCallKick(row);
  }
}

async function redriveCallKick(
  row: AccessRevocationRow,
): Promise<string | null> {
  const reinstated = await prisma.appointmentParticipant.findFirst({
    where: { appointmentId: row.planId, ...paidParticipant(row.userId) },
    select: { id: true },
  });
  if (reinstated) return null;
  return (await kickUserFromAppointmentCalls(row.planId, row.userId))
    ? null
    : "Call kick failed";
}

async function redriveCollaboratorRevocation(
  row: AccessRevocationRow,
): Promise<string | null> {
  if (!row.planType) return "COLLAB_REVOKE row has no plan type";
  const planType = row.planType === "WEBINAR" ? "webinar" : "class";
  const regranted = await prisma.collaborator.findFirst({
    where: {
      status: "ACCEPTED",
      consultantProfile: { userId: row.userId, deletedAt: null },
      ...(planType === "webinar"
        ? { webinarPlanId: row.planId }
        : { classPlanId: row.planId }),
    },
    select: { id: true },
  });
  if (regranted) return null;
  const { revokeCollaboratorAccess } =
    await import("@/lib/collaborators/service");
  const { success } = await revokeCollaboratorAccess(
    planType,
    row.planId,
    row.userId,
  );
  return success ? null : "Collaborator Stream access not fully revoked";
}

async function redriveEventChannelRemoval(
  row: AccessRevocationRow,
): Promise<string | null> {
  if (!row.planType) return "EVENT_CHANNEL_REMOVE row has no event type";
  const type = row.planType === "WEBINAR" ? "webinar" : "class";
  if (await isEventParticipant(type, row.planId, row.userId)) return null;
  const { failedUserIds } = await removeUsersFromEventChannel(
    type,
    row.planId,
    [row.userId],
  );
  return failedUserIds.length === 0 ? null : "Event channel removal failed";
}

async function redriveDmRemoval(
  row: AccessRevocationRow,
): Promise<string | null> {
  if (!row.counterpartUserId) return "DM_REMOVE row has no counterpart";
  if (
    await isDmChannelIdEligible(row.counterpartUserId, row.userId, row.planId)
  ) {
    return null;
  }
  return (await removeFromDm(row.planId, row.userId))
    ? null
    : "DM removal failed";
}

async function redriveOrgRevocation(
  row: AccessRevocationRow,
): Promise<string | null> {
  const rejoined = await prisma.membership.findFirst({
    where: {
      userId: row.userId,
      organizationId: row.planId,
      status: { in: ["ACTIVE", "PENDING"] },
    },
    select: { id: true },
  });
  if (rejoined) return null;
  const { revokeMemberStreamAccess } =
    await import("@/lib/stream/org-access-revocation");
  const outcome = await revokeMemberStreamAccess({
    userId: row.userId,
    orgId: row.planId,
    revokeTokensIssuedBefore: row.createdAt,
  });
  return outcome.complete ? null : outcome.failures.join("; ");
}

async function loadEventDmContext(
  type: "webinar" | "class",
  eventId: string,
): Promise<{ counterparts: string[]; organizationId: string | null }> {
  const planSelect = {
    organizationId: true,
    consultantProfile: { select: { userId: true } },
    collaborators: {
      where: {
        status: "ACCEPTED" as const,
        tier: "PRESENTER" as const,
        consultantProfile: { deletedAt: null },
      },
      select: { consultantProfile: { select: { userId: true } } },
    },
  };
  const row =
    type === "webinar"
      ? await prisma.webinar.findUnique({
          where: { id: eventId },
          select: {
            appointment: { select: { organizationId: true } },
            webinarPlan: { select: planSelect },
          },
        })
      : await prisma.class.findUnique({
          where: { id: eventId },
          select: {
            appointment: { select: { organizationId: true } },
            classPlan: { select: planSelect },
          },
        });
  if (!row) return { counterparts: [], organizationId: null };
  const plan = "webinarPlan" in row ? row.webinarPlan : row.classPlan;
  const counterparts = [
    plan.consultantProfile?.userId,
    ...plan.collaborators.map((c) => c.consultantProfile.userId),
  ].filter((id): id is string => Boolean(id));
  return {
    counterparts,
    organizationId:
      plan.organizationId ?? row.appointment?.organizationId ?? null,
  };
}

/** Ends the users' access to a webinar or class channel and to the presenter DMs only that seat justified. */
export async function revokeEndedEventChatAccess(
  type: "webinar" | "class",
  eventId: string,
  userIds: string[],
): Promise<void> {
  let context: { counterparts: string[]; organizationId: string | null } = {
    counterparts: [],
    organizationId: null,
  };
  try {
    context = await loadEventDmContext(type, eventId);
  } catch (error) {
    streamLogger.warn(
      "Event DM context unavailable; revoking the channel only",
      {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  await revokeEndedBookingChatAccess({
    userIds,
    event: { type, id: eventId },
    dmCounterpartUserIds: context.counterparts,
    dmOrganizationId: context.organizationId,
  });
}
