# Implementation Roadmap - Production Readiness

> **Version:** 1.0
> **Last Updated:** 2024
> **Status:** Active

## Executive Summary

This roadmap provides a prioritized action plan for preparing the SaaS application for production scale. Issues are categorized by severity and organized into implementation phases.

---

## Table of Contents

1. [Issue Summary](#1-issue-summary)
2. [Priority Matrix](#2-priority-matrix)
3. [Phase 1: Critical Security](#3-phase-1-critical-security)
4. [Phase 2: Database Performance](#4-phase-2-database-performance)
5. [Phase 3: Payment Hardening](#5-phase-3-payment-hardening)
6. [Phase 4: Rate Limiting](#6-phase-4-rate-limiting)
7. [Phase 5: Scaling Architecture](#7-phase-5-scaling-architecture)
8. [Testing Requirements](#8-testing-requirements)
9. [Rollout Strategy](#9-rollout-strategy)

---

## 1. Issue Summary

### By Severity

| Severity    | Count | Category                |
| ----------- | ----- | ----------------------- |
| 🔴 CRITICAL | 12    | Security, Data Exposure |
| 🟠 HIGH     | 18    | Performance, Payments   |
| 🟡 MEDIUM   | 15    | Scaling, Monitoring     |
| 🟢 LOW      | 8     | Optimization            |

### By Category

| Category      | Critical | High | Medium | Low |
| ------------- | -------- | ---- | ------ | --- |
| Security      | 8        | 5    | 3      | 1   |
| Database      | 2        | 6    | 4      | 2   |
| Payments      | 2        | 5    | 3      | 2   |
| Rate Limiting | 0        | 2    | 3      | 1   |
| Architecture  | 0        | 0    | 2      | 2   |

---

## 2. Priority Matrix

### Must Have (P0) - Block Production Launch

| ID     | Issue                           | Document    | Effort  |
| ------ | ------------------------------- | ----------- | ------- |
| SEC-01 | 77 unprotected API endpoints    | 01-security | 2 days  |
| SEC-02 | Password hash in API response   | 01-security | 1 hour  |
| SEC-03 | Disabled auth in user endpoints | 01-security | 30 min  |
| SEC-04 | Missing authorization checks    | 01-security | 1 day   |
| DB-01  | 20+ missing database indexes    | 02-database | 4 hours |
| PAY-01 | Webhook replay vulnerability    | 03-payment  | 4 hours |
| PAY-02 | Refund over-calculation bug     | 03-payment  | 1 hour  |

### Should Have (P1) - Fix Within First Week

| ID     | Issue                       | Document     | Effort  |
| ------ | --------------------------- | ------------ | ------- |
| SEC-05 | Debug endpoint exposure     | 01-security  | 2 hours |
| SEC-06 | Input validation gaps       | 01-security  | 1 day   |
| DB-02  | N+1 query problems          | 02-database  | 2 days  |
| DB-03  | Race conditions             | 02-database  | 1 day   |
| PAY-03 | Slot overlap detection bug  | 03-payment   | 2 hours |
| PAY-04 | LemonSqueezy incomplete     | 03-payment   | 4 hours |
| RL-01  | Auth endpoint rate limiting | 04-ratelimit | 4 hours |
| RL-02  | Webhook rate limiting       | 04-ratelimit | 2 hours |

### Nice to Have (P2) - Fix Within First Month

| ID       | Issue                     | Document     | Effort  |
| -------- | ------------------------- | ------------ | ------- |
| DB-04    | Session optimization      | 05-scaling   | 4 hours |
| DB-05    | Connection pooling config | 02-database  | 2 hours |
| SCALE-01 | Redis caching layer       | 05-scaling   | 2 days  |
| SCALE-02 | Background job processing | 05-scaling   | 3 days  |
| RL-03    | Per-endpoint rate limits  | 04-ratelimit | 1 day   |
| MON-01   | Comprehensive monitoring  | 05-scaling   | 2 days  |

---

## 3. Phase 1: Critical Security

**Timeline:** Days 1-3
**Owner:** Security Team / Backend Lead

### 3.1 Add Authentication to Endpoints

**Files to Modify:**

```
app/api/user/[id]/route.ts                    → Uncomment auth (lines 13-16)
app/api/user/consultants/[id]/route.ts        → Uncomment auth (lines 86-89)
app/api/user/consultees/route.ts              → Add auth
app/api/user/consultees/[id]/route.ts         → Add auth
app/api/user/consultants/route.ts             → Add auth
app/api/user/reviews/route.ts                 → Add auth to POST
app/api/bookings/classes/route.ts               → Add auth
app/api/bookings/consultations/route.ts         → Add auth
app/api/bookings/subscriptions/route.ts         → Add auth
app/api/bookings/webinars/route.ts              → Add auth
app/api/plans/*/route.ts                      → Add auth to all
app/api/participants/*/route.ts               → Add auth to all
app/api/slots/appointments/route.ts           → Add auth
app/api/dashboard/*/route.ts                  → Add auth to all
app/api/stream/debug/route.ts                 → Add admin auth or remove
app/api/stream/channels/create/route.ts       → Add auth
app/api/form/onboarding/[id]/route.ts         → Add auth
```

**Template:**

```typescript
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // ... rest of handler
}
```

### 3.2 Remove Password Exposure

**File:** `app/api/dashboard/consultant/[consultantId]/route.ts`

```typescript
// REMOVE these lines (84-88):
password: u.password || null,
passwordResetToken: u.passwordResetToken || null,
passwordResetExpires: u.passwordResetExpires || null,
```

### 3.3 Add Authorization Checks

**File:** `app/api/appointments/[appointmentId]/cancel/route.ts`

```typescript
// After auth check, add ownership verification:
const isOwner =
  appointment?.consultation?.requestedBy?.userId === session.user.id ||
  session.user.consultantProfileId ===
    appointment?.consultation?.consultationPlan?.consultantProfileId;

const isAdmin = session.user.role === "ADMIN" || session.user.role === "STAFF";

if (!isOwner && !isAdmin) {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
```

### 3.4 Verification Checklist

- [ ] All 77 endpoints have authentication
- [ ] Password fields removed from responses
- [ ] Authorization checks on resource endpoints
- [ ] Debug endpoint protected or removed
- [ ] Test all protected endpoints return 401/403 appropriately

---

## 4. Phase 2: Database Performance

**Timeline:** Days 4-7
**Owner:** Backend Team

### 4.1 Add Missing Indexes

**File:** `prisma/schema.prisma`

```prisma
// Add these indexes:

model Consultation {
  @@index([consultationPlanId])
  @@index([requestedById])
  @@index([status])
}

model Subscription {
  @@index([subscriptionPlanId])
  @@index([requestedById])
  @@index([status])
}

model SlotOfAppointment {
  @@index([startsAt])
  @@index([endsAt])
  @@index([appointmentId, startsAt, endsAt])
}

model Appointment {
  @@index([createdAt])
}

model Webinar {
  @@index([requestedById])
  @@index([status])
}

model Class {
  @@index([requestedById])
  @@index([status])
}

model Feedback {
  @@index([status])
}

model SupportTicket {
  @@index([status])
}
```

**Migration:**

```bash
npx prisma migrate dev --name add_performance_indexes
```

### 4.2 Add Optimistic Locking

```prisma
model Payment {
  version Int @default(0)
}

model Appointment {
  version Int @default(0)
}

model Subscription {
  version Int @default(0)
}
```

### 4.3 Add Webhook Deduplication

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

### 4.4 Fix N+1 Queries

**Priority Files:**

1. `app/api/slots/appointments/route.ts`
2. `app/api/bookings/subscriptions/route.ts`
3. `app/api/bookings/consultations/route.ts`

**Pattern:**

```typescript
// Replace deep includes with selective loading
const appointments = await prisma.appointment.findMany({
  select: {
    id: true,
    consultationId: true,
    // Only needed fields
  },
});

// Parallel fetch relations
const consultationIds = appointments
  .map((a) => a.consultationId)
  .filter(Boolean);
const consultations = await prisma.consultation.findMany({
  where: { id: { in: consultationIds } },
  select: { id: true, title: true },
});
```

### 4.5 Verification Checklist

- [ ] All indexes created successfully
- [ ] Migration applied without errors
- [ ] N+1 queries reduced (verify with query logging)
- [ ] Optimistic locking tested
- [ ] Webhook deduplication working

---

## 5. Phase 3: Payment Hardening

**Timeline:** Days 8-10
**Owner:** Payment Team

### 5.1 Fix Refund Calculation

**File:** `app/api/payments/refunds/route.ts:83-84`

```typescript
// Change from:
.filter((r) => r.status === "SUCCEEDED")

// To:
.filter((r) => r.status === "SUCCEEDED" || r.status === "PENDING")
```

### 5.2 Fix Slot Overlap Detection

**File:** `lib/payments/operations/checkout.ts:330-353`

```typescript
// Replace complex OR with simplified check:
const existingBooking = await tx.slotOfAppointment.findFirst({
  where: {
    AND: [
      { startsAt: { lt: slotEnd } },
      { endsAt: { gt: slotStart } },
      { consultantProfileId: consultantId },
      { isTentative: false },
    ],
  },
});
```

### 5.3 Implement Webhook Idempotency

**File:** `app/api/webhooks/stripe/route.ts`

```typescript
// At the start of webhook handler:
const existing = await prisma.webhookLog.findUnique({
  where: { eventId_gateway: { eventId: event.id, gateway: "STRIPE" } },
});

if (existing) {
  return NextResponse.json({ status: "already_processed" });
}

await prisma.webhookLog.create({
  data: { eventId: event.id, gateway: "STRIPE", eventType: event.type },
});

// Continue with processing...
```

### 5.4 Complete LemonSqueezy Implementation

**File:** `app/api/webhooks/lemon-squeezy/route.ts:230-236`

Replace TODO with actual appointment creation logic.

### 5.5 Verification Checklist

- [ ] Refund calculation includes PENDING
- [ ] Slot overlap detection covers all cases
- [ ] Webhook idempotency prevents duplicates
- [ ] LemonSqueezy creates appointments
- [ ] Concurrent refund test passes

---

## 6. Phase 4: Rate Limiting

**Timeline:** Days 11-13
**Owner:** Backend/Security Team

### 6.1 Add Auth Endpoint Rate Limits

**File:** `app/api/auth/register/route.ts`

```typescript
import { RATE_LIMITS } from "@/lib/ratelimit";

export async function POST(req: NextRequest) {
  const ip = req.ip || "unknown";
  const { success } = await RATE_LIMITS.AUTH_REGISTER.limit(ip);

  if (!success) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }
  // Continue...
}
```

Apply similar to:

- `/api/auth/forgot-password`
- `/api/auth/reset-password`

### 6.2 Add Webhook Rate Limits

**Files:** `app/api/webhooks/*/route.ts`

```typescript
const { success } = await RATE_LIMITS.WEBHOOK.limit(gateway);
if (!success) {
  return NextResponse.json({ error: "Rate limited" }, { status: 429 });
}
```

### 6.3 Add Query Complexity Limits

```typescript
// lib/queryLimits.ts
export const QUERY_LIMITS = {
  MAX_PAGE_SIZE: 100,
  DEFAULT_PAGE_SIZE: 20,
  MAX_DATE_RANGE_DAYS: 90,
};

// Apply in list endpoints
const limit = Math.min(
  Math.max(parseInt(searchParams.get("limit") || "20"), 1),
  QUERY_LIMITS.MAX_PAGE_SIZE,
);
```

### 6.4 Verification Checklist

- [ ] Auth endpoints rate limited
- [ ] Webhook endpoints rate limited
- [ ] Pagination limits enforced
- [ ] Date range limits enforced
- [ ] 429 responses returned correctly

---

## 7. Phase 5: Scaling Architecture

**Timeline:** Days 14-21
**Owner:** Platform Team

### 7.1 Implement Redis Caching

```typescript
// lib/cache.ts
export async function withCache<T>(
  key: string,
  ttl: number,
  fn: () => Promise<T>,
): Promise<T> {
  const cached = await redis.get<T>(key);
  if (cached) return cached;

  const result = await fn();
  await redis.setex(key, ttl, result);
  return result;
}
```

Apply to:

- Consultant profiles
- Availability data
- Domain/subdomain lists

### 7.2 Optimize Session Callback

Remove DB query from session callback, store data in JWT.

### 7.3 Implement Background Jobs

Set up Inngest for:

- Webhook processing
- Email sending
- Cleanup jobs

### 7.4 Add Monitoring

- Set up Vercel Analytics
- Configure alerting thresholds
- Add structured logging

### 7.5 Verification Checklist

- [ ] Cache hit rate > 80%
- [ ] Session callback has no DB queries
- [ ] Background jobs processing correctly
- [ ] Alerts firing appropriately
- [ ] Logs structured and searchable

---

## 8. Testing Requirements

### 8.1 Security Tests

```bash
# Test authentication
curl -X GET http://localhost:3000/api/user/123
# Expected: 401 Unauthorized

# Test authorization
curl -X DELETE http://localhost:3000/api/appointments/123/cancel \
  -H "Authorization: Bearer <other_user_token>"
# Expected: 403 Forbidden
```

### 8.2 Load Tests

```javascript
// k6 load test
import http from "k6/http";

export const options = {
  stages: [
    { duration: "1m", target: 50 },
    { duration: "3m", target: 100 },
    { duration: "1m", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
  },
};
```

### 8.3 Concurrency Tests

```typescript
// Test double booking prevention
async function testConcurrentBooking() {
  const promises = Array(10)
    .fill(null)
    .map(() => bookSlot(sameSlotParams));
  const results = await Promise.allSettled(promises);
  const successes = results.filter((r) => r.status === "fulfilled");
  expect(successes.length).toBe(1);
}
```

---

## 9. Rollout Strategy

### 9.1 Pre-Launch Checklist

- [ ] All P0 issues resolved
- [ ] All P1 issues resolved or have workarounds
- [ ] Security audit passed
- [ ] Load testing completed (100 concurrent users)
- [ ] Monitoring dashboards operational
- [ ] Alerting configured and tested
- [ ] Backup and recovery tested
- [ ] Incident response plan documented

### 9.2 Phased Rollout

**Week 1: Internal Testing**

- Deploy to staging
- Internal team testing
- Fix critical bugs

**Week 2: Beta Users**

- Deploy to production with feature flags
- Invite 50-100 beta users
- Monitor closely
- Fix issues

**Week 3: Soft Launch**

- Remove feature flags
- Limit signups (1000 users)
- Active monitoring
- Performance tuning

**Week 4+: General Availability**

- Open signups
- Scale infrastructure as needed
- Continue monitoring

### 9.3 Rollback Plan

1. Monitor error rates (threshold: 1%)
2. If exceeded, revert deployment
3. If database migration involved, restore from backup
4. Communicate with affected users

---

## Appendix: Quick Reference

### Command Reference

```bash
# Run security scan
npm run security:scan

# Apply database migrations
npx prisma migrate deploy

# Run load tests
k6 run loadtest.js

# Check query performance
npx prisma studio
```

### Monitoring URLs

- Vercel Dashboard: `https://vercel.com/team/project`
- Database: `https://app.supabase.com/project/xxx`
- Redis: `https://console.upstash.com`
- Stream: `https://dashboard.getstream.io`

### Emergency Contacts

| Role          | Responsibility            |
| ------------- | ------------------------- |
| Backend Lead  | Database issues, API bugs |
| Security Lead | Security incidents        |
| DevOps        | Infrastructure issues     |
| Product       | User communication        |

---

## Document References

| #   | Document                    | Focus Area                                   |
| --- | --------------------------- | -------------------------------------------- |
| 01  | security-vulnerabilities.md | Authentication, Authorization, Data Exposure |
| 02  | database-performance.md     | Indexes, N+1, Race Conditions, Pooling       |
| 03  | payment-system.md           | Webhooks, Refunds, Disputes, Fraud           |
| 04  | rate-limiting-ddos.md       | Rate Limits, DDoS Protection                 |
| 05  | scaling-architecture.md     | Caching, Jobs, Sessions, Infrastructure      |
| 06  | implementation-roadmap.md   | This document                                |
