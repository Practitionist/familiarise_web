# Caching with Upstash Redis - Implementation Guide

> **Priority:** 🟠 HIGH
> **Effort:** 4-6 hours
> **Dependencies:** None

## Executive Summary

Upstash Redis provides serverless Redis for caching, reducing database load and improving response times. This replaces repetitive database queries with cached data.

---

## Table of Contents

1. [Why Upstash Redis](#1-why-upstash-redis)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Caching Patterns](#4-caching-patterns)
5. [Cache Keys Strategy](#5-cache-keys-strategy)
6. [Implementation](#6-implementation)
7. [Cache Invalidation](#7-cache-invalidation)
8. [Monitoring](#8-monitoring)

---

## 1. Why Upstash Redis

### Problems It Solves

| Current Issue | Redis Solution |
|---------------|----------------|
| Session callback queries DB every request | Cache user data |
| Consultant profiles fetched repeatedly | Cache for 30 minutes |
| Domain/subdomain lists fetched every load | Cache for 24 hours |
| Availability calculated repeatedly | Cache for 5 minutes |
| N+1 queries on list pages | Cache aggregated data |

### Performance Impact

```
Without Cache:
├── API Response Time: 200-500ms
├── Database Queries: 10-100 per request
└── Database Load: High

With Cache:
├── API Response Time: 20-50ms
├── Database Queries: 1-2 per request (cache miss only)
└── Database Load: Low
```

### Upstash Benefits

- **Serverless:** No infrastructure to manage
- **Global:** Edge locations for low latency
- **Pay-as-you-go:** No minimum costs
- **REST API:** Works in serverless/edge environments
- **Durable:** Data persisted across restarts

---

## 2. Installation

### Step 1: Install Package

```bash
npm install @upstash/redis
```

### Step 2: Create Redis Database

1. Go to [console.upstash.com](https://console.upstash.com)
2. Create new Redis database
3. Select region closest to your users
4. Copy REST URL and Token

### Step 3: Environment Variables

```env
# .env.local
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx
```

---

## 3. Configuration

### Redis Client

```typescript
// lib/redis.ts
import { Redis } from "@upstash/redis";

// Create Redis client
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Helper for type-safe operations
export async function getFromCache<T>(key: string): Promise<T | null> {
  const data = await redis.get(key);
  return data as T | null;
}

export async function setInCache<T>(
  key: string,
  data: T,
  ttlSeconds: number
): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(data));
}

export async function deleteFromCache(key: string): Promise<void> {
  await redis.del(key);
}

export async function deleteByPattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
```

### Cache Configuration

```typescript
// lib/cache/config.ts
export const CACHE_CONFIG = {
  // TTL in seconds
  TTL: {
    USER_PROFILE: 3600,         // 1 hour
    CONSULTANT_PROFILE: 1800,   // 30 minutes
    CONSULTEE_PROFILE: 1800,    // 30 minutes
    AVAILABILITY: 300,          // 5 minutes
    PLAN_DETAILS: 3600,         // 1 hour
    DOMAIN_LIST: 86400,         // 24 hours
    SUBDOMAIN_LIST: 86400,      // 24 hours
    TAG_LIST: 86400,            // 24 hours
    SESSION_DATA: 3600,         // 1 hour
    SEARCH_RESULTS: 300,        // 5 minutes
  },

  // Key prefixes
  PREFIX: {
    USER: "user",
    CONSULTANT: "consultant",
    CONSULTEE: "consultee",
    AVAILABILITY: "availability",
    PLAN: "plan",
    DOMAIN: "domain",
    SESSION: "session",
    SEARCH: "search",
  },
};

// Key generators
export const CACHE_KEYS = {
  // User keys
  userProfile: (userId: string) =>
    `${CACHE_CONFIG.PREFIX.USER}:${userId}:profile`,
  userSession: (userId: string) =>
    `${CACHE_CONFIG.PREFIX.SESSION}:${userId}`,

  // Consultant keys
  consultantProfile: (consultantId: string) =>
    `${CACHE_CONFIG.PREFIX.CONSULTANT}:${consultantId}:profile`,
  consultantPlans: (consultantId: string) =>
    `${CACHE_CONFIG.PREFIX.CONSULTANT}:${consultantId}:plans`,
  consultantAvailability: (consultantId: string, date: string) =>
    `${CACHE_CONFIG.PREFIX.AVAILABILITY}:${consultantId}:${date}`,

  // Consultee keys
  consulteeProfile: (consulteeId: string) =>
    `${CACHE_CONFIG.PREFIX.CONSULTEE}:${consulteeId}:profile`,

  // Plan keys
  planDetails: (planId: string) =>
    `${CACHE_CONFIG.PREFIX.PLAN}:${planId}:details`,

  // Domain keys
  domainList: () => `${CACHE_CONFIG.PREFIX.DOMAIN}:list`,
  subdomainList: (domainId: string) =>
    `${CACHE_CONFIG.PREFIX.DOMAIN}:${domainId}:subdomains`,
  tagList: (domainId: string) =>
    `${CACHE_CONFIG.PREFIX.DOMAIN}:${domainId}:tags`,

  // Search keys
  consultantSearch: (query: string, filters: string) =>
    `${CACHE_CONFIG.PREFIX.SEARCH}:consultants:${hashString(query + filters)}`,
};

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}
```

---

## 4. Caching Patterns

### Pattern 1: Cache-Aside (Lazy Loading)

```typescript
// lib/cache/patterns.ts
import { redis } from "@/lib/redis";
import { CACHE_CONFIG, CACHE_KEYS } from "./config";

export async function withCache<T>(
  key: string,
  ttl: number,
  fetchFn: () => Promise<T>
): Promise<T> {
  // Try to get from cache
  const cached = await redis.get<T>(key);

  if (cached !== null) {
    return cached;
  }

  // Fetch from source
  const data = await fetchFn();

  // Store in cache (don't await to not block response)
  redis.setex(key, ttl, JSON.stringify(data)).catch(console.error);

  return data;
}

// Usage
const profile = await withCache(
  CACHE_KEYS.consultantProfile(consultantId),
  CACHE_CONFIG.TTL.CONSULTANT_PROFILE,
  () => prisma.consultantProfile.findUnique({ where: { id: consultantId } })
);
```

### Pattern 2: Write-Through

```typescript
// Update cache when data changes
export async function updateConsultantProfile(
  consultantId: string,
  data: UpdateData
) {
  // Update database
  const updated = await prisma.consultantProfile.update({
    where: { id: consultantId },
    data,
  });

  // Update cache
  await redis.setex(
    CACHE_KEYS.consultantProfile(consultantId),
    CACHE_CONFIG.TTL.CONSULTANT_PROFILE,
    JSON.stringify(updated)
  );

  return updated;
}
```

### Pattern 3: Cache Invalidation on Write

```typescript
// Invalidate cache when data changes
export async function invalidateConsultantCache(consultantId: string) {
  await Promise.all([
    redis.del(CACHE_KEYS.consultantProfile(consultantId)),
    redis.del(CACHE_KEYS.consultantPlans(consultantId)),
    deleteByPattern(`${CACHE_CONFIG.PREFIX.AVAILABILITY}:${consultantId}:*`),
  ]);
}

export async function updateConsultantProfile(
  consultantId: string,
  data: UpdateData
) {
  const updated = await prisma.consultantProfile.update({
    where: { id: consultantId },
    data,
  });

  // Invalidate cache
  await invalidateConsultantCache(consultantId);

  return updated;
}
```

### Pattern 4: Stale-While-Revalidate

```typescript
export async function withSWR<T>(
  key: string,
  ttl: number,
  staleTime: number, // How long stale data is acceptable
  fetchFn: () => Promise<T>
): Promise<T> {
  const cacheKey = key;
  const timestampKey = `${key}:ts`;

  // Try to get from cache
  const [cached, timestamp] = await Promise.all([
    redis.get<T>(cacheKey),
    redis.get<number>(timestampKey),
  ]);

  const now = Date.now();
  const isStale = timestamp && now - timestamp > staleTime * 1000;

  // Return cached data if available
  if (cached !== null) {
    // If stale, revalidate in background
    if (isStale) {
      fetchFn().then(async (data) => {
        await Promise.all([
          redis.setex(cacheKey, ttl, JSON.stringify(data)),
          redis.setex(timestampKey, ttl, now),
        ]);
      }).catch(console.error);
    }
    return cached;
  }

  // No cache, fetch and store
  const data = await fetchFn();
  await Promise.all([
    redis.setex(cacheKey, ttl, JSON.stringify(data)),
    redis.setex(timestampKey, ttl, now),
  ]);

  return data;
}
```

---

## 5. Cache Keys Strategy

### Key Naming Convention

```
{prefix}:{entity_id}:{data_type}:{variant}

Examples:
- user:123:profile
- consultant:456:profile
- consultant:456:plans
- availability:456:2024-01-15
- domain:list
- domain:789:subdomains
- session:123
- search:consultants:abc123
```

### Key Groups

```typescript
// All keys for a user
const userKeys = [
  CACHE_KEYS.userProfile(userId),
  CACHE_KEYS.userSession(userId),
];

// All keys for a consultant
const consultantKeys = (id: string) => [
  CACHE_KEYS.consultantProfile(id),
  CACHE_KEYS.consultantPlans(id),
  // Plus pattern for availability
];

// Static data keys
const staticKeys = [
  CACHE_KEYS.domainList(),
  // Subdomain and tag keys per domain
];
```

---

## 6. Implementation

### Cached Data Services

```typescript
// lib/services/cached-consultant.ts
import { withCache, invalidateConsultantCache } from "@/lib/cache";
import { CACHE_CONFIG, CACHE_KEYS } from "@/lib/cache/config";
import prisma from "@/lib/prisma";

export async function getConsultantProfile(consultantId: string) {
  return withCache(
    CACHE_KEYS.consultantProfile(consultantId),
    CACHE_CONFIG.TTL.CONSULTANT_PROFILE,
    async () => {
      return prisma.consultantProfile.findUnique({
        where: { id: consultantId },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
          domain: true,
          subDomains: true,
          tags: true,
        },
      });
    }
  );
}

export async function getConsultantPlans(consultantId: string) {
  return withCache(
    CACHE_KEYS.consultantPlans(consultantId),
    CACHE_CONFIG.TTL.PLAN_DETAILS,
    async () => {
      const [consultations, subscriptions, webinars, classes] = await Promise.all([
        prisma.consultationPlan.findMany({
          where: { consultantProfileId: consultantId, isActive: true },
        }),
        prisma.subscriptionPlan.findMany({
          where: { consultantProfileId: consultantId, isActive: true },
        }),
        prisma.webinarPlan.findMany({
          where: { consultantProfileId: consultantId, isActive: true },
        }),
        prisma.classPlan.findMany({
          where: { consultantProfileId: consultantId, isActive: true },
        }),
      ]);

      return { consultations, subscriptions, webinars, classes };
    }
  );
}

export async function getConsultantAvailability(
  consultantId: string,
  date: string
) {
  return withCache(
    CACHE_KEYS.consultantAvailability(consultantId, date),
    CACHE_CONFIG.TTL.AVAILABILITY,
    async () => {
      return prisma.weeklyAvailabilitySlot.findMany({
        where: { consultantProfileId: consultantId },
        select: {
          dayOfWeek: true,
          startTime: true,
          endTime: true,
        },
      });
    }
  );
}
```

### Cached Domain Data

```typescript
// lib/services/cached-domains.ts
import { withCache } from "@/lib/cache";
import { CACHE_CONFIG, CACHE_KEYS } from "@/lib/cache/config";
import prisma from "@/lib/prisma";

export async function getDomainList() {
  return withCache(
    CACHE_KEYS.domainList(),
    CACHE_CONFIG.TTL.DOMAIN_LIST,
    async () => {
      return prisma.domain.findMany({
        orderBy: { name: "asc" },
      });
    }
  );
}

export async function getSubdomains(domainId: string) {
  return withCache(
    CACHE_KEYS.subdomainList(domainId),
    CACHE_CONFIG.TTL.SUBDOMAIN_LIST,
    async () => {
      return prisma.subDomain.findMany({
        where: { domainId },
        orderBy: { name: "asc" },
      });
    }
  );
}

export async function getTags(domainId: string) {
  return withCache(
    CACHE_KEYS.tagList(domainId),
    CACHE_CONFIG.TTL.TAG_LIST,
    async () => {
      return prisma.tag.findMany({
        where: { domainId },
        orderBy: { name: "asc" },
      });
    }
  );
}
```

### Session Data Caching

```typescript
// lib/services/cached-session.ts
import { redis } from "@/lib/redis";
import { CACHE_CONFIG, CACHE_KEYS } from "@/lib/cache/config";
import prisma from "@/lib/prisma";

// Cache additional session data
export async function getSessionData(userId: string) {
  const cacheKey = CACHE_KEYS.userSession(userId);

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return cached as SessionData;
  }

  // Fetch from database
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      phone: true,
      address: true,
      timezone: true,
      consultantProfile: {
        select: { id: true },
      },
      consulteeProfile: {
        select: { id: true },
      },
    },
  });

  if (user) {
    // Cache for 1 hour
    await redis.setex(
      cacheKey,
      CACHE_CONFIG.TTL.SESSION_DATA,
      JSON.stringify(user)
    );
  }

  return user;
}

// Invalidate on profile update
export async function invalidateSessionData(userId: string) {
  await redis.del(CACHE_KEYS.userSession(userId));
}
```

---

## 7. Cache Invalidation

### Invalidation Events

```typescript
// lib/cache/invalidation.ts
import { redis, deleteByPattern } from "@/lib/redis";
import { CACHE_KEYS } from "./config";

// Event-based invalidation handlers
export const INVALIDATION_HANDLERS = {
  // When user profile is updated
  "user.updated": async (userId: string) => {
    await Promise.all([
      redis.del(CACHE_KEYS.userProfile(userId)),
      redis.del(CACHE_KEYS.userSession(userId)),
    ]);
  },

  // When consultant profile is updated
  "consultant.updated": async (consultantId: string) => {
    await Promise.all([
      redis.del(CACHE_KEYS.consultantProfile(consultantId)),
      redis.del(CACHE_KEYS.consultantPlans(consultantId)),
    ]);
  },

  // When availability is changed
  "availability.updated": async (consultantId: string) => {
    await deleteByPattern(`availability:${consultantId}:*`);
  },

  // When a plan is updated
  "plan.updated": async (consultantId: string, planId: string) => {
    await Promise.all([
      redis.del(CACHE_KEYS.consultantPlans(consultantId)),
      redis.del(CACHE_KEYS.planDetails(planId)),
    ]);
  },

  // When domain data is updated (rare)
  "domain.updated": async (domainId?: string) => {
    if (domainId) {
      await Promise.all([
        redis.del(CACHE_KEYS.subdomainList(domainId)),
        redis.del(CACHE_KEYS.tagList(domainId)),
      ]);
    }
    await redis.del(CACHE_KEYS.domainList());
  },

  // When appointment is booked (affects availability display)
  "appointment.created": async (consultantId: string, date: string) => {
    await redis.del(CACHE_KEYS.consultantAvailability(consultantId, date));
  },
};

// Usage in API routes
export async function invalidateCache(
  event: keyof typeof INVALIDATION_HANDLERS,
  ...args: Parameters<(typeof INVALIDATION_HANDLERS)[typeof event]>
) {
  const handler = INVALIDATION_HANDLERS[event];
  if (handler) {
    await handler(...args);
  }
}
```

### Invalidation in API Routes

```typescript
// app/api/user/consultants/[id]/route.ts
import { invalidateCache } from "@/lib/cache/invalidation";

export async function PUT(req: NextRequest, { params }) {
  const { id } = await params;
  const body = await req.json();

  // Update database
  const updated = await prisma.consultantProfile.update({
    where: { id },
    data: body,
  });

  // Invalidate cache
  await invalidateCache("consultant.updated", id);

  return NextResponse.json(updated);
}
```

### Scheduled Cache Cleanup

```typescript
// lib/inngest/functions/cache-cleanup.ts
import { inngest } from "../client";
import { redis } from "@/lib/redis";

export const cleanupExpiredCache = inngest.createFunction(
  {
    id: "cleanup-expired-cache",
    name: "Cleanup Expired Cache",
  },
  { cron: "0 * * * *" }, // Every hour
  async ({ step }) => {
    // Redis handles TTL expiration automatically
    // This is for manual cleanup of orphaned keys if needed

    // Get cache stats
    const info = await step.run("get-info", async () => {
      return redis.info("memory");
    });

    return { memoryInfo: info };
  }
);
```

---

## 8. Monitoring

### Cache Metrics

```typescript
// lib/cache/metrics.ts
import { redis } from "@/lib/redis";
import posthog from "posthog-node";

const ph = new posthog.PostHog(process.env.POSTHOG_PERSONAL_API_KEY!);

interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
}

// Track cache performance
let metrics: CacheMetrics = {
  hits: 0,
  misses: 0,
  hitRate: 0,
};

export function recordCacheHit() {
  metrics.hits++;
  updateHitRate();
}

export function recordCacheMiss() {
  metrics.misses++;
  updateHitRate();
}

function updateHitRate() {
  const total = metrics.hits + metrics.misses;
  metrics.hitRate = total > 0 ? metrics.hits / total : 0;
}

// Report metrics periodically
export async function reportMetrics() {
  ph.capture({
    distinctId: "system",
    event: "cache_metrics",
    properties: {
      ...metrics,
    },
  });

  // Reset counters
  metrics = { hits: 0, misses: 0, hitRate: 0 };
}

// Enhanced withCache with metrics
export async function withCacheMetrics<T>(
  key: string,
  ttl: number,
  fetchFn: () => Promise<T>
): Promise<T> {
  const cached = await redis.get<T>(key);

  if (cached !== null) {
    recordCacheHit();
    return cached;
  }

  recordCacheMiss();
  const data = await fetchFn();
  await redis.setex(key, ttl, JSON.stringify(data));

  return data;
}
```

### Upstash Dashboard

Upstash provides:
- Request count
- Data transfer
- Memory usage
- Command breakdown
- Latency metrics

### Health Check

```typescript
// app/api/health/cache/route.ts
import { redis } from "@/lib/redis";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Ping Redis
    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;

    // Get memory info
    const info = await redis.info("memory");

    return NextResponse.json({
      status: "healthy",
      latency: `${latency}ms`,
      memory: info,
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
```

---

## Quick Reference

### Common Commands

```typescript
// Set with TTL
await redis.setex("key", 3600, "value");

// Get
const value = await redis.get("key");

// Delete
await redis.del("key");

// Delete multiple
await redis.del("key1", "key2", "key3");

// Check existence
const exists = await redis.exists("key");

// Get keys by pattern
const keys = await redis.keys("prefix:*");

// Increment
await redis.incr("counter");

// Hash operations
await redis.hset("hash", "field", "value");
await redis.hget("hash", "field");
await redis.hgetall("hash");

// List operations
await redis.lpush("list", "value");
await redis.lrange("list", 0, -1);

// Set operations
await redis.sadd("set", "member");
await redis.smembers("set");
```

### Environment Variables

```env
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx
```

### Verification Checklist

- [ ] Upstash Redis database created
- [ ] Environment variables set
- [ ] Redis client configured
- [ ] Cache keys strategy defined
- [ ] Consultant profile caching implemented
- [ ] Domain data caching implemented
- [ ] Session data caching implemented
- [ ] Cache invalidation implemented
- [ ] Metrics tracking added
- [ ] Health check endpoint created
