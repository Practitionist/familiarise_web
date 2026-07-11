"use server";

import { z } from "zod";
import prisma from "@/lib/prisma";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { markChannelExists } from "@/lib/stream-cache";
import { upsertUsersToStream } from "./user.action";
import { getDmChannelId } from "@/lib/stream-utils";
import { getChannelTypeFromId } from "@/lib/stream-channel-ids";
import * as Sentry from "@sentry/nextjs";

// Input validation schemas
const channelTypeSchema = z.enum(["messaging", "team"]);
const channelIdSchema = z.string().min(1, "Channel ID is required");
const memberIdSchema = z.string().min(1, "Member ID is required");
const membersSchema = z
  .array(memberIdSchema)
  .min(1, "At least one member required");

const createChannelSchema = z.object({
  channelType: channelTypeSchema,
  channelId: channelIdSchema,
  channelName: z.string().optional(),
  members: membersSchema,
  createdById: memberIdSchema,
  additionalData: z.record(z.unknown()).optional(),
  // #B2 Stream.io org tagging — pre-launch enterprise tag so admins can later
  // query Stream API by `custom.organization_id`. Optional so personal
  // (non-org) channels keep their existing shape (no stray null field).
  organizationId: z.string().min(1).nullable().optional(),
});

/**
 * Best-effort channel-scoped `channel_moderator` grant (#899). Non-fatal: chat
 * still works without it. Shared by createChannel and the collaborator-channel
 * path so the grant contract lives in one place.
 */
async function grantChannelModerator(
  channel: ReturnType<ReturnType<typeof getStreamChatClient>["channel"]>,
  userId: string,
  channelId: string,
): Promise<void> {
  try {
    await channel.assignRoles([
      { user_id: userId, channel_role: "channel_moderator" },
    ]);
  } catch (error) {
    streamLogger.warn("Failed to grant channel_moderator to channel host", {
      channelId,
      userId,
      error,
    });
  }
}

/**
 * Generic function to create a channel
 * Validates inputs and handles member deduplication
 */
export async function createChannel(input: {
  channelType: "messaging" | "team";
  channelId: string;
  channelName?: string;
  members: string[];
  createdById: string;
  additionalData?: Record<string, unknown>;
  /**
   * Optional enterprise organization stamp. When non-null, written to the
   * channel's custom data as `organization_id` (snake_case per Stream's
   * convention) so org admins can list / query channels via Stream's
   * `queryChannels({filter: {organization_id: {$eq: orgId}}})`.
   * `null` / `undefined` → key omitted entirely so existing personal
   * channels created before this rollout don't gain a `null` field.
   */
  organizationId?: string | null;
}) {
  // Validate input
  const validated = createChannelSchema.parse(input);

  const client = getStreamChatClient();

  // Ensure creator is always included in members list
  const allMembers = Array.from(
    new Set([validated.createdById, ...validated.members]),
  );

  streamLogger.debug("Creating channel", {
    channelId: validated.channelId,
    type: validated.channelType,
    memberCount: allMembers.length,
    organizationId: validated.organizationId ?? undefined,
  });

  // Ensure all members exist in Stream before channel creation
  await upsertUsersToStream(allMembers);

  // Merge the optional org stamp into additionalData. Use snake_case
  // (`organization_id`) to match Stream's chat field convention and the
  // other event tags in this file (webinar_id, class_id).
  const mergedAdditionalData: Record<string, unknown> = {
    ...(validated.additionalData ?? {}),
    ...(validated.organizationId
      ? { organization_id: validated.organizationId }
      : {}),
  };

  // Create the channel with members atomically
  // Note: Explicitly typing channel data for stream-chat v9
  const createChannelData = {
    name: validated.channelName,
    created_by_id: validated.createdById,
    members: allMembers,
    ...mergedAdditionalData,
  };
  const channel = client.channel(
    validated.channelType,
    validated.channelId,
    createChannelData as Record<string, unknown>,
  );

  const channelData = await channel.create();

  // Channel-scoped moderation replaces the old global-admin Stream role
  // (#899). Only the channel HOST may moderate — never an arbitrary creator:
  //  - team channels (webinar/class): the creator IS the consultant host.
  //  - messaging channels: only consultation/subscription DMs carry a
  //    `dm_consultant_user_id`; grant moderation to that consultant. Peer DMs
  //    (createDirectMessageChannel) have no host, so `moderatorId` is
  //    undefined and no grant is issued — this prevents a consultee who
  //    opens a 1:1 DM from being able to mute/remove the consultant (#981).
  const moderatorId =
    validated.channelType === "team"
      ? validated.createdById
      : (mergedAdditionalData.dm_consultant_user_id as string | undefined);

  if (moderatorId) {
    await grantChannelModerator(channel, moderatorId, validated.channelId);
  }

  // Cache the channel existence
  markChannelExists(validated.channelType, validated.channelId);

  streamLogger.debug("Channel created successfully", {
    channelId: validated.channelId,
    memberCount: allMembers.length,
  });

  return {
    channelId: validated.channelId,
    members: allMembers,
    channelData,
  };
}

/**
 * Create a direct message channel between two users
 */
export async function createDirectMessageChannel(
  currentUserId: string,
  targetUserId: string,
) {
  // Validate inputs
  memberIdSchema.parse(currentUserId);
  memberIdSchema.parse(targetUserId);

  const channelId = getDmChannelId(currentUserId, targetUserId);

  return createChannel({
    channelType: "messaging",
    channelId,
    members: [currentUserId, targetUserId],
    createdById: currentUserId,
  });
}

/**
 * Create a webinar channel with all participants
 * Fetches participants from both waitlist and appointments
 *
 * @param webinarId — Webinar entity id
 * @param organizationId — Optional explicit org override. When omitted, the
 *   helper falls back to `webinarPlan.organizationId` so callers don't have
 *   to plumb it through. Pass `null` to force-omit the org tag.
 */
export async function createWebinarChannel(
  webinarId: string,
  organizationId?: string | null,
) {
  channelIdSchema.parse(webinarId);

  const webinar = await prisma.webinar.findUnique({
    where: { id: webinarId },
    include: {
      webinarPlan: {
        include: {
          consultantProfile: {
            include: { user: { select: { id: true } } },
          },
        },
      },
      waitlist: {
        where: { status: "BOOKED" },
        select: { userId: true },
      },
      appointment: {
        include: {
          slotsOfAppointment: {
            include: { user: { select: { id: true } } },
          },
        },
      },
    },
  });

  if (!webinar) {
    throw new Error(`Webinar not found: ${webinarId}`);
  }

  const consultantUserId = webinar.webinarPlan.consultantProfile?.user?.id;
  if (!consultantUserId) {
    throw new Error(`Consultant not found for webinar: ${webinarId}`);
  }

  // Collect all participant IDs — only BOOKED waitlist users get chat access
  const waitlistIds = webinar.waitlist.map((entry) => entry.userId);
  const appointmentIds =
    webinar.appointment?.slotsOfAppointment?.flatMap((slot) =>
      slot.user.map((u) => u.id),
    ) || [];

  const allParticipantIds = Array.from(
    new Set([...waitlistIds, ...appointmentIds]),
  );

  const allMembers = Array.from(
    new Set([consultantUserId, ...allParticipantIds]),
  );

  streamLogger.debug("Creating webinar channel", {
    webinarId,
    waitlistCount: waitlistIds.length,
    appointmentCount: appointmentIds.length,
    totalUnique: allMembers.length,
  });

  // Ensure all members exist in Stream before channel creation
  await upsertUsersToStream(allMembers);

  // Fall back to the plan's org if the caller didn't pass one explicitly.
  // `null` is treated as "explicitly no org"; `undefined` triggers fallback.
  const resolvedOrgId =
    organizationId === undefined
      ? webinar.webinarPlan.organizationId ?? null
      : organizationId;

  return createChannel({
    channelType: "team",
    channelId: `webinar-${webinarId}`,
    channelName: webinar.webinarPlan.title,
    members: allMembers,
    createdById: consultantUserId,
    additionalData: { webinar_id: webinarId },
    organizationId: resolvedOrgId,
  });
}

/**
 * Create a class channel with all participants
 *
 * @param classId — Class entity id
 * @param organizationId — Optional explicit org override. Falls back to
 *   `classPlan.organizationId` when omitted; `null` force-omits the tag.
 */
export async function createClassChannel(
  classId: string,
  organizationId?: string | null,
) {
  channelIdSchema.parse(classId);

  const classData = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      classPlan: {
        include: {
          consultantProfile: {
            include: { user: { select: { id: true } } },
          },
        },
      },
      waitlist: {
        where: { status: "BOOKED" },
        select: { userId: true },
      },
      appointments: {
        include: {
          slotsOfAppointment: {
            include: { user: { select: { id: true } } },
          },
        },
      },
    },
  });

  if (!classData) {
    throw new Error(`Class not found: ${classId}`);
  }

  const consultantUserId = classData.classPlan.consultantProfile?.user?.id;
  if (!consultantUserId) {
    throw new Error(`Consultant not found for class: ${classId}`);
  }

  // Only BOOKED waitlist users get chat access
  const waitlistIds = classData.waitlist.map((entry) => entry.userId);
  const appointmentIds =
    classData.appointments?.flatMap((apt) =>
      apt.slotsOfAppointment?.flatMap((slot) => slot.user.map((u) => u.id)),
    ) || [];

  const allMembers = Array.from(
    new Set([consultantUserId, ...waitlistIds, ...appointmentIds]),
  );

  streamLogger.debug("Creating class channel", {
    classId,
    waitlistCount: waitlistIds.length,
    appointmentCount: appointmentIds.length,
    totalUnique: allMembers.length,
  });

  // Ensure all members exist in Stream before channel creation
  await upsertUsersToStream(allMembers);

  const resolvedOrgId =
    organizationId === undefined
      ? classData.classPlan.organizationId ?? null
      : organizationId;

  return createChannel({
    channelType: "team",
    channelId: `class-${classId}`,
    channelName: classData.classPlan.title,
    members: allMembers,
    createdById: consultantUserId,
    additionalData: { class_id: classId },
    organizationId: resolvedOrgId,
  });
}

/**
 * Create a consultation channel
 *
 * @param consultationId — Consultation entity id
 * @param organizationId — Optional explicit org override. When omitted, the
 *   resolved org tag falls back through this chain:
 *     1. `consultationPlan.organizationId` (plan is hosted by an org)
 *     2. `consultation.appointment.organizationId` (booking is funded by
 *        an org member, even when the plan itself is platform-owned)
 *     3. `null` — personal channel, no org tag
 *   Pass `null` explicitly to force-omit the org tag regardless of fallback.
 *
 *   Note: the underlying DM channel is per consultant-consultee pair, so an
 *   org tag here reflects the *first booking* — if the same pair later books
 *   a personal-plan consultation, the existing channel keeps the org tag.
 */
export async function createConsultationChannel(
  consultationId: string,
  organizationId?: string | null,
) {
  channelIdSchema.parse(consultationId);

  const consultation = await prisma.consultation.findUnique({
    where: { id: consultationId },
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
      // Pull the appointment row so we can fall back to its org tag
      // when the plan itself isn't org-hosted but the booker is paying
      // through an org-funded membership (C.3 / #674).
      appointment: { select: { organizationId: true } },
    },
  });

  if (!consultation) {
    throw new Error(`Consultation not found: ${consultationId}`);
  }

  const consultantId = consultation.consultationPlan.consultantProfile.user.id;
  const consulteeId = consultation.requestedBy.user.id;

  if (!consultantId || !consulteeId) {
    throw new Error(
      `Participants not found for consultation: ${consultationId}`,
    );
  }

  // Ensure both users exist in Stream before channel creation
  await upsertUsersToStream([consultantId, consulteeId]);

  const resolvedOrgId =
    organizationId === undefined
      ? consultation.consultationPlan.organizationId ??
        consultation.appointment?.organizationId ??
        null
      : organizationId;

  // DM channel is per consultant-consultee pair (not per event).
  // Per-event IDs are not stored on the channel since multiple
  // consultations/subscriptions between the same pair share one DM.
  return createChannel({
    channelType: "messaging",
    channelId: getDmChannelId(consultantId, consulteeId),
    members: [consultantId, consulteeId],
    createdById: consultantId,
    additionalData: {
      dm_consultant_user_id: consultantId,
      dm_consultee_user_id: consulteeId,
    },
    organizationId: resolvedOrgId,
  });
}

/**
 * Create a subscription channel
 *
 * @param subscriptionId — Subscription entity id
 * @param organizationId — Optional explicit org override. When omitted, the
 *   resolved org tag falls back through this chain:
 *     1. `subscriptionPlan.organizationId` (plan is hosted by an org)
 *     2. `subscription.appointment.organizationId` (booking is funded by
 *        an org member, even when the plan itself is platform-owned)
 *     3. `null` — personal channel, no org tag
 *   Pass `null` explicitly to force-omit. See `createConsultationChannel`
 *   for the DM-channel sharing caveat.
 */
export async function createSubscriptionChannel(
  subscriptionId: string,
  organizationId?: string | null,
) {
  channelIdSchema.parse(subscriptionId);

  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
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
      // Pull a single org-tagged appointment so we can fall back to
      // its org id when the plan itself isn't org-hosted but the
      // subscription is funded through an org-funded membership.
      // Subscription has a 1:N appointments relation; all appointments
      // in one subscription share the same org context (the org pays
      // for the whole subscription upfront) so taking the first is
      // sufficient. (C.3 / #674)
      appointments: {
        where: { organizationId: { not: null } },
        select: { organizationId: true },
        take: 1,
      },
    },
  });

  if (!subscription) {
    throw new Error(`Subscription not found: ${subscriptionId}`);
  }

  const consultantId = subscription.subscriptionPlan.consultantProfile.user.id;
  const consulteeId = subscription.requestedBy.user.id;

  if (!consultantId || !consulteeId) {
    throw new Error(
      `Participants not found for subscription: ${subscriptionId}`,
    );
  }

  // Ensure both users exist in Stream before channel creation
  await upsertUsersToStream([consultantId, consulteeId]);

  const resolvedOrgId =
    organizationId === undefined
      ? subscription.subscriptionPlan.organizationId ??
        subscription.appointments[0]?.organizationId ??
        null
      : organizationId;

  // DM channel is per consultant-consultee pair (not per event).
  // Per-event IDs are not stored on the channel since multiple
  // consultations/subscriptions between the same pair share one DM.
  return createChannel({
    channelType: "messaging",
    channelId: getDmChannelId(consultantId, consulteeId),
    members: [consultantId, consulteeId],
    createdById: consultantId,
    additionalData: {
      dm_consultant_user_id: consultantId,
      dm_consultee_user_id: consulteeId,
    },
    organizationId: resolvedOrgId,
  });
}

/**
 * Initialize channels for all existing entities
 * Uses parallel processing for better performance
 */
export async function initializeAllChannels() {
  streamLogger.info("Starting bulk channel initialization");

  // Fetch all data in parallel
  const [webinars, classes, consultations, subscriptions] = await Promise.all([
    prisma.webinar.findMany({
      include: {
        webinarPlan: {
          include: {
            consultantProfile: { include: { user: { select: { id: true } } } },
          },
        },
        waitlist: {
          where: { status: "BOOKED" },
          select: { userId: true },
        },
      },
    }),
    prisma.class.findMany({
      include: {
        classPlan: {
          include: {
            consultantProfile: { include: { user: { select: { id: true } } } },
          },
        },
        waitlist: {
          where: { status: "BOOKED" },
          select: { userId: true },
        },
      },
    }),
    prisma.consultation.findMany({
      where: { status: "APPROVED" },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: { include: { user: { select: { id: true } } } },
          },
        },
        requestedBy: { include: { user: { select: { id: true } } } },
      },
    }),
    prisma.subscription.findMany({
      where: { status: "APPROVED" },
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: { include: { user: { select: { id: true } } } },
          },
        },
        requestedBy: { include: { user: { select: { id: true } } } },
      },
    }),
  ]);

  streamLogger.info("Fetched entities for initialization", {
    webinars: webinars.length,
    classes: classes.length,
    consultations: consultations.length,
    subscriptions: subscriptions.length,
  });

  // Collect all unique user IDs
  const userIds = new Set<string>();

  webinars.forEach((w) => {
    if (w.webinarPlan.consultantProfile?.user?.id) {
      userIds.add(w.webinarPlan.consultantProfile.user.id);
    }
    w.waitlist.forEach((e) => userIds.add(e.userId));
  });

  classes.forEach((c) => {
    if (c.classPlan.consultantProfile?.user?.id) {
      userIds.add(c.classPlan.consultantProfile.user.id);
    }
    c.waitlist.forEach((e) => userIds.add(e.userId));
  });

  consultations.forEach((c) => {
    if (c.consultationPlan.consultantProfile?.user?.id) {
      userIds.add(c.consultationPlan.consultantProfile.user.id);
    }
    if (c.requestedBy?.user?.id) userIds.add(c.requestedBy.user.id);
  });

  subscriptions.forEach((s) => {
    if (s.subscriptionPlan.consultantProfile?.user?.id) {
      userIds.add(s.subscriptionPlan.consultantProfile.user.id);
    }
    if (s.requestedBy?.user?.id) userIds.add(s.requestedBy.user.id);
  });

  // Batch upsert all users first
  const uniqueUserIds = Array.from(userIds);
  if (uniqueUserIds.length > 0) {
    await upsertUsersToStream(uniqueUserIds);
  }

  // Create channels in parallel batches (limit concurrency to avoid rate limits)
  const BATCH_SIZE = 10;
  const results = {
    webinars: { success: 0, failed: 0 },
    classes: { success: 0, failed: 0 },
    consultations: { success: 0, failed: 0 },
    subscriptions: { success: 0, failed: 0 },
  };

  // Process webinars
  for (let i = 0; i < webinars.length; i += BATCH_SIZE) {
    const batch = webinars.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((w) => createWebinarChannel(w.id)),
    );
    batchResults.forEach((r) => {
      if (r.status === "fulfilled") results.webinars.success++;
      else results.webinars.failed++;
    });
  }

  // Process classes
  for (let i = 0; i < classes.length; i += BATCH_SIZE) {
    const batch = classes.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((c) => createClassChannel(c.id)),
    );
    batchResults.forEach((r) => {
      if (r.status === "fulfilled") results.classes.success++;
      else results.classes.failed++;
    });
  }

  // Process consultations
  for (let i = 0; i < consultations.length; i += BATCH_SIZE) {
    const batch = consultations.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((c) => createConsultationChannel(c.id)),
    );
    batchResults.forEach((r) => {
      if (r.status === "fulfilled") results.consultations.success++;
      else results.consultations.failed++;
    });
  }

  // Process subscriptions
  for (let i = 0; i < subscriptions.length; i += BATCH_SIZE) {
    const batch = subscriptions.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((s) => createSubscriptionChannel(s.id)),
    );
    batchResults.forEach((r) => {
      if (r.status === "fulfilled") results.subscriptions.success++;
      else results.subscriptions.failed++;
    });
  }

  streamLogger.info("Bulk channel initialization completed", { results });

  return {
    success: true,
    counts: {
      users: uniqueUserIds.length,
      ...results,
    },
  };
}

/**
 * Create or reconcile a collaborator channel for a webinar or class plan.
 * Called when a collaborator accepts an invitation (idempotent).
 * Performs full member diffing: adds any DB collaborators missing from the channel
 * and removes any channel members no longer in the DB set (except host).
 * Members: host + all accepted collaborators.
 */
export async function createCollaboratorChannel(
  planType: "webinar" | "class",
  planId: string,
) {
  channelIdSchema.parse(planId);

  const collaboratorWhere = {
    status: "ACCEPTED" as const,
  };

  const collaboratorInclude = {
    consultantProfile: {
      include: { user: { select: { id: true } } },
    },
  };

  let title: string;
  let hostUserId: string | undefined;
  let collaboratorUserIds: string[];

  if (planType === "webinar") {
    const plan = await prisma.webinarPlan.findUnique({
      where: { id: planId },
      include: {
        consultantProfile: {
          include: { user: { select: { id: true } } },
        },
        collaborators: {
          where: collaboratorWhere,
          include: collaboratorInclude,
        },
      },
    });

    if (!plan) throw new Error(`Webinar plan not found: ${planId}`);
    title = plan.title;
    hostUserId = plan.consultantProfile?.user?.id;
    collaboratorUserIds = plan.collaborators
      .map((c) => c.consultantProfile.user.id)
      .filter(Boolean);
  } else {
    const plan = await prisma.classPlan.findUnique({
      where: { id: planId },
      include: {
        consultantProfile: {
          include: { user: { select: { id: true } } },
        },
        collaborators: {
          where: collaboratorWhere,
          include: collaboratorInclude,
        },
      },
    });

    if (!plan) throw new Error(`Class plan not found: ${planId}`);
    title = plan.title;
    hostUserId = plan.consultantProfile?.user?.id;
    collaboratorUserIds = plan.collaborators
      .map((c) => c.consultantProfile.user.id)
      .filter(Boolean);
  }

  if (!hostUserId) {
    throw new Error(`Host not found for ${planType} plan: ${planId}`);
  }

  // Deduplicated expected member set: host + all accepted collaborators
  const expectedMemberIds = Array.from(
    new Set([hostUserId, ...collaboratorUserIds]),
  );

  if (expectedMemberIds.length < 2) {
    streamLogger.debug("Skipping collaborator channel - not enough members", {
      planType,
      planId,
    });
    return null;
  }

  const channelId = `collab-${planType}-${planId}`;
  const client = getStreamChatClient();

  const channel = client.channel("messaging", channelId, {
    name: `${title} - Collaborators`,
    created_by_id: hostUserId,
    members: expectedMemberIds,
    [`${planType}_plan_id`]: planId,
    is_collaborator_channel: true,
  } as Record<string, unknown>);

  // Idempotent create — no-op if channel already exists
  await channel.create();
  markChannelExists("messaging", channelId);

  // Host moderates their own collab channel — this path bypasses
  // createChannel, so the #899 channel-scoped grant is repeated here.
  await grantChannelModerator(channel, hostUserId, channelId);

  // Query current channel membership for diffing
  const channelData = await channel.query();
  const currentMemberIds = (channelData.members ?? [])
    .map((m) => m.user_id)
    .filter((id): id is string => !!id);

  // Add members present in DB but missing from channel
  const toAdd = expectedMemberIds.filter(
    (id) => !currentMemberIds.includes(id),
  );
  if (toAdd.length > 0) {
    await channel.addMembers(toAdd);
    streamLogger.debug("Collaborator channel: added missing members", {
      channelId,
      added: toAdd,
    });
  }

  // Remove channel members no longer in the DB set
  const toRemove = currentMemberIds.filter(
    (id) => !expectedMemberIds.includes(id),
  );
  if (toRemove.length > 0) {
    await channel.removeMembers(toRemove);
    streamLogger.debug("Collaborator channel: removed departed members", {
      channelId,
      removed: toRemove,
    });
  }

  streamLogger.debug("Collaborator channel reconciled", {
    channelId,
    planType,
    planId,
    memberCount: expectedMemberIds.length,
    added: toAdd.length,
    removed: toRemove.length,
  });

  return {
    channelId,
    members: expectedMemberIds,
    channelData,
  };
}

/**
 * Adds a user to a specific channel
 */
export async function addMemberToChannel(
  channelId: string,
  userId: string,
  channelType?: "messaging" | "team",
) {
  channelIdSchema.parse(channelId);
  memberIdSchema.parse(userId);

  const client = getStreamChatClient();

  const resolvedChannelType = channelType ?? getChannelTypeFromId(channelId);

  streamLogger.debug("Adding member to channel", {
    channelId,
    userId,
    channelType: resolvedChannelType,
  });

  try {
    const channel = client.channel(resolvedChannelType, channelId);
    await channel.create(); // Creates if doesn't exist, no-op if exists

    const response = await channel.addMembers([userId]);

    streamLogger.debug("Member added successfully", { channelId, userId });
    return { success: true, response };
  } catch (error) {
    streamLogger.error("Failed to add member to channel", error, {
      channelId,
      userId,
    });
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    throw error;
  }
}
