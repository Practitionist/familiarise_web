# API Endpoints

This document provides a comprehensive reference for all Stream-related API endpoints including request/response formats, authentication requirements, and usage examples.

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Meeting Lifecycle Endpoints](#meeting-lifecycle-endpoints)
- [Channel Management](#channel-management)
- [User Search](#user-search)
- [Debug and Monitoring](#debug-and-monitoring)
- [Synchronization](#synchronization)
- [Error Handling](#error-handling)
- [Deprecated & Superseded Approaches](#deprecated--superseded-approaches)

---

## Overview

Stream and meeting API endpoints are located under `/api/stream/*` and `/api/meetings/[meetingId]/*` and follow REST conventions.

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
| 409  | Conflict              | Ceiling reached / invalid state   |
| 500  | Internal Server Error | Server-side error                 |

---

## Authentication

Most endpoints require an authenticated Better Auth session.

### Session-Based Authentication

**How it Works:**

```typescript
import { headers } from "next/headers";

import { auth } from "@/lib/auth";

// In API route
const session = await auth.api.getSession({ headers: await headers() });

if (!session?.user?.id) {
  return NextResponse.json(
    { success: false, error: "Unauthorized" },
    { status: 401 },
  );
}
```

**Client-Side Request:**

```typescript
// Better Auth includes the session cookie automatically
const response = await fetch("/api/stream/search?term=john");
```

### Secret-Based Authentication

Some endpoints use a secret query parameter for server-to-server authentication.

**Example:**

```typescript
const secret = searchParams.get("secret");
if (secret !== process.env.STREAM_SYNC_SECRET) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

**Usage:**

```bash
curl -X POST "https://your-domain.com/api/stream/sync/background?secret=your-secret-here"
```

---

## Meeting Lifecycle Endpoints

All meeting lifecycle routes live under `/api/meetings/[meetingId]/*`, validate `meetingId` via `guardMeetingRoute`, and resolve caller entitlement via `resolveMeetingAccess` (including transparent stale-link alias fallback from older `occurrence-<uuid>` URLs to rotated `occurrence-<uuid>-r<base36>` call segments via `parseOccurrenceIdFromCallId`).

### POST /api/meetings/[meetingId]/join

Admits an entitled participant to an existing Stream call and upserts the caller on Stream first. Accepted presenter collaborators (`CO_HOST` / `CO_INSTRUCTOR`) on a webinar or class receive `co_presenter`; all other participants receive `call_member`. Returns structured denial descriptors (`code: "TOO_EARLY" | "SESSION_ENDED" | "CONSENT_REQUIRED"`, `startsAt`, `endsAt`, `canReopen`) on HTTP `401` / `403` / `404` for `<MeetingLobbyGateCard />`, or HTTP `409` with `code: "ROOM_NOT_PROVISIONED"` when Postgres holds a `Meeting` row whose backing Stream call has not yet been minted.

**Location:** `/app/api/meetings/[meetingId]/join/route.ts`

**Authentication:** Required (Better Auth session + DPDP `STREAM_DATA_PROCESSING` consent + active booking entitlement within `[startsAt - 15m, roomEndsAt + 30m]`, where the room end is the booked end plus any granted extension)

**Rate Limit:** two limits, both failing open when Redis is unreachable. `meetingJoinLimiter` (10 per minute per user) runs inside `guardMeetingRoute` straight after authentication. `streamJoinLimiter` (1,500 per minute per IP) runs at the edge in `middleware.ts` as an abuse backstop only: the edge cannot validate a session, and the ceiling is sized so a cohort of up to 200 behind one NAT is not throttled together. Each attendee makes about five calls in the minute the room opens (page load, three lobby auto-retries in `MeetingLobbyGateCard`, the self-heal retry), so 1,000, plus headroom.

**Response (Success - 200):**

```json
{
  "callType": "default",
  "callId": "occurrence-550e8400-e29b-41d4-a716-446655440000",
  "role": "participant"
}
```

### POST /api/meetings/[meetingId]/end

Ends a Stream call for everyone (host-only). Calls `call.end()` on Stream inside `withStreamCircuitBreaker` and synchronously invokes `recordMeetingEndedSynchronously` (`lib/stream/session-handlers.ts`) by compare-and-set on the call id and the end it read (`where: { id, streamCallId, endedAt, endedReason }`):

- **Pre-Start Device Check (`endedAt < startsAt`)**: Classifies as `"ended_early"`, keeps `AppointmentOccurrence` scheduled (`SCHEDULED`), and immediately rotates `Meeting.streamCallId` to a fresh `occurrence-<uuid>-r<base36>` id; it writes no attendance. `ended_early` is rejoinable, so the next join makes the provisioner build a clean room and clear the end stamp.
- **Live Session Termination (`endedAt >= startsAt`)**: Stamps `endedAt = now`, `endedReason = "call_ended"`, and `isRecording = false` by compare-and-set on the call id and the end it read, and prevents unauthorized rejoin. It writes no attendance.
- **Deliberate-End Guard**: `recordMeetingEndedSynchronously` returns `{ kind: "not_found" | "already_ended" | "recorded" }` and never overwrites a deliberate end (`recordedEndHolds`, driven by `END_REASON_POLICY`). `already_ended` still answers `200`.
- **Error Propagation**: Returns HTTP `404` with `code: "MEETING_NOT_FOUND"` when no `Meeting` matched the call, HTTP `503` if Stream's circuit breaker is open, and HTTP `500` (never a false `200 OK`) if database state persistence throws an unexpected error.
- **Rate Limit**: `meetingControlLimiter` (10 per minute per user, shared with `extend`, `reopen` and `live`; `stage` uses its own 60 per minute `meetingStageLimiter`) is applied by `guardMeetingRoute` after authentication and answers `429` with `code: "RATE_LIMITED"`. `applyRateLimit` fails open when Redis errors.

**Location:** `/app/api/meetings/[meetingId]/end/route.ts`

**Authentication:** Required (Host only — plan owner, assigned occurrence consultant, or accepted co-presenter)

**Response (Success - 200):** `callId` is the id that now represents the room, which is the rotated id after a pre-start `ended_early`.

```json
{
  "ended": true,
  "callId": "occurrence-550e8400-e29b-41d4-a716-446655440000"
}
```

### POST /api/meetings/[meetingId]/reopen

Safety-valve endpoint allowing a session host or co-presenter to reopen a deliberately ended room while the occurrence remains within `[startsAt - 15m, roomEndsAt + 30m]` (booked end plus any extension). Because `call.end()` irreversibly seals the closed Stream `cid`, `/reopen` verifies host/co-presenter authority (`isAuthorizedReopenHost`), DPDP consent, active non-dead occurrence/booking status, and a host-reopenable end reason (`endAllowsHostReopen`). It then builds the call with the provisioner's own payload (`buildRoomCallPlan`), creates the new Stream call first with `getOrCreate` on `occurrence-<uuid>-r<base36>`, and only then rotates `Meeting.streamCallId` via CAS (`where: { id, streamCallId: <read>, endedAt: <read> }`), clearing `endedAt` / `endedReason` / `isRecording`. The extension budget survives because it lives on `Meeting`.

- **Stream Failure**: Nothing is rotated. An open circuit answers HTTP `503`; any other failure answers `500`.
- **Lost CAS**: Answers `200` with `reopened: false` and the current `streamCallId`; the fresh Stream call stays unused.
- **Not Ended or Not Reopenable**: A meeting that is not ended answers `200` with `reopened: false`; an ended meeting whose reason is not host-reopenable, or an inactive slot, answers `409`; a closed grace window answers `409`.
- **Rate Limit**: `meetingControlLimiter` (10 per minute per user), applied directly after authentication.

**Location:** `/app/api/meetings/[meetingId]/reopen/route.ts`

**Authentication:** Required (Host or accepted co-presenter with active DPDP consent)

**Response (Success - 200):**

```json
{
  "reopened": true,
  "streamCallId": "occurrence-550e8400-e29b-41d4-a716-446655440000-r19abc2"
}
```

### POST /api/meetings/[meetingId]/live

Transitions a 1-to-Many backstage session (`WEBINAR` or `CLASS`) to live via `call.goLive()` so waiting attendees exit the backstage lobby onto the live video stage.

**Location:** `/app/api/meetings/[meetingId]/live/route.ts`

**Authentication:** Required (Host only)

**Response (Success - 200):**

```json
{
  "live": true,
  "callId": "occurrence-550e8400-e29b-41d4-a716-446655440000"
}
```

### POST /api/meetings/[meetingId]/extend

Grants the host one free `+15 minutes` (`900s`) room extension per `Meeting` when neither the consultant, co-presenters, presenter collaborators, nor active participants hold a conflicting confirmed booking within `[startsAt, max(roomEndsAt, now) + 15m]`. The booked `AppointmentOccurrence.endsAt` never moves. One CAS `prisma.meeting.updateMany` increments `Meeting.extendedSeconds` and `Meeting.extensionsUsed` (its `WHERE` requires `endedAt: null`, `extensionsUsed` equal to the value read and below `MAX_MEETING_EXTENSIONS`, and the occurrence still `SCHEDULED`, without an outcome, and not deleted). Only then, outside any transaction, the route mirrors the extension to Stream: `max_duration_seconds = max(existing, derived room cap)` and `custom = { ...existing, sessionEndsAt, sessionBaseEndsAt, extendedSeconds, extensionsUsed }`. Every Stream value is derived from Postgres, so a retry converges instead of adding time.

- **Rate Limit**: `meetingControlLimiter` (10 per minute per user).
- **Retry**: When `extensionsUsed` is already at the maximum, the route re-mirrors to Stream. It answers `200` if Stream was behind and `409` with `alreadyExtended: true` if it was already in sync.

**Location:** `/app/api/meetings/[meetingId]/extend/route.ts`

**Authentication:** Required (Host only)

**Response (Success - 200):**

```json
{
  "extended": true,
  "addedSeconds": 900,
  "maxDurationSeconds": 7200,
  "endsAt": "2026-10-10T18:15:00.000Z",
  "extensionsUsed": 1,
  "hasConflictingNextBooking": false
}
```

`endsAt` in the response is the room end. The residual risk is that `occurrence_no_confirmed_overlap` sees only booked ends, so the extension is protected only by this route's conflict check.

**Response (Conflict - 409):** Returned in three cases.

- `code: "SESSION_NOT_EXTENDABLE"` when the meeting has ended, or the occurrence is deleted, not `SCHEDULED`, or already has an outcome.
- `alreadyExtended: true` (with the room-end `endsAt`) when the free `+15m` extension has already been used.
- `hasConflictingNextBooking: true` when another session overlaps the extension.

**Response (Service Unavailable - 503):** `code: "EXTEND_SYNC_PENDING"` when Stream could not take the mirror. The extension is saved in Postgres and a retry converges. An open circuit answers a plain `503`.

### GET & POST /api/meetings/[meetingId]/qa

Manages hybrid in-room Q&A (`GET` lists questions ordered by upvotes & creation time; `POST` supports submitting questions `action: "ask"`, attendee upvoting `action: "upvote"`, host answers `action: "answer"`, and host stage lower-third spotlight pinning `action: "pin" | "unpin"` broadcasting `familiarise.qa.*` custom events over Stream WebSockets and persisting `custom.activeStageBanner`). Disabled with `403 trial_chat_disabled` on free `TRIAL` sessions.

**Location:** `/app/api/meetings/[meetingId]/qa/route.ts`

**Authentication:** Required (Entitled session participants for `ask`/`upvote`; host or co-presenter for `answer`/`pin`/`unpin`)

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

**Authentication:** A staff or admin session. The route answers 401 without a session, 403 for other roles, and 403 outside `next dev` (it checks `NODE_ENV` is `development`), so it does not exist on a deployed build. There is no secret query parameter and no environment variable that re-enables it.

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

### POST /api/cleanup/stream-sync

Authenticated with the server cron bearer. Optional `?dry-run=true` queues a
comparison without provider deletion or cursor advancement. Lease and execution
history are still written. The
registered handler queues `stream-maintenance-background?job=stream-sync` using
the configured HTTPS origin and returns 202 for admission. The staff
`POST /api/admin/system-jobs/run` door accepts `jobId: "stream-sync"` with an
audited reason and queues the same adapter.

The core processes at most five pages of 100 principals under a fail-closed
Postgres lease. Completion belongs in `SystemJobExecution`, not the admission
body. See [background sync](./09-background-sync.md). The former
`/api/stream/sync/manual` and `/api/stream/sync/background` examples do not name
current routes; do not use query-string synchronization secrets or the removed
Actions wrapper.

### POST /api/stream/recordings/sync

This separate, session-authenticated recovery endpoint mirrors recordings for
the caller's recent sessions. It accepts optional `consultantCursor` and
`consulteeCursor`, pages 25 meetings per identity, applies request rate limiting,
and sends no recording-ready notices. It returns rows and per-identity next
cursors. It does not run the principal-deletion job. Automatic missed-webhook
recovery belongs to `reconcile-orphaned-recordings` in the daily window.

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

## Deprecated & Superseded Approaches

- **NextAuth `authOptions` / `getServerSession`**: Replaced by `auth.api.getSession({ headers: await headers() })` from `@/lib/auth`.
- **Direct client-side call lifecycle (`call.endCall()`, `call.goLive()`, client-side `call.getOrCreate()`)**: Replaced by `/api/meetings/[meetingId]/{join,end,live,extend}`.

---

## Related Documentation

- [User Management](./07-user-management.md)
- [Token Management](./08-token-management.md)
- [Background Sync](./09-background-sync.md)
