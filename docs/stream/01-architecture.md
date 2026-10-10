# 01. Architecture Overview

> Complete system architecture for Stream Chat and Video integration

## Table of Contents

- [System Architecture](#system-architecture)
- [Component Relationships](#component-relationships)
- [Data Flow](#data-flow)
- [Integration Points](#integration-points)
- [Key Design Patterns](#key-design-patterns)
- [Architecture Decisions](#architecture-decisions)
- [Security Considerations](#security-considerations)
- [Performance Considerations](#performance-considerations)
- [Scalability](#scalability)
- [Architectural Non-Goals & Deferred Capabilities](#architectural-non-goals--deferred-capabilities)

---

## System Architecture

### High-Level Overview

The Stream SDK integration follows a three-tier architecture:

1. **Client Tier** - React components using Stream SDKs
2. **Server Tier** - Next.js API routes and server actions
3. **External Tier** - Stream Cloud services

```mermaid
graph TB
    subgraph Client["Client Layer (Browser)"]
        UI[React Components]
        SP[StreamProvider]
        ChatSDK[Chat Client SDK]
        VideoSDK[Video Client SDK]
        Hooks[Custom Hooks]
        ErrorBoundary[Error Boundary]
    end

    subgraph Server["Server Layer (Next.js)"]
        SA[Server Actions]
        API[API Routes]
        Jobs[Background Jobs]
        NodeSDK[Node SDK]
        Prisma[(Prisma DB)]
    end

    subgraph External["External Services"]
        StreamChat[Stream Chat API]
        StreamVideo[Stream Video API]
    end

    UI --> SP
    SP --> ChatSDK
    SP --> VideoSDK
    SP --> ErrorBoundary
    UI --> Hooks
    Hooks --> SA
    Hooks --> API

    SA --> NodeSDK
    SA --> Prisma
    API --> NodeSDK
    API --> Prisma
    Jobs --> NodeSDK
    Jobs --> Prisma

    ChatSDK <-->|WebSocket| StreamChat
    VideoSDK <-->|WebRTC| StreamVideo
    NodeSDK <-->|REST| StreamChat
    NodeSDK <-->|REST| StreamVideo

    style Client fill:#e3f2fd
    style Server fill:#e8f5e9
    style External fill:#fff3e0
    style SP fill:#1976d2,color:#fff
    style NodeSDK fill:#388e3c,color:#fff
```

### Component Breakdown

#### Client Components

| Component              | Location                                    | Purpose                                                                          |
| ---------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| **StreamProvider**     | `providers/StreamProvider.tsx`              | Thin, SDK-free shell that lazy-loads the implementation                          |
| **StreamProviderImpl** | `providers/StreamProviderImpl.tsx`          | Heavy implementation: initializes Chat & Video clients, manages connection state |
| **Disconnect Module**  | `lib/stream/disconnect.ts`                  | SDK-free shared client refs + `disconnectStreamClients`                          |
| **Chat Client**        | Stream SDK                                  | Manages real-time messaging connections                                          |
| **Video Client**       | Stream SDK                                  | Manages video call connections                                                   |
| **Meeting Components** | `app/meetings/[id]/`                        | Video call UI (Setup, Room, Controls)                                            |
| **Error Boundary**     | `components/stream/StreamErrorBoundary.tsx` | Catches and recovers from Stream errors                                          |
| **Custom Hooks**       | `app/meetings/[id]/hooks/`                  | React hooks for Stream operations                                                |

> **Provider split (PR #887, nav-perf):** The provider is split for bundle reasons. `providers/StreamProvider.tsx` is a thin, SDK-free shell that lazy-loads the heavy implementation `providers/StreamProviderImpl.tsx` via `next/dynamic(..., { ssr: false })`. All Stream SDK imports and the two SDK stylesheets live only in that lazy chunk, so routes that merely mount the provider no longer ship the SDK synchronously. The SDK-free module `lib/stream/disconnect.ts` owns the shared module-level client refs (chat, video, current user ID) plus `disconnectStreamClients`, so SDK-free callers (the navbar, other dashboards) can disconnect on logout without statically linking the SDK. See [Navigation Performance](../performance/01-navigation-performance.md) for the full rationale.

#### Server Components

| Component           | Location                                    | Purpose                              |
| ------------------- | ------------------------------------------- | ------------------------------------ |
| **Token Providers** | `actions/stream/chat/stream.action.ts`      | Generate JWT tokens for auth         |
| **User Actions**    | `actions/stream/chat/user.action.ts`        | User upsert, search, sync            |
| **Channel Actions** | `actions/stream/chat/channel.action.ts`     | Channel creation & management        |
| **Meeting Actions** | `actions/stream/meetings/meeting.action.ts` | Meeting session operations           |
| **Sync Job**        | `jobs/stream-sync.ts`                       | Daily user cleanup                   |
| **API Endpoints**   | `app/api/stream/`                           | REST endpoints for Stream operations |

---

## Component Relationships

### Provider Hierarchy

```mermaid
graph TD
    App[Next.js App]
    Auth[Better Auth Session]
    Stream["StreamProvider (SDK-free shell)"]
    Impl["StreamProviderImpl (lazy SDK chunk)"]
    Pages[Application Pages]

    App --> Auth
    Auth --> Stream
    Stream -.->|"next/dynamic, ssr:false"| Impl
    Stream --> Pages

    Impl -.->|Initializes| ChatClient[Chat Client Instance]
    Impl -.->|Initializes| VideoClient[Video Client Instance]
    Impl -.->|Manages| TokenCache[Token Cache]
    Impl -.->|Wraps| ErrorBoundary[Error Boundary]

    Disconnect["lib/stream/disconnect.ts (SDK-free)"]
    Impl -.->|Owns global refs via| Disconnect

    Pages -->|Uses| ChatClient
    Pages -->|Uses| VideoClient
```

The shell renders `StreamProviderImpl` through `next/dynamic` with `ssr: false`, so the Stream SDK is never part of the synchronous bundle for a route that only mounts the provider. The implementation and the SDK-free `lib/stream/disconnect.ts` module share the same module-level client references, which lets a logout handler in any SDK-free component tear the connection down without pulling the SDK into that component's chunk.

### Dependency Graph

```mermaid
graph LR
    subgraph UI Layer
        MeetingPage[Meeting Page]
        ChatUI[Chat UI]
    end

    subgraph Hook Layer
        useGetCall[useGetCallById]
        useStream[useStreamConnection]
    end

    subgraph Action Layer
        TokenAction[Token Actions]
        ChannelAction[Channel Actions]
        MeetingAction[Meeting Actions]
    end

    subgraph SDK Layer
        StreamSDK[Node SDK]
    end

    MeetingPage --> useGetCall
    MeetingPage --> useStream
    ChatUI --> useStream

    useGetCall --> MeetingAction
    useStream --> TokenAction

    MeetingAction --> StreamSDK
    TokenAction --> StreamSDK
    ChannelAction --> StreamSDK
```

---

## Data Flow

### 1. User Authentication & Connection Flow

```mermaid
sequenceDiagram
    participant User
    participant BetterAuth as Better Auth
    participant StreamProvider
    participant TokenProvider
    participant StreamCloud
    participant Database

    User->>BetterAuth: Login
    BetterAuth->>User: Session created

    User->>StreamProvider: Page loads
    StreamProvider->>Database: Fetch user details
    Database-->>StreamProvider: User data

    par Chat Connection
        StreamProvider->>TokenProvider: Get chat token
        TokenProvider->>StreamCloud: Create token (Node SDK)
        StreamCloud-->>TokenProvider: JWT token
        TokenProvider-->>StreamProvider: Chat token
        StreamProvider->>StreamCloud: Connect user
    and Video Connection
        StreamProvider->>TokenProvider: Get video token
        TokenProvider->>StreamCloud: Create token (Node SDK)
        StreamCloud-->>TokenProvider: JWT token
        TokenProvider-->>StreamProvider: Video token
        StreamProvider->>StreamCloud: Initialize client
    end

    StreamProvider->>StreamCloud: Sync user channels
    StreamCloud-->>StreamProvider: Channels synced
    StreamProvider-->>User: Connected & Ready
```

### 2. Meeting Join Flow

```mermaid
sequenceDiagram
    participant User
    participant Dashboard
    participant MeetingAction as provisionAppointmentMeeting
    participant MeetingPage
    participant JoinRoute as POST /api/meetings/[id]/join
    participant Database
    participant StreamCloud

    User->>Dashboard: Click Join Session
    Dashboard->>MeetingAction: provisionAppointmentMeeting(slot)
    MeetingAction->>Database: Verify entitlement & booking status
    MeetingAction->>StreamCloud: call.getOrCreate (author=host, settings_override)
    MeetingAction->>Database: Persist Meeting (streamCallId: occurrence-<slotId>)
    MeetingAction-->>Dashboard: { ok: true, streamCallId }

    User->>MeetingPage: Navigate to /meetings/{streamCallId}
    MeetingPage->>JoinRoute: POST /api/meetings/{streamCallId}/join
    JoinRoute->>Database: resolveMeetingAccess + DPDP checkConsent
    JoinRoute->>StreamCloud: upsertUsersToStream + updateCallMembers(call_member or co_presenter)
    JoinRoute-->>MeetingPage: { callType: "default", callId, role }
    MeetingPage-->>User: Show MeetingSetup -> MeetingRoom
    StreamCloud-->>Database: Webhooks (participant_joined/left, call.ended) write attendance, presence & endedAt
```

### 3. Channel Creation Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant ChannelAction
    participant Database
    participant NodeSDK
    participant StreamCloud

    Client->>API: POST /api/stream/channels/create
    API->>ChannelAction: createWebinarChannel(eventId)

    ChannelAction->>Database: Get webinar + participants
    Database-->>ChannelAction: Webinar data

    ChannelAction->>ChannelAction: Collect member IDs
    Note over ChannelAction: - Registered attendees<br/>- Consultant host

    ChannelAction->>NodeSDK: channel.create()
    NodeSDK->>StreamCloud: Create channel
    StreamCloud-->>NodeSDK: Channel created
    NodeSDK-->>ChannelAction: Success

    ChannelAction-->>API: Channel data
    API-->>Client: Success response
```

### 4. Token Refresh Flow

```mermaid
flowchart TD
    Start[Need token] --> Check{Token in cache?}

    Check -->|Yes| CheckExpiry{Expires soon?}
    Check -->|No| Generate

    CheckExpiry -->|No| Return[Return cached token]
    CheckExpiry -->|Yes| Generate[Generate new token]

    Generate --> ServerAction[Call tokenProvider]
    ServerAction --> CreateToken[Stream SDK createToken]
    CreateToken --> Cache[Cache for 50 minutes]
    Cache --> Return

    Return --> End[Use token]
```

---

## Integration Points

### 1. Prisma Database Integration

Stream SDK integrates with Prisma for:

**User Management:**

```typescript
// Sync between Prisma and Stream
const user = await prisma.user.findUnique({ where: { id } });
await chatClient.upsertUser({
  id: user.id,
  name: user.name,
  image: user.image,
  role: mapRoleToStream(user.role), // "admin" only for staff/admins, "user" for everyone else
});
```

**Meeting Sessions:**

```prisma
model Meeting {
  id           String   @id @default(cuid())
  streamCallId String   @unique  // Maps to Stream Video call ID
  platform     Platform @default(STREAM)
  passcode     String?
  hostKeys     String[]
  recordings   Recording[]
  appointmentOccurrence AppointmentOccurrence @relation(...)
}
```

**Appointment Linking:**

- Consultations → 1-on-1 messaging channels
- Subscriptions → Recurring messaging channels
- Webinars → Group team channels
- Classes → Group team channels

### 2. Better Auth Session Management

```typescript
// StreamProvider uses session for initialization
const { data: session } = useSession(); // from "@/lib/auth-client"

if (session?.user?.id) {
  // Initialize Stream with authenticated user
  connectUserToStream(session.user.id);
}
```

### 3. Event System Integration

Channels are provisioned deterministically across booking modalities:

| Modality / Scope            | Channel ID Format                  | Channel Type | Members                                                       |
| --------------------------- | ---------------------------------- | ------------ | ------------------------------------------------------------- |
| Consultation / Subscription | `dm-{userIdA}-{userIdB}`           | `messaging`  | Consultant + Consultee (1 canonical thread per human pair)    |
| Enterprise Org DM           | `dmo-{orgHash}-{pairHash}`         | `messaging`  | Consultant + Consultee (`custom.organization_id = orgId`)     |
| Webinar                     | `webinar-{id}` + `dm-{a}-{b}`      | `team` + DM  | Group `team` channel (host + co-hosts + enrollees) AND 1:1 DM |
| Class                       | `class-{id}` + `dm-{a}-{b}`        | `team` + DM  | Group `team` channel (host + co-hosts + enrollees) AND 1:1 DM |
| Collaborator Coordination   | `collab-{webinar\|class}-{planId}` | `messaging`  | Plan owner + `ACCEPTED` collaborators                         |
| Free Trial (`TRIAL`)        | _(none — chat blocked)_            | —            | All Stream Chat channels, DMs, and in-call chat are disabled  |

---

## Key Design Patterns

### 1. Dual-Client Pattern

**Problem:** Need both Chat and Video functionality
**Solution:** Single provider initializes both clients

```typescript
// StreamProvider manages both clients
const [chatClient, setChatClient] = useState<StreamChat>();
const [videoClient, setVideoClient] = useState<StreamVideoClient>();

// Parallel initialization
Promise.all([initializeChatClient(), initializeVideoClient()]);
```

**Benefits:**

- Single connection state
- Shared token caching
- Unified error handling

### 2. Token Caching with Safety Buffer

**Problem:** Tokens expire after 1 hour, causing disconnections
**Solution:** Cache tokens for 50 minutes (10-minute safety buffer)

```typescript
const TOKEN_CACHE_DURATION = 50 * 60 * 1000; // 50 minutes

if (Date.now() - cachedToken.timestamp > TOKEN_CACHE_DURATION) {
  // Refresh token before it expires
  const newToken = await generateToken();
}
```

**Benefits:**

- Prevents mid-session disconnections
- Reduces token generation API calls
- Smooth user experience

### 3. Exponential Backoff Retry

**Problem:** Network failures causing permanent disconnection
**Solution:** Retry with increasing delays

```typescript
const delays = [1000, 2000, 4000, 8000, 16000]; // Max 30s
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    await connectUser();
    break;
  } catch (error) {
    await delay(delays[attempt]);
  }
}
```

**Benefits:**

- Handles temporary network issues
- Prevents server overload
- Better user experience

### 4. Atomic Channel Creation

**Problem:** Race conditions when multiple users create same channel
**Solution:** Create channel with all members atomically

```typescript
// Create channel AND add members in one operation
await channel.create({
  members: [consultant, consultee],
  data: {/* channel metadata */},
});
```

**Benefits:**

- No race conditions
- Consistent membership
- Idempotent operations

### 5. Event-Based Channel Sync

**Problem:** Users may miss channels created while offline
**Solution:** Sync channels on provider initialization

```typescript
useEffect(() => {
  if (chatConnected) {
    // Sync all event channels user should have access to
    syncUserEventChannels(userId);
  }
}, [chatConnected]);
```

**Benefits:**

- Always up-to-date channels
- Handles offline scenarios
- Automatic recovery

> **Note (PR #887, #248):** This one-time sync now runs inside the deferred initial connect (scheduled with `requestIdleCallback`) rather than synchronously on provider mount, and it is guarded so it is a no-op after the first sync. This keeps the sync off the dashboard-home critical path while preserving the recovery behaviour described above. See [Connection Optimization](#connection-optimization) and [Navigation Performance](../performance/01-navigation-performance.md).

---

## Architecture Decisions

### Why Two Separate SDKs?

**Chat SDK:**

- Optimized for messaging
- Built-in typing indicators
- Message persistence
- Channel types and permissions

**Video SDK:**

- Optimized for WebRTC
- Call quality management
- Device handling
- Recording capabilities

**Decision:** Use both for specialized features rather than one monolithic SDK

### Why Server-Side Token Generation?

**Security:** API secrets never exposed to client
**Control:** Centralized user validation
**Flexibility:** Custom token claims and expiry

```typescript
// Server Action (secure)
export async function tokenProvider(userId: string) {
  const user = await validateUser(userId);
  return streamClient.createToken(userId, exp);
}
```

### Why Lazy Channel Creation?

**Current:** Channels created on first access
**Alternative:** Eager creation on appointment booking

**Tradeoffs:**

- ✅ Lower Stream API usage
- ✅ No orphaned channels
- ⚠️ Potential race conditions (see [Troubleshooting - Channel Creation Race Conditions](./troubleshooting.md#channel-creation-race-conditions-medium))
- ⚠️ First-access latency

### Why Daily User Sync Job?

**Purpose:** Clean up users deleted from Prisma but still in Stream

**Tradeoffs:**

- ✅ Keeps Stream/Prisma in sync
- ✅ Reduces Stream billing
- ⚠️ Hard delete (no recovery)
- ⚠️ Deletes all user messages

**See:** [09. Background Sync](./09-background-sync.md)

---

## Security Considerations

### Least-Privilege Stream Roles

Only platform staff and admins get Stream's global `admin` role. Everyone else, consultants included, is mapped to the plain `user` role.

```typescript
// File: lib/user.ts
export function mapRoleToStream(role: string | null | undefined): string {
  switch (role?.toUpperCase()) {
    case "ADMIN":
    case "STAFF":
      return "admin";
    default:
      return "user";
  }
}
```

**How hosts get moderation:**

- Channel creation is performed server-side
- Each host receives a channel-scoped `channel_moderator` grant on their own host channels at creation time
- No global admin grant, and no moderation rights over unrelated peer direct-message channels

**See:** [Troubleshooting - Universal Admin Role](./troubleshooting.md#universal-admin-role-critical)

### Token & Consent Security

- **Server-Side Minting with Required `iat` & TTL**: Tokens are minted server-side (`actions/stream/chat/stream.action.ts`, `lib/stream/initial-tokens.ts`) with explicit `exp` (1 hour) and `iat` (60s clock-skew buffer) so `revokeUserToken` immediately invalidates active sessions on ban, org removal, or consent withdrawal.
- **DPDP `STREAM_DATA_PROCESSING` Consent Gate**: Both `assertCanMintToken` (for chat/video token generation) and `resolveMeetingAccess` (`hasStreamConsent` in `POST /api/meetings/[meetingId]/join`) verify active `STREAM_DATA_PROCESSING` consent before any user data or media reaches Stream.
- **Server-Action Boundary Lockdown**: Internal mutation modules (`actions/stream/chat/channel.action.ts`, `lib/stream/event-channel-service.ts`) do not expose unauthenticated `"use server"` endpoints, and `upsertUsersToStream` strips email PII from non-privileged responses.

---

## Performance Considerations

### Connection Optimization

**Parallel Initialization:**

```typescript
// Chat and Video connect simultaneously
Promise.all([
  chatClient.connectUser(...),
  new StreamVideoClient(...)
])
```

**Result:** ~2-3 second total connection time instead of 4-6 seconds

**Deferred initial connect:** The initial connect (`connectUser` plus the one-time `syncUserEventChannels`) is deferred off the dashboard-home critical path via `requestIdleCallback` (with a `setTimeout` fallback) and gated on `!isSessionPending && !!sessionUserId` so client token prefetch never races Better Auth session hydration. The chat sidebar's channel fetch is split into an initial fetch keyed on the client plus the org scope, and a separate listener effect keyed on the client alone. An in-flight fetch-key guard ensures that rapid channel clicks and mid-fetch org-scope switches no longer refire the storm or strand the wrong tenant's data: a duplicate fetch for the same key is skipped, while a fetch for a new key (an org-scope switch during an in-flight fetch) proceeds so the new scope actually loads. See [Navigation Performance](../performance/01-navigation-performance.md) for the measured impact.

**Connection robustness:** On a user switch the _global_ clients are disconnected, not just local React state, so a stale connection cannot survive the swap. Logout teardown uses `Promise.allSettled` and always clears global state even if an individual disconnect rejects. A Join click awaits a short readiness window (`waitForGlobalVideoClient`) so a click that lands during the deferred connect does not fail; if the client is still not ready it falls back to a soft "Connecting…" toast. `useStreamConnection` returns a safe default when called outside the provider, which keeps consumers from crashing during the lazy-load window.

### Token Caching

**Impact:**

- **Without cache:** 2 API calls per page load
- **With cache:** ~2 API calls per hour (plus server-seeded `mintInitialStreamTokens` on `/dashboard` and `/meetings`)
- **Savings:** 95% reduction in token generation calls

### Channel Query Optimization

**Pagination:** `queryChannelsPaged` (`lib/stream/batch.ts`) pages at Stream's hard 30-channel ceiling sorted by `created_at` ascending; user upserts and channel creation chunk rosters at 100 members per request.
**Filtering:** Only fetch relevant channels scoped via `buildOrgChannelFilter(scope)`.
**Caching:** Channels cached client-side; server existence/membership caches bounded via `BoundedTtlSet` (`lib/stream-cache.ts`).

---

## Scalability

### Current Limits

| Resource               | Limit                | Notes                       |
| ---------------------- | -------------------- | --------------------------- |
| Concurrent connections | Unlimited (per plan) | Based on Stream pricing     |
| Channels per user      | ~100 recommended     | Performance degrades beyond |
| Messages per channel   | Unlimited            | Frozen +7d, deleted +90d    |
| Call participants      | 100 (default)        | Configurable per call type  |

### Horizontal Scaling

**Client-side:** Fully scalable (stateless)
**Server-side:** Stateless actions (easily scaled)
**Background jobs:** Single instance (`withCronLock` Postgres lease)

---

## Architectural Non-Goals & Deferred Capabilities

The following capabilities are intentionally excluded or deferred at the current launch stage so engineers and AI agents do not build speculative infrastructure:

| Capability / Pattern                                           | Current Architectural Rule & Guardrail                                                                                                                                                                                                                                                                                                                                       | Revisit Trigger                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Guest or Magic-Link Video Call Access**                      | `guest_user_creation_disabled: true` is enforced on the Stream app (`scripts/stream/ensure-app-settings.ts`). Every participant must authenticate via Better Auth and pass the DPDP `STREAM_DATA_PROCESSING` consent gate (`hasStreamConsent` in `lib/meetings/access.ts`).                                                                                                  | Never for unconsented guests; external attendees must sign in and grant consent before joining.                  |
| **Consultee-to-Consultee Peer DMs**                            | `canDirectMessage` (`lib/stream/dm-eligibility.ts`) strictly requires a consultant ↔ consultee relationship on an eligible booking (`DM_ELIGIBLE_STATUSES = ["APPROVED", "SCHEDULED", "COMPLETED"]`). Learners can converse with peers only inside moderated `team` channels (`webinar-`/`class-`).                                                                          | Only if a dedicated moderated community product is introduced.                                                   |
| **Per-Call `call_cids` Scoped Tokens on `StreamVideoClient`**  | `providers/StreamProviderImpl.tsx` maintains a singleton `StreamVideoClient` per browser tab. Until the client lifecycle is refactored per-call, video tokens remain user-scoped (`generateUserToken` with `iat` and `exp`), and call admission is enforced by `resolveMeetingAccess` + `members`-only `call_member` role grants (`join-call` stripped from `user`/`guest`). | Only if `StreamVideoClient` is refactored from an app-wide singleton to a per-call instance on `/meetings/[id]`. |
| **Stream Native Multi-Tenant `teams` Isolation**               | Stream's `multi_tenant_enabled` is a one-way control-plane setting. Enterprise B2B tenant isolation is enforced at the application layer via `custom.organization_id` on channels and video calls, deterministic `dmo-<orgHash>-<pairHash>` DM IDs, and `buildOrgChannelFilter(scope)`.                                                                                      | Deferred until Stream Elevate tier and contractual hard-multi-tenancy requirements.                              |
| **`livestream` Call Type + HLS Playback for Group Sessions**   | All 1:1 and 1-to-Many sessions up to ~100 seats use the `default` WebRTC call type with Backstage (`join_ahead_time_seconds: 900`), muted/camera-off attendee defaults, and `<StageControls />`. Stream Dynascale automatically bills muted/camera-off WebRTC viewers at the Livestream rate (`$1.50 / 1,000 min`) without HLS latency (`10–15s`) or HLS egress surcharges.  | When webinar cohort sizes regularly exceed ~100 concurrent viewers.                                              |
| **Resumable TUS Uploads & Dedicated Transfer Queues**          | Stream retains recordings on its CDN for 14 days while `transfer-recordings` (`lib/stream/recording-transfer-service.ts`) streams SigV4 multipart chunks to Cloudflare R2 with `TRANSFERRING` CAS claims, HEAD size verification and 5 attempts.                                                                                                                             | Not needed while 14-day CDN retention + 6-hourly retry cron + 5 attempts provide ample recovery margin.          |
| **Cross-Tab `BroadcastChannel` / `SharedWorker` Coordination** | `MeetingPresence` tracks individual join/leave intervals and `evaluateOccurrenceFromPresence` merges overlapping stays with a 5-minute reconnect grace (`RECONNECT_GRACE_MINUTES = 5`).                                                                                                                                                                                      | Not needed; duplicate-tab audio echo is self-correcting and intervals are merged server-side.                    |

---

## Next Steps

**For detailed implementation:**

- [02. Setup & Configuration](./02-setup-configuration.md) - Get started
- [03. Provider & Authentication](./03-provider-authentication.md) - Deep dive into StreamProvider
- [04. Chat Implementation](./04-chat-implementation.md) - Messaging features
- [05. Video Implementation](./05-video-implementation.md) - Video calls
- [13. Recording & Webhooks](./13-recording-webhooks.md) - Recording and webhooks

**For troubleshooting:**

- [Troubleshooting](./troubleshooting.md) - Common problems and known issues

---

## Deprecated & Superseded Approaches

- **NextAuth (`getServerSession`, `authOptions`)**: Replaced across all client and server boundaries by Better Auth (`auth.api.getSession` on the server and `useSession` from `@/lib/auth-client` on the client).
- **Synchronous `StreamProvider` wrapping `children`**: Superseded by the SDK-free shell `providers/StreamProvider.tsx` + `next/dynamic(..., { ssr: false })` `StreamProviderImpl` publishing into `lib/stream/connection-store.ts` so server-rendered HTML is never stripped from dashboard routes.
- **Browser-initiated `call.getOrCreate()` in `useGetCallById`**: Superseded by server-side `provisionAppointmentMeeting` and `POST /api/meetings/[meetingId]/join`.

---

← [Setup & Configuration](./02-setup-configuration.md) →
