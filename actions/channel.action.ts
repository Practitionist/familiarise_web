"use server";

import { StreamChat } from "stream-chat";
import prisma from "@/lib/prisma";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_SECRET_KEY;

// Create a direct message channel
export async function createDirectMessageChannel(
  currentUserId: string,
  targetUserId: string,
) {
  if (!apiKey || !apiSecret) {
    throw new Error("Stream API keys not configured");
  }

  const serverClient = StreamChat.getInstance(apiKey, apiSecret);

  // Create a unique channel ID for the DM
  const channelId = [currentUserId, targetUserId].sort().join("-");

  // Create the channel
  const channel = serverClient.channel("messaging", channelId, {
    members: [currentUserId, targetUserId],
    created_by_id: currentUserId,
  });

  await channel.create();

  return { channelId };
}

// Create a webinar channel
export async function createWebinarChannel(webinarId: string) {
  if (!apiKey || !apiSecret) {
    throw new Error("Stream API keys not configured");
  }

  // Get webinar details
  const webinar = await prisma.webinar.findUnique({
    where: { id: webinarId },
    include: {
      webinarPlan: {
        include: {
          consultantProfile: true,
        },
      },
      waitlist: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!webinar) {
    throw new Error("Webinar not found");
  }

  const consultantId = webinar.webinarPlan.consultantProfileId;

  if (!consultantId) {
    throw new Error("Consultant not found for webinar");
  }

  const serverClient = StreamChat.getInstance(apiKey, apiSecret);

  // Create a channel for the webinar
  const channelId = `webinar-${webinarId}`;

  // Get all participant IDs
  const participantIds = webinar.waitlist.map((entry) => entry.userId);

  // Create the channel
  const channel = serverClient.channel("team", channelId, {
    name: webinar.webinarPlan.title,
    members: [consultantId, ...participantIds],
    created_by_id: consultantId,
    webinar_id: webinarId,
  });

  await channel.create();

  return { channelId };
}

// Create a class channel
export async function createClassChannel(classId: string) {
  if (!apiKey || !apiSecret) {
    throw new Error("Stream API keys not configured");
  }

  // Get class details
  const classData = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      classPlan: {
        include: {
          consultantProfile: true,
        },
      },
      waitlist: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!classData) {
    throw new Error("Class not found");
  }

  const consultantId = classData.classPlan.consultantProfileId;

  if (!consultantId) {
    throw new Error("Consultant not found for class");
  }

  const serverClient = StreamChat.getInstance(apiKey, apiSecret);

  // Create a channel for the class
  const channelId = `class-${classId}`;

  // Get all participant IDs
  const participantIds = classData.waitlist.map((entry) => entry.userId);

  // Create the channel
  const channel = serverClient.channel("team", channelId, {
    name: classData.classPlan.title,
    members: [consultantId, ...participantIds],
    created_by_id: consultantId,
    class_id: classId,
  });

  await channel.create();

  return { channelId };
}

// Create a consultation channel
export async function createConsultationChannel(consultationId: string) {
  if (!apiKey || !apiSecret) {
    throw new Error("Stream API keys not configured");
  }

  // Get consultation details
  const consultation = await prisma.consultation.findUnique({
    where: { id: consultationId },
    include: {
      consultationPlan: {
        include: {
          consultantProfile: {
            include: {
              user: true,
            },
          },
        },
      },
      requestedBy: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!consultation) {
    throw new Error("Consultation not found");
  }

  const consultantId = consultation.consultationPlan.consultantProfile.user.id;
  const consulteeId = consultation.requestedBy.user.id;

  if (!consultantId || !consulteeId) {
    throw new Error("Consultant or consultee not found for consultation");
  }

  const serverClient = StreamChat.getInstance(apiKey, apiSecret);

  // Create a direct message channel for the consultation
  const channelId = `consultation-${consultationId}`;

  // Create the channel
  const channel = serverClient.channel("messaging", channelId, {
    members: [consultantId, consulteeId],
    created_by_id: consultantId,
    consultation_id: consultationId,
  });

  await channel.create();

  return { channelId };
}

// Create a subscription channel
export async function createSubscriptionChannel(subscriptionId: string) {
  if (!apiKey || !apiSecret) {
    throw new Error("Stream API keys not configured");
  }

  // Get subscription details
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      subscriptionPlan: {
        include: {
          consultantProfile: {
            include: {
              user: true,
            },
          },
        },
      },
      requestedBy: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!subscription) {
    throw new Error("Subscription not found");
  }

  const consultantId = subscription.subscriptionPlan.consultantProfile.user.id;
  const consulteeId = subscription.requestedBy.user.id;

  if (!consultantId || !consulteeId) {
    throw new Error("Consultant or consultee not found for subscription");
  }

  const serverClient = StreamChat.getInstance(apiKey, apiSecret);

  // Create a direct message channel for the subscription
  const channelId = `subscription-${subscriptionId}`;

  // Create the channel
  const channel = serverClient.channel("messaging", channelId, {
    members: [consultantId, consulteeId],
    created_by_id: consultantId,
    subscription_id: subscriptionId,
  });

  await channel.create();

  return { channelId };
}

import { upsertUsersToStream } from "./user.action";

// Initialize channels for all existing webinars, classes, consultations, and subscriptions
export async function initializeAllChannels() {
  console.log("Initializing all channels...");

  // First, collect all user IDs that need to be registered with Stream Chat
  const userIds = new Set<string>();

  // Get all webinars with participants
  const webinars = await prisma.webinar.findMany({
    include: {
      webinarPlan: {
        include: {
          consultantProfile: {
            include: {
              user: true,
            },
          },
        },
      },
      waitlist: {
        include: {
          user: true,
        },
      },
    },
  });
  console.log(`Found ${webinars.length} webinars`);

  // Collect user IDs from webinars
  for (const webinar of webinars) {
    if (webinar.webinarPlan.consultantProfile?.user?.id) {
      userIds.add(webinar.webinarPlan.consultantProfile.user.id);
    }

    for (const entry of webinar.waitlist) {
      if (entry.user?.id) {
        userIds.add(entry.user.id);
      }
    }
  }

  // Get all classes with participants
  const classes = await prisma.class.findMany({
    include: {
      classPlan: {
        include: {
          consultantProfile: {
            include: {
              user: true,
            },
          },
        },
      },
      waitlist: {
        include: {
          user: true,
        },
      },
    },
  });
  console.log(`Found ${classes.length} classes`);

  // Collect user IDs from classes
  for (const classData of classes) {
    if (classData.classPlan.consultantProfile?.user?.id) {
      userIds.add(classData.classPlan.consultantProfile.user.id);
    }

    for (const entry of classData.waitlist) {
      if (entry.user?.id) {
        userIds.add(entry.user.id);
      }
    }
  }

  // Get all consultations with participants
  const consultations = await prisma.consultation.findMany({
    where: {
      requestStatus: "APPROVED",
    },
    include: {
      consultationPlan: {
        include: {
          consultantProfile: {
            include: {
              user: true,
            },
          },
        },
      },
      requestedBy: {
        include: {
          user: true,
        },
      },
    },
  });
  console.log(`Found ${consultations.length} consultations`);

  // Collect user IDs from consultations
  for (const consultation of consultations) {
    if (consultation.consultationPlan.consultantProfile?.user?.id) {
      userIds.add(consultation.consultationPlan.consultantProfile.user.id);
    }

    if (consultation.requestedBy?.user?.id) {
      userIds.add(consultation.requestedBy.user.id);
    }
  }

  // Get all subscriptions with participants
  const subscriptions = await prisma.subscription.findMany({
    where: {
      requestStatus: "APPROVED",
    },
    include: {
      subscriptionPlan: {
        include: {
          consultantProfile: {
            include: {
              user: true,
            },
          },
        },
      },
      requestedBy: {
        include: {
          user: true,
        },
      },
    },
  });
  console.log(`Found ${subscriptions.length} subscriptions`);

  // Collect user IDs from subscriptions
  for (const subscription of subscriptions) {
    if (subscription.subscriptionPlan.consultantProfile?.user?.id) {
      userIds.add(subscription.subscriptionPlan.consultantProfile.user.id);
    }

    if (subscription.requestedBy?.user?.id) {
      userIds.add(subscription.requestedBy.user.id);
    }
  }

  // Upsert all users to Stream Chat
  const uniqueUserIds = Array.from(userIds);
  console.log(`Upserting ${uniqueUserIds.length} users to Stream Chat`);

  try {
    await upsertUsersToStream(uniqueUserIds);
    console.log(
      `Successfully upserted ${uniqueUserIds.length} users to Stream Chat`,
    );
  } catch (error) {
    console.error("Error upserting users to Stream Chat:", error);
    // Continue even if upserting fails
  }

  // Now create channels for all entities

  // Create channels for all webinars
  for (const webinar of webinars) {
    try {
      await createWebinarChannel(webinar.id);
      console.log(`Created channel for webinar ${webinar.id}`);
    } catch (error) {
      console.error(`Error creating channel for webinar ${webinar.id}:`, error);
    }
  }

  // Create channels for all classes
  for (const classData of classes) {
    try {
      await createClassChannel(classData.id);
      console.log(`Created channel for class ${classData.id}`);
    } catch (error) {
      console.error(`Error creating channel for class ${classData.id}:`, error);
    }
  }

  // Create channels for all consultations
  for (const consultation of consultations) {
    try {
      await createConsultationChannel(consultation.id);
      console.log(`Created channel for consultation ${consultation.id}`);
    } catch (error) {
      console.error(
        `Error creating channel for consultation ${consultation.id}:`,
        error,
      );
    }
  }

  // Create channels for all subscriptions
  for (const subscription of subscriptions) {
    try {
      await createSubscriptionChannel(subscription.id);
      console.log(`Created channel for subscription ${subscription.id}`);
    } catch (error) {
      console.error(
        `Error creating channel for subscription ${subscription.id}:`,
        error,
      );
    }
  }

  return {
    success: true,
    counts: {
      users: uniqueUserIds.length,
      webinars: webinars.length,
      classes: classes.length,
      consultations: consultations.length,
      subscriptions: subscriptions.length,
    },
  };
}
