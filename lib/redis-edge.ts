/**
 * Edge-compatible Upstash Redis client.
 *
 * Used exclusively by lib/rate-limit.ts which runs in Next.js Edge middleware.
 * Does NOT import Node.js `crypto` or MockRedis — both are incompatible with
 * the Edge runtime. @upstash/redis uses the REST API and is safe for Edge.
 *
 * For server-side Redis (distributed locking, circuit breaker, etc.) use lib/redis.ts.
 */

import { Redis } from "@upstash/redis";

const redisEdge = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export default redisEdge;
