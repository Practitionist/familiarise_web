# Maintenance Mode Architecture

## Overview

The maintenance mode system uses a **two-tier state management** approach:

- **Redis (Upstash)**: Edge-fast reads for middleware. Queried on every request via REST API.
- **Prisma (PostgreSQL)**: Audit trail and historical data. Stores `MaintenanceWindow` records.

Three maintenance phases: **OFF** -> **DEGRADED** -> **OFFLINE**

### Fail-Open Design

If Redis is unreachable, the system defaults to `OFF` (site stays up). This prevents a Redis outage from accidentally triggering maintenance mode or blocking all traffic.

## Data Flow

```
Admin toggles maintenance mode (UI)
    |
    v
POST /api/admin/maintenance
    |
    +---> Redis: SET maintenance:phase = "OFFLINE"
    |     Redis: SET maintenance:config = { reason, eta, bypassSecret, betterstackIncidentId }
    |
    +---> Prisma: CREATE MaintenanceWindow { phase, reason, startedAt, startedBy, ... }
    |
    +---> BetterStack: CREATE incident (if OFFLINE)
    |
    v
Middleware reads Redis on every request
    |
    +---> getMaintenanceState() via direct Upstash REST fetch
    |
    +---> Phase = OFF? -> Continue normally
    |     Phase = DEGRADED? -> Add headers, continue
    |     Phase = OFFLINE? -> Rewrite to /maintenance page
    |
    v
Client-side MaintenanceProvider polls /api/health every 60s
    |
    +---> Banner shows (DEGRADED) or maintenance page auto-refreshes (OFFLINE)
    |
    v
Admin ends maintenance
    |
    +---> Redis: SET maintenance:phase = "OFF"
    +---> Prisma: UPDATE MaintenanceWindow { endedAt, endedBy }
    +---> BetterStack: RESOLVE incident
    +---> Novu: Send "we're back" notification
```

## Key Files

| File                                                            | Runtime | Purpose                                                                                                                                  |
| --------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `middleware.ts`                                                 | Edge    | Request interception, maintenance checks, route protection                                                                               |
| `lib/maintenance-edge.ts`                                       | Edge    | Edge-safe Redis reads via `fetch()` (180s cache) + Web Crypto HMAC-SHA256 bypass token verification.                                     |
| `lib/maintenance-cron.ts`                                       | Node.js | Shared cached `readMaintenancePhase()` reader (60s success / 5s failure cache) + `abortIfMaintenance` / `assertNotInMaintenance` guards. |
| `lib/maintenance.ts`                                            | Node.js | Server-side state management (reuses `readMaintenancePhase()` and invalidates cache on `setMaintenanceState()`).                         |
| `actions/maintenance/drain-sessions.ts`                         | Node.js | Active Stream video call drain + deterministic DB-derived chat channel freeze/unfreeze (`deriveChannelsToUnfreeze()`).                   |
| `lib/betterstack.ts`                                            | Node.js | BetterStack incident creation/resolution                                                                                                 |
| `app/api/admin/maintenance/route.ts`                            | Node.js | Admin CRUD API (GET/POST/PATCH/DELETE)                                                                                                   |
| `app/api/health/route.ts`                                       | Node.js | Public health check — returns maintenance state + calls BetterStack `/api/v2/monitors` to report `{ configured, reachable, monitors[] }` |
| `providers/MaintenanceProvider.tsx`                             | Client  | React context, polls `/api/health` every 60s                                                                                             |
| `components/banners/MaintenanceBanner.tsx`                      | Client  | Dismissible warning banner for DEGRADED mode                                                                                             |
| `app/maintenance/page.tsx`                                      | Client  | Full-screen offline page, auto-refreshes every 30s                                                                                       |
| `components/dashboard/MaintenanceControls.tsx`                  | Client  | Admin/staff UI for controlling maintenance                                                                                               |
| `app/dashboard/admin/maintenance/page.tsx`                      | Client  | Admin maintenance control page                                                                                                           |
| `app/dashboard/staff/[staffId]/(features)/maintenance/page.tsx` | Client  | Staff maintenance control page                                                                                                           |

## Database Model

```prisma
enum MaintenancePhase {
  OFF
  DEGRADED
  OFFLINE
}

model MaintenanceWindow {
  id           String           @id @default(cuid())
  phase        MaintenancePhase @default(OFF)
  reason       String?
  scheduledAt  DateTime?        // For future scheduled maintenance
  startedAt    DateTime?        // When entered this phase
  endedAt      DateTime?        // When left this phase
  estimatedEnd DateTime?        // ETA displayed to users
  startedBy    String?          // User ID who triggered
  endedBy      String?          // User ID who ended
  bypassSecret String?          // UUID for bypass access
  metadata     Json?            // Reserved for future use
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

## Redis Keys (`lib/maintenance-keys.ts`)

| Key                  | Type        | Value                                                           |
| -------------------- | ----------- | --------------------------------------------------------------- |
| `maintenance:phase`  | String      | `"OFF"`, `"DEGRADED"`, or `"OFFLINE"` (24h safety TTL)          |
| `maintenance:config` | JSON String | `{ reason, estimatedEnd, bypassSecret, betterstackIncidentId }` |

`betterstackIncidentId` is set when entering OFFLINE mode (incident creation succeeds) and read when ending maintenance (to auto-resolve the incident). It is `null` if DEGRADED was used or if incident creation failed.

## Edge, Node & Cron Infrastructure Evolution (Old vs. New Double ASCII Diagram)

### 1.1 Pre-Hardening Architecture (With All 10 Audited Production Flaws Highlighted)

```text
+===================================================================================================+
|                        PRODUCERS (API Routes, Webhooks, Server Actions, Jobs)                     |
+===================================================================================================+
   |                                                |
   | (~10% Money/Booking paths pass `tx`)           | (~90% Lifecycle/Booking/Org paths omit `tx`)
   v                                                v
+------------------------------------------------+ +------------------------------------------------+
| INSIDE `Serializable` $transaction (PG_POOL=1) | | OUTSIDE $transaction (Post-Commit Dual Write)  |
|  [FLAW #1] Runs 2x React Email SSR (`render` + | |  [FLAW #2] Crash/freeze after DB commit loses  |
|  `plainText`) + sequential User/Suppression    | |  the email & Novu bell completely.             |
|  queries while holding Serializable locks!     | +------------------------------------------------+
+------------------------------------------------+                          |
   |                                                                        |
   +-----------------------------------+------------------------------------+
                                       |
         +-----------------------------+-----------------------------+
         |                                                           |
         v (Email Path: `lib/email/deliver.ts`)                      v (In-App Bell Path: `lib/novu/outbox.ts`)
+--------------------------------------------------+       +--------------------------------------------------+
| Postgres: `FailedEmail` & `FailedEmailBatch`     |       | Postgres: `NotificationOutbox`                   |
| - Inserts `status: PENDING, nextRetryAt: NOW()`  |       | - Upserts `status: PENDING, nextRetryAt: NOW()`  |
| - [FLAW #3] NO inline lease grace window!        |       | - [FLAW #3] NO inline lease grace window!        |
| - [FLAW #4] `headers` (`List-Unsubscribe`) NOT   |       | - [FLAW #6] `deriveTransactionId` misses 5 keys  |
|   rebuilt on retry -> stripped on relay replay!  |       |   (`invoiceNumber`, `exportId`, `providerId`,    |
| - [FLAW #5] Never pruned! Full HTML/text bodies  |       |   `feedbackId`, `streamCallId`) & omits fallback |
|   for every `SENT` email accumulate forever!     |       |   to `row.id` when `transactionId` is null!      |
+--------------------------------------------------+       +--------------------------------------------------+
         |                           |                               |                           |
         | Inline Fast-Path (3-5s)   | Relay (Every 15m, limit=20)   | Inline Fast-Path (5s)     | Relay (Every 5m, limit=20)
         | [RACE CONDITION!]         | [6s timeout in cron-tick!]    | [RACE CONDITION!]         | [6s timeout in cron-tick!]
         +-------------+-------------+                               +-------------+-------------+
                       |                                                           |
                       v                                                           v
+--------------------------------------------------+       +--------------------------------------------------+
| Resend API (`POST /emails`, `/emails/batch`)     |       | Novu Cloud API (16 Multiplexed Workflow Families)|
| - [FLAW #7] `idempotencyKeyFor()` hashes         |       | - [FLAW #8] `syncSubscriber` (on dashboard mount)|
|   `to + subject + html` instead of `row.id`!     |       |   & `updateSubscriberPreferences` overwrite      |
|   Resend caches keys 24h -> SILENTLY DROPS any   |       |   disjoint keys in `subscriber.data`, wiping out |
|   2nd identical email sent within 24 hours!      |       |   muted preferences on every dashboard load!     |
| - [FLAW #9] Exhausting 5 transient attempts ->   |       | - [FLAW #10] All 18 `ORG_*` workflows omit       |
|   `DEAD_LETTER` emits ZERO Sentry error alerts!  |       |   `NotificationScope` (`organizationId`) -> org  |
|   `NovuError.body` echoes PII to Sentry!         |       |   alerts NEVER show under Org tab in `<Inbox />`!|
+--------------------------------------------------+       +--------------------------------------------------+

+===================================================================================================+
|                     CRON & MAINTENANCE INFRASTRUCTURE (Post-`c4e85c003` State)                    |
+===================================================================================================+
  Netlify `cron-tick.mts` (*/5 * * * *)                      GitHub Actions (42 Scheduled Workflows)
  - Uses `minute % every < 5` (ZERO stagger):                - `c4e85c003` deleted 17 GHA backstop workflows
    * `:00` & `:30` -> fires ALL 18/19 targets at once!        for ticker jobs without raising ticker timeouts!
    * `:15` & `:45` -> fires 16/17 targets at once!          - `cron-heartbeat.yml` runs 1x/day at 04:40 UTC:
    * `:05, :25, :35, :55` -> fires ZERO targets (33% idle!)   ONLY writer of `redis.set("cron:heartbeat:last")`!
  - `keep-warm.mts` only warms 3 instances -> 15+ cold       - `/api/health` checks `cron:heartbeat:last` with
    starts stampede PgBouncer & hit 6s abort ceiling!          6h threshold -> `cron.stale: true` 18h/day!
  - Warm container bug: 1 failed tick loads `@sentry/node`   - `withCronLock` in Postgres (`SystemJobExecution`)
    and patches global `fetch` for all future warm ticks!      has NO partial unique index on `(jobName) WHERE
                                                               status = 'RUNNING'` -> P0 TOCTOU lock race!
```

### 1.2 Target Production Architecture (Improvised, Decoupled & Hardened)

```text
+===================================================================================================+
|                     PRODUCERS (API Routes, Webhooks, Server Actions, Jobs)                        |
+===================================================================================================+
   |
   | 1. Pre-render React Email OUTSIDE Serializable $transaction (single-pass `render` + `toPlainText(html)`)
   | 2. Evaluate all User & Org NotificationPreferences in Postgres/App BEFORE staging (Single Source of Truth)
   | 3. Inside `$transaction(tx)`: insert lightweight Outbox row with:
   |    - `status: "PENDING"`, `nextRetryAt: NOW() + 60s` (inline lease grace window — prevents relay race!)
   |    - Reconstructed RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers on relay retry
   |    - `transactionId: derivedKey ?? row.id` (guaranteed idempotency key for every single/org workflow)
   |    - `NotificationScope` (`scope: "org", organizationId`) on all 18 `ORG_*` workflows
   v
+---------------------------------------------------------------------------------------------------+
|                        CONSOLIDATED OUTBOX LAYER (Postgres + Partial Indexes)                     |
|  1. `FailedEmail` & `FailedEmailBatch` (Resend Email Outbox)                                      |
|  2. `NotificationOutbox` (Novu In-App Feed Outbox)                                                |
|  3. `OutboundWebhookDelivery` (Enterprise Customer Webhooks)                                      |
|  * Bounded concurrency (`CONCURRENCY = 5`) + multi-recipient `resend.batch.send` (up to 100/call) |
|  * Outbox-row-scoped `Idempotency-Key: <EMAIL_TYPE>/<row.id>` (never drops legitimate repeats)    |
|  * Automated retention pruning in `prune-system-job-executions`:                                  |
|    - Null `htmlBody`/`textBody` on `SENT` emails after 7d; delete terminal outbox rows after 30d  |
+---------------------------------------------------------------------------------------------------+
   |
   v
+===================================================================================================+
|                  STAGGERED CRON & LOCKING ENGINE (Netlify Ticker + GitHub Actions)                |
+===================================================================================================+
  Netlify `cron-tick.mts` (Every 5m, Phase-Staggered):
  - Slot `:00, :15, :30, :45` (6 targets) | Slot `:05, :20, :35, :50` (6 targets) | Slot `:10, :25, :40, :55` (6 targets)
  - Max 6–7 concurrent targets per tick (matches warm pool + PgBouncer budget); 0% idle ticks!
  - Per-target timeout raised from 6s -> 15s; `tracePropagationTargets: []` prevents warm container fetch pollution.
  - Atomic Postgres lock: `CREATE UNIQUE INDEX "SystemJobExecution_running_jobName_key" ON "SystemJobExecution"("jobName") WHERE status = 'RUNNING'`
  - `/api/health` queries `pickFresherTimestamp(redisHeartbeat, SystemJobExecution.startedAt)` -> 0% false-stale rate!

+---------------------------------------------------------------------------------------------------+
|                        MAINTENANCE STATE & SESSION DRAIN ARCHITECTURE                             |
+---------------------------------------------------------------------------------------------------+
  [Edge Middleware (`middleware.ts` -> `lib/maintenance-edge.ts`)]
    - `getMaintenanceState()` (180s cache, 30s failure cache, 200ms Upstash REST fetch timeout)
    - `getMaintenanceStateCachedOnly()` (0ms non-blocking RSC/prefetch path with `event.waitUntil`)
    - `verifyMaintenanceBypassToken()` (Web Crypto HMAC-SHA256 `<expiresAtMs>.<hmacHex>` cookie check)

  [Node Runtime (`lib/maintenance.ts` <-> `lib/maintenance-cron.ts`)]
    - Unified `readMaintenancePhase()` (60s success cache, 5s failure cache; 1 `redis.get` when OFF)
    - `getMaintenanceState()` fetches fresh `REDIS_KEYS.PHASE` (`{ bypassCache: true }`) + `REDIS_KEYS.CONFIG`
    - `setMaintenanceState()` immediately calls `invalidateMaintenancePhaseCache()` on transition

  [Session Drain & Unfreeze (`actions/maintenance/drain-sessions.ts`)]
    - Enter OFFLINE: `drainActiveSessions()` ends active Stream video calls (`endedReason: "maintenance"`)
      and freezes associated Stream chat channels in batches of 10 (`setChannelsFrozenState(..., true)`)
    - Exit OFFLINE: `unfreezeChannelsAfterMaintenance()` queries Postgres `deriveChannelsToUnfreeze()`
      (`MeetingSession.endedReason = "maintenance"` since `MaintenanceWindow.startedAt`) and unfreezes
      channels directly — no dual-source Redis set ledger required!
```

The middleware reads the maintenance state on every non-static request, so the read must never become a per-request Upstash round-trip. `lib/maintenance-edge.ts` keeps a 180-second in-memory cache (a failed or non-OK read is cached for 30 seconds) and exposes two readers:

| Reader                            | Used by                                           | Behaviour                                                                                                |
| --------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `getMaintenanceState()` (Edge)    | Full document loads + `/api/*` in `middleware.ts` | Returns the cached value if fresh, otherwise does the live Upstash read (200 ms budget; fails open OFF). |
| `getMaintenanceStateCachedOnly()` | RSC / prefetch sub-navigations in `middleware.ts` | Never blocks on Upstash. Returns the last-known state and triggers a background refresh when stale.      |
| `readMaintenancePhase()` (Node)   | `lib/maintenance.ts` + `lib/maintenance-cron.ts`  | Shared 60s Node-runtime phase cache (5s failure cache), invalidated on `setMaintenanceState()`.          |

## Bypass Mechanism (`#1487`, `#1930`)

Each maintenance window generates a UUID bypass secret (`crypto.randomUUID()`).

**Usage**:

- HTTP Header: `x-maintenance-bypass: <secret>` (constant-time compared against the active secret)
- Query / Cookie: Passing `?bypass=<secret>` mints an `HttpOnly`, `Secure`, `SameSite=Lax` cookie `maintenance_bypass=<expiresAtMs>.<hmacHex>` signed with Web Crypto HMAC-SHA256 (`createMaintenanceBypassCookieValue` / `verifyMaintenanceBypassToken` in `lib/maintenance-edge.ts`, 4-hour TTL) so the raw secret is never stored in browser cookies.

**Fallback**: If the Redis-stored secret is unavailable, falls back to `MAINTENANCE_BYPASS_SECRET` env var.

**Scope**: Bypass allows full access during both DEGRADED and OFFLINE modes. Intended for admin/staff testing during maintenance.

## BetterStack Integration

BetterStack monitors the platform for uptime and auto-creates incidents during OFFLINE maintenance.

### Monitors

Two monitors are configured at [https://uptime.betterstack.com/team/t332379](https://uptime.betterstack.com/team/t332379):

| Public Name | URL                                     | Frequency   | Alert |
| ----------- | --------------------------------------- | ----------- | ----- |
| Website     | `https://familiarisenow.com`            | Every 3 min | Email |
| API Health  | `https://familiarisenow.com/api/health` | Every 3 min | Email |

### Status Page

Public status page: [https://familiarise.betteruptime.com](https://familiarise.betteruptime.com)
Shows both monitors and reflects active incidents.

### Incident Lifecycle

**When entering OFFLINE mode** (`POST /api/admin/maintenance`):

1. `createIncident()` is called in `lib/betterstack.ts`
2. BetterStack creates an incident at `/api/v2/incidents`
3. The returned incident ID is stored in Redis under `maintenance:config.betterstackIncidentId`
4. The POST response includes `betterstackIncidentId` so admins can verify

**When ending maintenance** (`DELETE /api/admin/maintenance`):

1. `getMaintenanceState()` reads `betterstackIncidentId` from Redis
2. If an incident ID exists, `resolveIncident(id)` is called
3. BetterStack marks the incident as resolved
4. Status page updates to "All systems operational"

**DEGRADED mode** does NOT create an incident — only OFFLINE does.

**Fail-safe**: If BetterStack API is unreachable or the API key is missing, maintenance mode still activates. Only the status page sync is affected.

### Setup

See [00-betterstack-setup.md](./00-betterstack-setup.md) for the full account and monitor setup guide.

**Required env var**: `BETTERSTACK_API_KEY` (now required — `lib/betterstack.ts` logs a warning and skips if missing)

## Admin API

| Method | Endpoint                 | Purpose                                   |
| ------ | ------------------------ | ----------------------------------------- |
| GET    | `/api/admin/maintenance` | Fetch current state + last 20 windows     |
| POST   | `/api/admin/maintenance` | Start maintenance (returns bypass secret) |
| PATCH  | `/api/admin/maintenance` | Update active window (phase, reason, ETA) |
| DELETE | `/api/admin/maintenance` | End maintenance (set phase=OFF)           |

**Authorization**: Requires `ADMIN` or `STAFF` role.

## Exempt Routes

These routes are never blocked by maintenance mode:

```
/api/webhooks/*        -- Payment + Stream webhook handlers
/api/health            -- Health check endpoint
/api/auth/*            -- Authentication flows
/api/admin/maintenance -- Maintenance control API
/maintenance           -- Maintenance page itself
/_next/*               -- Next.js internal assets
/favicon*              -- Favicon files
*.* (static files)     -- Any file with an extension
```

## Environment Variables

| Variable                    | Required | Purpose                                                                        |
| --------------------------- | -------- | ------------------------------------------------------------------------------ |
| `UPSTASH_REDIS_REST_URL`    | Yes      | Redis endpoint for maintenance state                                           |
| `UPSTASH_REDIS_REST_TOKEN`  | Yes      | Redis auth token                                                               |
| `MAINTENANCE_BYPASS_SECRET` | No       | Fallback bypass secret                                                         |
| `BETTERSTACK_API_KEY`       | **Yes**  | BetterStack incident management. Token from BetterStack Settings → API tokens. |
