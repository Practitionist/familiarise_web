# Stream Chat & Video - Bugs and Issues

This document catalogs all bugs, issues, and recommended fixes found during the codebase audit.

---

## Table of Contents
1. [Critical Bugs](#critical-bugs)
2. [High Priority Issues](#high-priority-issues)
3. [Medium Priority Issues](#medium-priority-issues)
4. [Low Priority Issues](#low-priority-issues)
5. [UpsertUsersToStream Flow Analysis](#upsertusersstostream-flow-analysis)
6. [Admin Role Analysis](#admin-role-analysis)

---

## Critical Bugs

### BUG-001: Channel Comparison Using Wrong Property

**File:** `components/chat/ChatSidebar.tsx:455`

**Description:**
The channel event handler compares `ch.cid` with `event.channel?.id`, but these properties have different formats:
- `cid` format: `"team:channel-123"` (includes type prefix)
- `id` format: `"channel-123"` (just the channel ID)

This causes channel updates to fail matching and not reflect in the UI.

**Current Code:**
```typescript
prev.map((ch) => ch.cid === event.channel?.id ? updatedChannel : ch)
```

**Impact:**
- Channel updates (new messages, member changes) may not reflect in the sidebar
- Users may see stale channel data
- Real-time updates could be missed

**Fix:**
```typescript
// Option 1: Compare cid to cid
prev.map((ch) => ch.cid === event.channel?.cid ? updatedChannel : ch)

// Option 2: Compare id to id
prev.map((ch) => ch.id === event.channel?.id ? updatedChannel : ch)
```

**Priority:** CRITICAL
**Effort:** Low (5 minutes)

---

### BUG-002: Universal Admin Role in Stream

**File:** `lib/user.ts:98-115`

**Description:**
ALL users receive "admin" role in Stream Chat regardless of their actual role in the application. This is a documented known issue but represents a significant security concern.

**Current Code:**
```typescript
export function mapRoleToStream(role: string | null | undefined): string {
  if (!role) return "admin"; // Default to admin for team channel access

  switch (role.toUpperCase()) {
    case "ADMIN":
      return "admin";
    case "CONSULTANT":
      return "admin";  // Should be custom role
    case "CONSULTEE":
      return "admin";  // Should be "user" or custom role
    case "USER":
      return "admin";
    default:
      return "admin";
  }
}
```

**Impact:**
- All users have full permissions (create, read, update, delete channels)
- No permission differentiation between user types
- Users can modify channels they shouldn't have access to
- Security vulnerability for data integrity

**Fix:**
```typescript
export function mapRoleToStream(role: string | null | undefined): string {
  if (!role) return "user"; // Default to basic user

  switch (role.toUpperCase()) {
    case "ADMIN":
      return "admin";
    case "CONSULTANT":
      return "channel_moderator"; // Can moderate their event channels
    case "CONSULTEE":
      return "user"; // Basic user permissions
    case "STAFF":
      return "admin"; // Staff needs admin access
    default:
      return "user";
  }
}
```

**Additional Steps Required:**
1. Configure custom roles in Stream Dashboard (Chat > Roles & Permissions)
2. Create "channel_moderator" role with appropriate permissions
3. Test role changes in staging environment first

**Reference:** [Stream Permissions v2 Documentation](https://getstream.io/chat/docs/react/user_permissions/)

**Priority:** CRITICAL
**Effort:** Medium (requires Stream Dashboard configuration)

---

## High Priority Issues

### ISSUE-001: ReactQueryProvider SSR Hydration Issue

**File:** `providers/ReactQueryProvider.tsx:7`

**Description:**
QueryClient is created outside the component, which can cause SSR hydration mismatches in Next.js.

**Current Code:**
```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
    },
  },
});
```

**Impact:**
- Potential hydration errors in production
- SSR data may not persist correctly
- Memory leaks in SSR contexts

**Fix:**
```typescript
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
```

**Priority:** HIGH
**Effort:** Low (10 minutes)

---

### ISSUE-002: StreamProvider useEffect Missing Dependencies

**File:** `providers/StreamProvider.tsx:309`

**Description:**
The useEffect has incomplete dependencies (connectServices and disconnect are omitted). The comment acknowledges this is intentional to avoid infinite loops, but this indicates an architectural issue.

**Impact:**
- Stale closures could reference outdated state
- Token refresh might not trigger reconnection
- Connection state could become out of sync

**Fix:**
Use `useCallback` to properly memoize the functions:
```typescript
const connectServices = useCallback(async () => {
  // ... connection logic
}, [userDetails?.id, apiKey]); // Only essential dependencies

const disconnect = useCallback(async () => {
  // ... disconnect logic
}, [chatClient, videoClient]); // Only essential dependencies

useEffect(() => {
  connectServices();
  return () => { disconnect(); };
}, [connectServices, disconnect]); // Now safe to include
```

**Priority:** HIGH
**Effort:** Medium (30 minutes)

---

### ISSUE-003: API Route Missing Authentication

**File:** `app/api/stream/channels/create/route.ts`

**Description:**
The channel creation endpoint doesn't verify user authentication or authorization.

**Current Code:**
```typescript
export async function POST(req: NextRequest) {
  // No auth check before processing
  const body = await req.json();
  // ... continues to create channel
}
```

**Impact:**
- Unauthenticated users could create channels
- Potential for channel spam or abuse
- Security vulnerability

**Fix:**
```typescript
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    );
  }

  const body = await req.json();
  // ... proceed with authenticated user
}
```

**Priority:** HIGH
**Effort:** Low (15 minutes)

---

### ISSUE-004: Debug API Route Exposes Sensitive Data

**File:** `app/api/stream/debug/route.ts`

**Description:**
Debug endpoint exposes user channels, appointments, and other sensitive data without authentication.

**Impact:**
- Anyone can query any user's channels and appointments
- Information disclosure vulnerability
- Privacy concern

**Fix:**
1. Add authentication check
2. Add authorization to ensure users can only query their own data (or admin for all)
3. Consider disabling in production or requiring admin role

**Priority:** HIGH
**Effort:** Low (15 minutes)

---

## Medium Priority Issues

### ISSUE-005: Shared Token Expiration

**File:** `providers/StreamProvider.tsx:110-116`

**Description:**
Both chat and video tokens share a single `expiresAt` timestamp, but they could have different expiration times.

**Current Code:**
```typescript
setTokenCache((prev) => ({
  ...prev,
  [`${type}Token`]: newToken,
  expiresAt, // Overwrites shared expiry for both tokens
}));
```

**Fix:**
Track expiration separately for each token:
```typescript
interface TokenCache {
  chatToken: string | null;
  chatExpiresAt: number;
  videoToken: string | null;
  videoExpiresAt: number;
}
```

**Priority:** MEDIUM
**Effort:** Low (20 minutes)

---

### ISSUE-006: Sequential Channel Creation Performance

**File:** `actions/stream/chat/channel.action.ts:471-518`

**Description:**
`initializeAllChannels()` creates channels sequentially in a loop, causing slow initialization for users with many events.

**Current Code:**
```typescript
for (const webinarData of webinars) {
  await createWebinarChannel(webinarData.id);
}
```

**Fix:**
Use batching with concurrency control:
```typescript
// Use Promise.all with batching
const batchSize = 5;
for (let i = 0; i < webinars.length; i += batchSize) {
  const batch = webinars.slice(i, i + batchSize);
  await Promise.all(batch.map(w => createWebinarChannel(w.id)));
}
```

**Priority:** MEDIUM
**Effort:** Low (15 minutes)

---

### ISSUE-007: Type Assertion in Event Channel

**File:** `actions/stream/chat/event-channel.action.ts:222`

**Description:**
Uses `as any` type assertion for sorting, which bypasses type safety.

**Current Code:**
```typescript
const sort = { last_message_at: -1 } as any;
```

**Fix:**
```typescript
import { ChannelSort } from "stream-chat";
const sort: ChannelSort = { last_message_at: -1 };
```

**Priority:** MEDIUM
**Effort:** Low (5 minutes)

---

### ISSUE-008: Middleware Token Cache Memory Leak

**File:** `middleware.ts:47-51`

**Description:**
Token cache can grow indefinitely and only cleans up when size > 1000 entries.

**Fix:**
Use a more aggressive cleanup strategy:
```typescript
// Clean old entries periodically (e.g., every 100 new entries)
if (tokenCache.size > 100) {
  const cutoff = Date.now() - CACHE_TTL;
  for (const [key, value] of tokenCache.entries()) {
    if (value.timestamp < cutoff) {
      tokenCache.delete(key);
    }
  }
}
```

Or use a proper LRU cache library.

**Priority:** MEDIUM
**Effort:** Low (15 minutes)

---

## Low Priority Issues

### ISSUE-009: GitHub Actions Deprecated Syntax

**File:** `jobs/cleanup-abandoned-payments.ts:297-303`

**Description:**
Uses deprecated `set-output` command syntax for GitHub Actions.

**Current Code:**
```typescript
console.log(`::set-output name=cleaned_count::${result.cleanedCount}`);
```

**Fix:**
```typescript
import { appendFileSync } from 'fs';

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `cleaned_count=${result.cleanedCount}\n`
  );
}
```

**Priority:** LOW
**Effort:** Low (10 minutes)

---

### ISSUE-010: Inconsistent Node Version in Workflows

**File:** `.github/workflows/stream_sync.yml:27`

**Description:**
Uses Node.js 20 while other workflows use Node.js 22.

**Fix:**
Standardize to Node.js 22 across all workflows.

**Priority:** LOW
**Effort:** Low (5 minutes)

---

### ISSUE-011: Duplicate Hook Implementations

**File:** `hooks/useEvents.ts`

**Description:**
`useEvents`, `useEventsByConsultee`, and `useEventsByConsultant` have nearly identical implementations (90%+ code duplication).

**Fix:**
Create a generic fetcher hook:
```typescript
type ProfileType = 'consultant' | 'consultee';

export const useEventsFetcher = (profileType: ProfileType, profileId: string) => {
  const queryParam = profileType === 'consultant'
    ? `consultantProfileId=${profileId}`
    : `consulteeProfileId=${profileId}`;

  // ... shared implementation
};

// Usage
export const useEventsByConsultee = (id: string) => useEventsFetcher('consultee', id);
export const useEventsByConsultant = (id: string) => useEventsFetcher('consultant', id);
```

**Priority:** LOW
**Effort:** Medium (30 minutes)

---

## UpsertUsersToStream Flow Analysis

### Question: Is `upsertUsersToStream` called correctly?

**Answer:** Yes, but there's room for optimization.

### Where It's Called:

1. **StreamProvider.tsx:138** - Called on initial connection
   ```typescript
   await upsertUserToStream(userDetails.id);
   ```
   This is correct - ensures user exists in Stream before connecting.

2. **event-channel.action.ts:120, 138, 183** - Called when creating event channels
   ```typescript
   await upsertUserToStream(consultantUserId);
   await upsertUserToStream(userId);
   ```
   This ensures members exist before adding to channels.

3. **channel.action.ts:460** - Called during channel initialization
   ```typescript
   await upsertUsersToStream(uniqueUserIds);
   ```
   Batch upserts all users for a channel.

4. **api/stream/search/route.ts:59** - Called after user search
   ```typescript
   await upsertUsersToStream(userIds);
   ```
   Ensures found users are synced to Stream.

### Why You See Many Users Upserted on First Load:

On first load, the `initializeUserChannels` function:
1. Queries all user's consultations, subscriptions, webinars, and classes
2. For each entity, creates a channel if it doesn't exist
3. Each channel creation upserts all participants

This is **correct behavior** but can be optimized:

### Optimization Recommendations:

1. **Batch Upserts Before Channel Creation:**
   ```typescript
   // Collect all unique user IDs first
   const allUserIds = new Set<string>();
   webinars.forEach(w => {
     allUserIds.add(w.consultantUserId);
     w.participants.forEach(p => allUserIds.add(p.userId));
   });

   // Single batch upsert
   await upsertUsersToStream(Array.from(allUserIds));

   // Then create channels (users already exist)
   for (const webinar of webinars) {
     await createWebinarChannel(webinar.id);
   }
   ```

2. **Add Deduplication in StreamProvider:**
   Track which users have been upserted in the session to avoid redundant calls.

---

## Admin Role Analysis

### Question: Is the admin role correct/expected?

**Answer:** No, this is a known critical bug.

### Current Behavior:
- ALL users (CONSULTANT, CONSULTEE, USER, etc.) receive "admin" role in Stream
- This gives everyone full permissions to all channels

### Why This Is Wrong:
1. **Security Risk:** Users can modify channels they shouldn't access
2. **No Permission Differentiation:** Everyone has equal access
3. **Violates Principle of Least Privilege:** Users should only have permissions they need

### What Should Happen:

| Application Role | Stream Role | Permissions |
|-----------------|-------------|-------------|
| ADMIN | admin | Full access |
| STAFF | admin | Full access |
| CONSULTANT | channel_moderator | Moderate own event channels |
| CONSULTEE | user | Read/write in channels they're members of |
| USER | user | Basic permissions |

### The Fix (documented above in BUG-002):
1. Update `mapRoleToStream()` function
2. Configure custom roles in Stream Dashboard
3. Set appropriate permissions per channel type

### References:
- [Stream Permissions v2](https://getstream.io/chat/docs/react/user_permissions/)
- [Stream Application Settings](https://getstream.io/chat/docs/react/application_settings/)
- [Existing Known Issues Doc](../docs/stream/13-known-issues.md)

---

## Summary

| ID | Type | Priority | Effort | Status |
|----|------|----------|--------|--------|
| BUG-001 | Bug | CRITICAL | Low | Open |
| BUG-002 | Bug | CRITICAL | Medium | Known Issue |
| ISSUE-001 | Issue | HIGH | Low | Open |
| ISSUE-002 | Issue | HIGH | Medium | Open |
| ISSUE-003 | Security | HIGH | Low | Open |
| ISSUE-004 | Security | HIGH | Low | Open |
| ISSUE-005 | Issue | MEDIUM | Low | Open |
| ISSUE-006 | Performance | MEDIUM | Low | Open |
| ISSUE-007 | Code Quality | MEDIUM | Low | Open |
| ISSUE-008 | Memory | MEDIUM | Low | Open |
| ISSUE-009 | Deprecation | LOW | Low | Open |
| ISSUE-010 | Consistency | LOW | Low | Open |
| ISSUE-011 | Code Quality | LOW | Medium | Open |

---

## Next Steps

1. **Immediate:** Fix BUG-001 (channel comparison)
2. **This Sprint:** Fix ISSUE-001, ISSUE-003, ISSUE-004 (SSR and security)
3. **Next Sprint:** Address BUG-002 (admin role) with Stream Dashboard configuration
4. **Backlog:** Performance and code quality improvements
