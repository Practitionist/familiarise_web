"use server";

import { StreamChat } from "stream-chat";
import prisma from "@/lib/prisma";
import { upsertUserToStream } from "./user.action";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_SECRET_KEY;

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
  try {
    if (!apiKey || !apiSecret) {
      throw new Error("Stream API keys not configured");
    }

    // Initialize the Stream Chat client
    const client = StreamChat.getInstance(apiKey, apiSecret);

    // Create a unique channel ID for the event
    const channelId = `${eventType}-${eventId}`;

    // Get the channel
    const channel = client.channel("team", channelId);

    // Query the channel to check if it exists
    const response = await channel.query();

    return !!response.channel;
  } catch (error) {
    console.error(`Error checking if ${eventType} channel exists:`, error);
    return false;
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

    // Check if the channel exists
    const channelExists = await checkEventChannelExists(eventType, eventId);

    // If the channel doesn't exist, create it
    if (!channelExists) {
      if (eventType === "webinar") {
        // Get webinar details
        const webinar = await prisma.webinar.findUnique({
          where: { id: eventId },
          include: {
            webinarPlan: true,
          },
        });

        if (!webinar) {
          throw new Error("Webinar not found");
        }

        // Create the channel
        const channel = client.channel("team", channelId, {
          name: webinar.webinarPlan.title,
          members: [userId],
          created_by_id: "system",
        });

        await channel.create();
        console.log(`Created channel for webinar ${eventId}`);
      } else {
        // Get class details
        const classData = await prisma.class.findUnique({
          where: { id: eventId },
          include: {
            classPlan: true,
          },
        });

        if (!classData) {
          throw new Error("Class not found");
        }

        // Create the channel
        const channel = client.channel("team", channelId, {
          name: classData.classPlan.title,
          members: [userId],
          created_by_id: "system",
        });

        await channel.create();
        console.log(`Created channel for class ${eventId}`);
      }
    } else {
      // Ensure the user is registered with Stream Chat
      await upsertUserToStream(userId);

      // Get the channel
      const channel = client.channel("team", channelId);

      // Add the user to the channel
      await channel.addMembers([userId]);
      console.log(`Added user ${userId} to ${eventType} channel ${channelId}`);
    }

    return { success: true };
  } catch (error) {
    console.error(`Error adding user to ${eventType} channel:`, error);
    throw error;
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

    // If the user is a consultee, get all webinars and classes they are participating in
    if (user.consulteeProfile) {
      const consulteeId = user.consulteeProfile.id;

      // Get webinars where the consultee is registered
      const webinars = await prisma.webinar.findMany({
        where: {
          OR: [
            // Get webinars where consultee is registered through appointments
            {
              appointment: {
                slotsOfAppointment: {
                  some: {
                    user: {
                      some: {
                        consulteeProfile: {
                          id: consulteeId,
                        },
                      },
                    },
                  },
                },
              },
            },
            // Get webinars where consultee is in waitlist
            {
              waitlist: {
                some: {
                  user: {
                    consulteeProfile: {
                      id: consulteeId,
                    },
                  },
                },
              },
            },
          ],
        },
        select: {
          id: true,
        },
      });

      // Add the user to all webinar channels
      for (const webinar of webinars) {
        await addUserToEventChannel("webinar", webinar.id, userId);
      }

      // Get classes where the consultee is registered
      const classes = await prisma.class.findMany({
        where: {
          OR: [
            // Get classes where consultee is registered through appointments
            {
              appointments: {
                some: {
                  slotsOfAppointment: {
                    some: {
                      user: {
                        some: {
                          consulteeProfile: {
                            id: consulteeId,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            // Get classes where consultee is in waitlist
            {
              waitlist: {
                some: {
                  user: {
                    consulteeProfile: {
                      id: consulteeId,
                    },
                  },
                },
              },
            },
          ],
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
