# 02. Setup & Configuration

> Complete guide for setting up Stream SDK integration in Familiarise

## Table of Contents

- [Environment Variables](#environment-variables)
- [Production Operator Cutover & Verification Runbook](#production-operator-cutover--verification-runbook)
- [Package Installation](#package-installation)
- [Pinned SDK Version Holds](#pinned-sdk-version-holds)
- [Stream Dashboard Setup](#stream-dashboard-setup)
- [Code Integration](#code-integration)
- [Minimal Working Example](#minimal-working-example)
- [Environment Validation](#environment-validation)
- [Common Setup Errors](#common-setup-errors)
- [Next.js Specific Configuration](#nextjs-specific-configuration)

---

## Environment Variables

### Required Variables

Stream SDK requires **3 critical environment variables** for operation, plus dual-secret webhook rotation and Cloudflare R2 storage credentials in production:

```env
# Stream API Credentials (Required)
NEXT_PUBLIC_STREAM_API_KEY=your_stream_api_key_here
STREAM_API_SECRET=your_stream_api_secret_here

# Webhook Verification & Zero-Downtime Secret Rotation
STREAM_WEBHOOK_SECRET=your_stream_webhook_secret_here
STREAM_WEBHOOK_SECRET_PREVIOUS=your_previous_webhook_secret_here

# Database Connection (Required for user sync)
DATABASE_URL=postgresql://user:password@host:5432/database

# Optional: Background Sync Job Protection
STREAM_SYNC_SECRET=your_secret_for_sync_endpoint

# Cloudflare R2 Permanent Recording Storage
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_RECORDINGS_BUCKET=familiarise-recordings
```

### Variable Breakdown

| Variable                         | Scope            | Purpose                                            | Security   |
| -------------------------------- | ---------------- | -------------------------------------------------- | ---------- |
| `NEXT_PUBLIC_STREAM_API_KEY`     | Public (Client)  | Identifies your Stream app                         | Public     |
| `STREAM_API_SECRET`              | Private (Server) | Authenticates server operations                    | **SECRET** |
| `STREAM_WEBHOOK_SECRET`          | Private (Server) | Primary HMAC secret for `/api/stream/webhooks`     | **SECRET** |
| `STREAM_WEBHOOK_SECRET_PREVIOUS` | Private (Server) | Fallback HMAC secret during zero-downtime rotation | **SECRET** |
| `DATABASE_URL`                   | Private (Server) | User data for token generation                     | **SECRET** |
| `STREAM_SYNC_SECRET`             | Private (Server) | Protects sync API endpoint                         | **SECRET** |
| `R2_*`                           | Private (Server) | Cloudflare R2 S3-compatible multipart storage      | **SECRET** |

⚠️ **Security Warning:**

- `NEXT_PUBLIC_` prefix makes variables accessible to the browser
- **NEVER** prefix `STREAM_API_SECRET` with `NEXT_PUBLIC_`
- Keep secrets in server-side code only

### Getting Stream Credentials

#### Step 1: Create Stream Account

1. Visit [getstream.io](https://getstream.io)
2. Sign up for a free account
3. Verify your email address

#### Step 2: Create Application

1. Navigate to **Dashboard** → **Create New App**
2. Choose app name (e.g., "Familiarise Dev")
3. Select region closest to your users
   - 🇺🇸 US East (Virginia / `gcp-us-east5`)
   - 🇪🇺 EU West (Ireland)
   - 🇸🇬 Singapore
   - 🇦🇺 Australia

#### Step 3: Retrieve Credentials

1. Navigate to **Dashboard** → **Your App** → **App Settings**
2. Copy **API Key** (format: `xxxxxxxxxxxxx`)
3. Copy **API Secret** (format: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

#### Step 4: Add to Environment File

**For Development:**

```bash
# .env.local (never commit this file!)
NEXT_PUBLIC_STREAM_API_KEY=your_key_here
STREAM_API_SECRET=your_secret_here
DATABASE_URL=postgresql://...
```

**For Production:**

```bash
# Set in Vercel/Netlify/hosting platform
NEXT_PUBLIC_STREAM_API_KEY=prod_key
STREAM_API_SECRET=prod_secret
STREAM_WEBHOOK_SECRET=prod_webhook_secret
DATABASE_URL=postgresql://...
STREAM_SYNC_SECRET=random_secure_string
```

### Environment File Template

Create `.env.example` in your project root:

```env
# Stream API Credentials
NEXT_PUBLIC_STREAM_API_KEY=""
STREAM_API_KEY=""
STREAM_API_SECRET=""
STREAM_WEBHOOK_SECRET=""
STREAM_WEBHOOK_SECRET_PREVIOUS=""
STREAM_SYNC_SECRET=""

# Database
DATABASE_URL=""
DIRECT_URL=""

# Better Auth
BETTER_AUTH_SECRET=""
BETTER_AUTH_URL=""

# Other services...
```

---

## Production Operator Cutover & Verification Runbook

Stream application settings, call-type permission grants, webhook subscriptions, and external storage are managed via idempotent scripts under `scripts/stream/` rather than manual dashboard edits. Pre-image backups are written automatically to `.stream-backups/` (and `os.tmpdir()` for call-type settings drift) before any write.

### 1. App Settings, Call-Type Hardening & Webhook Subscription (`scripts/stream/ensure.ts`)

Run the unified provisioning orchestrator to inspect and apply all Stream control-plane invariants in one pass:

```bash
# Step 1a: Dry run (inspects live Stream state and prints pending diffs without mutating)
npx tsx scripts/stream/ensure.ts

# Step 1b: Apply changes once /api/meetings/[meetingId]/join and /end are deployed
npx tsx scripts/stream/ensure.ts --apply --routes-are-deployed
# (Also accepts --confirm-join-route-deployed on ensure.ts / ensure-call-type-grants.ts)

# Step 1c: Verify and widen webhook event subscriptions for all handled chat & video events
npx tsx scripts/stream/ensure-webhook-subscription.ts --check
npx tsx scripts/stream/ensure-webhook-subscription.ts --apply
```

What the orchestrator enforces:

- **App-Level Settings (`ensure-app-settings.ts`)**: Configures `webhook_url` (`https://<origin>/api/stream/webhooks`), `AsyncModerationConfiguration`, `guest_user_creation_disabled: true`, and `enable_hook_payload_compression: false` after running a no-op fingerprint probe (`lib/stream/config-fingerprint.ts`) to guarantee `updateApp` merges rather than replaces unrelated app fields.
- **Billable Permissions + Scope Suffix Stripping (`ensure-call-type-grants.ts` & `harden-unused-call-types.ts`)**: Strips all billable permissions (`BILLABLE_PERMISSIONS`: `start-recording`, `stop-recording`, `start-frame-recording`, `stop-frame-recording`, `start-raw-recording`, `stop-raw-recording`, `start-individual-recording`, `stop-individual-recording`, `start-transcription`, `stop-transcription`, `start-closed-captions`, `stop-closed-captions`, `start-broadcasting`, `stop-broadcasting`, `start-rtmp-broadcasts`, `stop-rtmp-broadcast`, `stop-all-rtmp-broadcasts`, `use-noise-cancellation`, `enable-noise-cancellation`) **including their `-owner` and `-any-team` scoped suffixes** (`matchesPermissionWithScope`) across all four built-in call types (`default`, `livestream`, `audio_room`, and `development`).
- **Least-Privilege Call Admission on `default`**: Revokes `create-call`, `join-call`, `join-ended-call`, and `update-call-permissions` from `user` and `guest`, and revokes `create-call` and `end-call` from `user`, `guest`, and `call_member`. Only `call_member` and `co_presenter` (both assigned server-side after `resolveMeetingAccess`) and `admin` can join an active room. The `call_member` role holds only the `-owner` variants of `update-call-permissions`, `mute-users` and `pin-call-track`. The custom `co_presenter` role adds `mute-users`, `pin-call-track` and `join-backstage` for accepted presenter collaborators, and the script leaves that role untouched.
- **Unused Call-Type Reach Lockdown**: Strips `REACH_PERMISSIONS` (`create-call`, `join-call`, `join-backstage`, `join-ended-call` and `-any-team` variants) from `livestream`, `audio_room`, and `development` across all end-user roles (`user`, `guest`, `anonymous`, `speaker`, `host`, `call_member`).
- **Empty Room Auto-Close**: Enforces `session.inactivity_timeout_seconds = 300` (5 minutes) on the `default` call type.

### 2. Cloudflare R2 Recording Storage

Permanent recordings (`PERMANENT` policy on Webinars, Classes, and opt-in 1:1 sessions) are streamed server-side from Stream's signed recording URL directly to Cloudflare R2 (`$0` egress, S3-compatible multipart streaming via `lib/storage/r2-client.ts` and `lib/stream/recording-transfer-service.ts`, with automatic fallback to Supabase Storage for legacy objects).

Ensure `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_RECORDINGS_BUCKET` are set in the deployment environment before enabling permanent recording transfers (`jobs/stream/transfer-expiring-recordings.ts`).

### 3. Live Stream Rate-Limit Ceilings & Batch Pacing Invariant

Stream enforces strict per-minute rate limits per endpoint at the application level:

| Stream API Endpoint  | Live App Ceiling | Primary Call Sites                                                            |
| -------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `DeleteUser`         | **60 / min**     | `scripts/stream/stream-sync.ts` (`hardDeleteEligibleUsers`), `scrubUser`      |
| `DeleteChannels`     | **60 / min**     | `jobs/stream/expire-event-channels.ts` (retention purge)                      |
| `ExportUsers`        | **60 / min**     | Compliance / DSAR export workflows                                            |
| `UpdateUsers`        | **300 / min**    | `actions/stream/chat/user.action.ts` (`upsertUsersToStream`, 100-user chunks) |
| `UpdateUsersPartial` | **300 / min**    | User profile and role synchronization                                         |
| `SendMessage`        | **1,000 / min**  | `app/api/stream/channels/open/route.ts` (`booking-ctx-` receipt cards)        |
| `QueryChannels`      | **10,000 / min** | `lib/stream/batch.ts` (`queryChannelsPaged`, 30-channel page ceiling)         |

> [!IMPORTANT]
> **Why Batch Jobs Enforce `10_000ms` Pacing Between 100-Item Chunks:**
> Stream's batch deletion endpoints (`deleteUsers` and `deleteChannels`) accept up to 100 IDs per request, but their rate limit is **60 requests per minute** (1 request/second sustained, with tight burst buckets on shared cluster placements). Both `jobs/stream/expire-event-channels.ts` and `scripts/stream/stream-sync.ts` enforce a **`10_000ms` (10-second) delay between 100-item chunks** (`RATE_LIMIT_DELAY_MS = 10_000`, capped at 6 chunks/minute = 600 items/minute) so background cleanup jobs never trip `429 Too Many Requests` or starve interactive user traffic.

---

## Package Installation

Stream SDK consists of **4 separate packages**, pinned to exact versions in `package.json` (no caret ranges).

### Required Packages

```json
{
  "dependencies": {
    "@stream-io/node-sdk": "0.8.10",
    "@stream-io/video-react-sdk": "1.43.3",
    "stream-chat": "9.53.0",
    "stream-chat-react": "14.12.1"
  }
}
```

### Package Purposes

| Package                      | Purpose                      | Used In                                                       |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------- |
| `@stream-io/node-sdk`        | Server-side Video & App SDK  | `lib/stream-client.ts`, `actions/stream/**`, `scripts/stream` |
| `@stream-io/video-react-sdk` | Video client & WebRTC UI     | `providers/StreamProviderImpl.tsx`, `app/meetings/[id]/**`    |
| `stream-chat`                | Chat client core (Node & UI) | `lib/stream-client.ts`, `providers/StreamProviderImpl.tsx`    |
| `stream-chat-react`          | Chat React UI components     | `components/chat/**`                                          |

---

## Pinned SDK Version Governance

All four Stream packages use exact version pins in `package.json` and are grouped under `stream-communication` in `.github/dependabot.yml` (with `version-update:semver-major` ignored globally):

| Package                          | Pinned Version | Upstream Latest Series | Governance & Upgrade Verification Criteria                                                                                                                                                                                                                          |
| -------------------------------- | -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@stream-io/node-sdk`**        | `0.8.10`       | `0.8.x`                | Verify `npx tsc --noEmit` passes without casts on `call.updateCallMembers` in `app/api/meetings/[meetingId]/join/route.ts` and `scripts/stream/backfill-call-member-role.ts`, and run `npx jest __tests__/stream/`.                                                 |
| **`@stream-io/video-react-sdk`** | `1.43.3`       | `1.43.x`               | Verify WebRTC call join, `<StageControls />`, and incoming video resolution caps (`setPreferredIncomingVideoResolution`) in `app/meetings/[id]/components/MeetingRoom.tsx`.                                                                                         |
| **`stream-chat-react`**          | `14.12.1`      | `14.x`                 | Uses CSS v2 theming tokens (`stream-chat-react/dist/css/index.css`). Before upgrading minor/major versions, audit custom components under `components/chat/` (`CustomMessage.tsx`, `ChatContainer.tsx`, `ChatSidebar.tsx`) across light and dark modes.             |
| **`stream-chat`**                | `9.53.0`       | `10.x-rc`              | **Pre-Release Hold**: `stream-chat` `v10` remains in release-candidate status with breaking API removals (`Channel.getConfig()` removed, `client.configs` renamed to `client.channelServerConfigs`). Hold on `9.x` stable until `v10` reaches general availability. |

### Import Stream CSS

Stream CSS is imported inside `providers/StreamProviderImpl.tsx`, co-located with the lazy-loaded provider implementation that renders Stream UI components:

```typescript
// providers/StreamProviderImpl.tsx
import "stream-chat-react/dist/css/index.css";
import "@stream-io/video-react-sdk/dist/css/styles.css";
```

⚠️ **Important:** Import CSS **before** your custom styles to allow overrides. Do not import in `app/layout.tsx` or `providers/StreamProvider.tsx` — the CSS is scoped to the lazy `StreamProviderImpl` chunk so non-Stream routes never pay the CSS bundle cost.

---

## Stream Dashboard Setup

### 1. Configure Channel Types

**Navigation:** Dashboard → Chat → Channel Types

Stream provides default channel types. For Familiarise, configure:

#### messaging (1-on-1 Chats)

| Setting           | Value       | Purpose             |
| ----------------- | ----------- | ------------------- |
| Type Name         | `messaging` | Built-in type       |
| Max Members       | 10          | Small group chats   |
| Read Events       | ✅ Enabled  | Show read receipts  |
| Reactions         | ✅ Enabled  | Message reactions   |
| Replies           | ✅ Enabled  | Threaded replies    |
| Typing Indicators | ✅ Enabled  | "User is typing..." |

**Use Cases:**

- Direct consultations
- 1-on-1 subscription chats
- Private conversations

#### team (Group Channels)

| Setting            | Value      | Purpose          |
| ------------------ | ---------- | ---------------- |
| Type Name          | `team`     | Built-in type    |
| Max Members        | Unlimited  | Large events     |
| Read Events        | ✅ Enabled | Track attendance |
| Reactions          | ✅ Enabled | Engagement       |
| Replies            | ✅ Enabled | Discussions      |
| Push Notifications | ✅ Enabled | Event updates    |

**Use Cases:**

- Webinars (broadcast + Q&A)
- Online classes (instructor + students)
- Group events

### 2. Set Up Roles & Permissions

**Navigation:** Dashboard → Chat → Roles & Permissions

Only platform `ADMIN` and `STAFF` accounts receive the global `admin` role in Stream (`mapRoleToStream` in `lib/user.ts`). All other accounts (`CONSULTANT`, `CONSULTEE`, `USER`) receive the standard `user` role, while event hosts receive channel-scoped `channel_moderator` grants on their own `team` channels (`assignRoles` in `actions/stream/chat/channel.action.ts` and `lib/stream/event-channel-service.ts`).

#### Role Mapping (`lib/user.ts`)

| App Role     | Global Stream Role | Channel-Scoped Role (Owned Group Events) | Effective Permissions                    |
| ------------ | ------------------ | ---------------------------------------- | ---------------------------------------- |
| `ADMIN`      | `admin`            | —                                        | Full system access                       |
| `STAFF`      | `admin`            | —                                        | Full system access                       |
| `CONSULTANT` | `user`             | `channel_moderator`                      | Moderate own group channels; standard DM |
| `CONSULTEE`  | `user`             | —                                        | Read and send messages in joined threads |
| `USER`       | `user`             | —                                        | Standard permissions                     |

### 3. Enable Chat Features

**Navigation:** Dashboard → Chat → Settings

Enable these features:

| Feature            | Status    | Purpose                      |
| ------------------ | --------- | ---------------------------- |
| Message Search     | ✅ Enable | Search chat history          |
| Push Notifications | ✅ Enable | Mobile/browser notifications |
| Typing Indicators  | ✅ Enable | Real-time typing status      |
| Read Receipts      | ✅ Enable | Message read status          |
| Reactions          | ✅ Enable | Emoji reactions              |
| Threads            | ✅ Enable | Reply threading              |
| URL Enrichment     | ✅ Enable | Link previews                |
| File Uploads       | ✅ Enable | Image/document sharing       |

### 4. Configure Video Settings

**Navigation:** Dashboard → Video → Settings

| Setting            | Recommended Value | Notes                   |
| ------------------ | ----------------- | ----------------------- |
| Default Call Type  | `default`         | Basic video calls       |
| Max Participants   | 100               | Adjust per needs        |
| Recording          | Optional          | Enable if needed        |
| Screen Sharing     | ✅ Enable         | For presentations       |
| Picture-in-Picture | ✅ Enable         | Multitasking            |
| Video Quality      | Auto              | Adapts to bandwidth     |
| Backstage Mode     | ✅ Enable         | Pre-call prep for hosts |

### 5. Security Settings

**Navigation:** Dashboard → Security

| Setting            | Value     | Purpose                     |
| ------------------ | --------- | --------------------------- |
| Token Validity     | 1 hour    | Automatic token expiry      |
| API Rate Limits    | Default   | Prevent abuse               |
| Webhook Signatures | ✅ Enable | Verify webhook authenticity |
| IP Allowlist       | Optional  | Restrict server IPs         |

---

## Code Integration

### Integration Checklist

Follow these steps to integrate Stream SDK into your Next.js application:

- [ ] **Step 1:** Environment variables added to `.env.local`
- [ ] **Step 2:** All 4 Stream packages installed
- [ ] **Step 3:** CSS styles imported in `providers/StreamProvider.tsx`
- [ ] **Step 4:** Token providers created (server actions)
- [ ] **Step 5:** StreamProvider component created
- [ ] **Step 6:** App wrapped with StreamProvider
- [ ] **Step 7:** Error boundary integrated
- [ ] **Step 8:** Connection verified in browser

### Step 1: Create Token Providers

**File:** `actions/stream/chat/stream.action.ts`

```typescript
"use server";

import { fetchUserDetails, mapRoleToStream } from "@/lib/user";
import { StreamClient } from "@stream-io/node-sdk";
import { StreamChat } from "stream-chat";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;

// Video token provider (Stream Video)
export const tokenProvider = async (userId: string) => {
  try {
    const userDetails = await fetchUserDetails(userId);

    if (!userDetails) throw new Error("User not found");
    if (!apiKey) throw new Error("Stream API key not configured");
    if (!apiSecret) throw new Error("Stream API secret not configured");

    const client = new StreamClient(apiKey, apiSecret);

    const exp = Math.round(Date.now() / 1000) + 60 * 60; // 1 hour
    const issued = Math.round(Date.now() / 1000) - 60; // 1 minute ago

    const streamRole = mapRoleToStream(userDetails.role);

    console.log(
      `Generating token for user ${userDetails.id} with role ${streamRole}`,
    );

    // Generate user token with the correct payload structure
    const token = client.generateUserToken({
      user_id: userDetails.id,
      exp,
      iat: issued,
    });

    return token;
  } catch (error) {
    console.error("Error generating token:", error);
    throw error;
  }
};

// Chat token provider (Stream Chat)
export const chatTokenProvider = async (userId: string) => {
  try {
    if (!apiKey) throw new Error("Stream API key not configured");
    if (!apiSecret) throw new Error("Stream API secret not configured");

    const userDetails = await fetchUserDetails(userId);
    if (!userDetails) throw new Error("User not found");

    const serverClient = StreamChat.getInstance(apiKey, apiSecret);
    const token = serverClient.createToken(userDetails.id);
    return token;
  } catch (error) {
    console.error("Error generating chat token:", error);
    throw error;
  }
};
```

**Key Points:**

- Server actions (must have `"use server"` directive)
- Tokens valid for 1 hour
- Separate providers for chat and video
- User validation before token generation

### Step 2: Create StreamProvider

**File:** `providers/StreamProvider.tsx` (already exists in codebase)

This provider manages both chat and video client connections. See the actual implementation in the file for complete details.

**Key Features:**

- Dual-client pattern (chat + video)
- Token caching (50-minute cache for 1-hour tokens)
- Connection state management
- Exponential backoff retry logic
- Error boundary integration

### Step 3: Wrap Application

**File:** `app/layout.tsx`

```typescript
import StreamProvider from "@/providers/StreamProvider";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <html lang="en">
      <body>
        {session?.user?.id ? (
          <StreamProvider
            userId={session.user.id}
            enableChat={true}
            enableVideo={true}
          >
            {children}
          </StreamProvider>
        ) : (
          // Unauthenticated users don't need Stream
          children
        )}
      </body>
    </html>
  );
}
```

**Props:**

- `userId` - Authenticated user ID (required)
- `enableChat` - Enable chat client (default: true)
- `enableVideo` - Enable video client (default: true)

---

## Minimal Working Example

Complete minimal setup to verify Stream integration:

### 1. Environment Setup

```bash
# .env.local
NEXT_PUBLIC_STREAM_API_KEY=your_key
STREAM_API_SECRET=your_secret
DATABASE_URL=postgresql://...
```

### 2. Install Packages

```bash
npm install @stream-io/node-sdk @stream-io/video-react-sdk stream-chat stream-chat-react
```

### 3. Create Test Page

**File:** `app/stream-test/page.tsx`

```typescript
"use client";

import { useStreamConnection } from "@/providers/StreamProvider";

export default function StreamTestPage() {
  const { chatConnected, videoConnected, isConnecting, error } = useStreamConnection();

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Stream Connection Test</h1>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span>Chat:</span>
          {isConnecting ? (
            <span className="text-yellow-600">Connecting...</span>
          ) : chatConnected ? (
            <span className="text-green-600">✅ Connected</span>
          ) : (
            <span className="text-red-600">❌ Disconnected</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span>Video:</span>
          {isConnecting ? (
            <span className="text-yellow-600">Connecting...</span>
          ) : videoConnected ? (
            <span className="text-green-600">✅ Connected</span>
          ) : (
            <span className="text-red-600">❌ Disconnected</span>
          )}
        </div>

        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded">
            <p className="text-red-700 font-medium">Error:</p>
            <p className="text-red-600 text-sm">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
```

### 4. Test the Connection

1. Start dev server: `npm run dev`
2. Navigate to `/stream-test`
3. Check for green checkmarks
4. Open browser console for debug logs

**Expected Console Output:**

```
Connecting user user_123 to Stream Chat
Chat connection successful for user user_123
Video connection successful for user user_123
```

---

## Environment Validation

### Validation Function

Create a helper to validate environment variables at runtime:

**File:** `lib/env-validation.ts`

```typescript
export function validateStreamEnv() {
  const errors: string[] = [];

  // Check public API key
  const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
  if (!apiKey) {
    errors.push("NEXT_PUBLIC_STREAM_API_KEY is not set");
  } else if (apiKey.length < 10) {
    errors.push("NEXT_PUBLIC_STREAM_API_KEY appears invalid (too short)");
  }

  // Check secret (server-side only)
  if (typeof window === "undefined") {
    const apiSecret = process.env.STREAM_API_SECRET;
    if (!apiSecret) {
      errors.push("STREAM_API_SECRET is not set");
    } else if (apiSecret.length < 20) {
      errors.push("STREAM_API_SECRET appears invalid (too short)");
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      errors.push("DATABASE_URL is not set (required for user sync)");
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Stream environment validation failed:\n${errors.join("\n")}`,
    );
  }

  return {
    apiKey,
    apiSecret: process.env.STREAM_API_SECRET,
    databaseUrl: process.env.DATABASE_URL,
  };
}
```

### Usage in Provider

```typescript
// providers/StreamProvider.tsx
import { validateStreamEnv } from "@/lib/env-validation";

export default function StreamProvider({ children, userId }: Props) {
  useEffect(() => {
    try {
      validateStreamEnv();
    } catch (error) {
      console.error("Environment validation failed:", error);
      setError(error.message);
    }
  }, []);

  // Rest of provider code...
}
```

### Startup Check Script

**File:** `scripts/check-stream-env.ts`

```typescript
import { validateStreamEnv } from "../lib/env-validation";

try {
  console.log("Checking Stream environment variables...");
  const env = validateStreamEnv();
  console.log("✅ All Stream environment variables are valid");
  console.log(`   API Key: ${env.apiKey.substring(0, 10)}...`);
} catch (error) {
  console.error("❌ Environment validation failed:");
  console.error(error.message);
  process.exit(1);
}
```

Run before deployment:

```bash
npx tsx scripts/check-stream-env.ts
```

---

## Common Setup Errors

### Error 1: "API Key Not Defined"

**Full Error:**

```
Error: NEXT_PUBLIC_STREAM_API_KEY is not set
```

**Cause:** Environment variable not loaded

**Solutions:**

1. **Check file exists:**

   ```bash
   ls -la .env.local
   ```

2. **Verify variable name:**

   ```env
   # ✅ Correct (with NEXT_PUBLIC_ prefix)
   NEXT_PUBLIC_STREAM_API_KEY=abc123

   # ❌ Wrong (missing prefix)
   STREAM_API_KEY=abc123
   ```

3. **Restart dev server:**

   ```bash
   # Kill existing process
   # Restart
   npm run dev
   ```

4. **Check Next.js environment:**
   ```typescript
   // In a client component
   console.log(process.env.NEXT_PUBLIC_STREAM_API_KEY); // Should not be undefined
   ```

### Error 2: "Invalid API Secret"

**Full Error:**

```
StreamChat error: Invalid API secret
```

**Cause:** Wrong secret or extra characters

**Solutions:**

1. **Verify secret from dashboard:**
   - Login to Stream dashboard
   - Navigate to App Settings
   - Copy secret exactly (no spaces)

2. **Check for quotes/spaces:**

   ```env
   # ❌ Wrong (has quotes)
   STREAM_API_SECRET="abc123"

   # ✅ Correct (no quotes)
   STREAM_API_SECRET=abc123
   ```

3. **Ensure using correct app:**
   - Dev environment → Dev app
   - Production environment → Production app

### Error 3: "Module Not Found"

**Full Error:**

```
Cannot find module 'stream-chat'
```

**Cause:** Package not installed or corrupted

**Solutions:**

1. **Reinstall packages:**

   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

2. **Verify installation:**

   ```bash
   npm list stream-chat
   ```

3. **Check package.json:**

   ```json
   {
     "dependencies": {
       "stream-chat": "^8.57.6"
     }
   }
   ```

4. **Clear Next.js cache:**
   ```bash
   rm -rf .next
   npm run dev
   ```

### Error 4: "User Not Found"

**Full Error:**

```
Error: User not found
```

**Cause:** Database query failed or user doesn't exist

**Solutions:**

1. **Check DATABASE_URL is set:**

   ```bash
   echo $DATABASE_URL
   ```

2. **Verify user exists in database:**

   ```sql
   SELECT id, name FROM "User" WHERE id = 'user_id';
   ```

3. **Check Prisma connection:**
   ```bash
   npx prisma db pull
   ```

### Error 5: CORS Errors

**Full Error:**

```
Access to fetch at 'https://stream-io-api.com' from origin 'http://localhost:3000'
has been blocked by CORS policy
```

**Cause:** Server-side code running on client

**Solutions:**

1. **Ensure server actions have directive:**

   ```typescript
   "use server"; // Must be at top of file

   export async function tokenProvider(userId: string) {
     // Server-only code
   }
   ```

2. **Don't call server actions from client imports:**

   ```typescript
   // ❌ Wrong (importing server code in client)
   import { tokenProvider } from "@/actions/stream.action";

   // ✅ Correct (use as callback)
   tokenProvider: () => tokenProvider(userId);
   ```

### Error 6: "Token Expired"

**Full Error:**

```
StreamChat error: Token expired
```

**Cause:** System time mismatch or token generation bug

**Solutions:**

1. **Check system time:**

   ```bash
   date
   # Should match current time
   ```

2. **Synchronize time (Linux):**

   ```bash
   sudo ntpdate pool.ntp.org
   ```

3. **Verify token expiry:**
   ```typescript
   const exp = Math.round(Date.now() / 1000) + 60 * 60; // 1 hour from now
   console.log("Token expires at:", new Date(exp * 1000));
   ```

---

## Next.js Specific Configuration

### App Router Setup

Stream SDK works with Next.js 13+ App Router.

**File Structure:**

```
app/
├── layout.tsx          # Wrap with StreamProvider
├── (authenticated)/    # Protected routes
│   └── chat/
│       └── page.tsx    # Chat UI
└── api/
    └── stream/
        └── sync/
            └── route.ts # Background sync endpoint
```

### Server Actions

Stream token generation **must** use server actions:

```typescript
// actions/stream/chat/stream.action.ts
"use server"; // Required!

export async function tokenProvider(userId: string) {
  // Server-only code
  const secret = process.env.STREAM_API_SECRET; // Safe here
  return client.createToken(userId);
}
```

**Why Server Actions?**

- Keeps API secret secure
- No CORS issues
- Better performance
- Type-safe

### Client Components

Components using Stream hooks must be client components:

```typescript
"use client"; // Required for hooks

import { useStreamConnection } from "@/providers/StreamProvider";

export function ChatComponent() {
  const { chatConnected } = useStreamConnection();
  // ...
}
```

### Environment Variables in Next.js

| Prefix         | Access          | Example                      |
| -------------- | --------------- | ---------------------------- |
| `NEXT_PUBLIC_` | Client + Server | `NEXT_PUBLIC_STREAM_API_KEY` |
| _(none)_       | Server only     | `STREAM_API_SECRET`          |

**Loading Order:**

1. `.env.local` (local development, gitignored)
2. `.env.development` (development defaults)
3. `.env.production` (production defaults)
4. `.env` (all environments)

### Middleware Considerations

If using Next.js middleware for auth:

```typescript
// middleware.ts
export function middleware(request: NextRequest) {
  // Don't block Stream API calls
  if (request.nextUrl.pathname.startsWith("/api/stream")) {
    return NextResponse.next();
  }

  // Your auth logic
}
```

### Edge Runtime Compatibility

⚠️ Stream SDK is **not compatible** with Edge Runtime.

```typescript
// app/api/stream/token/route.ts
// ❌ Don't use edge runtime
// export const runtime = "edge";

// ✅ Use Node.js runtime (default)
export async function GET(request: Request) {
  const token = await tokenProvider(userId);
  return Response.json({ token });
}
```

---

## Development vs Production

### Development Setup

```env
# .env.local (never commit!)
NEXT_PUBLIC_STREAM_API_KEY=dev_key_123
STREAM_API_SECRET=dev_secret_456
DATABASE_URL=postgresql://localhost:5432/familiarise_dev
```

**Best Practices:**

- Use separate Stream app for development
- Shorter token expiry for testing (e.g., 10 minutes)
- Enable debug logging
- Test token refresh logic

### Production Setup

```env
# Set in deployment platform (Vercel, Railway, etc.)
NEXT_PUBLIC_STREAM_API_KEY=prod_key_789
STREAM_API_SECRET=prod_secret_012
DATABASE_URL=postgresql://prod-host:5432/familiarise
STREAM_SYNC_SECRET=random_secure_64_char_string
```

**Security Checklist:**

- [ ] Different API keys for dev/prod
- [ ] API secret never exposed to client
- [ ] HTTPS enforced
- [ ] Sync endpoint protected with secret
- [ ] Rate limiting enabled
- [ ] Error monitoring configured (Sentry)
- [ ] Token expiry appropriate (1 hour)
- [ ] Database connection pooling enabled

### Deployment Platforms

#### Vercel

```bash
# Set environment variables
vercel env add NEXT_PUBLIC_STREAM_API_KEY production
vercel env add STREAM_API_SECRET production
vercel env add DATABASE_URL production
```

#### Railway

```bash
# Set via dashboard or CLI
railway variables set NEXT_PUBLIC_STREAM_API_KEY=xxx
railway variables set STREAM_API_SECRET=xxx
```

---

## Next Steps

**Setup complete? Move to:**

1. **Understand the architecture:** [01. Architecture Overview](./01-architecture.md)
2. **Learn provider internals:** [03. Provider & Authentication](./03-provider-authentication.md)
3. **Implement chat:** [04. Chat Implementation](./04-chat-implementation.md)
4. **Add video calls:** [05. Video Implementation](./05-video-implementation.md)
5. **Recording & Webhooks:** [13. Recording & Webhooks](./13-recording-webhooks.md)

**Troubleshooting:** [Troubleshooting Guide](./troubleshooting.md)

---

## Deprecated & Superseded Approaches

- **`NEXTAUTH_SECRET` / `NEXTAUTH_URL`**: Replaced by `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
- **Manual dashboard clicks for call-type grants and app settings**: Superseded by `scripts/stream/ensure.ts` (`ensure-app-settings.ts` and `harden-unused-call-types.ts` write pre-image backups to `.stream-backups/`, while `ensure-call-type-grants.ts` writes a drift snapshot to `os.tmpdir()` when settings drift is detected and verifies post-write state).

---

← [01. Architecture](./01-architecture.md) | [Next: Provider & Authentication](./03-provider-authentication.md) →
