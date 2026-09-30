# API Endpoints

This document provides a comprehensive reference for all Stream-related API endpoints including request/response formats, authentication requirements, and usage examples.

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Channel Management](#channel-management)
- [User Search](#user-search)
- [Debug and Monitoring](#debug-and-monitoring)
- [Synchronization](#synchronization)
- [Error Handling](#error-handling)

---

## Overview

All Stream API endpoints are located under the `/api/stream/*` path and follow REST conventions.

### Base URL

**Development:**

```
http://localhost:3000/api/stream
```

**Production:**

```
https://your-domain.com/api/stream
```

### Common Response Format

**Success Response:**

```typescript
{
  success: true,
  data?: any,
  message?: string
}
```

**Error Response:**

```typescript
{
  success: false,
  error: string,
  details?: string
}
```

### HTTP Status Codes

| Code | Meaning               | Usage                             |
| ---- | --------------------- | --------------------------------- |
| 200  | OK                    | Successful GET request            |
| 201  | Created               | Successful POST creation          |
| 400  | Bad Request           | Invalid request parameters        |
| 401  | Unauthorized          | Missing or invalid authentication |
| 403  | Forbidden             | Insufficient permissions          |
| 404  | Not Found             | Resource doesn't exist            |
| 500  | Internal Server Error | Server-side error                 |

---

## Authentication

Most endpoints require an authenticated Better Auth session.

### Session-Based Authentication

**How it Works:**

The app uses **Better Auth** (`lib/auth.ts`). There is no NextAuth and no
`app/api/auth/[...nextauth]/options` — that path does not exist. Routes call the
memoized helper from `@/lib/auth-server`, which wraps `auth.api.getSession({ headers })`
once per request:

```typescript
import { getSession } from "@/lib/auth-server";

// In API route
const session = await getSession();

if (!session?.user?.id) {
  return NextResponse.json(
    { success: false, error: "Unauthorized" },
    { status: 401 },
  );
}
```

`getSession(true)` disables the cookie cache, which freshness-sensitive routes
(recording start/stop, consent) pass. `getCachedSession()` is the 5-minute-cached
twin. The raw `auth.api.getSession({ headers: await headers() })` form still works;
it just skips the memo, so a render path that calls both pays for two sessions.

**Client-Side Request:**

```typescript
// Better Auth includes the session cookie automatically
const response = await fetch("/api/stream/search?term=john");
```

### Secret-Based Authentication

**No Stream endpoint authenticates with a `?secret=` query parameter**, and
`STREAM_SYNC_SECRET` is read by nothing in the codebase — it is not in
`.env.sample` and no module reads it. The one route that takes a secret does so
as a _second_ factor on top of a session, and against its own variable:
`/api/stream/debug` requires `STREAM_DEBUG_SECRET` and fails closed when it is
unset (`app/api/stream/debug/route.ts:52-65`).

The background user sync is **not an HTTP endpoint at all** — it is a GitHub
Actions job (see [Synchronization](#synchronization) below).

---

## Channel Management

### POST /api/stream/channels/create

Creates a new Stream Chat channel for events or custom purposes.

**Location:** `/app/api/stream/channels/create/route.ts`

**Authentication:** Required (Session)

**Request Body (Event-Based):**

```typescript
{
  channelType: "team" | "messaging",
  eventType: "webinar" | "class" | "consultation" | "subscription",
  eventId: string,
  createdById: string
}
```

**Request Body (Custom Channel):**

```typescript
{
  channelType: "team" | "messaging",
  channelName: string,
  members?: string[],
  createdById: string,
  additionalData?: Record<string, any>
}
```

**Response (Success - 200):**

```typescript
{
  success: true,
  data: {
    channel: {
      id: string,
      type: string,
      cid: string,
      created_by: {
        id: string,
        name: string
      },
      member_count: number,
      // ... other channel properties
    }
  },
  message: string
}
```

**Response (Error - 400/500):**

```typescript
{
  success: false,
  error: string
}
```

#### Example: Create Webinar Channel

**Request:**

```typescript
const response = await fetch("/api/stream/channels/create", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    channelType: "team",
    eventType: "webinar",
    eventId: "webinar-123",
    createdById: "user-456",
  }),
});

const result = await response.json();
console.log(result);
```

**Response:**

```json
{
  "success": true,
  "data": {
    "channel": {
      "id": "webinar-webinar-123",
      "type": "team",
      "cid": "team:webinar-webinar-123",
      "created_by": {
        "id": "user-456",
        "name": "John Doe"
      },
      "member_count": 15,
      "name": "Advanced Web Development Webinar"
    }
  },
  "message": "Webinar channel created successfully"
}
```

#### Example: Create Custom Channel

**Request:**

```typescript
const response = await fetch("/api/stream/channels/create", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    channelType: "messaging",
    channelName: "Project Discussion",
    members: ["user-123", "user-456", "user-789"],
    createdById: "user-123",
    additionalData: {
      custom: true,
      project: "new-feature",
    },
  }),
});

const result = await response.json();
```

**Response:**

```json
{
  "success": true,
  "data": {
    "channel": {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "type": "messaging",
      "cid": "messaging:a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "Project Discussion",
      "member_count": 3,
      "custom": true,
      "project": "new-feature"
    }
  },
  "message": "Custom channel created successfully"
}
```

#### Error Cases

**Missing Required Fields:**

```json
{
  "success": false,
  "error": "channelType and createdById are required"
}
```

**Invalid Event Type:**

```json
{
  "success": false,
  "error": "Unknown event type: invalid-type"
}
```

**Custom Channel Missing Name:**

```json
{
  "success": false,
  "error": "channelName is required for custom channels"
}
```

---

## User Search

### GET /api/stream/search

Searches for users in the database and optionally checks relationship status.

**Location:** `/app/api/stream/search/route.ts`

**Authentication:** Required for relationship search

**Query Parameters:**

- `term` (required): Search term to match against name or email
- `relationships` (optional): Set to "true" to include relationship status

**Response (Success - 200):**

```typescript
{
  success: true,
  users: Array<{
    id: string,
    name: string | null,
    email: string,
    image: string | null,
    role: string,
    hasRelationship?: boolean  // Only if relationships=true
  }>
}
```

**Response (Error - 400/401/500):**

```typescript
{
  success: false,
  error: string
}
```

#### Example: Basic User Search

**Request:**

```typescript
const response = await fetch("/api/stream/search?term=john");

const result = await response.json();
console.log(result);
```

**Response:**

```json
{
  "success": true,
  "users": [
    {
      "id": "user-123",
      "name": "John Doe",
      "email": "john.doe@example.com",
      "image": "https://avatar.com/john.jpg",
      "role": "CONSULTANT"
    },
    {
      "id": "user-456",
      "name": "Johnny Smith",
      "email": "johnny@example.com",
      "image": null,
      "role": "CONSULTEE"
    }
  ]
}
```

#### Example: Search with Relationships

**Request:**

```typescript
const response = await fetch("/api/stream/search?term=jane&relationships=true");

const result = await response.json();
```

**Response:**

```json
{
  "success": true,
  "users": [
    {
      "id": "user-789",
      "name": "Jane Wilson",
      "email": "jane@example.com",
      "image": "https://avatar.com/jane.jpg",
      "role": "CONSULTANT",
      "hasRelationship": true
    },
    {
      "id": "user-012",
      "name": "Janet Brown",
      "email": "janet@example.com",
      "image": null,
      "role": "CONSULTEE",
      "hasRelationship": false
    }
  ]
}
```

**Note:** Users with `hasRelationship: true` appear first, followed by those without relationships.

#### Error Cases

**Missing Search Term:**

```json
{
  "success": false,
  "error": "Search term is required"
}
```

**Unauthorized (Relationship Search):**

```json
{
  "success": false,
  "error": "Authentication required for relationship search"
}
```

#### Automatic User Upsert

This endpoint automatically upserts found users to Stream Chat:

```typescript
// After finding users
if (users.length > 0) {
  try {
    const userIds = users.map((user) => user.id);
    await upsertUsersToStream(userIds);
    console.log(`Upserted ${users.length} users to Stream Chat`);
  } catch (upsertError) {
    console.error("Error upserting users to Stream Chat:", upsertError);
    // Continues even if upserting fails
  }
}
```

**This ensures users exist in Stream before initiating conversations.**

---

## Debug and Monitoring

### GET /api/stream/debug

Provides comprehensive debugging information about a user's Stream Chat connection state, including channels, appointments, and relationships.

**Location:** `/app/api/stream/debug/route.ts`

**Authentication:** Required (implicitly via API keys)

**Query Parameters:**

- `userId` (required): The user ID to debug

**Response (Success - 200):**

```typescript
{
  success: true,
  user: {
    id: string,
    name: string | null,
    email: string,
    role: string,
    consultantProfileId: string | null,
    consulteeProfileId: string | null
  },
  channels: Array<{
    id: string,
    type: string,
    name?: string,
    members: string[],
    memberCount: number,
    messageCount: number,
    lastMessage: any,
    data: any
  }>,
  consultations: Array<{
    id: string,
    status: string,
    consultationPlanId: string,
    consultationPlanTitle: string,
    consultantId: string,
    consulteeId: string
  }>,
  subscriptions: Array<{
    id: string,
    status: string,
    subscriptionPlanId: string,
    subscriptionPlanTitle: string,
    consultantId: string,
    consulteeId: string
  }>,
  webinars: Array<{
    id: string,
    status: string,
    webinarPlanId: string,
    webinarPlanTitle: string,
    consultantId: string,
    participantIds: string[],
    appointmentParticipantIds: string[],
    participantBreakdown: {
      fromAppointments: number,
      totalUnique: number
    }
  }>,
  classes: Array<{
    id: string,
    status: string,
    classPlanId: string,
    classPlanTitle: string,
    consultantId: string,
    participantIds: string[],
    appointmentParticipantIds: string[],
    participantBreakdown: {
      fromAppointments: number,
      totalUnique: number
    }
  }>
}
```

**Response (Error - 400/404/500):**

```typescript
{
  success: false,
  error: string
}
```

#### Example Request

**Request:**

```typescript
const response = await fetch("/api/stream/debug?userId=user-123");

const result = await response.json();
console.log(result);
```

**Response:**

```json
{
  "success": true,
  "user": {
    "id": "user-123",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "CONSULTANT",
    "consultantProfileId": "consultant-456",
    "consulteeProfileId": null
  },
  "channels": [
    {
      "id": "webinar-web-789",
      "type": "team",
      "name": "Advanced React Workshop",
      "members": ["user-123", "user-456", "user-789"],
      "memberCount": 3,
      "messageCount": 47,
      "lastMessage": {
        "text": "Great session today!",
        "user": { "id": "user-456" },
        "created_at": "2025-11-28T15:30:00Z"
      }
    }
  ],
  "consultations": [
    {
      "id": "consult-001",
      "status": "APPROVED",
      "consultationPlanId": "plan-123",
      "consultationPlanTitle": "Career Coaching Session",
      "consultantId": "user-123",
      "consulteeId": "user-456"
    }
  ],
  "subscriptions": [],
  "webinars": [
    {
      "id": "webinar-789",
      "status": "ACTIVE",
      "webinarPlanId": "plan-789",
      "webinarPlanTitle": "Advanced React Workshop",
      "consultantId": "user-123",
      "participantIds": ["user-456", "user-789", "user-012"],
      "appointmentParticipantIds": ["user-789", "user-012"],
      "participantBreakdown": {
        "fromAppointments": 2,
        "totalUnique": 3
      }
    }
  ],
  "classes": []
}
```

#### Error Cases

**Missing User ID:**

```json
{
  "success": false,
  "error": "userId is required"
}
```

**User Not Found:**

```json
{
  "success": false,
  "error": "User not found"
}
```

**Stream API Not Configured:**

```json
{
  "success": false,
  "error": "Stream API keys not configured"
}
```

#### Use Cases

1. **Troubleshooting:** Verify user's channel memberships and permissions
2. **Support:** Check why a user can't see certain channels
3. **Development:** Inspect relationship data and channel state
4. **Monitoring:** Verify appointment-channel synchronization

---

## Synchronization

### There is no `/api/stream/sync/*` endpoint

`POST /api/stream/sync/manual` and `POST /api/stream/sync/background` **do not
exist**, and `STREAM_SYNC_SECRET` is not a variable anything reads. The Stream
user sync is a **GitHub Actions job**, not an HTTP route.

**The real chain:**

| Layer          | Path                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| Workflow       | `.github/workflows/stream-sync.yml` — daily at `40 3 * * *` UTC                  |
| Job wrapper    | `jobs/stream/stream-sync.ts` — GitHub Actions outputs, Sentry, maintenance abort |
| Implementation | `scripts/stream/stream-sync.ts` — `performStreamUserSync()`                      |

```bash
# what the workflow actually runs
node_modules/.bin/tsx jobs/stream/stream-sync.ts
```

```typescript
// what the wrapper calls
import {
  performStreamUserSync,
  printSyncSummary,
} from "../../scripts/stream/stream-sync";
```

**Authentication:** the workflow's own `GITHUB_TOKEN` and the repository secrets
it declares. There is no shared secret to configure, which is why adding
`STREAM_SYNC_SECRET` to an environment is a no-op and why the pre-production
checklists that asked for it were wrong.

**Paging:** `scripts/ci/notify-ops-failure.sh "stream-sync"` runs in the
workflow's failure path.

**To run it by hand**, invoke the script directly rather than looking for a
route:

```bash
npx tsx jobs/stream/stream-sync.ts
```

The one HTTP route in this neighbourhood is **`POST /api/stream/recordings/sync`**,
which is unrelated: it syncs _recordings_ for the caller's own sessions, takes a
Better Auth session, and is rate-limited per user.

See `09-background-sync.md` for what the job does and how it is tuned.

---

## Error Handling

### Standard Error Format

All endpoints follow a consistent error format:

```typescript
{
  success: false,
  error: string,        // User-friendly error message
  details?: string      // Technical details (optional)
}
```

### Common Error Responses

#### 400 Bad Request

**Missing Parameters:**

```json
{
  "success": false,
  "error": "channelType and createdById are required"
}
```

**Invalid Parameters:**

```json
{
  "success": false,
  "error": "Unknown event type: invalid-type"
}
```

#### 401 Unauthorized

**Missing Session:**

```json
{
  "success": false,
  "error": "Unauthorized"
}
```

**Invalid Secret:**

```json
{
  "error": "Unauthorized"
}
```

#### 403 Forbidden

**Permission Denied:**

```json
{
  "success": false,
  "error": "Cannot generate token for other users"
}
```

#### 404 Not Found

**Resource Missing:**

```json
{
  "success": false,
  "error": "User not found"
}
```

#### 500 Internal Server Error

**Configuration Error:**

```json
{
  "success": false,
  "error": "Stream API keys not configured"
}
```

**Database Error:**

```json
{
  "error": "Internal Server Error",
  "details": "Database connection failed"
}
```

**Stream API Error:**

```json
{
  "success": false,
  "error": "Failed to create channel",
  "details": "Stream API timeout"
}
```

### Client-Side Error Handling

**Example:**

```typescript
async function createChannel(channelData: ChannelData) {
  try {
    const response = await fetch("/api/stream/channels/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(channelData),
    });

    const result = await response.json();

    if (!response.ok) {
      // Handle HTTP errors
      throw new Error(result.error || "Request failed");
    }

    if (!result.success) {
      // Handle application errors
      throw new Error(result.error);
    }

    return result.data;
  } catch (error) {
    console.error("Channel creation failed:", error);
    // Show user-friendly error message
    toast.error(error.message || "Failed to create channel");
    throw error;
  }
}
```

### Retry Strategy

**Example with Exponential Backoff:**

```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
): Promise<Response> {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Don't retry on client errors (4xx)
      if (response.status >= 400 && response.status < 500) {
        return response;
      }

      // Return on success or server error that should not be retried
      if (response.ok || response.status === 500) {
        return response;
      }

      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      console.warn(`Attempt ${attempt}/${maxRetries} failed:`, error);

      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// Usage
const response = await fetchWithRetry("/api/stream/search?term=john", {
  method: "GET",
});
```

### Rate Limiting

**Recommended Client-Side Rate Limiting:**

```typescript
class RateLimiter {
  private queue: Array<() => Promise<any>> = [];
  private processing = false;
  private requestsPerSecond: number;
  private delay: number;

  constructor(requestsPerSecond: number = 5) {
    this.requestsPerSecond = requestsPerSecond;
    this.delay = 1000 / requestsPerSecond;
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.process();
    });
  }

  private async process() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const fn = this.queue.shift()!;
      await fn();
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    }

    this.processing = false;
  }
}

// Usage
const limiter = new RateLimiter(5); // 5 requests per second

const results = await Promise.all(
  userIds.map((userId) =>
    limiter.add(() => fetch(`/api/stream/search?term=${userId}`)),
  ),
);
```

---

## Related Documentation

- [User Management](./07-user-management.md)
- [Token Management](./08-token-management.md)
- [Background Sync](./09-background-sync.md)
