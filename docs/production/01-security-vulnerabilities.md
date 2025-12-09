# Security Vulnerabilities - Production Readiness

> **Severity Level:** CRITICAL
> **Last Updated:** 2024
> **Status:** Requires Immediate Attention

## Executive Summary

This document outlines critical security vulnerabilities identified in the application that must be addressed before production deployment. The most severe finding is that **77 out of 83 API endpoints (93%) lack proper authentication checks**.

---

## Table of Contents

1. [Missing Authentication](#1-missing-authentication)
2. [Missing Authorization](#2-missing-authorization)
3. [Sensitive Data Exposure](#3-sensitive-data-exposure)
4. [Input Validation Gaps](#4-input-validation-gaps)
5. [Authentication Security Issues](#5-authentication-security-issues)
6. [CSRF & Session Security](#6-csrf--session-security)
7. [Remediation Checklist](#7-remediation-checklist)

---

## 1. Missing Authentication

### 1.1 Overview

| Metric | Value |
|--------|-------|
| Total API Endpoints | 83 |
| Protected Endpoints | 6 |
| Unprotected Endpoints | 77 |
| **Risk Level** | CRITICAL |

### 1.2 Critical Unprotected Endpoints

#### User Data Endpoints

| Endpoint | Method | Risk | Impact |
|----------|--------|------|--------|
| `/api/user/[id]` | GET | CRITICAL | Auth commented out - any user's profile accessible |
| `/api/user/consultants` | GET | HIGH | User enumeration, data scraping |
| `/api/user/consultees` | GET | HIGH | User enumeration, PII exposure |
| `/api/user/consultees/[id]` | GET/POST | CRITICAL | Read/create any consultee profile |
| `/api/user/consultants/[id]` | GET | HIGH | Auth commented out (lines 86-89) |
| `/api/user/reviews` | POST | HIGH | Create fake reviews without auth |
| `/api/user/staff` | GET | MEDIUM | Staff enumeration |

**File References:**
- `app/api/user/[id]/route.ts` - Lines 13-16 (commented auth)
- `app/api/user/consultants/[id]/route.ts` - Lines 86-89 (commented auth)
- `app/api/user/consultees/[id]/route.ts` - Lines 4-40

#### Event & Plan Endpoints

| Endpoint | Method | Risk | Impact |
|----------|--------|------|--------|
| `/api/events/classes` | GET/POST | HIGH | Enumerate/create classes |
| `/api/events/consultations` | GET/PATCH | HIGH | Query any consultation |
| `/api/events/subscriptions` | GET | HIGH | View all subscriptions |
| `/api/events/webinars` | GET | HIGH | View all webinars |
| `/api/plans/classes` | GET/POST | HIGH | Create plans for any consultant |
| `/api/plans/consultations` | GET/POST | HIGH | Create plans for any consultant |
| `/api/plans/subscriptions` | GET/POST | HIGH | Create plans for any consultant |
| `/api/plans/webinars` | GET/POST | HIGH | Create plans for any consultant |

#### Participant Management

| Endpoint | Method | Risk | Impact |
|----------|--------|------|--------|
| `/api/participants/subscriptions/[id]` | GET/DELETE | CRITICAL | Delete any participant |
| `/api/participants/class/[id]` | GET | MEDIUM | View participant lists |
| `/api/participants/consultations/[id]` | GET | MEDIUM | View participant details |
| `/api/participants/webinar/[id]` | GET | MEDIUM | View participant lists |

#### Slots & Appointments

| Endpoint | Method | Risk | Impact |
|----------|--------|------|--------|
| `/api/slots/appointments` | GET/POST | CRITICAL | View/create any appointments |
| `/api/slots/availability/[consultantId]` | GET | MEDIUM | Query any availability |
| `/api/slots/unallocated/*` | GET | LOW | View unallocated slots |

#### Dashboard Endpoints

| Endpoint | Method | Risk | Impact |
|----------|--------|------|--------|
| `/api/dashboard/consultant/[id]` | GET | CRITICAL | Full consultant data access |
| `/api/dashboard/consultant/[id]/requests` | GET | HIGH | View all requests |
| `/api/dashboard/consultant/[id]/planner` | GET | HIGH | View schedule |
| `/api/dashboard/consultee/[id]` | GET | CRITICAL | Full consultee data access |
| `/api/dashboard/consultee/[id]/events` | GET | HIGH | View all events |

#### Stream/Chat Endpoints

| Endpoint | Method | Risk | Impact |
|----------|--------|------|--------|
| `/api/stream/debug` | GET | CRITICAL | Full user data dump |
| `/api/stream/channels/create` | POST | CRITICAL | Create channels as anyone |
| `/api/stream/sync/background` | GET | MEDIUM | Trigger sync operations |
| `/api/stream/sync/manual` | GET | MEDIUM | Trigger sync operations |

#### Form Endpoints

| Endpoint | Method | Risk | Impact |
|----------|--------|------|--------|
| `/api/form/onboarding/[id]` | PATCH | CRITICAL | Modify any user's onboarding |

### 1.3 Remediation

#### Immediate Fix Template

```typescript
// Add to EVERY unprotected endpoint
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Continue with authenticated logic
}
```

#### Uncomment Existing Auth

**File:** `app/api/user/[id]/route.ts`
```typescript
// UNCOMMENT THESE LINES (13-16):
const session = await getServerSession(authOptions);
if (!session || (session.user.id !== id && session.user.role !== 'ADMIN')) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

**File:** `app/api/user/consultants/[id]/route.ts`
```typescript
// UNCOMMENT THESE LINES (86-89):
const session = await getServerSession(authOptions);
if (!session) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

---

## 2. Missing Authorization

### 2.1 Overview

Even when authentication exists, many endpoints don't verify the user has permission to access the specific resource.

### 2.2 Affected Endpoints

#### Resource Ownership Not Verified

| Endpoint | Issue | File Location |
|----------|-------|---------------|
| `/api/appointments/[id]/cancel` | Any user can cancel any appointment | `app/api/appointments/[appointmentId]/cancel/route.ts:6-16` |
| `/api/events/classes` | Can query by any `consulteeProfileId` | `app/api/events/classes/route.ts` |
| `/api/slots/appointments` | Accepts any `consultantProfileId` | `app/api/slots/appointments/route.ts` |
| `/api/user/consultants/[id]` | PUT doesn't verify ownership | `app/api/user/consultants/[id]/route.ts:172` |

### 2.3 Remediation

#### Authorization Check Pattern

```typescript
export async function POST(
  request: NextRequest,
  { params }: { params: { appointmentId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appointmentId } = await params;
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: { include: { requestedBy: true } },
      subscription: { include: { requestedBy: true } }
    }
  });

  // AUTHORIZATION CHECK - Verify ownership
  const isOwner =
    appointment?.consultation?.requestedBy?.userId === session.user.id ||
    appointment?.subscription?.requestedBy?.userId === session.user.id ||
    session.user.consultantProfileId === appointment?.consultation?.consultationPlan?.consultantProfileId;

  const isAdmin = session.user.role === 'ADMIN' || session.user.role === 'STAFF';

  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Proceed with operation
}
```

---

## 3. Sensitive Data Exposure

### 3.1 Password Hash in API Response

**Severity:** CRITICAL
**File:** `app/api/dashboard/consultant/[consultantId]/route.ts`
**Lines:** 84-94

```typescript
// CURRENT CODE - VULNERABLE
user: {
  id: u.id,
  name: u.name,
  password: u.password || null,           // REMOVE THIS
  passwordResetToken: u.passwordResetToken || null,  // REMOVE THIS
  passwordResetExpires: u.passwordResetExpires || null // REMOVE THIS
}
```

**Fix:**
```typescript
// SECURE CODE
user: {
  id: u.id,
  name: u.name,
  email: u.email,
  image: u.image,
  // NEVER include password fields
}
```

### 3.2 Detailed Error Messages

**File:** `app/api/form/onboarding/[id]/route.ts`
**Lines:** 26-39

```typescript
// CURRENT - Leaks implementation details
catch (error: unknown) {
  console.error("Error stack:", error.stack);
  return NextResponse.json({
    error: error instanceof Error ? error.message : "An error occurred"
  }, { status: 500 });
}

// FIXED - Generic error for client
catch (error: unknown) {
  console.error("Onboarding error:", error); // Log full error server-side
  return NextResponse.json({
    error: "An error occurred while processing your request"
  }, { status: 500 });
}
```

### 3.3 Debug Endpoint Exposure

**File:** `app/api/stream/debug/route.ts`

This endpoint returns comprehensive user data without authentication:
- All chat channels
- All consultations with full details
- All subscriptions
- All webinars with participants
- All classes with participants

**Fix:** Either remove this endpoint or add strict admin-only authentication.

---

## 4. Input Validation Gaps

### 4.1 Missing Validation

| Endpoint | Issue | Risk |
|----------|-------|------|
| `/api/user/[id]` PUT | No length limits on name, phone, address | Data corruption |
| `/api/plans/consultations` POST | Only existence check, no type validation | Invalid data |
| Multiple endpoints | No pagination limits | Resource exhaustion |

### 4.2 Integer Overflow Risk

```typescript
// CURRENT - No bounds checking
const limit = parseInt(searchParams.get("limit") || "10");
const page = parseInt(searchParams.get("page") || "1");
const skip = (page - 1) * limit; // Could overflow

// FIXED - Add bounds
const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "10"), 1), 100);
const page = Math.max(parseInt(searchParams.get("page") || "1"), 1);
const skip = (page - 1) * limit;
```

### 4.3 Date Parsing

**File:** `app/api/slots/appointments/route.ts:154-155`

```typescript
// CURRENT - No validation
{ startsAt: { lt: new Date(endDate) } },

// FIXED - Validate dates
const parsedEndDate = new Date(endDate);
if (isNaN(parsedEndDate.getTime())) {
  return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
}
```

---

## 5. Authentication Security Issues

### 5.1 Weak Password Reset Token

**File:** `app/api/auth/reset-password/route.ts:19-41`

```typescript
// CURRENT - Inefficient, not timing-safe
const usersWithToken = await prisma.user.findMany({
  where: {
    passwordResetToken: { not: null },
    passwordResetExpires: { gte: new Date() }
  }
});

let user = null;
for (const potentialUser of usersWithToken) {
  const tokenMatch = await bcrypt.compare(token, potentialUser.passwordResetToken!);
  if (tokenMatch) {
    user = potentialUser;
    break;
  }
}
```

**Issues:**
- Fetches ALL users with reset tokens
- Not constant-time comparison
- Allows enumeration

**Fix:**
```typescript
// Better approach: Hash token and query directly
import crypto from 'crypto';

const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const user = await prisma.user.findFirst({
  where: {
    passwordResetToken: tokenHash,
    passwordResetExpires: { gte: new Date() }
  }
});
```

### 5.2 Hardcoded Test User ID

**File:** `utils/auth.ts:4-15`

```typescript
// VULNERABLE - Exposed test user
export function getEffectiveUserId(session: Session | null): string | undefined {
  if (session?.user?.id) {
    return session.user.id;
  } else if (
    process.env.NODE_ENV === "test" ||
    process.env.NODE_ENV === "development"
  ) {
    return process.env.NEXT_PUBLIC_TEST_USERID; // Public env var!
  }
}
```

**Risk:** Test user ID could be used for unauthorized access if NODE_ENV not properly set.

**Fix:** Remove fallback or use server-only env var.

---

## 6. CSRF & Session Security

### 6.1 Middleware Bypass in Development

**File:** `middleware.ts:123-125`

```typescript
// DANGEROUS - Bypasses ALL auth in dev/test
if (process.env.NODE_ENV !== "production") {
  return NextResponse.next();
}
```

**Risk:** If NODE_ENV not explicitly "production", all auth is bypassed.

### 6.2 Token Cache Invalidation

**File:** `middleware.ts:47-94`

- Token cache stores JWT info in memory
- 1-minute TTL
- No invalidation on logout
- Could allow access after logout for up to 1 minute

---

## 7. Remediation Checklist

### Priority 1: Critical (Fix Immediately)

- [ ] Add authentication to 77 unprotected endpoints
- [ ] Uncomment disabled auth in `/api/user/[id]` and `/api/user/consultants/[id]`
- [ ] Remove password fields from API responses
- [ ] Add authorization (ownership) checks to resource endpoints
- [ ] Remove or protect `/api/stream/debug` endpoint
- [ ] Protect `/api/form/onboarding/[id]` PATCH endpoint

### Priority 2: High (Fix This Week)

- [ ] Add input validation schemas (Zod) to all endpoints
- [ ] Add pagination limits (max 100)
- [ ] Sanitize error messages in production
- [ ] Fix password reset token implementation
- [ ] Remove test user fallback from `getEffectiveUserId`

### Priority 3: Medium (Fix This Sprint)

- [ ] Add field-level authorization
- [ ] Implement request logging for security events
- [ ] Add security headers (CSP, HSTS, X-Frame-Options)
- [ ] Review all TODO comments for security gaps
- [ ] Add token cache invalidation on logout

---

## Appendix: Affected Files

```
app/api/user/[id]/route.ts
app/api/user/consultants/route.ts
app/api/user/consultants/[id]/route.ts
app/api/user/consultees/route.ts
app/api/user/consultees/[id]/route.ts
app/api/user/reviews/route.ts
app/api/user/staff/route.ts
app/api/events/classes/route.ts
app/api/events/consultations/route.ts
app/api/events/subscriptions/route.ts
app/api/events/webinars/route.ts
app/api/plans/classes/route.ts
app/api/plans/consultations/route.ts
app/api/plans/subscriptions/route.ts
app/api/plans/webinars/route.ts
app/api/participants/subscriptions/[subscriptionId]/route.ts
app/api/participants/class/[classId]/route.ts
app/api/participants/consultations/[consultationId]/route.ts
app/api/participants/webinar/[webinarId]/route.ts
app/api/slots/appointments/route.ts
app/api/slots/availability/[consultantId]/route.ts
app/api/dashboard/consultant/[consultantId]/route.ts
app/api/dashboard/consultant/[consultantId]/requests/route.ts
app/api/dashboard/consultant/[consultantId]/planner/route.ts
app/api/dashboard/consultee/[consulteeId]/route.ts
app/api/dashboard/consultee/[consulteeId]/events/route.ts
app/api/stream/debug/route.ts
app/api/stream/channels/create/route.ts
app/api/stream/sync/background/route.ts
app/api/stream/sync/manual/route.ts
app/api/form/onboarding/[id]/route.ts
utils/auth.ts
middleware.ts
```
