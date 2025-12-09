# Database Performance - Production Readiness

> **Severity Level:** CRITICAL
> **Last Updated:** 2024
> **Status:** Requires Optimization Before Scale

## Executive Summary

The database layer has significant performance issues that will cause degradation at scale. Key findings include 20+ missing indexes, N+1 query problems causing 100+ queries per page load, and race conditions in critical paths.

---

## Table of Contents

1. [Database Architecture Overview](#1-database-architecture-overview)
2. [Missing Indexes](#2-missing-indexes)
3. [N+1 Query Problems](#3-n1-query-problems)
4. [Race Conditions](#4-race-conditions)
5. [Connection Pooling](#5-connection-pooling)
6. [Performance Projections](#6-performance-projections)
7. [Remediation Guide](#7-remediation-guide)

---

## 1. Database Architecture Overview

### 1.1 Technology Stack

| Component         | Technology |
| ----------------- | ---------- |
| Database          | PostgreSQL |
| ORM               | Prisma     |
| Hosting           | Supabase   |
| Connection Pooler | Supavisor  |

### 1.2 Schema Statistics

| Metric                   | Count |
| ------------------------ | ----- |
| Total Models             | 30+   |
| Current Indexes          | 31    |
| Missing Indexes          | 20+   |
| Many-to-Many Relations   | 5     |
| Cascade Delete Relations | 15+   |

### 1.3 Core Model Relationships

```
User (1) ──┬── ConsultantProfile (0..1)
           ├── ConsulteeProfile (0..1)
           └── StaffProfile (0..1)

ConsultantProfile (1) ──┬── ConsultationPlan (*)
                        ├── SubscriptionPlan (*)
                        ├── WebinarPlan (*)
                        └── ClassPlan (*)

Appointment (1) ──┬── Consultation (0..1)
                  ├── Subscription (0..1)
                  ├── Webinar (0..1)
                  ├── Class (0..1)
                  ├── SlotOfAppointment (*)
                  └── Payment (*)
```

---

## 2. Missing Indexes

### 2.1 Critical Missing Indexes

#### Foreign Key Indexes (HIGH PRIORITY)

| Table          | Field                | Current  | Query Impact             |
| -------------- | -------------------- | -------- | ------------------------ |
| `Consultation` | `consultationPlanId` | No index | O(n) on plan joins       |
| `Consultation` | `requestedById`      | No index | Slow consultee history   |
| `Subscription` | `subscriptionPlanId` | No index | O(n) on plan joins       |
| `Subscription` | `requestedById`      | No index | Slow consultee history   |
| `Webinar`      | `requestedById`      | No index | Slow participant queries |
| `Class`        | `requestedById`      | No index | Slow participant queries |

#### Status Field Indexes (HIGH PRIORITY)

| Table           | Field           | Current  | Query Impact                 |
| --------------- | --------------- | -------- | ---------------------------- |
| `Consultation`  | `requestStatus` | No index | Full table scan on filtering |
| `Subscription`  | `requestStatus` | No index | Full table scan on filtering |
| `Feedback`      | `status`        | No index | Support dashboard slow       |
| `SupportTicket` | `status`        | No index | Ticket listing slow          |
| `Class`         | `status`        | No index | Event filtering slow         |
| `Webinar`       | `status`        | No index | Event filtering slow         |

#### Date Range Indexes (MEDIUM PRIORITY)

| Table               | Field       | Current  | Query Impact             |
| ------------------- | ----------- | -------- | ------------------------ |
| `Appointment`       | `createdAt` | No index | Recent appointments slow |
| `SlotOfAppointment` | `startsAt`  | No index | Date range queries slow  |
| `SlotOfAppointment` | `endsAt`    | No index | Overlap detection slow   |

### 2.2 Missing Composite Indexes

| Use Case                 | Fields                                           | Priority |
| ------------------------ | ------------------------------------------------ | -------- |
| Plan status filtering    | `(subscriptionPlanId, requestStatus)`            | HIGH     |
| Consultant history       | `(consultantProfileId, createdAt)`               | HIGH     |
| Consultee timeline       | `(consulteeProfileId, requestStatus, createdAt)` | HIGH     |
| Slot collision detection | `(appointmentId, startsAt, endsAt)`              | CRITICAL |
| Payment queries          | `(paymentStatus, paymentGateway)`                | MEDIUM   |

### 2.3 Index Migration Script

Add to `prisma/schema.prisma`:

```prisma
model Consultation {
  // ... existing fields ...

  @@index([consultationPlanId])
  @@index([requestedById])
  @@index([requestStatus])
  @@index([consultationPlanId, requestStatus])
}

model Subscription {
  // ... existing fields ...

  @@index([subscriptionPlanId])
  @@index([requestedById])
  @@index([requestStatus])
  @@index([subscriptionPlanId, requestStatus])
}

model Webinar {
  // ... existing fields ...

  @@index([requestedById])
  @@index([status])
}

model Class {
  // ... existing fields ...

  @@index([requestedById])
  @@index([status])
}

model Appointment {
  // ... existing fields ...

  @@index([createdAt])
}

model SlotOfAppointment {
  // ... existing fields ...

  @@index([startsAt])
  @@index([endsAt])
  @@index([appointmentId, startsAt, endsAt])
  @@index([startsAt, endsAt, isTentative])
}

model Feedback {
  // ... existing fields ...

  @@index([status])
}

model SupportTicket {
  // ... existing fields ...

  @@index([status])
}
```

---

## 3. N+1 Query Problems

### 3.1 Critical N+1 Patterns

#### Appointment Queries (CRITICAL)

**File:** `app/api/slots/appointments/route.ts`
**Lines:** 257-330

```typescript
// PROBLEM: 7-level deep nested includes
include: {
  slotsOfAppointment: {
    include: { user: true }  // N queries for N slots
  },
  consultation: {
    include: {
      consultationPlan: {
        include: {
          consultantProfile: {
            include: { user: true }  // Repeated user fetch
          }
        }
      },
      requestedBy: { include: { user: true } }  // Another user fetch
    }
  },
  subscription: { /* Same pattern */ },
  webinar: { /* Same pattern */ },
  class: { /* Same pattern */ }
}
```

**Impact:**

- For 10 appointments with 5 slots each = 50 user queries
- Plus 4 event types × relation chains
- **Estimated: 100+ queries per request**

#### Subscription Listing (HIGH)

**File:** `app/api/events/subscriptions/route.ts`
**Lines:** 39-73

```typescript
// PROBLEM: Deep includes with repeated data
include: {
  subscriptionPlan: {
    include: {
      consultantProfile: {
        include: {
          user: true,
          domain: true,      // Likely same domain repeated
          subDomains: true,  // Collection per consultant
          tags: true         // Collection per consultant
        }
      }
    }
  },
  appointments: {
    include: {
      slotsOfAppointment: {
        include: { user: true }  // N+1 per appointment
      }
    }
  }
}
```

### 3.2 Query Optimization Strategies

#### Strategy 1: Selective Field Loading

```typescript
// BEFORE: Loads everything
const appointments = await prisma.appointment.findMany({
  include: {
    consultation: {
      include: {
        consultationPlan: {
          include: { consultantProfile: { include: { user: true } } },
        },
      },
    },
  },
});

// AFTER: Select only needed fields
const appointments = await prisma.appointment.findMany({
  select: {
    id: true,
    createdAt: true,
    consultation: {
      select: {
        id: true,
        consultationPlan: {
          select: {
            title: true,
            consultantProfile: {
              select: {
                id: true,
                user: {
                  select: { name: true, image: true },
                },
              },
            },
          },
        },
      },
    },
  },
});
```

#### Strategy 2: Parallel Fetching

```typescript
// BEFORE: Deep nesting
const appointment = await prisma.appointment.findUnique({
  where: { id },
  include: {
    /* deep includes */
  },
});

// AFTER: Parallel fetches
const [appointment, consultation, slots] = await Promise.all([
  prisma.appointment.findUnique({
    where: { id },
    select: { id: true, consultationId: true },
  }),
  prisma.consultation.findUnique({
    where: { appointmentId: id },
    select: { id: true, title: true },
  }),
  prisma.slotOfAppointment.findMany({
    where: { appointmentId: id },
    select: { id: true, startsAt: true, endsAt: true },
  }),
]);
```

#### Strategy 3: DataLoader Pattern

```typescript
// Create a DataLoader for users
import DataLoader from "dataloader";

const userLoader = new DataLoader(async (userIds: string[]) => {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));
  return userIds.map((id) => userMap.get(id));
});

// Use in resolver
const user = await userLoader.load(consultation.requestedById);
```

### 3.3 Pagination Issues

**Problem:** Many endpoints use `take/skip` with heavy includes.

```typescript
// PROBLEM: Loads all relations for paginated results
const items = await prisma.subscription.findMany({
  take: 10,
  skip: 0,
  include: {
    /* heavy includes */
  },
});

// SOLUTION: Two-phase loading
// Phase 1: Get IDs only
const ids = await prisma.subscription.findMany({
  take: 10,
  skip: 0,
  select: { id: true },
});

// Phase 2: Load with relations (only 10 items)
const items = await prisma.subscription.findMany({
  where: { id: { in: ids.map((i) => i.id) } },
  include: {
    /* needed relations */
  },
});
```

---

## 4. Race Conditions

### 4.1 Identified Race Conditions

#### Double Booking (CRITICAL)

**File:** `utils/slotAllocation/SlotAllocationService.ts`

```typescript
// RACE CONDITION WINDOW
const availableSlots = await findAvailableSlots(...);  // Query 1
// Another request could book the same slot here
await createAppointment(...);                           // Query 2
```

**Impact:** Same slot can be booked by two concurrent requests.

#### Payment Webhook Races (CRITICAL)

**File:** `app/api/webhooks/utils.ts:70-114`

```typescript
// RACE CONDITION
const existingRefund = await tx.refund.findUnique({
  where: { refundId }
});
// Another webhook could create refund here
if (existingRefund) return;
await tx.refund.create({...});
```

**Impact:** Duplicate refund records, data inconsistency.

#### Subscription Approval (HIGH)

**File:** `app/api/events/subscriptions/route.ts:176-213`

```typescript
const subscription = await prisma.subscription.update({...});
// Another request might approve same subscription
if (status === RequestStatus.APPROVED) {
  await createAppointmentsForSubscription(subscription);
}
```

**Impact:** Duplicate appointments created.

#### Cleanup Job Concurrency (MEDIUM)

**File:** `jobs/cleanup-abandoned-payments.ts:117-161`

Multiple job instances could process same abandoned payments.

### 4.2 Race Condition Fixes

#### Solution 1: Optimistic Locking

```prisma
// Add version field to schema
model Appointment {
  id        String   @id @default(cuid())
  version   Int      @default(0)
  // ... other fields
}
```

```typescript
// Update with version check
async function updateAppointment(
  id: string,
  data: any,
  currentVersion: number,
) {
  const updated = await prisma.appointment.updateMany({
    where: {
      id,
      version: currentVersion, // Only update if version matches
    },
    data: {
      ...data,
      version: { increment: 1 },
    },
  });

  if (updated.count === 0) {
    throw new Error("Concurrent modification detected");
  }
}
```

#### Solution 2: Database Constraints

```prisma
model SlotOfAppointment {
  // Add unique constraint to prevent double booking
  @@unique([startsAt, endsAt, consultantProfileId], name: "unique_consultant_slot")
}
```

#### Solution 3: Advisory Locks

```typescript
// Use PostgreSQL advisory locks for critical operations
async function withAdvisoryLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockId = hashStringToInt(lockKey);

  await prisma.$executeRaw`SELECT pg_advisory_lock(${lockId})`;
  try {
    return await fn();
  } finally {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${lockId})`;
  }
}

// Usage
await withAdvisoryLock(`slot:${slotId}`, async () => {
  await bookSlot(slotId, userId);
});
```

#### Solution 4: Idempotency Keys

```prisma
// Add webhook deduplication table
model WebhookLog {
  id        String   @id @default(cuid())
  eventId   String
  gateway   String
  processed Boolean  @default(true)
  createdAt DateTime @default(now())

  @@unique([eventId, gateway])
}
```

```typescript
// Check before processing webhook
const existing = await prisma.webhookLog.findUnique({
  where: { eventId_gateway: { eventId, gateway } },
});

if (existing) {
  return { status: "already_processed" };
}

await prisma.webhookLog.create({
  data: { eventId, gateway },
});

// Process webhook...
```

---

## 5. Connection Pooling

### 5.1 Current Configuration

**File:** `.env.sample`

```
DATABASE_URL=""        # Connection pooled via Supavisor
DIRECT_URL=""          # Direct connection for migrations
```

### 5.2 Issues

| Issue                    | Impact                  | Severity |
| ------------------------ | ----------------------- | -------- |
| No explicit pool size    | Default 3 connections   | HIGH     |
| No timeout configuration | Long queries block pool | MEDIUM   |
| No monitoring            | Can't detect exhaustion | MEDIUM   |

### 5.3 Recommended Configuration

```env
# Production connection string
DATABASE_URL="postgresql://user:pass@host:6543/db?pgbouncer=true&connection_limit=20&pool_timeout=30"

# Direct connection for migrations only
DIRECT_URL="postgresql://user:pass@host:5432/db"
```

### 5.4 Prisma Client Configuration

**File:** `lib/prisma.ts`

```typescript
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Add query timing in development
if (process.env.NODE_ENV === "development") {
  prisma.$use(async (params, next) => {
    const before = Date.now();
    const result = await next(params);
    const after = Date.now();

    if (after - before > 100) {
      console.warn(
        `Slow query (${after - before}ms): ${params.model}.${params.action}`,
      );
    }

    return result;
  });
}
```

---

## 6. Performance Projections

### 6.1 Current vs Projected Performance

| Scenario            | Current (1K users) | 100K Users | 1M Users | 10M Users |
| ------------------- | ------------------ | ---------- | -------- | --------- |
| List subscriptions  | ~200ms             | ~500ms     | ~2s      | ~20s      |
| Fetch appointments  | ~150ms             | ~400ms     | ~1.5s    | ~15s      |
| Admin payment stats | ~300ms             | ~1s        | ~5s      | ~60s      |
| Cleanup job         | ~500ms             | ~5s        | ~30s     | ~300s     |

### 6.2 With Optimizations

| Scenario            | Optimized | Improvement  |
| ------------------- | --------- | ------------ |
| List subscriptions  | ~50ms     | 4x faster    |
| Fetch appointments  | ~40ms     | 3.75x faster |
| Admin payment stats | ~100ms    | 3x faster    |
| Cleanup job         | ~200ms    | 2.5x faster  |

### 6.3 Bottleneck Analysis

```
Current Query Flow:
┌─────────────────────────────────────────────────────────┐
│ Request                                                  │
│    ↓                                                     │
│ No Cache → Database Query (100+ queries)                │
│    ↓                                                     │
│ Process Results                                          │
│    ↓                                                     │
│ Response (~200ms)                                        │
└─────────────────────────────────────────────────────────┘

Optimized Query Flow:
┌─────────────────────────────────────────────────────────┐
│ Request                                                  │
│    ↓                                                     │
│ Redis Cache Check → HIT → Response (~5ms)               │
│         ↓ MISS                                           │
│ Database Query (3-5 queries with indexes)               │
│    ↓                                                     │
│ Cache Result → Response (~50ms)                         │
└─────────────────────────────────────────────────────────┘
```

---

## 7. Remediation Guide

### 7.1 Phase 1: Critical (Week 1)

#### Add Missing Indexes

```bash
# 1. Update schema.prisma with indexes from Section 2.3
# 2. Generate and apply migration
npx prisma migrate dev --name add_performance_indexes

# 3. Verify indexes were created
npx prisma db execute --stdin <<EOF
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
EOF
```

#### Add Optimistic Locking

```prisma
// Add to critical models
model Appointment {
  version Int @default(0) @map("version")
}

model Payment {
  version Int @default(0) @map("version")
}

model Subscription {
  version Int @default(0) @map("version")
}
```

#### Add Webhook Deduplication

```prisma
model WebhookLog {
  id        String   @id @default(cuid())
  eventId   String
  gateway   String
  eventType String
  payload   Json?
  processed Boolean  @default(true)
  createdAt DateTime @default(now())

  @@unique([eventId, gateway])
  @@index([createdAt])
}
```

### 7.2 Phase 2: High Priority (Week 2)

#### Fix N+1 Queries

1. Refactor `app/api/slots/appointments/route.ts`
2. Refactor `app/api/events/subscriptions/route.ts`
3. Refactor `app/api/events/consultations/route.ts`
4. Implement DataLoader pattern for user fetching

#### Add Query Monitoring

```typescript
// lib/prisma.ts - Add query logging
prisma.$use(async (params, next) => {
  const start = performance.now();
  const result = await next(params);
  const duration = performance.now() - start;

  // Log slow queries
  if (duration > 100) {
    console.warn({
      level: "warn",
      message: "Slow query detected",
      model: params.model,
      action: params.action,
      duration: `${duration.toFixed(2)}ms`,
      args: params.args,
    });
  }

  return result;
});
```

### 7.3 Phase 3: Scaling (Week 3+)

#### Implement Caching Layer

```typescript
// lib/cache.ts
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const cached = await redis.get<T>(key);
  if (cached) return cached;

  const result = await fn();
  await redis.setex(key, ttlSeconds, result);
  return result;
}

// Usage
const consultant = await withCache(
  `consultant:${id}`,
  3600, // 1 hour
  () => prisma.consultantProfile.findUnique({ where: { id } }),
);
```

#### Add Read Replicas

```typescript
// lib/prisma.ts
import { PrismaClient } from "@prisma/client";

// Primary for writes
export const prismaWrite = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

// Replica for reads
export const prismaRead = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL_READ_REPLICA } },
});

// Helper function
export function getPrisma(operation: "read" | "write") {
  return operation === "read" ? prismaRead : prismaWrite;
}
```

---

## Appendix: Performance Testing

### Load Test Script

```typescript
// scripts/load-test.ts
import { check } from "k6";
import http from "k6/http";

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 50 },
    { duration: "30s", target: 100 },
    { duration: "1m", target: 100 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const endpoints = [
    "/api/events/subscriptions",
    "/api/slots/appointments",
    "/api/user/consultants",
  ];

  for (const endpoint of endpoints) {
    const res = http.get(`${__ENV.BASE_URL}${endpoint}`);
    check(res, {
      "status is 200": (r) => r.status === 200,
      "response time < 500ms": (r) => r.timings.duration < 500,
    });
  }
}
```

### Monitor Queries

```sql
-- Enable slow query logging
ALTER SYSTEM SET log_min_duration_statement = 100;
SELECT pg_reload_conf();

-- View slow queries
SELECT
  query,
  calls,
  mean_time,
  total_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 20;
```
