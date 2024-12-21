import { Redis } from "ioredis";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis as UpstashRedis } from "@upstash/redis";

let redis: Redis | null = null;
let upstashRedis: UpstashRedis | null = null;
let ratelimit: Ratelimit | null = null;

// Initialize Redis client based on environment
if (
  process.env.UPSTASH_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_TOKEN
) {
  // Use Upstash Redis
  upstashRedis = new UpstashRedis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  // Create rate limiter - 5 requests per 10 seconds
  ratelimit = new Ratelimit({
    redis: upstashRedis,
    limiter: Ratelimit.slidingWindow(5, "10 s"),
  });
} else {
  // Use normal Redis
  redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
}

// Rate limiting function
export async function checkRateLimit(identifier: string): Promise<boolean> {
  if (ratelimit) {
    // Using Upstash rate limiter
    const result = await ratelimit.limit(identifier);
    return result.success;
  } else if (redis) {
    // Simple rate limiting with normal Redis
    const key = `ratelimit:${identifier}`;
    const limit = 5; // requests
    const window = 10; // seconds

    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, window);
    }

    return current <= limit;
  }
  return true; // No rate limiting if Redis is not configured
}

// Distributed locking
export async function acquireLock(
  lockKey: string,
  ttl: number = 30000,
): Promise<boolean> {
  if (upstashRedis) {
    // Using Upstash Redis
    return (
      (await upstashRedis.set(lockKey, "locked", {
        nx: true,
        px: ttl,
      })) === "OK"
    );
  } else if (redis) {
    // Using normal Redis
    return (await redis.set(lockKey, "locked", "PX", ttl, "NX")) === "OK";
  }
  return true; // No locking if Redis is not configured
}

export async function releaseLock(lockKey: string): Promise<void> {
  if (upstashRedis) {
    await upstashRedis.del(lockKey);
  } else if (redis) {
    await redis.del(lockKey);
  }
}

export default redis || upstashRedis;
