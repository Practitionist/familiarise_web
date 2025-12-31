"use server";

import { z } from "zod";
import prisma from "@/lib/prisma";
import { mapRoleToStream } from "@/lib/user";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { markUserSynced, isUserSynced } from "@/lib/stream-cache";

// Input validation schemas
const userIdSchema = z.string().min(1, "User ID is required");
const userIdsSchema = z
  .array(userIdSchema)
  .min(1, "At least one user ID required");
const searchTermSchema = z.string().min(1, "Search term is required").max(100);

/**
 * Upserts a user to Stream Chat
 * Uses caching to avoid redundant upserts
 * @param userId The ID of the user to upsert
 * @returns The upserted user or null if already synced
 */
export const upsertUserToStream = async (userId: string) => {
  // Validate input
  const validatedUserId = userIdSchema.parse(userId);

  // Check cache first - skip if recently synced
  if (isUserSynced(validatedUserId)) {
    streamLogger.debug("User already synced recently, skipping", {
      userId: validatedUserId,
    });
    return null;
  }

  try {
    // Get user details from the database
    const user = await prisma.user.findUnique({
      where: { id: validatedUserId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
    });

    if (!user) {
      throw new Error(`User not found: ${validatedUserId}`);
    }

    const client = getStreamChatClient();
    const streamRole = mapRoleToStream(user.role);

    streamLogger.debug("Upserting user to Stream", {
      userId: user.id,
      role: streamRole,
    });

    // Upsert the user to Stream Chat
    const streamUser = await client.upsertUser({
      id: user.id,
      name: user.name ?? user.id,
      email: user.email,
      image: user.image ?? undefined,
      role: streamRole,
    });

    // Mark as synced in cache
    markUserSynced(user.id);

    return streamUser;
  } catch (error) {
    streamLogger.error("Failed to upsert user to Stream", error, {
      userId: validatedUserId,
    });
    throw error;
  }
};

/**
 * Upserts multiple users to Stream Chat in a single batch call
 * Much more efficient than individual upserts
 * @param userIds The IDs of the users to upsert
 * @returns The upserted users
 */
export const upsertUsersToStream = async (userIds: string[]) => {
  // Validate input
  const validatedIds = userIdsSchema.parse(userIds);

  // Filter out already synced users
  const unsyncedIds = validatedIds.filter((id) => !isUserSynced(id));

  if (unsyncedIds.length === 0) {
    streamLogger.debug("All users already synced, skipping batch upsert", {
      totalRequested: validatedIds.length,
    });
    return { users: {} };
  }

  try {
    // Get user details from the database
    const users = await prisma.user.findMany({
      where: { id: { in: unsyncedIds } },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
    });

    if (users.length === 0) {
      streamLogger.warn("No users found for batch upsert", {
        requestedIds: unsyncedIds,
      });
      return { users: {} };
    }

    const client = getStreamChatClient();

    // Prepare users for batch upsert
    const streamUsers = users.map((user) => {
      const streamRole = mapRoleToStream(user.role);
      return {
        id: user.id,
        name: user.name ?? user.id,
        email: user.email,
        image: user.image ?? undefined,
        role: streamRole,
      };
    });

    streamLogger.debug("Batch upserting users to Stream", {
      count: streamUsers.length,
      skipped: validatedIds.length - unsyncedIds.length,
    });

    // Single batch API call
    const result = await client.upsertUsers(streamUsers);

    // Mark all as synced
    users.forEach((user) => markUserSynced(user.id));

    return result;
  } catch (error) {
    streamLogger.error("Failed to batch upsert users to Stream", error, {
      userCount: unsyncedIds.length,
    });
    throw error;
  }
};

/**
 * Enhanced user search with relationship status for Direct Message dialog
 * @param searchTerm The term to search for (name or email)
 * @param currentUserId The current user's ID to exclude from results
 * @returns Users with relationship status information
 */
export const searchUsersWithRelationships = async (
  searchTerm: string,
  currentUserId: string,
) => {
  // Validate inputs
  const validatedTerm = searchTermSchema.parse(searchTerm.trim());
  const validatedUserId = userIdSchema.parse(currentUserId);

  try {
    const users = await prisma.user.findMany({
      where: {
        AND: [
          { id: { not: validatedUserId } },
          {
            NOT: [
              { id: { startsWith: "recording-egress-" } },
              { id: { startsWith: "system-" } },
            ],
          },
          {
            OR: [
              { name: { contains: validatedTerm, mode: "insensitive" } },
              { email: { contains: validatedTerm, mode: "insensitive" } },
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

    // Check relationships in parallel for better performance
    const usersWithRelationships = await Promise.all(
      users.map(async (user) => {
        const hasRelationship = await checkUserRelationship(
          validatedUserId,
          user.id,
        );
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: user.role,
          hasRelationship,
        };
      }),
    );

    // Sort by relationship status (connected users first), then by name
    usersWithRelationships.sort((a, b) => {
      if (a.hasRelationship && !b.hasRelationship) return -1;
      if (!a.hasRelationship && b.hasRelationship) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });

    streamLogger.debug("User search completed", {
      term: validatedTerm,
      resultCount: usersWithRelationships.length,
    });

    return usersWithRelationships;
  } catch (error) {
    streamLogger.error("User search failed", error, {
      searchTerm: validatedTerm,
    });
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
    // Get profile IDs for both users in parallel
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

    // Check for relationships in parallel
    const relationshipChecks = await Promise.all([
      checkConsultationRelationship(user1, user2),
      checkSubscriptionRelationship(user1, user2),
      checkSharedAppointments(userId1, userId2),
    ]);

    return relationshipChecks.some(Boolean);
  } catch (error) {
    streamLogger.error("Relationship check failed", error, {
      userId1,
      userId2,
    });
    return false; // Default to no relationship on error
  }
};

/**
 * Check consultation relationships between two users
 */
async function checkConsultationRelationship(
  user1: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
  user2: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<boolean> {
  if (!user1.consultantProfileId && !user1.consulteeProfileId) return false;
  if (!user2.consultantProfileId && !user2.consulteeProfileId) return false;

  const checks: Promise<boolean>[] = [];

  // Check if user1 (consultant) has consultations with user2 (consultee)
  if (user1.consultantProfileId && user2.consulteeProfileId) {
    checks.push(
      prisma.consultation
        .findFirst({
          where: {
            consultationPlan: {
              consultantProfileId: user1.consultantProfileId,
            },
            requestedById: user2.consulteeProfileId,
            requestStatus: { in: ["APPROVED", "SCHEDULED"] },
          },
          select: { id: true },
        })
        .then((r) => !!r),
    );
  }

  // Check reverse relationship
  if (user2.consultantProfileId && user1.consulteeProfileId) {
    checks.push(
      prisma.consultation
        .findFirst({
          where: {
            consultationPlan: {
              consultantProfileId: user2.consultantProfileId,
            },
            requestedById: user1.consulteeProfileId,
            requestStatus: { in: ["APPROVED", "SCHEDULED"] },
          },
          select: { id: true },
        })
        .then((r) => !!r),
    );
  }

  if (checks.length === 0) return false;

  const results = await Promise.all(checks);
  return results.some(Boolean);
}

/**
 * Check subscription relationships between two users
 */
async function checkSubscriptionRelationship(
  user1: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
  user2: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<boolean> {
  if (!user1.consultantProfileId && !user1.consulteeProfileId) return false;
  if (!user2.consultantProfileId && !user2.consulteeProfileId) return false;

  const checks: Promise<boolean>[] = [];

  if (user1.consultantProfileId && user2.consulteeProfileId) {
    checks.push(
      prisma.subscription
        .findFirst({
          where: {
            subscriptionPlan: {
              consultantProfileId: user1.consultantProfileId,
            },
            requestedById: user2.consulteeProfileId,
            requestStatus: { in: ["APPROVED", "SCHEDULED"] },
            schedulingPeriodEndsAt: { gte: new Date() },
          },
          select: { id: true },
        })
        .then((r) => !!r),
    );
  }

  if (user2.consultantProfileId && user1.consulteeProfileId) {
    checks.push(
      prisma.subscription
        .findFirst({
          where: {
            subscriptionPlan: {
              consultantProfileId: user2.consultantProfileId,
            },
            requestedById: user1.consulteeProfileId,
            requestStatus: { in: ["APPROVED", "SCHEDULED"] },
            schedulingPeriodEndsAt: { gte: new Date() },
          },
          select: { id: true },
        })
        .then((r) => !!r),
    );
  }

  if (checks.length === 0) return false;

  const results = await Promise.all(checks);
  return results.some(Boolean);
}

/**
 * Check if users share any appointments (webinars, classes)
 */
async function checkSharedAppointments(
  userId1: string,
  userId2: string,
): Promise<boolean> {
  const sharedSlot = await prisma.slotOfAppointment.findFirst({
    where: {
      user: { some: { id: userId1 } },
      AND: { user: { some: { id: userId2 } } },
    },
    select: { id: true },
  });

  return !!sharedSlot;
}

/**
 * Legacy search function for backward compatibility
 * @param searchTerm The term to search for (name or email)
 * @returns The users that match the search term
 */
export const searchUsers = async (searchTerm: string) => {
  const validatedTerm = searchTermSchema.parse(searchTerm.trim());

  try {
    const users = await prisma.user.findMany({
      where: {
        AND: [
          {
            NOT: [
              { id: { startsWith: "recording-egress-" } },
              { id: { startsWith: "system-" } },
            ],
          },
          {
            OR: [
              { name: { contains: validatedTerm, mode: "insensitive" } },
              { email: { contains: validatedTerm, mode: "insensitive" } },
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

    streamLogger.debug("Legacy user search completed", {
      term: validatedTerm,
      resultCount: users.length,
    });

    return users;
  } catch (error) {
    streamLogger.error("Legacy user search failed", error, {
      searchTerm: validatedTerm,
    });
    throw error;
  }
};
