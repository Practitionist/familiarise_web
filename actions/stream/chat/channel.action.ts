"use server";

import { StreamChat } from "stream-chat";
import prisma from "@/lib/prisma";
import { upsertUsersToStream } from "./user.action";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;

// Generic function to create a channel
export async function createChannel({
  channelType,
  channelId,
  channelName,
  members,
  createdById,
  additionalData = {},
}: {
  channelType: "messaging" | "team";
  channelId: string;
  channelName?: string;
  members: string[];
  createdById: string;
  additionalData?: Record<string, any>;
}) {
  if (!apiKey || !apiSecret) {
    throw new Error("Stream API keys not configured");
  }

  const serverClient = StreamChat.getInstance(apiKey, apiSecret);

  // Ensure creator is always included in members list
  const allMembers = Array.from(new Set([createdById, ...members]));
  console.log(`Creating ${channelType} channel ${channelId} with ${allMembers.length} members including creator ${createdById}`);

  // Create the channel
  const channel = serverClient.channel(channelType, channelId, {
    name: channelName,
    created_by_id: createdById,
    ...additionalData,
  });

  await channel.create();
  console.log(`Channel ${channelId} created successfully`);
  
  // Add all members (including creator) after creation to ensure membership is established
  if (allMembers && allMembers.length > 0) {
    try {
      await channel.addMembers(allMembers);
      console.log(`Successfully added ${allMembers.length} members to channel ${channelId}:`, allMembers);
      
      // Verify membership was established
      const channelData = await channel.query();
      const actualMembers = Object.keys(channelData.members || {});
      console.log(`Channel ${channelId} actual members after creation:`, actualMembers);
      
      return { channelId, members: actualMembers, channelData };
    } catch (memberError) {
      console.error(`Failed to add members to channel ${channelId}:`, memberError);
      throw memberError; // Throw error instead of continuing, as membership is critical
    }
  }

  return { channelId };
}

// Create a direct message channel
export async function createDirectMessageChannel(
  currentUserId: string,
  targetUserId: string,
) {
  // Create a unique channel ID for the DM using localeCompare for reliable alphabetical sorting
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

// Create a webinar channel
export async function createWebinarChannel(webinarId: string) {
  // Get webinar details including both waitlist AND appointment participants
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
      appointment: {
        include: {
          slotsOfAppointment: {
            include: {
              user: true,
            },
          },
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

  // Get participant IDs from waitlist
  const waitlistParticipantIds = webinar.waitlist.map((entry) => entry.userId);
  
  // Get participant IDs from appointments
  const appointmentParticipantIds = webinar.appointment?.slotsOfAppointment?.flatMap(
    (slot) => slot.user.map((user) => user.id)
  ) || [];

  // Combine both sets and remove duplicates
  const allParticipantIds = Array.from(new Set([...waitlistParticipantIds, ...appointmentParticipantIds]));

  console.log(`Webinar ${webinarId} participants: ${waitlistParticipantIds.length} from waitlist, ${appointmentParticipantIds.length} from appointments, ${allParticipantIds.length} total unique`);

  return createChannel({
    channelType: "team",
    channelId: `webinar-${webinarId}`,
    channelName: webinar.webinarPlan.title,
    members: [consultantId, ...allParticipantIds],
    createdById: consultantId,
    additionalData: { webinar_id: webinarId },
  });
}

// Create a class channel
export async function createClassChannel(classId: string) {
  // Get class details including both waitlist AND appointment participants
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
      appointments: {
        include: {
          slotsOfAppointment: {
            include: {
              user: true,
            },
          },
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

  // Get participant IDs from waitlist
  const waitlistParticipantIds = classData.waitlist.map((entry) => entry.userId);
  
  // Get participant IDs from appointments
  const appointmentParticipantIds = classData.appointments?.flatMap(
    (appointment) => appointment.slotsOfAppointment?.flatMap(
      (slot) => slot.user.map((user) => user.id)
    )
  ) || [];

  // Combine both sets and remove duplicates
  const allParticipantIds = Array.from(new Set([...waitlistParticipantIds, ...appointmentParticipantIds]));

  console.log(`Class ${classId} participants: ${waitlistParticipantIds.length} from waitlist, ${appointmentParticipantIds.length} from appointments, ${allParticipantIds.length} total unique`);

  return createChannel({
    channelType: "team",
    channelId: `class-${classId}`,
    channelName: classData.classPlan.title,
    members: [consultantId, ...allParticipantIds],
    createdById: consultantId,
    additionalData: { class_id: classId },
  });
}

// Create a consultation channel
export async function createConsultationChannel(consultationId: string) {
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

  return createChannel({
    channelType: "messaging",
    channelId: `consultation-${consultationId}`,
    members: [consultantId, consulteeId],
    createdById: consultantId,
    additionalData: { consultation_id: consultationId },
  });
}

// Create a subscription channel
export async function createSubscriptionChannel(subscriptionId: string) {
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

  return createChannel({
    channelType: "messaging",
    channelId: `subscription-${subscriptionId}`,
    members: [consultantId, consulteeId],
    createdById: consultantId,
    additionalData: { subscription_id: subscriptionId },
  });
}

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
  for (const webinarData of webinars) {
    try {
      await createWebinarChannel(webinarData.id);
      console.log(`Created channel for webinar ${webinarData.id}`);
    } catch (error) {
      console.error(
        `Error creating channel for webinar ${webinarData.id}:`,
        error,
      );
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
  for (const consultationData of consultations) {
    try {
      await createConsultationChannel(consultationData.id);
      console.log(`Created channel for consultation ${consultationData.id}`);
    } catch (error) {
      console.error(
        `Error creating channel for consultation ${consultationData.id}:`,
        error,
      );
    }
  }

  // Create channels for all subscriptions
  for (const subscriptionData of subscriptions) {
    try {
      await createSubscriptionChannel(subscriptionData.id);
      console.log(`Created channel for subscription ${subscriptionData.id}`);
    } catch (error) {
      console.error(
        `Error creating channel for subscription ${subscriptionData.id}:`,
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

/**
 * Adds a user to a specific channel.
 * Ensures Stream keys are configured.
 * @param channelId The ID of the channel to add the user to.
 * @param userId The ID of the user to add.
 */
export async function addMemberToChannel(channelId: string, userId: string) {
  if (!apiKey || !apiSecret) {
    throw new Error("Stream API keys not configured");
  }
  if (!channelId || !userId) {
    throw new Error("Channel ID and User ID are required");
  }

  const serverClient = StreamChat.getInstance(apiKey, apiSecret);

  // OPTIMIZATION: No need to explicitly upsert user here.
  // Stream's addMembers should handle user creation if needed.
  // await upsertUserToStream(userId); // Removed this line

  // TODO: Determine channel type dynamically if needed, assuming 'team' for now
  // This might need adjustment if you add members to 'messaging' channels this way.
  const channelType = "team";
  console.log(
    `Adding member ${userId} to ${channelType} channel ${channelId} via action`,
  );

  try {
    const channel = serverClient.channel(channelType, channelId);
    // Ensure channel exists before adding members (optional but safer)
    await channel.create(); // Creates if it doesn't exist, does nothing if it does

    const response = await channel.addMembers([userId]);

    console.log(
      `Add members response for user ${userId} to channel ${channelId}:`,
      response,
    );
    return { success: true, response };
  } catch (error) {
    console.error(
      `Error adding member ${userId} to channel ${channelId} via action:`,
      error,
    );
    // Rethrow the error so the calling component can handle it
    throw error;
  }
}
