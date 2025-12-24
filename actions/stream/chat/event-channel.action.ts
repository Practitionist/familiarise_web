"use server";

import { z } from "zod";
import prisma from "@/lib/prisma";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import {
  isChannelCached,
  markChannelExists,
  getMembershipCached,
  markMembership,
  initialSyncCompletedUsers,
} from "@/lib/stream-cache";
import { upsertUserToStream } from "./user.action";

// Validation schemas
const eventTypeSchema = z.enum([
  "webinar",
  "class",
  "consultation",
  "subscription",
]);
const eventIdSchema = z.string().min(1, "Event ID is required");
const userIdSchema = z.string().min(1, "User ID is required");

type EventType = z.infer<typeof eventTypeSchema>;

/**
 * Get the channel ID for an event
 */
function getChannelId(eventType: EventType, eventId: string): string {
  return `${eventType}-${eventId}`;
}

/**
 * Get the channel type for an event type
 */
function getChannelType(eventType: EventType): "messaging" | "team" {
  return eventType === "consultation" || eventType === "subscription"
    ? "messaging"
    : "team";
}

/**
 * Check if an event channel exists (with caching)
 */
export async function checkEventChannelExists(
  eventType: EventType,
  eventId: string,
): Promise<boolean> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  // Check cache first
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
    await channel.query({ state: false, messages: { limit: 0 } });

    // Cache the result
    markChannelExists(channelType, channelId);
    streamLogger.debug("Channel exists", { channelId });
    return true;
  } catch (error) {
    // Channel doesn't exist if query fails
    streamLogger.debug("Channel does not exist", { channelId });
    return false;
  }
}

/**
 * Add a user to an event channel, creating the channel if it doesn't exist
 * Uses caching to avoid redundant operations
 */
export async function addUserToEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{ success: boolean; channelId: string; created?: boolean }> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);
  userIdSchema.parse(userId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  // Check membership cache first
  const membershipCached = getMembershipCached(channelId, userId);
  if (membershipCached === true) {
    streamLogger.debug("User already member (cached)", { channelId, userId });
    return { success: true, channelId };
  }

  const client = getStreamChatClient();

  try {
    // Ensure user is upserted to Stream first
    await upsertUserToStream(userId);

    const channel = client.channel(channelType, channelId);

    // Try to add member directly (works for existing channels)
    try {
      await channel.addMembers([userId]);
      markMembership(channelId, userId, true);
      streamLogger.debug("Added user to existing channel", {
        channelId,
        userId,
      });
      return { success: true, channelId };
    } catch (addError) {
      // Channel might not exist, try to create it
      streamLogger.debug("Channel may not exist, attempting creation", {
        channelId,
      });
    }

    // Channel doesn't exist, create it based on event type
    let created = false;
    const eventData = await getEventData(eventType, eventId);

    if (!eventData) {
      throw new Error(`${eventType} not found: ${eventId}`);
    }

    // Create channel with all data and members in a single atomic call
    // This fixes the "created_by_id must be provided" error and reduces 3 API calls to 1
    const { consultantId, members, name } = eventData;
    const allMembers = Array.from(new Set([consultantId, ...members, userId]));

    // Re-initialize channel with all required data for atomic creation
    const channelWithData = client.channel(channelType, channelId, {
      name,
      created_by_id: consultantId,
      [`${eventType}_id`]: eventId,
      members: allMembers,
    });

    await channelWithData.create();

    markChannelExists(channelType, channelId);
    markMembership(channelId, userId, true);
    created = true;

    streamLogger.info("Created channel and added user", {
      channelId,
      userId,
      memberCount: allMembers.length,
    });

    return { success: true, channelId, created };
  } catch (error) {
    streamLogger.error("Failed to add user to event channel", error, {
      eventType,
      eventId,
      userId,
    });
    throw error;
  }
}

/**
 * Get event data for channel creation
 */
async function getEventData(eventType: EventType, eventId: string) {
  switch (eventType) {
    case "webinar": {
      const webinar = await prisma.webinar.findUnique({
        where: { id: eventId },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          waitlist: { select: { userId: true } },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: { user: { select: { id: true } } },
              },
            },
          },
        },
      });
      if (!webinar) return null;

      const consultantId = webinar.webinarPlan.consultantProfile?.user?.id;
      if (!consultantId) return null;

      const members = [
        ...webinar.waitlist.map((w) => w.userId),
        ...(webinar.appointment?.slotsOfAppointment?.flatMap((s) =>
          s.user.map((u) => u.id),
        ) || []),
      ];

      return { consultantId, members, name: webinar.webinarPlan.title };
    }

    case "class": {
      const classData = await prisma.class.findUnique({
        where: { id: eventId },
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          waitlist: { select: { userId: true } },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: { user: { select: { id: true } } },
              },
            },
          },
        },
      });
      if (!classData) return null;

      const consultantId = classData.classPlan.consultantProfile?.user?.id;
      if (!consultantId) return null;

      const members = [
        ...classData.waitlist.map((w) => w.userId),
        ...(classData.appointments?.flatMap(
          (a) =>
            a.slotsOfAppointment?.flatMap((s) => s.user.map((u) => u.id)) || [],
        ) || []),
      ];

      return { consultantId, members, name: classData.classPlan.title };
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
          requestedBy: { include: { user: { select: { id: true } } } },
        },
      });
      if (!consultation) return null;

      const consultantId =
        consultation.consultationPlan.consultantProfile?.user?.id;
      const consulteeId = consultation.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;

      return {
        consultantId,
        members: [consulteeId],
        name: consultation.consultationPlan.title,
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
          requestedBy: { include: { user: { select: { id: true } } } },
        },
      });
      if (!subscription) return null;

      const consultantId =
        subscription.subscriptionPlan.consultantProfile?.user?.id;
      const consulteeId = subscription.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;

      return {
        consultantId,
        members: [consulteeId],
        name: subscription.subscriptionPlan.title,
      };
    }

    default:
      return null;
  }
}

/**
 * Get all event channels for a user
 */
export async function getUserEventChannels(userId: string) {
  userIdSchema.parse(userId);

  const client = getStreamChatClient();

  try {
    const channels = await client.queryChannels(
      { members: { $in: [userId] } },
      { last_message_at: -1 },
      { limit: 100 },
    );

    return channels.map((channel) => ({
      id: channel.id,
      type: channel.type,
      name: channel.data?.name as string | undefined,
      memberCount: Object.keys(channel.state.members || {}).length,
    }));
  } catch (error) {
    streamLogger.error("Failed to get user event channels", error, { userId });
    throw error;
  }
}

/**
 * Sync user to all their event channels
 * OPTIMIZED: Uses batch queries and parallel processing
 * Only runs once per user per session
 */
export async function syncUserEventChannels(userId: string) {
  userIdSchema.parse(userId);

  // Check if sync already completed for this user in this session
  if (initialSyncCompletedUsers.has(userId)) {
    streamLogger.debug("Sync already completed for user this session", {
      userId,
    });
    return { success: true, skipped: true };
  }

  streamLogger.info("Starting channel sync for user", { userId });
  const startTime = Date.now();

  try {
    // First, upsert the user to Stream
    await upsertUserToStream(userId);

    // Get user's profile IDs
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        consultantProfileId: true,
        consulteeProfileId: true,
      },
    });

    if (!user) {
      streamLogger.warn("User not found for sync", { userId });
      return { success: false, error: "User not found" };
    }

    // Collect all event IDs the user should have access to
    const eventIds: { type: EventType; id: string }[] = [];

    // Batch query all events in parallel
    const [webinars, classes, consultations, subscriptions] = await Promise.all(
      [
        getWebinarIdsForUser(userId, user),
        getClassIdsForUser(userId, user),
        getConsultationIdsForUser(user),
        getSubscriptionIdsForUser(user),
      ],
    );

    webinars.forEach((id) => eventIds.push({ type: "webinar", id }));
    classes.forEach((id) => eventIds.push({ type: "class", id }));
    consultations.forEach((id) => eventIds.push({ type: "consultation", id }));
    subscriptions.forEach((id) => eventIds.push({ type: "subscription", id }));

    streamLogger.debug("Events found for user", {
      userId,
      webinars: webinars.length,
      classes: classes.length,
      consultations: consultations.length,
      subscriptions: subscriptions.length,
      total: eventIds.length,
    });

    if (eventIds.length === 0) {
      initialSyncCompletedUsers.add(userId);
      return { success: true, channelsSynced: 0 };
    }

    // Process in parallel batches with rate limiting
    const BATCH_SIZE = 5;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
      const batch = eventIds.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map((event) =>
          addUserToEventChannel(event.type, event.id, userId),
        ),
      );

      results.forEach((result) => {
        if (result.status === "fulfilled") successCount++;
        else failCount++;
      });
    }

    const duration = Date.now() - startTime;
    streamLogger.info("Channel sync completed", {
      userId,
      successCount,
      failCount,
      durationMs: duration,
    });

    // Mark sync as completed for this user
    initialSyncCompletedUsers.add(userId);

    return {
      success: true,
      channelsSynced: successCount,
      failed: failCount,
      durationMs: duration,
    };
  } catch (error) {
    streamLogger.error("Channel sync failed", error, { userId });
    throw error;
  }
}

/**
 * Get webinar IDs for a user
 */
async function getWebinarIdsForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<string[]> {
  if (user.consultantProfileId) {
    // Consultant: get webinars they host
    const webinars = await prisma.webinar.findMany({
      where: {
        webinarPlan: { consultantProfileId: user.consultantProfileId },
      },
      select: { id: true },
    });
    return webinars.map((w) => w.id);
  }

  // Consultee: get webinars from waitlist or appointments
  const [waitlistWebinars, appointmentWebinars] = await Promise.all([
    prisma.webinar.findMany({
      where: { waitlist: { some: { userId } } },
      select: { id: true },
    }),
    prisma.webinar.findMany({
      where: {
        appointment: {
          slotsOfAppointment: { some: { user: { some: { id: userId } } } },
        },
      },
      select: { id: true },
    }),
  ]);

  return Array.from(
    new Set([
      ...waitlistWebinars.map((w) => w.id),
      ...appointmentWebinars.map((w) => w.id),
    ]),
  );
}

/**
 * Get class IDs for a user
 */
async function getClassIdsForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<string[]> {
  if (user.consultantProfileId) {
    // Consultant: get classes they host
    const classes = await prisma.class.findMany({
      where: {
        classPlan: { consultantProfileId: user.consultantProfileId },
      },
      select: { id: true },
    });
    return classes.map((c) => c.id);
  }

  // Consultee: get classes from waitlist or appointments
  const [waitlistClasses, appointmentClasses] = await Promise.all([
    prisma.class.findMany({
      where: { waitlist: { some: { userId } } },
      select: { id: true },
    }),
    prisma.class.findMany({
      where: {
        appointments: {
          some: {
            slotsOfAppointment: { some: { user: { some: { id: userId } } } },
          },
        },
      },
      select: { id: true },
    }),
  ]);

  return Array.from(
    new Set([
      ...waitlistClasses.map((c) => c.id),
      ...appointmentClasses.map((c) => c.id),
    ]),
  );
}

/**
 * Get consultation IDs for a user
 */
async function getConsultationIdsForUser(user: {
  consultantProfileId: string | null;
  consulteeProfileId: string | null;
}): Promise<string[]> {
  if (!user.consultantProfileId && !user.consulteeProfileId) {
    return [];
  }

  const consultations = await prisma.consultation.findMany({
    where: {
      requestStatus: { in: ["APPROVED", "SCHEDULED"] },
      OR: [
        user.consultantProfileId
          ? {
              consultationPlan: {
                consultantProfileId: user.consultantProfileId,
              },
            }
          : {},
        user.consulteeProfileId
          ? { requestedById: user.consulteeProfileId }
          : {},
      ].filter((o) => Object.keys(o).length > 0),
    },
    select: { id: true },
  });

  return consultations.map((c) => c.id);
}

/**
 * Get subscription IDs for a user
 */
async function getSubscriptionIdsForUser(user: {
  consultantProfileId: string | null;
  consulteeProfileId: string | null;
}): Promise<string[]> {
  if (!user.consultantProfileId && !user.consulteeProfileId) {
    return [];
  }

  const subscriptions = await prisma.subscription.findMany({
    where: {
      requestStatus: { in: ["APPROVED", "SCHEDULED"] },
      OR: [
        user.consultantProfileId
          ? {
              subscriptionPlan: {
                consultantProfileId: user.consultantProfileId,
              },
            }
          : {},
        user.consulteeProfileId
          ? { requestedById: user.consulteeProfileId }
          : {},
      ].filter((o) => Object.keys(o).length > 0),
    },
    select: { id: true },
  });

  return subscriptions.map((s) => s.id);
}
