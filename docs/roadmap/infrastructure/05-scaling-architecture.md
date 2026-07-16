# Scaling Architecture - Production Readiness

> **Severity Level:** MEDIUM-HIGH
> **Last Updated:** 2024
> **Status:** Preparation for Scale

## Executive Summary

This document outlines architectural improvements needed to scale the application from current state to handling millions of users. It covers caching strategies, background job processing, session optimization, real-time features scaling, and infrastructure considerations.

---

## Table of Contents

1. [Current Architecture](#1-current-architecture)
2. [Scaling Bottlenecks](#2-scaling-bottlenecks)
3. [Caching Strategy](#3-caching-strategy)
4. [Background Job Processing](#4-background-job-processing)
5. [Session Optimization](#5-session-optimization)
6. [Real-Time Features](#6-real-time-features)
7. [Infrastructure Scaling](#7-infrastructure-scaling)
8. [Monitoring & Observability](#8-monitoring--observability)

---

## 1. Current Architecture

### 1.1 Technology Stack

```
┌─────────────────────────────────────────────────────────────┐
│                         CLIENT                               │
│  React 18 + Next.js 15 + TanStack Query + Redux Toolkit     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      EDGE / CDN                              │
│            Vercel Edge Network / Cloudflare                  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                         │
│  Next.js API Routes + Server Actions + Middleware           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │ NextAuth│  │ Prisma  │  │ Stream  │  │ Payment │       │
│  │   JWT   │  │   ORM   │  │   SDK   │  │ Gateways│       │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                       DATA LAYER                             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐   │
│  │  PostgreSQL   │  │ Upstash Redis │  │   Supabase    │   │
│  │  (Supabase)   │  │ (Rate Limit)  │  │   (Storage)   │   │
│  └───────────────┘  └───────────────┘  └───────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    EXTERNAL SERVICES                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │ Stream  │  │ Stripe  │  │Razorpay │  │  Email  │       │
│  │ (Chat)  │  │(Payment)│  │(Payment)│  │ Service │       │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Current Strengths

| Aspect           | Implementation   | Status                 |
| ---------------- | ---------------- | ---------------------- |
| Serverless       | Vercel Functions | ✅ Auto-scaling        |
| Database Pooling | Supavisor        | ✅ Connection pooling  |
| CDN              | Vercel Edge      | ✅ Global distribution |
| Client Caching   | TanStack Query   | ✅ 1-5 min stale times |
| Authentication   | JWT-based        | ✅ Stateless           |

### 1.3 Current Weaknesses

| Aspect             | Issue                  | Impact                      |
| ------------------ | ---------------------- | --------------------------- |
| Session Callback   | DB query per request   | Linear DB load growth       |
| Server Caching     | None implemented       | Repeated expensive queries  |
| Background Jobs    | Manual/cron only       | Blocking request processing |
| Token Cache        | In-memory (1000 limit) | Not distributed             |
| Webhook Processing | Synchronous            | Timeout risk                |

---

## 2. Scaling Bottlenecks

### 2.1 Bottleneck Analysis

```
                    Current Load
                         ↓
┌─────────────────────────────────────────────────────────────┐
│                    REQUEST FLOW                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Middleware Token Check ─────────────────────→ BOTTLENECK│
│     └─ In-memory cache, 1000 entry limit                    │
│     └─ Not distributed across instances                      │
│                                                              │
│  2. Session Callback ───────────────────────────→ BOTTLENECK│
│     └─ prisma.user.findUnique() on EVERY request            │
│     └─ Includes phone, address, timezone                     │
│                                                              │
│  3. API Route Processing                                     │
│     └─ N+1 queries (100+ queries per request)  ─→ BOTTLENECK│
│     └─ No server-side caching                                │
│                                                              │
│  4. Webhook Processing ─────────────────────────→ BOTTLENECK│
│     └─ Synchronous (blocks response)                         │
│     └─ Database transactions in webhook                      │
│                                                              │
│  5. Real-time Sync                                           │
│     └─ Stream reconnection on page load                      │
│     └─ Channel sync on connection                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Scaling Projections

| Users | Current Performance | With Optimizations       |
| ----- | ------------------- | ------------------------ |
| 1K    | Good (~100ms)       | Excellent (~30ms)        |
| 10K   | Degraded (~300ms)   | Good (~50ms)             |
| 100K  | Poor (~1s+)         | Good (~100ms)            |
| 1M    | Unusable            | Acceptable (~200ms)      |
| 10M   | Failed              | Needs horizontal scaling |

---

## 3. Caching Strategy

### 3.1 Multi-Layer Caching

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: CDN Cache (Vercel/Cloudflare)                       │
│ - Static assets                                              │
│ - Public API responses (with cache headers)                  │
│ - TTL: Minutes to hours                                      │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Application Cache (Redis)                           │
│ - User profiles                                              │
│ - Consultant availability                                    │
│ - Plan details                                               │
│ - TTL: 5-60 minutes                                          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Client Cache (TanStack Query)                       │
│ - API responses                                              │
│ - User state                                                 │
│ - TTL: 1-5 minutes (staleTime)                               │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Redis Cache Implementation

```typescript
// lib/cache.ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// Cache key patterns
export const CACHE_KEYS = {
  USER_PROFILE: (id: string) => `user:${id}:profile`,
  CONSULTANT_PROFILE: (id: string) => `consultant:${id}:profile`,
  CONSULTANT_AVAILABILITY: (id: string, date: string) =>
    `consultant:${id}:availability:${date}`,
  PLAN_DETAILS: (id: string) => `plan:${id}:details`,
  DOMAIN_LIST: () => `domains:list`,
  SUBDOMAIN_LIST: (domainId: string) => `domains:${domainId}:subdomains`,
};

// Cache TTLs (seconds)
export const CACHE_TTL = {
  USER_PROFILE: 3600, // 1 hour
  CONSULTANT_PROFILE: 1800, // 30 min
  AVAILABILITY: 300, // 5 min
  PLAN_DETAILS: 3600, // 1 hour
  DOMAIN_LIST: 86400, // 24 hours
};

// Generic cache wrapper
export async function withCache<T>(
  key: string,
  ttl: number,
  fn: () => Promise<T>,
): Promise<T> {
  // Try to get from cache
  const cached = await redis.get<T>(key);
  if (cached !== null) {
    return cached;
  }

  // Execute function and cache result
  const result = await fn();
  await redis.setex(key, ttl, JSON.stringify(result));
  return result;
}

// Cache invalidation
export async function invalidateCache(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// Example: Invalidate user profile on update
export async function invalidateUserCache(userId: string): Promise<void> {
  await invalidateCache(`user:${userId}:*`);
}
```

### 3.3 Cached Data Access

```typescript
// lib/data/consultants.ts
import { withCache, CACHE_KEYS, CACHE_TTL } from "@/lib/cache";
import prisma from "@/lib/prisma";

export async function getConsultantProfile(id: string) {
  return withCache(
    CACHE_KEYS.CONSULTANT_PROFILE(id),
    CACHE_TTL.CONSULTANT_PROFILE,
    async () => {
      return prisma.consultantProfile.findUnique({
        where: { id },
        select: {
          id: true,
          bio: true,
          experience: true,
          qualifications: true,
          user: {
            select: {
              id: true,
              name: true,
              image: true,
            },
          },
          domain: {
            select: { id: true, name: true },
          },
        },
      });
    },
  );
}

export async function getConsultantAvailability(id: string, date: string) {
  return withCache(
    CACHE_KEYS.CONSULTANT_AVAILABILITY(id, date),
    CACHE_TTL.AVAILABILITY,
    async () => {
      return prisma.weeklyAvailabilitySlot.findMany({
        where: { consultantProfileId: id },
        select: {
          dayOfWeek: true,
          startTime: true,
          endTime: true,
        },
      });
    },
  );
}
```

### 3.4 Cache Invalidation Strategy

```typescript
// lib/cache/invalidation.ts
import { invalidateCache, CACHE_KEYS } from "@/lib/cache";

// Event-based invalidation
export const CACHE_INVALIDATION_MAP = {
  // When user updates profile
  "user.updated": async (userId: string) => {
    await invalidateCache(`user:${userId}:*`);
  },

  // When consultant updates profile
  "consultant.updated": async (consultantId: string) => {
    await invalidateCache(`consultant:${consultantId}:*`);
  },

  // When availability changes
  "availability.updated": async (consultantId: string) => {
    await invalidateCache(`consultant:${consultantId}:availability:*`);
  },

  // When appointment is booked
  "appointment.created": async (consultantId: string, date: string) => {
    await invalidateCache(
      CACHE_KEYS.CONSULTANT_AVAILABILITY(consultantId, date),
    );
  },

  // When plan is updated
  "plan.updated": async (planId: string) => {
    await invalidateCache(`plan:${planId}:*`);
  },
};

// Usage in API routes
export async function updateConsultantProfile(id: string, data: UpdateData) {
  const updated = await prisma.consultantProfile.update({
    where: { id },
    data,
  });

  // Invalidate cache
  await CACHE_INVALIDATION_MAP["consultant.updated"](id);

  return updated;
}
```

---

## 4. Background Job Processing

### 4.1 Job Queue Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      JOB PRODUCERS                           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │ Webhook │  │  API    │  │  Cron   │  │ Events  │       │
│  │ Handler │  │ Routes  │  │  Jobs   │  │         │       │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘       │
│       └────────────┴────────────┴────────────┘             │
│                           ↓                                  │
│                    ┌────────────┐                            │
│                    │  Inngest   │                            │
│                    │   Queue    │                            │
│                    └─────┬──────┘                            │
│                          ↓                                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │ Payment │  │  Email  │  │ Cleanup │  │  Sync   │       │
│  │ Process │  │ Sender  │  │   Jobs  │  │  Jobs   │       │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Inngest Implementation

```typescript
// lib/inngest/client.ts
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "familiarise",
  schemas: new EventSchemas().fromRecord<Events>(),
});

// Define event types
type Events = {
  "payment/webhook.received": {
    data: {
      gateway: "stripe" | "razorpay";
      eventId: string;
      eventType: string;
      payload: unknown;
    };
  };
  "email/send": {
    data: {
      to: string;
      template: string;
      variables: Record<string, unknown>;
    };
  };
  "appointment/created": {
    data: {
      appointmentId: string;
      consultantId: string;
      consulteeId: string;
    };
  };
  "cleanup/abandoned-payments": {
    data: {};
  };
  "stream/sync-channels": {
    data: {
      userId: string;
    };
  };
};
```

### 4.3 Job Functions

```typescript
// lib/inngest/functions/payment.ts
import { inngest } from "../client";
import { handlePaymentSuccess, handlePaymentFailure } from "@/lib/payments";

export const processPaymentWebhook = inngest.createFunction(
  {
    id: "process-payment-webhook",
    retries: 3,
    concurrency: 10,
  },
  { event: "payment/webhook.received" },
  async ({ event, step }) => {
    const { gateway, eventId, eventType, payload } = event.data;

    // Step 1: Check if already processed
    const exists = await step.run("check-duplicate", async () => {
      return prisma.webhookLog.findUnique({
        where: { eventId_gateway: { eventId, gateway } },
      });
    });

    if (exists) {
      return { status: "already_processed" };
    }

    // Step 2: Log the webhook
    await step.run("log-webhook", async () => {
      return prisma.webhookLog.create({
        data: { eventId, gateway, eventType, payload },
      });
    });

    // Step 3: Process based on event type
    if (eventType === "payment_intent.succeeded") {
      await step.run("process-success", async () => {
        return handlePaymentSuccess(payload);
      });

      // Step 4: Send confirmation email
      await step.sendEvent("send-confirmation", {
        name: "email/send",
        data: {
          to: payload.receipt_email,
          template: "payment-confirmation",
          variables: { amount: payload.amount },
        },
      });
    }

    return { status: "processed" };
  },
);

// Email sending function
export const sendEmail = inngest.createFunction(
  {
    id: "send-email",
    retries: 3,
    rateLimit: {
      limit: 100,
      period: "1m",
    },
  },
  { event: "email/send" },
  async ({ event }) => {
    const { to, template, variables } = event.data;
    // Send email logic
  },
);

// Cleanup function (scheduled)
export const cleanupAbandonedPayments = inngest.createFunction(
  {
    id: "cleanup-abandoned-payments",
  },
  { cron: "*/15 * * * *" }, // Every 15 minutes
  async ({ step }) => {
    const abandoned = await step.run("find-abandoned", async () => {
      return prisma.payment.findMany({
        where: {
          paymentStatus: "PENDING",
          expiresAt: { lt: new Date() },
        },
        take: 100,
      });
    });

    for (const payment of abandoned) {
      await step.run(`cleanup-${payment.id}`, async () => {
        await cleanupPayment(payment.id);
      });
    }

    return { processed: abandoned.length };
  },
);
```

### 4.4 Webhook Handler (Updated)

```typescript
// app/api/webhooks/stripe/route.ts
import { inngest } from "@/lib/inngest/client";

export async function POST(req: NextRequest) {
  // Verify signature
  const { isValid, body } = await verifyWebhookSignature(req, secret, "stripe");
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const event = JSON.parse(body);

  // Queue for background processing
  await inngest.send({
    name: "payment/webhook.received",
    data: {
      gateway: "stripe",
      eventId: event.id,
      eventType: event.type,
      payload: event.data.object,
    },
  });

  // Return immediately
  return NextResponse.json({ received: true });
}
```

---

## 5. Session Optimization

### 5.1 Current Session Flow (Problematic)

```typescript
// CURRENT: DB query on every session access
session: async ({ session, token }) => {
  const user = await prisma.user.findUnique({
    where: { id: token.sub },
    select: {
      phone: true,
      address: true,
      timezone: true,
      // ...more fields
    },
  });
  // Adds user data to session
};
```

**Issue:** Every authenticated request triggers a database query.

### 5.2 Optimized Session Flow

```typescript
// lib/auth/options.ts
export const authOptions: NextAuthOptions = {
  // ...other options

  callbacks: {
    // Store all needed data in JWT at sign-in
    jwt: async ({ token, user, trigger, session }) => {
      // Initial sign-in: populate token with user data
      if (trigger === "signIn" && user) {
        const fullUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            phone: true,
            address: true,
            timezone: true,
            onboardingCompleted: true,
            consultantProfile: { select: { id: true } },
            consulteeProfile: { select: { id: true } },
            staffProfile: { select: { id: true } },
          },
        });

        if (fullUser) {
          token.id = fullUser.id;
          token.name = fullUser.name;
          token.email = fullUser.email;
          token.role = fullUser.role;
          token.phone = fullUser.phone;
          token.address = fullUser.address;
          token.timezone = fullUser.timezone;
          token.onboardingCompleted = fullUser.onboardingCompleted;
          token.consultantProfileId = fullUser.consultantProfile?.id;
          token.consulteeProfileId = fullUser.consulteeProfile?.id;
          token.staffProfileId = fullUser.staffProfile?.id;
        }
      }

      // Explicit update: refresh token data
      if (trigger === "update" && session) {
        const freshUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: {
            phone: true,
            address: true,
            timezone: true,
            onboardingCompleted: true,
          },
        });
        if (freshUser) {
          token.phone = freshUser.phone;
          token.address = freshUser.address;
          token.timezone = freshUser.timezone;
          token.onboardingCompleted = freshUser.onboardingCompleted;
        }
      }

      return token;
    },

    // Session callback: NO database queries
    session: async ({ session, token }) => {
      // Just map token data to session
      session.user = {
        id: token.id as string,
        name: token.name as string,
        email: token.email as string,
        role: token.role as UserRole,
        phone: token.phone as string | null,
        address: token.address as Address | null,
        timezone: token.timezone as string | null,
        onboardingCompleted: token.onboardingCompleted as boolean,
        consultantProfileId: token.consultantProfileId as string | undefined,
        consulteeProfileId: token.consulteeProfileId as string | undefined,
        staffProfileId: token.staffProfileId as string | undefined,
      };
      return session;
    },
  },
};
```

### 5.3 Session Update API

```typescript
// app/api/auth/session/route.ts
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";

// Call this after user updates their profile
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Trigger session update
  // This will cause the jwt callback to run with trigger="update"
  return NextResponse.json({ success: true });
}
```

```typescript
// Client-side: Update session after profile change
async function updateProfile(data: ProfileData) {
  await fetch("/api/user/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  });

  // Update NextAuth session
  await update(); // From useSession()
}
```

---

## 6. Real-Time Features

### 6.1 Stream.io Optimization

**Current Issues:**

- Token fetched on every page load
- Channel sync on every connection
- No connection pooling awareness

### 6.2 Optimized Stream Provider

```typescript
// providers/stream-provider.tsx
"use client";

import { createContext, useContext, useEffect, useState, useRef } from "react";
import { StreamChat, Channel } from "stream-chat";
import { StreamVideo, StreamVideoClient } from "@stream-io/video-react-sdk";

interface StreamContextType {
  chatClient: StreamChat | null;
  videoClient: StreamVideoClient | null;
  isConnected: boolean;
}

const StreamContext = createContext<StreamContextType | null>(null);

// Token cache with refresh
const tokenCache = {
  token: null as string | null,
  expiresAt: 0,
  userId: null as string | null,
};

async function getStreamToken(userId: string): Promise<string> {
  const now = Date.now();
  const REFRESH_BUFFER = 5 * 60 * 1000; // 5 minutes before expiry

  // Return cached token if valid
  if (
    tokenCache.token &&
    tokenCache.userId === userId &&
    tokenCache.expiresAt - REFRESH_BUFFER > now
  ) {
    return tokenCache.token;
  }

  // Fetch new token
  const response = await fetch("/api/stream/token", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
  const { token, expiresAt } = await response.json();

  // Cache it
  tokenCache.token = token;
  tokenCache.expiresAt = expiresAt;
  tokenCache.userId = userId;

  return token;
}

export function StreamProvider({ children, user }: Props) {
  const [chatClient, setChatClient] = useState<StreamChat | null>(null);
  const [videoClient, setVideoClient] = useState<StreamVideoClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const connectionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!user?.id) return;

    // Prevent multiple simultaneous connection attempts
    if (connectionRef.current) return;

    connectionRef.current = (async () => {
      try {
        const token = await getStreamToken(user.id);
        const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY!;

        // Initialize chat client
        const chat = StreamChat.getInstance(apiKey);
        await chat.connectUser(
          {
            id: user.id,
            name: user.name || undefined,
            image: user.image || undefined,
          },
          token
        );

        // Initialize video client
        const video = new StreamVideoClient({
          apiKey,
          user: { id: user.id },
          token,
        });

        setChatClient(chat);
        setVideoClient(video);
        setIsConnected(true);

        // Set up token refresh
        const refreshInterval = setInterval(async () => {
          const newToken = await getStreamToken(user.id);
          chat.tokenManager.setTokenOrProvider(newToken);
          video.updateToken(newToken);
        }, 45 * 60 * 1000); // Refresh every 45 minutes

        return () => {
          clearInterval(refreshInterval);
          chat.disconnectUser();
          video.disconnectUser();
        };
      } catch (error) {
        console.error("Stream connection error:", error);
      } finally {
        connectionRef.current = null;
      }
    })();

    return () => {
      if (chatClient) chatClient.disconnectUser();
      if (videoClient) videoClient.disconnectUser();
    };
  }, [user?.id]);

  return (
    <StreamContext.Provider value={{ chatClient, videoClient, isConnected }}>
      {children}
    </StreamContext.Provider>
  );
}
```

### 6.3 Lazy Channel Loading

```typescript
// hooks/useStreamChannel.ts
import { useQuery } from "@tanstack/react-query";
import { useStream } from "@/providers/stream-provider";

export function useStreamChannel(channelId: string) {
  const { chatClient, isConnected } = useStream();

  return useQuery({
    queryKey: ["stream-channel", channelId],
    queryFn: async () => {
      if (!chatClient || !isConnected) {
        throw new Error("Stream not connected");
      }

      const channel = chatClient.channel("messaging", channelId);
      await channel.watch();
      return channel;
    },
    enabled: isConnected && !!channelId,
    staleTime: Infinity, // Channel doesn't need refetching
  });
}
```

---

## 7. Infrastructure Scaling

### 7.1 Horizontal Scaling Strategy

```
                    Load Balancer (Vercel Edge)
                              ↓
        ┌────────────────────┼────────────────────┐
        ↓                    ↓                    ↓
   ┌─────────┐         ┌─────────┐         ┌─────────┐
   │ Region  │         │ Region  │         │ Region  │
   │   US    │         │   EU    │         │  APAC   │
   └────┬────┘         └────┬────┘         └────┬────┘
        ↓                    ↓                    ↓
   ┌─────────┐         ┌─────────┐         ┌─────────┐
   │ Serverless│       │Serverless│        │Serverless│
   │Functions │        │Functions │        │Functions │
   └────┬────┘         └────┬────┘         └────┬────┘
        └────────────────────┴────────────────────┘
                              ↓
                 ┌────────────┼────────────┐
                 ↓            ↓            ↓
            ┌─────────┐  ┌─────────┐  ┌─────────┐
            │  Redis  │  │ Primary │  │  Read   │
            │ Cluster │  │   DB    │  │ Replica │
            └─────────┘  └─────────┘  └─────────┘
```

### 7.2 Database Scaling

```typescript
// lib/prisma.ts
import { PrismaClient } from "@prisma/client";

// Read replica for heavy read operations
const readReplica = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL_READ_REPLICA,
    },
  },
});

// Primary for writes
const primary = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Query router
export function getPrisma(operation: "read" | "write" = "read") {
  // Use read replica for read operations (if available)
  if (operation === "read" && process.env.DATABASE_URL_READ_REPLICA) {
    return readReplica;
  }
  return primary;
}

// Usage
const consultants = await getPrisma("read").consultantProfile.findMany({...});
const newAppointment = await getPrisma("write").appointment.create({...});
```

### 7.3 CDN Configuration

```typescript
// next.config.js
module.exports = {
  // Enable static page caching
  headers: async () => [
    {
      source: "/api/user/content/domains",
      headers: [
        {
          key: "Cache-Control",
          value: "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      ],
    },
    {
      source: "/api/plans/:type",
      headers: [
        {
          key: "Cache-Control",
          value: "public, s-maxage=300, stale-while-revalidate=3600",
        },
      ],
    },
  ],
};
```

---

## 8. Monitoring & Observability

### 8.1 Key Metrics

```typescript
// lib/metrics.ts
export const METRICS = {
  // Performance
  "api.response_time": "Histogram",
  "api.request_count": "Counter",
  "api.error_count": "Counter",

  // Database
  "db.query_time": "Histogram",
  "db.connection_pool.active": "Gauge",
  "db.connection_pool.waiting": "Gauge",

  // Cache
  "cache.hit_rate": "Gauge",
  "cache.miss_rate": "Gauge",
  "cache.eviction_count": "Counter",

  // Queue
  "queue.job_count": "Gauge",
  "queue.job_latency": "Histogram",
  "queue.job_failures": "Counter",

  // Real-time
  "stream.connection_count": "Gauge",
  "stream.message_count": "Counter",
  "stream.error_count": "Counter",
};
```

### 8.2 Logging Strategy

```typescript
// lib/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    env: process.env.NODE_ENV,
    service: "familiarise-web",
  },
});

// Request logging middleware
export function logRequest(
  req: NextRequest,
  res: NextResponse,
  duration: number,
) {
  logger.info({
    type: "request",
    method: req.method,
    path: req.nextUrl.pathname,
    status: res.status,
    duration,
    userId: req.headers.get("x-user-id"),
  });
}
```

### 8.3 Alerting Thresholds

```yaml
# alerts.yaml
alerts:
  - name: "High API Latency"
    condition: "p95(api.response_time) > 500ms"
    duration: "5m"
    severity: warning

  - name: "Database Connection Saturation"
    condition: "db.connection_pool.waiting > 5"
    duration: "1m"
    severity: critical

  - name: "Cache Hit Rate Low"
    condition: "cache.hit_rate < 0.8"
    duration: "10m"
    severity: warning

  - name: "Queue Backlog"
    condition: "queue.job_count > 1000"
    duration: "5m"
    severity: high

  - name: "Error Rate Spike"
    condition: "rate(api.error_count[5m]) > 10"
    severity: critical
```

---

## Appendix: Implementation Checklist

### Phase 1: Quick Wins (Week 1)

- [ ] Implement Redis caching for consultant profiles
- [ ] Optimize session callback (remove DB queries)
- [ ] Add CDN cache headers to static API responses
- [ ] Set up basic monitoring with Vercel Analytics

### Phase 2: Core Improvements (Week 2-3)

- [ ] Implement Inngest for background jobs
- [ ] Move webhook processing to queue
- [ ] Add comprehensive cache invalidation
- [ ] Implement read replica routing

### Phase 3: Production Hardening (Week 4+)

- [ ] Set up distributed tracing
- [ ] Implement circuit breakers
- [ ] Add comprehensive alerting
- [ ] Load test with realistic traffic patterns
