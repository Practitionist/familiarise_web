"use server";

import { StreamChat } from "stream-chat";
import prisma from "@/lib/prisma";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_SECRET_KEY;

// Create a direct message channel
export async function createDirectMessageChannel(currentUserId: string, targetUserId: string) {
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
  const participantIds = webinar.waitlist.map(entry => entry.userId);
  
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
  const participantIds = classData.waitlist.map(entry => entry.userId);
  
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

// Initialize channels for all existing webinars and classes
export async function initializeAllChannels() {
  // Get all webinars
  const webinars = await prisma.webinar.findMany();
  
  // Create channels for all webinars
  for (const webinar of webinars) {
    try {
      await createWebinarChannel(webinar.id);
    } catch (error) {
      console.error(`Error creating channel for webinar ${webinar.id}:`, error);
    }
  }
  
  // Get all classes
  const classes = await prisma.class.findMany();
  
  // Create channels for all classes
  for (const classData of classes) {
    try {
      await createClassChannel(classData.id);
    } catch (error) {
      console.error(`Error creating channel for class ${classData.id}:`, error);
    }
  }
  
  return { success: true };
}
