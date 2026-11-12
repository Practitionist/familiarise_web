import * as Sentry from "@sentry/nextjs";
import type { StreamChat } from "stream-chat";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { paidParticipant } from "@/lib/booking/participants";
import {
  getStreamChatClient,
  isExpectedStreamError,
  withStreamCircuitBreaker,
  StreamUnavailableError,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import {
  isChannelCached,
  markChannelExists,
  getMembershipCached,
  markMembership,
} from "@/lib/stream-cache";
import {
  upsertUserToStream,
  upsertUsersToStream,
} from "@/actions/stream/chat/user.action";
import { bookingOrgId, isChannelAlreadyExistsError } from "@/lib/stream-utils";
import {
  addRemainingMembers,
  createMemberChunk,
  forEachChunk,
} from "@/lib/stream/batch";
import {
  DEFAULT_RETENTION_DAYS,
  isPastRetention,
} from "@/lib/stream/channel-lifecycle";
import { OPENABLE_EVENT_STATUSES } from "@/lib/stream/dm-eligibility-statuses";
import { ConsentRequiredError } from "@/lib/compliance/dpdp";
import { isUpsertRefusal } from "@/lib/stream/connect-failure";

export const STREAM_SERVER_TRUSTED = Symbol.for(
  "familiarise.stream.serverTrusted",
);

export const eventTypeSchema = z.enum([
  "webinar",
  "class",
  "consultation",
  "subscription",
]);
export const eventIdSchema = z.string().min(1, "Event ID is required");
export const userIdSchema = z.string().min(1, "User ID is required");

export type EventType = z.infer<typeof eventTypeSchema>;

export function getChannelId(eventType: EventType, eventId: string): string {
  return `${eventType}-${eventId}`;
}

export function getChannelType(eventType: EventType): "messaging" | "team" {
  return eventType === "consultation" || eventType === "subscription"
    ? "messaging"
    : "team";
}

export async function checkEventChannelExists(
  eventType: EventType,
  eventId: string,
): Promise<boolean> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  const cached = isChannelCached(channelType, channelId);
  if (cached !== undefined) {
    streamLogger.debug("Channel existence from cache", {
      channelId,
      exists: cached,
    });
    return cached;
  }

  const client = getStreamChatClient();

  try {
    const channel = client.channel(channelType, channelId);
    await withStreamCircuitBreaker(
      () => channel.query({ state: false, messages: { limit: 0 } }),
      () => {
        throw new StreamUnavailableError();
      },
    );

    markChannelExists(channelType, channelId);
    streamLogger.debug("Channel exists", { channelId });
    return true;
  } catch {
    streamLogger.debug("Channel does not exist", { channelId });
    return false;
  }
}

async function syncUserOrSkipOnConsent(
  userId: string,
  channelId: string,
): Promise<boolean> {
  try {
    if (
      isUpsertRefusal(
        await upsertUserToStream(userId, {
          serverTrusted: STREAM_SERVER_TRUSTED,
        }),
      )
    ) {
      streamLogger.info(
        "Skipping event channel join — Stream refused the account",
        { userId, channelId },
      );
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      streamLogger.info(
        "Skipping event channel join — Stream consent not granted",
        { userId, channelId, purposeCode: err.purposeCode },
      );
      return false;
    }
    throw err;
  }
}

const MODERATOR_COLLABORATOR_ROLES = new Set([
  "CO_HOST",
  "CO_INSTRUCTOR",
  "MODERATOR",
]);

async function resolveEventCollaboratorChannelRole(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<"channel_moderator" | undefined> {
  if (eventType !== "webinar" && eventType !== "class") return undefined;

  const collab = await prisma.collaborator.findFirst({
    where: {
      status: "ACCEPTED",
      consultantProfile: { userId, deletedAt: null },
      ...(eventType === "webinar"
        ? { webinarPlan: { webinars: { some: { id: eventId } } } }
        : { classPlan: { classes: { some: { id: eventId } } } }),
    },
    select: { role: true },
  });

  if (collab && MODERATOR_COLLABORATOR_ROLES.has(collab.role)) {
    return "channel_moderator";
  }

  return undefined;
}

async function tryAddToExistingChannel(
  channel: ReturnType<StreamChat["channel"]>,
  channelId: string,
  userId: string,
  channelRole?: "channel_moderator",
): Promise<boolean> {
  const memberSpec = channelRole
    ? [{ user_id: userId, channel_role: channelRole }]
    : [userId];
  try {
    await withStreamCircuitBreaker(
      () => channel.addMembers(memberSpec),
      () => {
        throw new StreamUnavailableError();
      },
    );
    markMembership(channelId, userId, true);
    streamLogger.debug("Added user to existing channel", { channelId, userId });
    return true;
  } catch (addError) {
    if (addError instanceof StreamUnavailableError) throw addError;
    streamLogger.debug("Channel may not exist, attempting creation", {
      channelId,
    });
    return false;
  }
}

/** Why a join did not land: Stream refused the account, or the user is still not a member. */
export type EventChannelJoinFailure = "account_refused" | "member_not_added";

export async function addUserToEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{
  success: boolean;
  channelId: string;
  created?: boolean;
  reason?: EventChannelJoinFailure;
}> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);
  userIdSchema.parse(userId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  const membershipCached = getMembershipCached(channelId, userId);
  if (membershipCached === true) {
    streamLogger.debug("User already member (cached)", { channelId, userId });
    return { success: true, channelId };
  }

  const client = getStreamChatClient();

  if (!(await syncUserOrSkipOnConsent(userId, channelId))) {
    return { success: false, channelId, reason: "account_refused" };
  }

  const collaboratorChannelRole = await resolveEventCollaboratorChannelRole(
    eventType,
    eventId,
    userId,
  );
  const memberSpec = collaboratorChannelRole
    ? [{ user_id: userId, channel_role: collaboratorChannelRole }]
    : [userId];

  try {
    const channel = client.channel(channelType, channelId);

    if (
      await tryAddToExistingChannel(
        channel,
        channelId,
        userId,
        collaboratorChannelRole,
      )
    ) {
      return { success: true, channelId };
    }

    const eventData = await getEventData(eventType, eventId);
    if (!eventData) {
      throw new Error(`${eventType} not found: ${eventId}`);
    }

    const { consultantId, members, name, organizationId } = eventData;
    const moderatorIds =
      "moderatorIds" in eventData ? eventData.moderatorIds : [];
    const allMembers = Array.from(new Set([consultantId, userId, ...members]));

    const upsertResult = await upsertUsersToStream(allMembers, {
      serverTrusted: STREAM_SERVER_TRUSTED,
    });
    const droppedIds = new Set(upsertResult?.droppedIds ?? []);
    const syncedMembers = allMembers.filter((id) => !droppedIds.has(id));

    const eventChannelData = {
      name,
      created_by_id: consultantId,
      members: createMemberChunk(syncedMembers),
      [`${eventType}_id`]: eventId,
      ...(channelType === "team" && syncedMembers.length >= 100
        ? { cooldown: 3 }
        : {}),
      ...(organizationId ? { organization_id: organizationId } : {}),
    };

    const channelWithData = client.channel(
      channelType,
      channelId,
      eventChannelData as Record<string, unknown>,
    );

    let adoptRetryFailed = false;
    try {
      await withStreamCircuitBreaker(
        () => channelWithData.create(),
        () => {
          throw new StreamUnavailableError();
        },
      );
    } catch (createError) {
      if (!isChannelAlreadyExistsError(createError)) throw createError;

      streamLogger.info("Lost channel-create race; adopting existing channel", {
        channelId,
        userId,
      });

      try {
        await channel.addMembers(memberSpec);
      } catch (adoptError) {
        adoptRetryFailed = true;
        streamLogger.warn("Post-adoption addMembers retry failed", {
          channelId,
          userId,
          error: adoptError,
        });
      }
    }

    await addRemainingMembers(channelWithData, syncedMembers);

    const roleAssignments = Array.from(
      new Set([
        consultantId,
        ...moderatorIds.filter((id) => syncedMembers.includes(id)),
        ...(collaboratorChannelRole && syncedMembers.includes(userId)
          ? [userId]
          : []),
      ]),
    ).map((id) => ({
      user_id: id,
      channel_role: "channel_moderator" as const,
    }));

    try {
      await channelWithData.assignRoles(roleAssignments);
    } catch (grantError) {
      streamLogger.warn("Failed to grant channel_moderator to event host", {
        channelId,
        consultantId,
        error: grantError,
      });
    }

    markChannelExists(channelType, channelId);
    if (adoptRetryFailed) {
      return { success: false, channelId, reason: "member_not_added" };
    }
    markMembership(channelId, userId, true);

    streamLogger.info("Created channel and added user", {
      channelId,
      userId,
      memberCount: syncedMembers.length,
    });

    return { success: true, channelId, created: true };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to add user to event channel", error, {
      eventType,
      eventId,
      userId,
    });
    throw error;
  }
}

export async function removeUserFromEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{ success: boolean }> {
  userIdSchema.parse(userId);
  const { failedUserIds } = await removeUsersFromEventChannel(
    eventType,
    eventId,
    [userId],
  );
  return { success: failedUserIds.length === 0 };
}

/** Removes the users 100 at a time; a missing channel counts as removed. */
export async function removeUsersFromEventChannel(
  eventType: EventType,
  eventId: string,
  userIds: string[],
): Promise<{ failedUserIds: string[] }> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);
  const failedUserIds: string[] = [];
  if (userIds.length === 0) return { failedUserIds };

  await forEachChunk(userIds, async (batch) => {
    try {
      await getStreamChatClient()
        .channel(channelType, channelId)
        .removeMembers(batch);
    } catch (error) {
      if (!isExpectedStreamError(error)) {
        failedUserIds.push(...batch);
        streamLogger.warn("Failed to remove users from event channel", {
          channelId,
          count: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      for (const id of batch) markMembership(channelId, id, false);
    }
  });
  return { failedUserIds };
}

const groupEventPlanInclude = {
  consultantProfile: {
    include: { user: { select: { id: true } } },
  },
  collaborators: {
    where: {
      status: "ACCEPTED" as const,
      consultantProfile: { deletedAt: null },
    },
    select: {
      role: true,
      consultantProfile: { select: { userId: true } },
    },
  },
};

// Chat membership follows a paid seat; an unpaid HELD one is not a member.
const groupEventAppointmentInclude = {
  participants: {
    where: paidParticipant(),
    select: { userId: true },
  },
};

function buildGroupEventData(
  plan: {
    title: string;
    organizationId: string | null;
    consultantProfile?: { user?: { id: string } | null } | null;
    collaborators?: {
      role?: string;
      consultantProfile: { userId: string };
    }[];
  },
  appointment: {
    organizationId: string | null;
    participants: { userId: string }[];
  } | null,
) {
  const consultantId = plan.consultantProfile?.user?.id;
  if (!consultantId) return null;

  const collaborators = plan.collaborators ?? [];
  const members = [
    ...collaborators.map((c) => c.consultantProfile.userId),
    ...(appointment?.participants.map((p) => p.userId) || []),
  ];
  const moderatorIds = collaborators
    .filter((c) => c.role && MODERATOR_COLLABORATOR_ROLES.has(c.role))
    .map((c) => c.consultantProfile.userId);

  const organizationId = bookingOrgId({
    webinarPlan: plan,
    appointment,
  });

  return {
    consultantId,
    members,
    moderatorIds,
    name: plan.title,
    organizationId,
  };
}

export async function getEventData(eventType: EventType, eventId: string) {
  switch (eventType) {
    case "webinar": {
      const webinar = await prisma.webinar.findUnique({
        where: { id: eventId },
        include: {
          webinarPlan: { include: groupEventPlanInclude },
          appointment: { include: groupEventAppointmentInclude },
        },
      });
      if (!webinar) return null;
      return buildGroupEventData(webinar.webinarPlan, webinar.appointment);
    }

    case "class": {
      const classData = await prisma.class.findUnique({
        where: { id: eventId },
        include: {
          classPlan: { include: groupEventPlanInclude },
          appointment: { include: groupEventAppointmentInclude },
        },
      });
      if (!classData) return null;
      return buildGroupEventData(classData.classPlan, classData.appointment);
    }

    case "consultation": {
      const consultation = await prisma.consultation.findUnique({
        where: { id: eventId },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          requestedBy: {
            include: { user: { select: { id: true } } },
          },
          appointment: { select: { organizationId: true } },
        },
      });
      if (!consultation) return null;

      const consultantId =
        consultation.consultationPlan.consultantProfile?.user?.id;
      const consulteeId = consultation.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;

      const organizationId = bookingOrgId({
        consultationPlan: consultation.consultationPlan,
        appointment: consultation.appointment,
      });

      return {
        consultantId,
        members: [consultantId, consulteeId],
        name: `Consultation - ${consultation.consultationPlan.title}`,
        organizationId,
      };
    }

    case "subscription": {
      const subscription = await prisma.subscription.findUnique({
        where: { id: eventId },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          requestedBy: {
            include: { user: { select: { id: true } } },
          },
          appointment: { select: { organizationId: true } },
        },
      });
      if (!subscription) return null;

      const consultantId =
        subscription.subscriptionPlan.consultantProfile?.user?.id;
      const consulteeId = subscription.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;

      const organizationId = bookingOrgId({
        subscriptionPlan: subscription.subscriptionPlan,
        appointment: subscription.appointment,
      });

      return {
        consultantId,
        members: [consultantId, consulteeId],
        name: `Subscription - ${subscription.subscriptionPlan.title}`,
        organizationId,
      };
    }
  }
}

export interface OrgRetentionSource {
  chatRetentionDays?: number | null;
  streamRecordingRetentionDays?: number | null;
}

export function resolveEventRetentionDays(
  planOrg?: OrgRetentionSource | null,
  appointmentOrg?: OrgRetentionSource | null,
): number {
  return (
    planOrg?.chatRetentionDays ??
    appointmentOrg?.chatRetentionDays ??
    planOrg?.streamRecordingRetentionDays ??
    appointmentOrg?.streamRecordingRetentionDays ??
    DEFAULT_RETENTION_DAYS
  );
}

export async function isEventParticipant(
  eventType: "webinar" | "class",
  eventId: string,
  userId: string,
): Promise<boolean> {
  const admitted = await eventParticipantsAmong(eventType, eventId, [userId]);
  return admitted?.has(userId) ?? false;
}

const retentionOrgSelect = {
  select: { chatRetentionDays: true, streamRecordingRetentionDays: true },
};

/**
 * The subset of `userIds` with access to an openable, in-retention event's
 * channel: the host (profile not deleted), an ACCEPTED collaborator, or a paid
 * seat on a live appointment. `isEventParticipant` is this for one user.
 * Null means the event is missing, not openable or past retention: closed to everyone.
 */
export async function eventParticipantsAmong(
  eventType: "webinar" | "class",
  eventId: string,
  userIds: string[],
): Promise<Set<string> | null> {
  const ids = Array.from(new Set(userIds));
  const admitted = new Set<string>();
  if (ids.length === 0) return admitted;

  const planSelect = {
    select: {
      organization: retentionOrgSelect,
      consultantProfile: { select: { userId: true, deletedAt: true } },
      collaborators: {
        where: {
          status: "ACCEPTED" as const,
          consultantProfile: { userId: { in: ids }, deletedAt: null },
        },
        select: { consultantProfile: { select: { userId: true } } },
      },
    },
  };
  const appointmentSelect = {
    select: {
      deletedAt: true,
      organization: retentionOrgSelect,
      occurrences: {
        orderBy: { endsAt: "desc" as const },
        take: 1,
        select: { endsAt: true },
      },
      _count: {
        select: { occurrences: { where: { deletedAt: null } } },
      },
      participants: {
        where: { ...paidParticipant(), userId: { in: ids } },
        select: { userId: true },
      },
    },
  };
  const where = { id: eventId, status: { in: [...OPENABLE_EVENT_STATUSES] } };

  const hit =
    eventType === "webinar"
      ? await prisma.webinar.findFirst({
          where,
          select: { webinarPlan: planSelect, appointment: appointmentSelect },
        })
      : await prisma.class.findFirst({
          where,
          select: {
            schedulingPeriodEndsAt: true,
            classPlan: planSelect,
            appointment: appointmentSelect,
          },
        });
  if (!hit) return null;

  const plan = "webinarPlan" in hit ? hit.webinarPlan : hit.classPlan;
  const appointment = hit.appointment;
  const fallbackEndsAt =
    "schedulingPeriodEndsAt" in hit ? hit.schedulingPeriodEndsAt : null;
  if (
    isPastRetention(
      appointment?.occurrences[0]?.endsAt ?? fallbackEndsAt ?? null,
      resolveEventRetentionDays(plan?.organization, appointment?.organization),
    )
  ) {
    return null;
  }

  const host = plan?.consultantProfile;
  if (host && !host.deletedAt && ids.includes(host.userId)) {
    admitted.add(host.userId);
  }
  for (const c of plan?.collaborators ?? []) {
    admitted.add(c.consultantProfile.userId);
  }
  if (
    appointment &&
    appointment.deletedAt === null &&
    appointment._count.occurrences > 0
  ) {
    for (const p of appointment.participants) admitted.add(p.userId);
  }
  return admitted;
}

export function resolveStreamScopeFilter(searchParams: URLSearchParams): {
  mode: "all" | "personal" | "org";
  organizationId: string | null;
} {
  const explicitOrgId = searchParams.get("organizationId")?.trim() || null;
  const scope = searchParams.get("scope")?.trim() || null;
  if (explicitOrgId) {
    return { mode: "org", organizationId: explicitOrgId };
  }
  if (scope?.startsWith("org:")) {
    const parsedOrgId = scope.slice("org:".length).trim();
    if (parsedOrgId) {
      return { mode: "org", organizationId: parsedOrgId };
    }
  }
  if (scope === "personal") {
    return { mode: "personal", organizationId: null };
  }
  return { mode: "all", organizationId: null };
}

export function buildBookingOrgScopeWhere<
  K extends
    "consultationPlan" | "subscriptionPlan" | "webinarPlan" | "classPlan",
>(
  searchParams: URLSearchParams,
  planKey: K,
): Record<string, unknown> | undefined {
  const resolved = resolveStreamScopeFilter(searchParams);
  if (resolved.mode === "org" && resolved.organizationId) {
    return {
      OR: [
        { appointment: { organizationId: resolved.organizationId } },
        { [planKey]: { organizationId: resolved.organizationId } },
      ],
    };
  }
  if (resolved.mode === "personal") {
    return {
      [planKey]: { organizationId: null },
      OR: [
        { appointment: { is: null } },
        { appointment: { organizationId: null } },
      ],
    };
  }
  return undefined;
}
