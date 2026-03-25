"use server";

import { z } from "zod";
import {
  generateVideoToken,
  generateChatToken,
  isStreamConfigured,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";

// Token expiry for both chat and video (1 hour)
const TOKEN_EXPIRATION_SECONDS = 3600;

// Input validation
const userIdSchema = z.string().min(1, "User ID is required");

/**
 * Generate a video call token for a user
 * Token is valid for 1 hour by default
 * @param userId The user ID to generate token for
 * @returns The video token string
 */
export async function tokenProvider(userId: string): Promise<string> {
  // Validate input
  const validatedUserId = userIdSchema.parse(userId);

  if (!isStreamConfigured()) {
    streamLogger.error("Stream not configured for video token generation");
    throw new Error("Stream API is not configured");
  }

  try {
    const token = generateVideoToken(validatedUserId, TOKEN_EXPIRATION_SECONDS);

    streamLogger.debug("Generated video token", { userId: validatedUserId });

    return token;
  } catch (error) {
    streamLogger.error("Failed to generate video token", error, {
      userId: validatedUserId,
    });
    throw error;
  }
}

/**
 * Generate a chat token for a user
 * Token is valid for 1 hour by default
 * @param userId The user ID to generate token for
 * @returns The chat token string
 */
export async function chatTokenProvider(userId: string): Promise<string> {
  // Validate input
  const validatedUserId = userIdSchema.parse(userId);

  if (!isStreamConfigured()) {
    streamLogger.error("Stream not configured for chat token generation");
    throw new Error("Stream API is not configured");
  }

  try {
    const token = generateChatToken(validatedUserId, TOKEN_EXPIRATION_SECONDS);

    streamLogger.debug("Generated chat token", { userId: validatedUserId });

    return token;
  } catch (error) {
    streamLogger.error("Failed to generate chat token", error, {
      userId: validatedUserId,
    });
    throw error;
  }
}
