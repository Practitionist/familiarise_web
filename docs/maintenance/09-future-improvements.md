# Future Improvements

Recommended code changes to improve maintenance mode protection.

> **Already implemented**: BetterStack incident management (auto-create on OFFLINE, auto-resolve on end) is complete. See [Architecture](./01-architecture.md#betterstack-integration) and [BetterStack Setup Guide](./00-betterstack-setup.md).
>
> **Sprint 1 completed (Feb 2026)**: Items 1, 2, 3, and new items A, B below are **fully implemented**. The Implementation Priority table at the bottom reflects the updated status.
>
> **Sprint 2 completed (Feb 2026)**: Items 4, 5, C are **fully implemented**. Only item 6 (Scheduled Maintenance) remains as a future improvement.

## 1. DEGRADED Write-Blocking

**Problem**: DEGRADED mode currently allows all write operations (POST, PATCH, DELETE). Users can complete checkouts, create events, and modify data during DEGRADED mode.

**Proposed Change**: Add write-blocking logic to the middleware for DEGRADED mode. Block transactional routes while allowing reads.

**Files to Modify**:

- `middleware.ts` -- Add DEGRADED write-blocking check
- `lib/maintenance-edge.ts` -- Add helper function

**Implementation**:

```typescript
// lib/maintenance-edge.ts
const WRITE_BLOCKED_IN_DEGRADED = [
  "/api/checkout",
  "/api/appointments/*/cancel",
  "/api/appointments/*/reschedule",
  "/api/appointments/*/documents",
  "/api/bookings/consultations", // POST/PATCH only
  "/api/bookings/subscriptions", // POST only
  "/api/bookings/webinars", // POST only
  "/api/bookings/classes", // POST only
  "/api/bookings/*/allocate",
  "/api/trials", // POST only
  "/api/plans/*/materials", // POST only
];

export function isWriteBlockedInDegraded(
  pathname: string,
  method: string,
): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return false;
  }
  return WRITE_BLOCKED_IN_DEGRADED.some((pattern) =>
    matchRoute(pathname, pattern),
  );
}
```

**Effort**: 2-4 hours
**Priority**: HIGH -- Prevents the most common business risk scenario

---

## 2. Cron Job Maintenance Guard

**Problem**: All 27 cron jobs bypass middleware entirely. They connect directly to PostgreSQL and have no awareness of maintenance mode.

**Proposed Change**: Create a shared utility that every cron job calls at startup to check maintenance state.

**Files to Create**:

- `lib/maintenance-cron.ts` -- Guard utility

**Files to Modify**:

- All 27 job files in `jobs/` -- Add guard call at entry

**Implementation**:

```typescript
// lib/maintenance-cron.ts
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function abortIfMaintenance(jobName: string): Promise<void> {
  try {
    const phase = await redis.get<string>("maintenance:phase");
    if (phase === "OFFLINE") {
      console.log(
        `⚠️ [${jobName}] Maintenance mode is OFFLINE. Skipping job execution.`,
      );
      process.exit(0); // Clean exit, GitHub Actions marks as success
    }
    if (phase === "DEGRADED") {
      console.log(
        `ℹ️ [${jobName}] Maintenance mode is DEGRADED. Proceeding with caution.`,
      );
    }
  } catch (error) {
    // Fail-open: if Redis is unreachable, proceed with the job
    console.warn(
      `⚠️ [${jobName}] Could not check maintenance state. Proceeding.`,
    );
  }
}

// Usage in each job:
// import { abortIfMaintenance } from "@/lib/maintenance-cron";
// await abortIfMaintenance("cleanup-abandoned-payments");
```

**Effort**: 4-6 hours (utility + updating all 27 jobs)
**Priority**: **CRITICAL** -- This is the biggest gap in the current system. Cron jobs running during DB migration can corrupt data.

---

## 3. Webhook DB Health Check

**Problem**: Webhook handlers are exempt from maintenance mode (correct), but they attempt DB writes that may fail during migration.

**Proposed Change**: Add a DB health check at the start of each webhook handler. If the DB is unhealthy, return 503 to trigger the gateway's retry mechanism.

**Files to Modify**:

- `app/api/webhooks/stripe/route.ts`
- `app/api/webhooks/razorpay/route.ts`

**Implementation**:

```typescript
// Add to each webhook handler before processing:
async function checkDbHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// In the handler:
const dbHealthy = await checkDbHealth();
if (!dbHealthy) {
  console.warn("DB unhealthy during webhook processing, returning 503");
  return NextResponse.json(
    { error: "Service temporarily unavailable" },
    { status: 503 },
  );
}
```

**Effort**: 2-3 hours
**Priority**: HIGH -- Prevents webhook handlers from writing to a migrating DB, leveraging gateway retry behavior

---

## 4. UI Maintenance Guard Hook ✅ IMPLEMENTED

**Problem**: During DEGRADED mode, the UI shows a banner but doesn't disable interactive elements. Users can still click "Book Now" or "Pay" buttons.

**Implemented**: Created `hooks/useMaintenanceGuard.ts` hook. Wired into all 4 checkout pages (consultation, subscription, webinar, class) to block `handleCheckout` and disable payment buttons during DEGRADED/OFFLINE mode. Shows toast with maintenance message on blocked attempts.

**Files to Create**:

- `hooks/useMaintenanceGuard.ts`

**Files to Modify**:

- Checkout button component
- Booking/scheduling components
- Event creation forms

**Implementation**:

```typescript
// hooks/useMaintenanceGuard.ts
import { useMaintenanceContext } from "@/providers/MaintenanceProvider";

export function useMaintenanceGuard() {
  const { phase } = useMaintenanceContext();

  return {
    isBlocked: phase === "DEGRADED" || phase === "OFFLINE",
    isDegraded: phase === "DEGRADED",
    isOffline: phase === "OFFLINE",
    blockReason:
      phase === "DEGRADED"
        ? "Bookings are temporarily paused during maintenance."
        : phase === "OFFLINE"
          ? "The platform is currently under maintenance."
          : null,
  };
}

// Usage:
// const { isBlocked, blockReason } = useMaintenanceGuard();
// <Button disabled={isBlocked} title={blockReason}>Book Now</Button>
```

**Effort**: 3-5 hours (hook + updating key components)
**Priority**: MEDIUM -- Improves UX during DEGRADED mode, prevents confusing failed transactions

---

## 5. Admin Pre-Flight API ✅ IMPLEMENTED

**Problem**: Before activating maintenance, admins must manually check for active calls, pending payments, and upcoming appointments across multiple dashboards.

**Implemented**: Created `GET /api/admin/maintenance/preflight` endpoint that queries active calls, pending payments, upcoming appointments (4h), pending payouts, and open disputes. Returns SAFE/CAUTION/RISKY recommendation with warnings. Integrated into MaintenanceControls UI with a "Run Check" button and stats display.

**Files to Create**:

- `app/api/admin/maintenance/preflight/route.ts`

**Implementation**:

```typescript
// GET /api/admin/maintenance/preflight
// Returns:
{
  activeCalls: 2,              // From Stream.io API
  pendingPayments: 5,          // From Prisma
  upcomingAppointments: 12,    // Next 4 hours, from Prisma
  activeVideoSessions: 1,     // From Stream.io API
  pendingPayouts: 3,           // From Prisma
  isPayoutWindow: false,       // Is it Monday 8-10 PM UTC?
  recommendation: "SAFE" | "CAUTION" | "RISKY",
  warnings: [
    "3 appointments scheduled in the next 2 hours",
    "2 pending payment intents detected"
  ]
}
```

**UI Integration**: Show this data in the MaintenanceControls component before the activate button.

**Effort**: 4-6 hours (API + UI integration)
**Priority**: MEDIUM -- Quality-of-life improvement for admins, reduces risk of missed checks

---

## 6. Scheduled Maintenance

**Problem**: Maintenance can only be activated immediately. There's no way to schedule it in advance and notify users ahead of time.

**Proposed Change**: Support scheduling maintenance windows with future `scheduledAt` time. Send notifications ahead of time.

**Files to Modify**:

- `app/api/admin/maintenance/route.ts` -- Accept `scheduledAt` parameter
- `lib/maintenance.ts` -- Add scheduling logic
- `components/dashboard/MaintenanceControls.tsx` -- Add scheduling UI
- `providers/MaintenanceProvider.tsx` -- Show upcoming maintenance info

**Files to Create**:

- `jobs/maintenance/activate-scheduled-maintenance.ts` -- Cron job to activate when time comes

**Implementation Details**:

1. Admin schedules maintenance: creates `MaintenanceWindow` with `scheduledAt` in the future
2. 24 hours before: Send Novu notification to all users
3. 1 hour before: Show banner "Scheduled maintenance in X minutes"
4. At `scheduledAt`: Cron job activates the maintenance window (sets Redis keys)
5. At `estimatedEnd`: Auto-deactivate (optional, with safety check)

**Database**: The `MaintenanceWindow` model already has a `scheduledAt` field -- this feature just needs the logic to use it.

**Effort**: 8-12 hours
**Priority**: LOW -- Nice to have, but manual activation works fine for a small team

---

## New Gaps Discovered (Feb 2026 audit)

### A. Admin System-Jobs DEGRADED Blocking ✅ IMPLEMENTED

**Problem**: `/api/admin/system-jobs/run` allowed all system jobs during DEGRADED, including financial jobs that call external payment APIs.

**Implemented**: Financial job IDs are blocked in DEGRADED (503 response). All jobs blocked in OFFLINE.
File: `app/api/admin/system-jobs/run/route.ts`

---

### B. Stream.io Webhook DB Health Check ✅ IMPLEMENTED

**Problem**: `app/api/stream/webhooks/route.ts` wrote recording metadata and session events to the DB during migrations without a health check.

**Implemented**: Added `isDbHealthy()` check (reusing `app/api/webhooks/utils.ts`). Returns 503 on DB failure so Stream retries.

---

### C. `reconcile-document-storage` Safety Risk ✅ IMPLEMENTED

**Problem**: The daily document storage reconciliation job (`jobs/cleanup/reconcile-document-storage.ts`) deletes files it considers orphaned. If Supabase Storage is temporarily unreachable (e.g. during migration), it may falsely mark valid files as orphaned and delete them.

**Implemented**: Added a lightweight storage health probe at the start of `reconcileDocumentStorage()` that lists a single item from the `documents` bucket. If storage is unreachable, the job aborts with a warning instead of proceeding to the deletion loop.
File: `scripts/cleanup/reconcile-document-storage.ts`

---

## Implementation Priority Order

| #   | Improvement                                        | Priority | Status  |
| --- | -------------------------------------------------- | -------- | ------- |
| 2   | Cron job maintenance guard                         | CRITICAL | ✅ Done |
| 1   | DEGRADED write-blocking                            | HIGH     | ✅ Done |
| 3   | Webhook DB health check (Stripe/Razorpay) | HIGH     | ✅ Done |
| A   | Admin system-jobs DEGRADED blocking                | MEDIUM   | ✅ Done |
| B   | Stream.io webhook DB health check                  | MEDIUM   | ✅ Done |
| C   | `reconcile-document-storage` storage probe         | MEDIUM   | ✅ Done |
| 4   | UI maintenance guard hook                          | MEDIUM   | ✅ Done |
| 5   | Admin pre-flight API                               | MEDIUM   | ✅ Done |
| 6   | Scheduled maintenance                              | LOW      | Pending |
