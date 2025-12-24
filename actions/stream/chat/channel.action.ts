"use server";

import { z } from "zod";
import prisma from "@/lib/prisma";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { markChannelExists } from "@/lib/stream-cache";
import { upsertUsersToStream } from "./user.action";

// Input validation schemas
const channelTypeSchema = z.enum(["messaging", "team"]);
const channelIdSchema = z.string().min(1, "Channel ID is required");
const memberIdSchema = z.string().min(1, "Member ID is required");
const membersSchema = z.array(memberIdSchema).min(1, "At least one member required");

const createChannelSchema = z.object({
  channelType: channelTypeSchema,
  channelId: channelIdSchema,
  channelName: z.string().optional(),
  members: membersSchema,
  createdById: memberIdSchema,
  additionalData: z.record(z.unknown()).optional(),
});

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
}) {
  // Validate input
  const validated = createChannelSchema.parse(input);

  const client = getStreamChatClient();

  // Ensure creator is always included in members list
  const allMembers = Array.from(new Set([validated.createdById, ...validated.members]));

  streamLogger.debug("Creating channel", {
    channelId: validated.channelId,
    type: validated.channelType,
    memberCount: allMembers.length,
  });

  // Create the channel with members atomically
  const channel = client.channel(validated.channelType, validated.channelId, {
    name: validated.channelName,
    created_by_id: validated.createdById,
    members: allMembers,
    ...validated.additionalData,
  });

  await channel.create();

  // Cache the channel existence
  markChannelExists(validated.channelType, validated.channelId);

  // Verify membership was established
  const channelData = await channel.query();
  const actualMembers = Object.keys(channelData.members || {});

  streamLogger.debug("Channel created successfully", {
    channelId: validated.channelId,
    actualMemberCount: actualMembers.length,
  });

  return { channelId: validated.channelId, members: actualMembers, channelData };
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

  // Create a unique channel ID for the DM using localeCompare for reliable sorting
  const channelId = [currentUserId, targetUserId]
    .sort((a, b) => a.localeCompare(b))
    .join("-");

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
 */
export async function createWebinarChannel(webinarId: string) {
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

  if (!webinar) {
    throw new Error(`Webinar not found: ${webinarId}`);
  }

  const consultantUserId = webinar.webinarPlan.consultantProfile?.user?.id;
  if (!consultantUserId) {
    throw new Error(`Consultant not found for webinar: ${webinarId}`);
  }

  // Collect all participant IDs efficiently
  const waitlistIds = webinar.waitlist.map((entry) => entry.userId);
  const appointmentIds =
    webinar.appointment?.slotsOfAppointment?.flatMap((slot) =>
      slot.user.map((u) => u.id),
    ) || [];

  const allParticipantIds = Array.from(new Set([...waitlistIds, ...appointmentIds]));

  streamLogger.debug("Creating webinar channel", {
    webinarId,
    waitlistCount: waitlistIds.length,
    appointmentCount: appointmentIds.length,
    totalUnique: allParticipantIds.length,
  });

  return createChannel({
    channelType: "team",
    channelId: `webinar-${webinarId}`,
    channelName: webinar.webinarPlan.title,
    members: [consultantUserId, ...allParticipantIds],
    createdById: consultantUserId,
    additionalData: { webinar_id: webinarId },
  });
}

/**
 * Create a class channel with all participants
 */
export async function createClassChannel(classId: string) {
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

  if (!classData) {
    throw new Error(`Class not found: ${classId}`);
  }

  const consultantUserId = classData.classPlan.consultantProfile?.user?.id;
  if (!consultantUserId) {
    throw new Error(`Consultant not found for class: ${classId}`);
  }

  const waitlistIds = classData.waitlist.map((entry) => entry.userId);
  const appointmentIds =
    classData.appointments?.flatMap((apt) =>
      apt.slotsOfAppointment?.flatMap((slot) => slot.user.map((u) => u.id)),
    ) || [];

  const allParticipantIds = Array.from(new Set([...waitlistIds, ...appointmentIds]));

  streamLogger.debug("Creating class channel", {
    classId,
    waitlistCount: waitlistIds.length,
    appointmentCount: appointmentIds.length,
    totalUnique: allParticipantIds.length,
  });

  return createChannel({
    channelType: "team",
    channelId: `class-${classId}`,
    channelName: classData.classPlan.title,
    members: [consultantUserId, ...allParticipantIds],
    createdById: consultantUserId,
    additionalData: { class_id: classId },
  });
}

/**
 * Create a consultation channel
 */
export async function createConsultationChannel(consultationId: string) {
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
    },
  });

  if (!consultation) {
    throw new Error(`Consultation not found: ${consultationId}`);
  }

  const consultantId = consultation.consultationPlan.consultantProfile.user.id;
  const consulteeId = consultation.requestedBy.user.id;

  if (!consultantId || !consulteeId) {
    throw new Error(`Participants not found for consultation: ${consultationId}`);
  }

  return createChannel({
    channelType: "messaging",
    channelId: `consultation-${consultationId}`,
    members: [consultantId, consulteeId],
    createdById: consultantId,
    additionalData: { consultation_id: consultationId },
  });
}

/**
 * Create a subscription channel
 */
export async function createSubscriptionChannel(subscriptionId: string) {
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
    },
  });

  if (!subscription) {
    throw new Error(`Subscription not found: ${subscriptionId}`);
  }

  const consultantId = subscription.subscriptionPlan.consultantProfile.user.id;
  const consulteeId = subscription.requestedBy.user.id;

  if (!consultantId || !consulteeId) {
    throw new Error(`Participants not found for subscription: ${subscriptionId}`);
  }

  return createChannel({
    channelType: "messaging",
    channelId: `subscription-${subscriptionId}`,
    members: [consultantId, consulteeId],
    createdById: consultantId,
    additionalData: { subscription_id: subscriptionId },
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
          include: { consultantProfile: { include: { user: { select: { id: true } } } } },
        },
        waitlist: { select: { userId: true } },
      },
    }),
    prisma.class.findMany({
      include: {
        classPlan: {
          include: { consultantProfile: { include: { user: { select: { id: true } } } } },
        },
        waitlist: { select: { userId: true } },
      },
    }),
    prisma.consultation.findMany({
      where: { requestStatus: "APPROVED" },
      include: {
        consultationPlan: {
          include: { consultantProfile: { include: { user: { select: { id: true } } } } },
        },
        requestedBy: { include: { user: { select: { id: true } } } },
      },
    }),
    prisma.subscription.findMany({
      where: { requestStatus: "APPROVED" },
      include: {
        subscriptionPlan: {
          include: { consultantProfile: { include: { user: { select: { id: true } } } } },
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
 * Adds a user to a specific channel
 */
export async function addMemberToChannel(channelId: string, userId: string) {
  channelIdSchema.parse(channelId);
  memberIdSchema.parse(userId);

  const client = getStreamChatClient();

  // Infer channel type from ID pattern
  const channelType =
    channelId.startsWith("consultation-") || channelId.startsWith("subscription-")
      ? "messaging"
      : "team";

  streamLogger.debug("Adding member to channel", { channelId, userId, channelType });

  try {
    const channel = client.channel(channelType, channelId);
    await channel.create(); // Creates if doesn't exist, no-op if exists

    const response = await channel.addMembers([userId]);

    streamLogger.debug("Member added successfully", { channelId, userId });
    return { success: true, response };
  } catch (error) {
    streamLogger.error("Failed to add member to channel", error, { channelId, userId });
    throw error;
  }
}
