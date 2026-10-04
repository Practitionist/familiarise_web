import * as Sentry from "@sentry/nextjs";
import type { ChannelFilters, StreamChat } from "stream-chat";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import {
  getStreamChatClient,
  getStreamVideoClient,
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
  queryChannelsPaged,
} from "@/lib/stream/batch";
import {
  DEFAULT_RETENTION_DAYS,
  isPastRetention,
} from "@/lib/stream/channel-lifecycle";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
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

async function tryAddToExistingChannel(
  channel: ReturnType<StreamChat["channel"]>,
  channelId: string,
  userId: string,
): Promise<boolean> {
  try {
    await withStreamCircuitBreaker(
      () => channel.addMembers([userId]),
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

export async function addUserToEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{
  success: boolean;
  channelId: string;
  created?: boolean;
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
    return { success: false, channelId };
  }

  try {
    const channel = client.channel(channelType, channelId);

    if (await tryAddToExistingChannel(channel, channelId, userId)) {
      return { success: true, channelId };
    }

    const eventData = await getEventData(eventType, eventId);
    if (!eventData) {
      throw new Error(`${eventType} not found: ${eventId}`);
    }

    const { consultantId, members, name, organizationId } = eventData;
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
        await channel.addMembers([userId]);
      } catch (adoptError) {
        adoptRetryFailed = true;
        streamLogger.warn("Post-adoption addMembers retry failed (non-fatal)", {
          channelId,
          userId,
          error: adoptError,
        });
      }
    }

    await addRemainingMembers(channelWithData, syncedMembers);

    try {
      await channelWithData.assignRoles([
        { user_id: consultantId, channel_role: "channel_moderator" },
      ]);
    } catch (grantError) {
      streamLogger.warn("Failed to grant channel_moderator to event host", {
        channelId,
        consultantId,
        error: grantError,
      });
    }

    markChannelExists(channelType, channelId);
    if (!adoptRetryFailed) {
      markMembership(channelId, userId, true);
    }

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
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);
  userIdSchema.parse(userId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);
  const client = getStreamChatClient();

  try {
    const channel = client.channel(channelType, channelId);
    await channel.removeMembers([userId]);
    markMembership(channelId, userId, false);
    streamLogger.info("Removed user from event channel", {
      channelId,
      userId,
    });
    return { success: true };
  } catch (error) {
    markMembership(channelId, userId, false);
    if (isExpectedStreamError(error)) {
      streamLogger.debug("No event channel to remove the user from", {
        eventType,
        eventId,
        userId,
      });
      return { success: true };
    }
    streamLogger.warn("Failed to remove user from event channel", {
      eventType,
      eventId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false };
  }
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
    select: { consultantProfile: { select: { userId: true } } },
  },
};

const groupEventAppointmentInclude = {
  participants: {
    where: liveParticipant(),
    select: { userId: true },
  },
};

function buildGroupEventData(
  plan: {
    title: string;
    organizationId: string | null;
    consultantProfile?: { user?: { id: string } | null } | null;
    collaborators?: { consultantProfile: { userId: string } }[];
  },
  appointment: {
    organizationId: string | null;
    participants: { userId: string }[];
  } | null,
) {
  const consultantId = plan.consultantProfile?.user?.id;
  if (!consultantId) return null;

  const members = [
    ...(plan.collaborators ?? []).map((c) => c.consultantProfile.userId),
    ...(appointment?.participants.map((p) => p.userId) || []),
  ];

  const organizationId = bookingOrgId({
    webinarPlan: plan,
    appointment,
  });

  return {
    consultantId,
    members,
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
  const collaboratorFilter = {
    collaborators: {
      some: {
        consultantProfile: { userId, deletedAt: null },
        status: "ACCEPTED" as const,
      },
    },
  };
  const appointmentFilter = {
    deletedAt: null,
    occurrences: { some: { deletedAt: null } },
    participants: { some: liveParticipant(userId) },
  };
  const appointmentSelect = {
    organization: {
      select: {
        chatRetentionDays: true,
        streamRecordingRetentionDays: true,
      },
    },
    occurrences: {
      orderBy: { endsAt: "desc" as const },
      take: 1,
      select: { endsAt: true },
    },
  };
  const planOrgSelect = {
    organization: {
      select: {
        chatRetentionDays: true,
        streamRecordingRetentionDays: true,
      },
    },
  };

  if (eventType === "webinar") {
    const hit = await prisma.webinar.findFirst({
      where: {
        id: eventId,
        status: { in: [...OPENABLE_EVENT_STATUSES] },
        OR: [
          { appointment: appointmentFilter },
          { webinarPlan: { consultantProfile: { userId } } },
          { webinarPlan: collaboratorFilter },
        ],
      },
      select: {
        id: true,
        webinarPlan: { select: planOrgSelect },
        appointment: { select: appointmentSelect },
      },
    });
    if (!hit) return false;
    return !isPastRetention(
      hit.appointment?.occurrences[0]?.endsAt ?? null,
      resolveEventRetentionDays(
        hit.webinarPlan?.organization,
        hit.appointment?.organization,
      ),
    );
  }

  const hit = await prisma.class.findFirst({
    where: {
      id: eventId,
      status: { in: [...OPENABLE_EVENT_STATUSES] },
      OR: [
        { appointment: appointmentFilter },
        { classPlan: { consultantProfile: { userId } } },
        { classPlan: collaboratorFilter },
      ],
    },
    select: {
      id: true,
      schedulingPeriodEndsAt: true,
      classPlan: { select: planOrgSelect },
      appointment: { select: appointmentSelect },
    },
  });
  if (!hit) return false;
  return !isPastRetention(
    hit.appointment?.occurrences[0]?.endsAt ??
      hit.schedulingPeriodEndsAt ??
      null,
    resolveEventRetentionDays(
      hit.classPlan?.organization,
      hit.appointment?.organization,
    ),
  );
}

export async function queryOrgTaggedChannels(
  chat: StreamChat,
  organizationId: string,
  extraFilter?: Record<string, unknown>,
) {
  const filter = {
    ...extraFilter,
    organization_id: { $eq: organizationId },
  } as unknown as ChannelFilters;
  return queryChannelsPaged((opts) =>
    chat.queryChannels(filter, [{ last_message_at: -1 }], opts),
  );
}

async function endSingleStreamVideoCall(
  video: ReturnType<typeof getStreamVideoClient>["video"],
  call: { id: string; streamCallId: string },
  options: {
    now: Date;
    endedReason: string | null;
    errorPrefix: string;
    useCircuitBreaker?: boolean;
  },
  errors: string[],
): Promise<boolean> {
  let counted = false;
  let ended = false;
  try {
    const endCall = () =>
      video.call(STREAM_CALL_TYPE, toCallId(call.streamCallId)).end();
    await (options.useCircuitBreaker
      ? withStreamCircuitBreaker(endCall)
      : endCall());
    ended = true;
    counted = true;
  } catch (err) {
    if (isExpectedStreamError(err)) {
      ended = true;
    } else {
      errors.push(
        `${options.errorPrefix} call ${call.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (ended && prisma.meeting?.updateMany) {
    try {
      await prisma.meeting.updateMany({
        where: { id: call.id, endedAt: null },
        data: { endedAt: options.now, endedReason: options.endedReason },
      });
    } catch (dbErr) {
      errors.push(
        `${options.errorPrefix} meeting update ${call.id}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }
  }
  return counted;
}

export async function endActiveStreamVideoCalls(
  calls: { id: string; streamCallId: string }[],
  options: {
    now: Date;
    endedReason: string | null;
    errorPrefix: string;
    useCircuitBreaker?: boolean;
  },
): Promise<{ callsEnded: number; errors: string[] }> {
  let callsEnded = 0;
  const errors: string[] = [];
  if (calls.length === 0) return { callsEnded, errors };

  try {
    const video = getStreamVideoClient().video;
    for (const call of calls) {
      const counted = await endSingleStreamVideoCall(
        video,
        call,
        options,
        errors,
      );
      if (counted) callsEnded++;
    }
  } catch (err) {
    errors.push(
      `${options.errorPrefix} video client: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { callsEnded, errors };
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
