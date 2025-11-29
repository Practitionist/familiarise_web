import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import crypto from "crypto";

// Validate environment variables
if (
  !process.env.UPSTASH_REDIS_REST_URL ||
  !process.env.UPSTASH_REDIS_REST_TOKEN
) {
  throw new Error(
    "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set",
  );
}

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Create rate limiter - 5 requests per 10 seconds
const ratelimit = new Ratelimit({
  redis: redis,
  limiter: Ratelimit.slidingWindow(5, "10 s"),
});

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Check if an identifier is within rate limits
 * @param identifier - The identifier to check (e.g., user ID, IP address)
 * @returns True if within limits, false if rate limited
 */
export async function checkRateLimit(identifier: string): Promise<boolean> {
  const result = await ratelimit.limit(identifier);
  return result.success;
}

// ============================================================================
// Simple Lock/Unlock (for rate limiting and simple use cases)
// ============================================================================

/**
 * Acquire a simple lock
 * @param key - The lock key
 * @param ttl - Time to live in milliseconds
 * @returns Lock token if acquired, null if already locked
 */
export async function acquireLock(
  key: string,
  ttl: number,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await redis.set(key, token, { nx: true, px: ttl });
  return result === "OK" ? token : null;
}

/**
 * Release a simple lock
 * @param key - The lock key
 * @param token - The lock token (for safe release)
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  const current = await redis.get(key);
  if (current === token) {
    await redis.del(key);
  }
}

export default redis;
