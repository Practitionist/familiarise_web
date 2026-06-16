/**
 * Centralized Stream Client Manager
 * Provides singleton instances for StreamChat and handles connection management
 */

import { StreamChat } from "stream-chat";
import { StreamClient } from "@stream-io/node-sdk";
import { withCircuitBreaker } from "@/lib/redis";

// Environment validation
const STREAM_API_KEY = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const STREAM_API_SECRET = process.env.STREAM_API_SECRET;

// Singleton instances
let chatClientInstance: StreamChat | null = null;
let videoClientInstance: StreamClient | null = null;

// Connection state tracking
let isInitialized = false;

/**
 * Validates that Stream API credentials are configured
 * @throws Error if credentials are missing
 */
export function validateStreamConfig(): void {
  if (!STREAM_API_KEY) {
    throw new Error(
      "NEXT_PUBLIC_STREAM_API_KEY is not configured. Please set it in your environment variables.",
    );
  }
  if (!STREAM_API_SECRET) {
    throw new Error(
      "STREAM_API_SECRET is not configured. Please set it in your environment variables.",
    );
  }
}

/**
 * Check if Stream is properly configured
 */
export function isStreamConfigured(): boolean {
  return !!(STREAM_API_KEY && STREAM_API_SECRET);
}

/**
 * Get the singleton StreamChat server client instance
 * This client is for server-side operations only (has secret)
 */
export function getStreamChatClient(): StreamChat {
  validateStreamConfig();

  if (!chatClientInstance) {
    chatClientInstance = StreamChat.getInstance(
      STREAM_API_KEY!,
      STREAM_API_SECRET!,
      {
        timeout: 30000, // 30 seconds timeout for operations
      },
    );
    isInitialized = true;
  }

  return chatClientInstance;
}

/**
 * Get the singleton Stream Video server client instance
 * This client is for server-side video operations only (has secret)
 */
export function getStreamVideoClient(): StreamClient {
  validateStreamConfig();

  if (!videoClientInstance) {
    videoClientInstance = new StreamClient(STREAM_API_KEY!, STREAM_API_SECRET!);
  }

  return videoClientInstance;
}

/**
 * Get the Stream API key (safe for client-side)
 */
export function getStreamApiKey(): string {
  if (!STREAM_API_KEY) {
    throw new Error("NEXT_PUBLIC_STREAM_API_KEY is not configured");
  }
  return STREAM_API_KEY;
}

/**
 * Generate a chat token for a user
 * @param userId The user ID to generate token for
 * @param expirationTime Optional expiration time in seconds (default: 1 hour)
 */
export function generateChatToken(
  userId: string,
  expirationTime?: number,
): string {
  const client = getStreamChatClient();

  if (expirationTime) {
    const exp = Math.floor(Date.now() / 1000) + expirationTime;
    return client.createToken(userId, exp);
  }

  return client.createToken(userId);
}

/**
 * Generate a video token for a user
 * @param userId The user ID to generate token for
 * @param expirationSeconds Token expiration in seconds (default: 3600 = 1 hour)
 */
export function generateVideoToken(
  userId: string,
  expirationSeconds: number = 3600,
): string {
  const client = getStreamVideoClient();

  const exp = Math.round(Date.now() / 1000) + expirationSeconds;
  const issued = Math.round(Date.now() / 1000) - 60; // 1 minute ago for clock skew

  return client.generateUserToken({
    user_id: userId,
    exp,
    iat: issued,
  });
}

/**
 * Check if the Stream client is initialized
 */
export function isClientInitialized(): boolean {
  return isInitialized;
}

/**
 * Reset client instances (useful for testing)
 */
export function resetClients(): void {
  chatClientInstance = null;
  videoClientInstance = null;
  isInitialized = false;
}

/**
 * Sentinel thrown by withStreamCircuitBreaker when the breaker is OPEN and the
 * caller did not supply a fallback. Lets hot paths distinguish "Stream is down,
 * we fast-failed" from a genuine Stream API error and degrade accordingly.
 */
export class StreamUnavailableError extends Error {
  constructor() {
    super("Stream circuit breaker is OPEN — Stream temporarily unavailable");
    this.name = "StreamUnavailableError";
  }
}

/**
 * #473 — wrap a hot-path Stream network call in the shared circuit breaker so a
 * Stream outage fast-fails (sub-ms) instead of every dashboard load eating the
 * full 30s client timeout and cascading.
 *
 * Closed-breaker behaviour is identical to calling `operation` directly: a real
 * Stream error rejects with the original error (we pass NO fallback to
 * withCircuitBreaker, so it rethrows). Only when the breaker is already OPEN
 * does withCircuitBreaker reject with its generic "circuit breaker is OPEN"
 * Error — we intercept that to run the caller's `fallback` (graceful
 * degradation) or throw the typed StreamUnavailableError so callers can branch.
 */
export async function withStreamCircuitBreaker<T>(
  operation: () => Promise<T>,
  fallback?: () => T,
): Promise<T> {
  try {
    return await withCircuitBreaker(operation);
  } catch (error) {
    // Distinguish "breaker is OPEN, we never tried" from a real Stream error.
    if (
      error instanceof Error &&
      error.message.includes("circuit breaker is OPEN")
    ) {
      if (fallback) return fallback();
      throw new StreamUnavailableError();
    }
    // Genuine Stream/operation error — preserve original behaviour, rethrow.
    throw error;
  }
}

// Type exports for external use
export type { StreamChat };
