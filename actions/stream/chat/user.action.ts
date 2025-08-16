"use server";

import { StreamChat } from "stream-chat";
import prisma from "@/lib/prisma";
import { mapRoleToStream } from "@/lib/user";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;

/**
 * Upserts a user to Stream Chat
 * @param userId The ID of the user to upsert
 * @returns The upserted user
 */
export const upsertUserToStream = async (userId: string) => {
  try {
    if (!apiKey || !apiSecret) {
      throw new Error("Stream API keys not configured");
    }

    // Get user details from the database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Initialize the Stream Chat client
    const client = StreamChat.getInstance(apiKey, apiSecret);

    // Use the shared utility function
    const streamRole = mapRoleToStream(user.role);

    console.log(`Upserting user ${user.id} with role ${streamRole}`);

    // Upsert the user to Stream Chat
    const streamUser = await client.upsertUser({
      id: user.id,
      name: user.name ?? user.id,
      email: user.email,
      image: user.image ?? undefined,
      role: streamRole,
    });

    return streamUser;
  } catch (error) {
    console.error("Error upserting user to Stream Chat:", error);
    throw error;
  }
};

/**
 * Upserts multiple users to Stream Chat
 * @param userIds The IDs of the users to upsert
 * @returns The upserted users
 */
export const upsertUsersToStream = async (userIds: string[]) => {
  try {
    if (!apiKey || !apiSecret) {
      throw new Error("Stream API keys not configured");
    }

    // Get user details from the database
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
    });

    if (users.length === 0) {
      throw new Error("No users found");
    }

    // Initialize the Stream Chat client
    const client = StreamChat.getInstance(apiKey, apiSecret);

    // Prepare users for upsert
    const streamUsers = users.map((user) => {
      // Use the shared utility function
      const streamRole = mapRoleToStream(user.role);

      console.log(
        `Preparing to upsert user ${user.id} with role ${streamRole}`,
      );

      return {
        id: user.id,
        name: user.name ?? user.id,
        email: user.email,
        image: user.image ?? undefined,
        role: streamRole,
      };
    });

    // Upsert the users to Stream Chat
    const result = await client.upsertUsers(streamUsers);

    return result;
  } catch (error) {
    console.error("Error upserting users to Stream Chat:", error);
    throw error;
  }
};

/**
 * Enhanced user search with relationship status for Direct Message dialog
 * @param searchTerm The term to search for (name or email).
 * @param currentUserId The current user's ID to exclude from results and check relationships
 * @returns Users with relationship status information
 */
export const searchUsersWithRelationships = async (
  searchTerm: string,
  currentUserId: string,
) => {
  try {
    if (!searchTerm.trim()) {
      return [];
    }
    console.log(`Searching DB for users with term: ${searchTerm}`);
    
    const users = await prisma.user.findMany({
      where: {
        AND: [
          { id: { not: currentUserId } }, // Exclude current user
          {
            // Exclude users whose IDs start with common system prefixes
            NOT: [
              { id: { startsWith: "recording-egress-" } },
              { id: { startsWith: "system-" } },
            ],
          },
          {
            OR: [
              { name: { contains: searchTerm, mode: "insensitive" } },
              { email: { contains: searchTerm, mode: "insensitive" } },
            ],
          },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        consultantProfileId: true,
        consulteeProfileId: true,
      },
      take: 20,
      orderBy: [{ name: "asc" }],
    });

    // For each user, check if they have any relationship with the current user
    const usersWithRelationships = await Promise.all(
      users.map(async (user) => {
        const hasRelationship = await checkUserRelationship(currentUserId, user.id);
        
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: user.role,
          hasRelationship,
        };
      })
    );

    // Sort by relationship status (connected users first), then by name
    usersWithRelationships.sort((a, b) => {
      if (a.hasRelationship && !b.hasRelationship) return -1;
      if (!a.hasRelationship && b.hasRelationship) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });

    console.log(`Found ${usersWithRelationships.length} users with relationship status.`);
    return usersWithRelationships;
  } catch (error) {
    console.error("Error searching users with relationships:", error);
    throw error;
  }
};

/**
 * Check if two users have any relationship through appointments
 * @param userId1 First user ID
 * @param userId2 Second user ID
 * @returns Boolean indicating if they have any relationship
 */
export const checkUserRelationship = async (
  userId1: string,
  userId2: string,
): Promise<boolean> => {
  try {
    // Get profile IDs for both users
    const [user1, user2] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId1 },
        select: { consultantProfileId: true, consulteeProfileId: true },
      }),
      prisma.user.findUnique({
        where: { id: userId2 },
        select: { consultantProfileId: true, consulteeProfileId: true },
      }),
    ]);

    if (!user1 || !user2) return false;

    // Check for relationships through various appointment types
    const relationshipChecks = await Promise.all([
      // Check consultations (user1 as consultant, user2 as consultee or vice versa)
      checkConsultationRelationship(user1, user2),
      
      // Check subscriptions
      checkSubscriptionRelationship(user1, user2),
      
      // Check webinars/classes through shared appointments
      checkSharedAppointments(userId1, userId2),
    ]);

    return relationshipChecks.some(Boolean);
  } catch (error) {
    console.error("Error checking user relationship:", error);
    return false; // Default to no relationship on error
  }
};

/**
 * Check consultation relationships between two users
 */
async function checkConsultationRelationship(
  user1: { consultantProfileId: string | null; consulteeProfileId: string | null },
  user2: { consultantProfileId: string | null; consulteeProfileId: string | null },
): Promise<boolean> {
  if (!user1.consultantProfileId && !user1.consulteeProfileId) return false;
  if (!user2.consultantProfileId && !user2.consulteeProfileId) return false;

  // Check if user1 (consultant) has consultations with user2 (consultee)
  if (user1.consultantProfileId && user2.consulteeProfileId) {
    const consultation = await prisma.consultation.findFirst({
      where: {
        consultationPlan: {
          consultantProfileId: user1.consultantProfileId,
        },
        requestedById: user2.consulteeProfileId,
        requestStatus: {
          in: ["APPROVED", "SCHEDULED"],
        },
      },
    });
    if (consultation) return true;
  }

  // Check reverse relationship (user2 as consultant, user1 as consultee)
  if (user2.consultantProfileId && user1.consulteeProfileId) {
    const consultation = await prisma.consultation.findFirst({
      where: {
        consultationPlan: {
          consultantProfileId: user2.consultantProfileId,
        },
        requestedById: user1.consulteeProfileId,
        requestStatus: {
          in: ["APPROVED", "SCHEDULED"],
        },
      },
    });
    if (consultation) return true;
  }

  return false;
}

/**
 * Check subscription relationships between two users
 */
async function checkSubscriptionRelationship(
  user1: { consultantProfileId: string | null; consulteeProfileId: string | null },
  user2: { consultantProfileId: string | null; consulteeProfileId: string | null },
): Promise<boolean> {
  if (!user1.consultantProfileId && !user1.consulteeProfileId) return false;
  if (!user2.consultantProfileId && !user2.consulteeProfileId) return false;

  // Check if user1 (consultant) has subscriptions with user2 (consultee)
  if (user1.consultantProfileId && user2.consulteeProfileId) {
    const subscription = await prisma.subscription.findFirst({
      where: {
        subscriptionPlan: {
          consultantProfileId: user1.consultantProfileId,
        },
        requestedById: user2.consulteeProfileId,
        requestStatus: {
          in: ["APPROVED", "SCHEDULED"],
        },
        endDate: {
          gte: new Date(), // Active subscription
        },
      },
    });
    if (subscription) return true;
  }

  // Check reverse relationship
  if (user2.consultantProfileId && user1.consulteeProfileId) {
    const subscription = await prisma.subscription.findFirst({
      where: {
        subscriptionPlan: {
          consultantProfileId: user2.consultantProfileId,
        },
        requestedById: user1.consulteeProfileId,
        requestStatus: {
          in: ["APPROVED", "SCHEDULED"],
        },
        endDate: {
          gte: new Date(),
        },
      },
    });
    if (subscription) return true;
  }

  return false;
}

/**
 * Check if users share any appointments (webinars, classes)
 */
async function checkSharedAppointments(
  userId1: string,
  userId2: string,
): Promise<boolean> {
  // Check if both users are in the same appointment slots
  const sharedSlot = await prisma.slotOfAppointment.findFirst({
    where: {
      user: {
        some: { id: userId1 },
      },
      AND: {
        user: {
          some: { id: userId2 },
        },
      },
    },
  });

  return !!sharedSlot;
}

/**
 * Legacy search function for backward compatibility
 * @param searchTerm The term to search for (name or email).
 * @returns The users that match the search term.
 */
export const searchUsers = async (searchTerm: string) => {
  try {
    if (!searchTerm.trim()) {
      return [];
    }
    console.log(`Searching DB for users with term: ${searchTerm}`);
    const users = await prisma.user.findMany({
      where: {
        AND: [
          {
            // Exclude users whose IDs start with common system prefixes
            // or have a specific role indicating they are not regular users.
            // Adjust these conditions based on your data model and needs.
            NOT: [
              { id: { startsWith: "recording-egress-" } },
              { id: { startsWith: "system-" } },
              // Example: { role: "BOT" }, // If you have a 'role' field in your Prisma User model
              // Example: { email: { endsWith: "@system.internal" } } // If system users have specific email patterns
            ],
          },
          {
            OR: [
              { name: { contains: searchTerm, mode: "insensitive" } },
              { email: { contains: searchTerm, mode: "insensitive" } },
              // Avoid broad ID contains search for user-facing DM search to prevent irrelevant matches
              // If specific ID search is needed, consider an exact match: { id: searchTerm }
            ],
          },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
      take: 10,
      orderBy: [{ name: "asc" }],
    });
    console.log(`Found ${users.length} users in DB matching criteria.`);
    return users;
  } catch (error) {
    console.error("Error searching users in DB:", error);
    // Decide if to throw or return empty array for robustness in calling code
    throw error;
  }
};
