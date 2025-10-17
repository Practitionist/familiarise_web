"use server";

import { StreamChat } from "stream-chat";
import prisma from "@/lib/prisma";
import { upsertUserToStream } from "./user.action";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;

/**
 * Check if a channel exists for a webinar or class
 * @param eventType The type of event (webinar or class)
 * @param eventId The ID of the event
 * @returns True if the channel exists, false otherwise
 */
export const checkEventChannelExists = async (
  eventType: "webinar" | "class",
  eventId: string,
) => {
  // Define channelId here to make it accessible in the catch block
  const channelId = `${eventType}-${eventId}`;
  try {
    if (!apiKey || !apiSecret) {
      throw new Error("Stream API keys not configured");
    }

    // Initialize the Stream Chat client
    const client = StreamChat.getInstance(apiKey, apiSecret);

    // Create a unique channel ID for the event
    // const channelId = `${eventType}-${eventId}`; // Moved up

    // Get the channel instance. Provide a created_by_id for potential implicit creation.
    // Using a generic system ID for this server-side check/creation.
    const channel = client.channel("team", channelId, {
      created_by_id: "system", // Provide a system user ID
    });

    // Query the channel. If it doesn't exist, this might create it (if permissions allow)
    // or it will return an empty channel object if it truly doesn't exist and can't be created.
    const response = await channel.query();

    // A channel exists if response.channel has data and an id.
    // For a newly implicitly created channel by query(), it might lack full data until properly created.
    // However, if channel.id exists on response.channel, it means Stream acknowledges it.
    const exists = !!(response.channel && response.channel.id);
    console.log(`Channel ${channelId} exists: ${exists}`, response.channel);
    return exists;
  } catch (error: any) {
    // If the error is specifically that the channel is not found (e.g. code 16 from Stream for GetChannel), it means it doesn't exist.
    // Other errors should be treated as actual errors.
    if (
      error.code === 16 ||
      (error.response && error.response.data && error.response.data.code === 16)
    ) {
      console.log(`Channel ${channelId} not found via query.`);
      return false; // Channel doesn't exist
    }
    console.error(
      `Error checking if ${eventType} channel ${eventId} (ID: ${channelId}) exists:`,
      error.message,
      error.response?.data,
    );
    // For other errors, we might not be sure if it exists or not, re-throwing might be better
    // but for a simple existence check, returning false on error is safer.
    return false; // Or rethrow if you want to handle specific errors upstream
  }
};

/**
 * Add a user to an event channel
 * @param eventType The type of event (webinar or class)
 * @param eventId The ID of the event
 * @param userId The ID of the user to add
 * @returns The updated channel
 */
export const addUserToEventChannel = async (
  eventType: "webinar" | "class",
  eventId: string,
  userId: string,
) => {
  try {
    if (!apiKey || !apiSecret) {
      throw new Error("Stream API keys not configured");
    }

    // Initialize the Stream Chat client
    const client = StreamChat.getInstance(apiKey, apiSecret);

    // Create a unique channel ID for the event
    const channelId = `${eventType}-${eventId}`;
    let systemCreatedChannel = false; // Flag to know if we created it in this function

    // Check if the channel exists. This function should now correctly handle this.
    let channelExists = await checkEventChannelExists(eventType, eventId);
    let channel = client.channel("team", channelId);

    // If the channel doesn't exist, create it
    if (!channelExists) {
      console.log(`Channel ${channelId} does not exist. Creating...`);
      let channelCreatorId = "system"; // Default creator
      let channelName = `${eventType} ${eventId}`;

      if (eventType === "webinar") {
        const webinar = await prisma.webinar.findUnique({
          where: { id: eventId },
          include: {
            webinarPlan: {
              include: { consultantProfile: { include: { user: true } } },
            },
          },
        });
        if (!webinar) throw new Error(`Webinar ${eventId} not found`);
        channelName = webinar.webinarPlan.title;
        // Use the consultant as the creator if available
        if (webinar.webinarPlan.consultantProfile?.user?.id) {
          const consultantUserId =
            webinar.webinarPlan.consultantProfile.user.id;
          // Ensure consultant user exists in Stream before making them a creator
          await upsertUserToStream(consultantUserId);
          channelCreatorId = consultantUserId;
        }
      } else {
        // class
        const classData = await prisma.class.findUnique({
          where: { id: eventId },
          include: {
            classPlan: {
              include: { consultantProfile: { include: { user: true } } },
            },
          },
        });
        if (!classData) throw new Error(`Class ${eventId} not found`);
        channelName = classData.classPlan.title;
        if (classData.classPlan.consultantProfile?.user?.id) {
          const consultantUserId =
            classData.classPlan.consultantProfile.user.id;
          await upsertUserToStream(consultantUserId);
          channelCreatorId = consultantUserId;
        }
      }

      channel = client.channel("team", channelId, {
        name: channelName,
        created_by_id: channelCreatorId,
        members: [userId], // Add the target user directly during creation
      });

      await channel.create();
      systemCreatedChannel = true;
      console.log(
        `Created channel ${channelId} with creator ${channelCreatorId} and initial member ${userId}.`,
      );
      // No need to call addMembers if user was added during creation
    } else {
      // Channel exists, ensure name is correct and add the user
      let expectedName = `${eventType} ${eventId}`;
      if (eventType === "webinar") {
        const webinar = await prisma.webinar.findUnique({
          where: { id: eventId },
          include: { webinarPlan: true },
        });
        if (webinar) expectedName = webinar.webinarPlan.title;
      } else {
        // class
        const classData = await prisma.class.findUnique({
          where: { id: eventId },
          include: { classPlan: true },
        });
        if (classData) expectedName = classData.classPlan.title;
      }

      // Fetch current channel data to check if name update is needed
      const existingChannelData = await channel.query();
      if (
        existingChannelData.channel &&
        existingChannelData.channel.name !== expectedName
      ) {
        console.log(`Updating channel ${channelId} name to "${expectedName}"`);
        await channel.update({ name: expectedName });
      }

      await upsertUserToStream(userId);
      console.log(`Channel ${channelId} exists. Adding member ${userId}...`);
      await channel.addMembers([userId]);
      console.log(
        `Added user ${userId} to existing ${eventType} channel ${channelId}`,
      );
    }

    return { success: true, systemCreatedChannel };
  } catch (error) {
    console.error(
      `Error in addUserToEventChannel for ${eventType} ${eventId}, user ${userId}:`,
      error,
    );
    throw error; // Re-throw to allow upstream handling
  }
};

/**
 * Get all event channels for a user
 * @param userId The ID of the user
 * @returns An array of channel objects
 */
export const getUserEventChannels = async (userId: string) => {
  try {
    if (!apiKey || !apiSecret) {
      throw new Error("Stream API keys not configured");
    }

    // Initialize the Stream Chat client
    const client = StreamChat.getInstance(apiKey, apiSecret);

    // Query channels where the user is a member
    const filter = {
      type: "team",
      members: { $in: [userId] },
    };

    // Sort by last_message_at in descending order
    const sort = { last_message_at: -1 } as any;

    const channels = await client.queryChannels(filter, sort, {
      watch: true,
      state: true,
    });

    return channels;
  } catch (error) {
    console.error("Error getting user event channels:", error);
    throw error;
  }
};

/**
 * Synchronize event channels for a user
 * This function ensures that the user is a member of all channels for events they are participating in
 * @param userId The ID of the user
 */
export const syncUserEventChannels = async (userId: string) => {
  try {
    // Get user details
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        consulteeProfile: true,
        consultantProfile: true,
      },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Get webinars where the user is participating (SIMPLIFIED APPROACH)
    // Method 1: Direct waitlist participation
    const webinarsFromWaitlist = await prisma.webinar.findMany({
      where: {
        waitlist: {
          some: {
            userId: userId, // Direct user ID, no need for consulteeProfile
          },
        },
      },
      select: { id: true },
    });

    // Method 2: Appointment participation
    const webinarsFromAppointments = await prisma.webinar.findMany({
      where: {
        appointment: {
          slotsOfAppointment: {
            some: {
              user: {
                some: {
                  id: userId, // Direct user ID
                },
              },
            },
          },
        },
      },
      select: { id: true },
    });

    // Combine and deduplicate webinar IDs
    const allWebinarIds = Array.from(
      new Set([
        ...webinarsFromWaitlist.map((w) => w.id),
        ...webinarsFromAppointments.map((w) => w.id),
      ]),
    );

    console.log(
      `User ${userId}: Found ${webinarsFromWaitlist.length} webinars from waitlist, ${webinarsFromAppointments.length} from appointments, ${allWebinarIds.length} total unique webinars`,
    );

    // Add the user to all webinar channels
    for (const webinarId of allWebinarIds) {
      await addUserToEventChannel("webinar", webinarId, userId);
    }

    // Get classes where the user is participating (SIMPLIFIED APPROACH)
    // Method 1: Direct waitlist participation
    const classesFromWaitlist = await prisma.class.findMany({
      where: {
        waitlist: {
          some: {
            userId: userId, // Direct user ID
          },
        },
      },
      select: { id: true },
    });

    // Method 2: Appointment participation
    const classesFromAppointments = await prisma.class.findMany({
      where: {
        appointments: {
          some: {
            slotsOfAppointment: {
              some: {
                user: {
                  some: {
                    id: userId, // Direct user ID
                  },
                },
              },
            },
          },
        },
      },
      select: { id: true },
    });

    // Combine and deduplicate class IDs
    const allClassIds = Array.from(
      new Set([
        ...classesFromWaitlist.map((c) => c.id),
        ...classesFromAppointments.map((c) => c.id),
      ]),
    );

    console.log(
      `User ${userId}: Found ${classesFromWaitlist.length} classes from waitlist, ${classesFromAppointments.length} from appointments, ${allClassIds.length} total unique classes`,
    );

    // Add the user to all class channels
    for (const classId of allClassIds) {
      await addUserToEventChannel("class", classId, userId);
    }

    // If the user is a consultant, get all webinars and classes they are hosting
    if (user.consultantProfile) {
      const consultantId = user.consultantProfile.id;

      // Get webinars where the consultant is the host
      const webinars = await prisma.webinar.findMany({
        where: {
          webinarPlan: {
            consultantProfileId: consultantId,
          },
        },
        select: {
          id: true,
        },
      });

      // Add the user to all webinar channels
      for (const webinar of webinars) {
        await addUserToEventChannel("webinar", webinar.id, userId);
      }

      // Get classes where the consultant is the host
      const classes = await prisma.class.findMany({
        where: {
          classPlan: {
            consultantProfileId: consultantId,
          },
        },
        select: {
          id: true,
        },
      });

      // Add the user to all class channels
      for (const classItem of classes) {
        await addUserToEventChannel("class", classItem.id, userId);
      }
    }

    return { success: true };
  } catch (error) {
    console.error("Error synchronizing user event channels:", error);
    throw error;
  }
};
