# 01. Architecture Overview

> Complete system architecture for Stream Chat and Video integration

## Table of Contents
- [System Architecture](#system-architecture)
- [Component Relationships](#component-relationships)
- [Data Flow](#data-flow)
- [Integration Points](#integration-points)
- [Key Design Patterns](#key-design-patterns)

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

| Component | Location | Purpose |
|-----------|----------|---------|
| **StreamProvider** | `providers/StreamProvider.tsx` | Initializes Chat & Video clients, manages connection state |
| **Chat Client** | Stream SDK | Manages real-time messaging connections |
| **Video Client** | Stream SDK | Manages video call connections |
| **Meeting Components** | `app/meetings/[id]/` | Video call UI (Setup, Room, Controls) |
| **Error Boundary** | `components/stream/StreamErrorBoundary.tsx` | Catches and recovers from Stream errors |
| **Custom Hooks** | `app/meetings/[id]/hooks/` | React hooks for Stream operations |

#### Server Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Token Providers** | `actions/stream/chat/stream.action.ts` | Generate JWT tokens for auth |
| **User Actions** | `actions/stream/chat/user.action.ts` | User upsert, search, sync |
| **Channel Actions** | `actions/stream/chat/channel.action.ts` | Channel creation & management |
| **Meeting Actions** | `actions/stream/meetings/meeting.action.ts` | Meeting session operations |
| **Sync Job** | `jobs/stream-sync.ts` | Daily user cleanup |
| **API Endpoints** | `app/api/stream/` | REST endpoints for Stream operations |

---

## Component Relationships

### Provider Hierarchy

```mermaid
graph TD
    App[Next.js App]
    Auth[NextAuth Session Provider]
    Stream[StreamProvider]
    Pages[Application Pages]

    App --> Auth
    Auth --> Stream
    Stream --> Pages

    Stream -.->|Initializes| ChatClient[Chat Client Instance]
    Stream -.->|Initializes| VideoClient[Video Client Instance]
    Stream -.->|Manages| TokenCache[Token Cache]
    Stream -.->|Wraps| ErrorBoundary[Error Boundary]

    Pages -->|Uses| ChatClient
    Pages -->|Uses| VideoClient
```

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
    participant NextAuth
    participant StreamProvider
    participant TokenProvider
    participant StreamCloud
    participant Database

    User->>NextAuth: Login
    NextAuth->>User: Session created

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
    participant MeetingPage
    participant Hook
    participant VideoClient
    participant Database
    participant StreamCloud

    User->>MeetingPage: Navigate to /meetings/{slotId}
    MeetingPage->>Hook: useGetCallById(callId)

    Hook->>VideoClient: queryCalls({id: callId})
    VideoClient->>StreamCloud: Query for call

    alt Call exists
        StreamCloud-->>VideoClient: Return call
    else Call not found
        VideoClient->>StreamCloud: Create call
        StreamCloud-->>VideoClient: New call created
        Hook->>Database: Save MeetingSession
    end

    VideoClient-->>Hook: Call object
    Hook-->>MeetingPage: Call ready
    MeetingPage-->>User: Show MeetingSetup

    User->>MeetingPage: Join meeting
    MeetingPage->>VideoClient: call.join()
    VideoClient->>StreamCloud: Join call
    StreamCloud-->>User: In meeting
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
    Note over ChannelAction: - Waitlist users<br/>- Appointment users<br/>- Consultant host

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
const user = await prisma.user.findUnique({ where: { id } })
await chatClient.upsertUser({
  id: user.id,
  name: user.name,
  image: user.image,
  role: mapRoleToStream(user.role) // ⚠️ Currently returns "admin" for all
})
```

**Meeting Sessions:**
```prisma
model MeetingSession {
  id           String   @id @default(cuid())
  streamCallId String   @unique  // Maps to Stream Video call ID
  platform     Platform @default(STREAM)
  passcode     String?
  hostKeys     String[]
  recordings   Recording[]
  slotOfAppointment SlotOfAppointment @relation(...)
}
```

**Appointment Linking:**
- Consultations → 1-on-1 messaging channels
- Subscriptions → Recurring messaging channels
- Webinars → Group team channels
- Classes → Group team channels

### 2. NextAuth Session Management

```typescript
// StreamProvider uses session for initialization
const { data: session } = useSession()

if (session?.user?.id) {
  // Initialize Stream with authenticated user
  connectUserToStream(session.user.id)
}
```

### 3. Event System Integration

Channels are automatically created for:

| Event Type | Channel ID Format | Channel Type | Members |
|------------|------------------|--------------|---------|
| Consultation | `consultation-{id}` | `messaging` | Consultee + Consultant |
| Subscription | `subscription-{id}` | `messaging` | Consultee + Consultant |
| Webinar | `webinar-{id}` | `team` | All participants + host |
| Class | `class-{id}` | `team` | All participants + host |
| Direct Message | `{userId1}-{userId2}` | `messaging` | Two users (alphabetical) |

---

## Key Design Patterns

### 1. Dual-Client Pattern

**Problem:** Need both Chat and Video functionality
**Solution:** Single provider initializes both clients

```typescript
// StreamProvider manages both clients
const [chatClient, setChatClient] = useState<StreamChat>()
const [videoClient, setVideoClient] = useState<StreamVideoClient>()

// Parallel initialization
Promise.all([
  initializeChatClient(),
  initializeVideoClient()
])
```

**Benefits:**
- Single connection state
- Shared token caching
- Unified error handling

### 2. Token Caching with Safety Buffer

**Problem:** Tokens expire after 1 hour, causing disconnections
**Solution:** Cache tokens for 50 minutes (10-minute safety buffer)

```typescript
const TOKEN_CACHE_DURATION = 50 * 60 * 1000 // 50 minutes

if (Date.now() - cachedToken.timestamp > TOKEN_CACHE_DURATION) {
  // Refresh token before it expires
  const newToken = await generateToken()
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
const delays = [1000, 2000, 4000, 8000, 16000] // Max 30s
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    await connectUser()
    break
  } catch (error) {
    await delay(delays[attempt])
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
  data: { /* channel metadata */ }
})
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
    syncUserEventChannels(userId)
  }
}, [chatConnected])
```

**Benefits:**
- Always up-to-date channels
- Handles offline scenarios
- Automatic recovery

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
  const user = await validateUser(userId)
  return streamClient.createToken(userId, exp)
}
```

### Why Lazy Channel Creation?

**Current:** Channels created on first access
**Alternative:** Eager creation on appointment booking

**Tradeoffs:**
- ✅ Lower Stream API usage
- ✅ No orphaned channels
- ⚠️ Potential race conditions (see [Known Issues](./13-known-issues.md#medium-bug-3-channel-creation-race-conditions))
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

### 🔴 CRITICAL: Universal Admin Role

**Current:** All users get "admin" role in Stream

```typescript
// File: lib/user.ts:98-115
export function mapRoleToStream(role: string): string {
  return "admin" // ⚠️ Everyone is admin!
}
```

**Impact:**
- No permission enforcement
- All users can moderate channels
- Potential data access issues

**See:** [13. Known Issues - Bug #1](./13-known-issues.md#critical-bug-1-universal-admin-role)

### Token Security

✅ **Good Practices:**
- Tokens generated server-side only
- Short expiry (1 hour)
- User validation before generation
- Secure storage (not in localStorage)

⚠️ **Areas for Improvement:**
- No token revocation mechanism
- No audit logging for token generation
- No rate limiting on token endpoints

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

### Token Caching

**Impact:**
- **Without cache:** 2 API calls per page load
- **With cache:** ~2 API calls per hour
- **Savings:** 95% reduction in token generation calls

### Channel Query Optimization

**Pagination:** 100 users per page for background sync
**Filtering:** Only fetch relevant channels
**Caching:** Channels cached client-side

---

## Scalability

### Current Limits

| Resource | Limit | Notes |
|----------|-------|-------|
| Concurrent connections | Unlimited (per plan) | Based on Stream pricing |
| Channels per user | ~100 recommended | Performance degrades beyond |
| Messages per channel | Unlimited | Archived after 30 days |
| Call participants | 100 (default) | Configurable per call type |

### Horizontal Scaling

**Client-side:** Fully scalable (stateless)
**Server-side:** Stateless actions (easily scaled)
**Background jobs:** Single instance (cron-based)

### Bottlenecks

1. **Token generation:** Could become bottleneck at scale → Solution: Token caching
2. **Channel sync:** O(n) per user → Solution: Batch operations
3. **User sync job:** Sequential processing → Solution: Parallel batch deletion

---

## Next Steps

**For detailed implementation:**
- [02. Setup & Configuration](./02-setup-configuration.md) - Get started
- [03. Provider & Authentication](./03-provider-authentication.md) - Deep dive into StreamProvider
- [04. Chat Implementation](./04-chat-implementation.md) - Messaging features
- [05. Video Implementation](./05-video-implementation.md) - Video calls

**For troubleshooting:**
- [13. Known Issues](./13-known-issues.md) - Current bugs
- [14. Troubleshooting](./14-troubleshooting.md) - Common problems

---

← [README](./README.md) | [Next: Setup & Configuration](./02-setup-configuration.md) →
