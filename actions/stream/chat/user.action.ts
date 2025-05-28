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
    } as any); // Cast to any to allow custom fields like email

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
 * Searches for users in the database, excluding known system/bot patterns.
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
