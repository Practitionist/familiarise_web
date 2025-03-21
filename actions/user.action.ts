"use server";

import { StreamChat } from "stream-chat";
import prisma from "@/lib/prisma";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_SECRET_KEY;

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

    // Map our application roles to Stream Chat roles
    // Stream Chat roles are: admin, user, guest, anonymous
    let streamRole = "user"; // Default role

    if (user.role) {
      // Map our application roles to Stream Chat roles
      switch (user.role.toUpperCase()) {
        case "ADMIN":
          streamRole = "admin";
          break;
        case "CONSULTANT":
        case "CONSULTEE":
        case "USER":
          streamRole = "user";
          break;
        default:
          streamRole = "user";
      }
    }

    console.log(`Upserting user ${user.id} with role ${streamRole}`);

    // Upsert the user to Stream Chat
    const streamUser = await client.upsertUser({
      id: user.id,
      name: user.name || user.id,
      email: user.email,
      image: user.image || undefined,
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
      // Map our application roles to Stream Chat roles
      // Stream Chat roles are: admin, user, guest, anonymous
      let streamRole = "user"; // Default role

      if (user.role) {
        // Map our application roles to Stream Chat roles
        switch (user.role.toUpperCase()) {
          case "ADMIN":
            streamRole = "admin";
            break;
          case "CONSULTANT":
          case "CONSULTEE":
          case "USER":
            streamRole = "user";
            break;
          default:
            streamRole = "user";
        }
      }

      console.log(
        `Preparing to upsert user ${user.id} with role ${streamRole}`,
      );

      return {
        id: user.id,
        name: user.name || user.id,
        email: user.email,
        image: user.image || undefined,
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
 * Searches for users in the database
 * @param searchTerm The term to search for
 * @returns The users that match the search term
 */
export const searchUsers = async (searchTerm: string) => {
  try {
    // Search for users by name or email
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { name: { contains: searchTerm, mode: "insensitive" } },
          { email: { contains: searchTerm, mode: "insensitive" } },
          { id: { contains: searchTerm, mode: "insensitive" } },
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
    });

    return users;
  } catch (error) {
    console.error("Error searching users:", error);
    throw error;
  }
};
