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
    |     Redis: SET maintenance:config = { reason, eta, bypassSecret }
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

| File | Runtime | Purpose |
|------|---------|---------|
| `middleware.ts` | Edge | Request interception, maintenance checks, route protection |
| `lib/maintenance-edge.ts` | Edge | Edge-safe Redis reads via `fetch()`. No SDK imports. |
| `lib/maintenance.ts` | Node.js | Server-side state management. Redis SDK + Prisma writes. |
| `lib/betterstack.ts` | Node.js | BetterStack incident creation/resolution |
| `app/api/admin/maintenance/route.ts` | Node.js | Admin CRUD API (GET/POST/PATCH/DELETE) |
| `app/api/health/route.ts` | Node.js | Public health check, returns maintenance state |
| `providers/MaintenanceProvider.tsx` | Client | React context, polls `/api/health` every 60s |
| `components/banners/MaintenanceBanner.tsx` | Client | Dismissible warning banner for DEGRADED mode |
| `app/maintenance/page.tsx` | Client | Full-screen offline page, auto-refreshes every 30s |
| `components/dashboard/MaintenanceControls.tsx` | Client | Admin/staff UI for controlling maintenance |
| `app/dashboard/admin/maintenance/page.tsx` | Client | Admin maintenance control page |
| `app/dashboard/staff/[staffId]/(features)/maintenance/page.tsx` | Client | Staff maintenance control page |

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

## Redis Keys

| Key | Type | Value |
|-----|------|-------|
| `maintenance:phase` | String | `"OFF"`, `"DEGRADED"`, or `"OFFLINE"` |
| `maintenance:config` | JSON String | `{ reason, estimatedEnd, bypassSecret }` |

## Bypass Mechanism

Each maintenance window generates a UUID bypass secret (`crypto.randomUUID()`).

**Usage**:
- HTTP Header: `x-maintenance-bypass: <secret>`
- Cookie: `maintenance_bypass=<secret>`

**Fallback**: If the database-stored secret is unavailable, falls back to `MAINTENANCE_BYPASS_SECRET` env var.

**Scope**: Bypass allows full access during both DEGRADED and OFFLINE modes. Intended for admin/staff testing during maintenance.

## BetterStack Integration

When entering OFFLINE mode, the system auto-creates a BetterStack incident:
- Endpoint: `https://uptime.betterstack.com/api/v2/incidents`
- Requester: `system@familiarise.com`
- Notifications: Email + Push (no SMS/call)

When ending maintenance, the incident is auto-resolved.

**Required env var**: `BETTERSTACK_API_KEY`

## Admin API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/admin/maintenance` | Fetch current state + last 20 windows |
| POST | `/api/admin/maintenance` | Start maintenance (returns bypass secret) |
| PATCH | `/api/admin/maintenance` | Update active window (phase, reason, ETA) |
| DELETE | `/api/admin/maintenance` | End maintenance (set phase=OFF) |

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

| Variable | Required | Purpose |
|----------|----------|---------|
| `UPSTASH_REDIS_REST_URL` | Yes | Redis endpoint for maintenance state |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Redis auth token |
| `MAINTENANCE_BYPASS_SECRET` | No | Fallback bypass secret |
| `BETTERSTACK_API_KEY` | No | BetterStack incident management |
