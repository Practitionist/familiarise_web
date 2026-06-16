/**
 * Maintenance Mode — Edge-compatible reader
 *
 * This module is safe for Next.js middleware (Edge Runtime).
 * Uses direct fetch to Upstash Redis REST API (no SDK import needed).
 * No Prisma, no Node.js-only APIs.
 *
 * For write operations (setMaintenanceState), use lib/maintenance.ts instead.
 */

import { NextRequest } from "next/server";

// Redis key constants. Platform-scoped: the middleware reads the single
// platform maintenance phase/config on every request (30s-cached below).
//
// NOTE for future devs: per-org maintenance windows
// ("maintenance:phase:org:<orgId>") are NOT implemented. There was previously
// `orgMaintenanceKeys()` / `platformMaintenanceKeys()` scaffolding here with no
// consumers — it was removed (#776) as dead code. If/when per-org windows ship,
// add the org-scoped read here (org key first, fall back to platform) and a
// matching writer in the admin maintenance route.
const REDIS_KEYS = {
  PHASE: "maintenance:phase",
  CONFIG: "maintenance:config",
} as const;

// Routes exempt from maintenance mode
const EXEMPT_PREFIXES = [
  "/api/webhooks/",
  "/api/health",
  "/api/auth/",
  "/api/admin/maintenance",
  "/maintenance",
  "/_next/",
  "/favicon",
];

export interface MaintenanceState {
  phase: "OFF" | "DEGRADED" | "OFFLINE";
  reason: string | null;
  estimatedEnd: string | null;
  bypassSecret: string | null;
}

const OFF_STATE: MaintenanceState = {
  phase: "OFF",
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
};

// In-memory cache to avoid Redis round-trips on every request.
// Edge isolates share module scope within an instance lifetime.
let cachedState: MaintenanceState | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Direct Upstash REST call — edge-safe, no SDK needed.
 */
async function redisGet(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(1500),
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.result ?? null;
}

/**
 * Read current maintenance state from Redis (edge-safe).
 * Fail-open: returns OFF if Redis is unreachable or not configured.
 */
export async function getMaintenanceState(): Promise<MaintenanceState> {
  const now = Date.now();
  if (cachedState && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedState;
  }

  try {
    const [phase, configRaw] = await Promise.all([
      redisGet(REDIS_KEYS.PHASE),
      redisGet(REDIS_KEYS.CONFIG),
    ]);

    if (!phase || phase === "OFF") {
      cachedState = OFF_STATE;
      cacheTimestamp = now;
      return OFF_STATE;
    }

    let config: Partial<MaintenanceState> = {};
    if (configRaw) {
      try {
        config = JSON.parse(configRaw);
      } catch {
        // Malformed config — treat as no config
      }
    }

    const state: MaintenanceState = {
      phase: phase as MaintenanceState["phase"],
      reason: config.reason ?? null,
      estimatedEnd: config.estimatedEnd ?? null,
      bypassSecret: config.bypassSecret ?? null,
    };
    cachedState = state;
    cacheTimestamp = now;
    return state;
  } catch {
    // Fail-open: cache OFF to avoid repeated failing calls
    cachedState = OFF_STATE;
    cacheTimestamp = now;
    return OFF_STATE;
  }
}

// Matches paths ending with a file extension (e.g. .js, .css, .png, .woff2).
// More precise than pathname.includes(".") which false-positives on /api/v2.0/foo.
// Exported so middleware.ts reuses the exact same rule for its static-asset skip
// (single source of truth — #776).
export const HAS_FILE_EXTENSION = /\.\w{2,10}$/;

/**
 * Check if a route is exempt from maintenance mode.
 */
export function isMaintenanceExempt(pathname: string): boolean {
  if (HAS_FILE_EXTENSION.test(pathname)) return true;
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Transactional write routes to block during DEGRADED maintenance.
// Read-only methods (GET, HEAD, OPTIONS) are always allowed.
// Patterns support a single '*' wildcard segment (e.g. /api/bookings/*/allocate).
const WRITE_BLOCKED_IN_DEGRADED = [
  "/api/checkout",
  "/api/appointments/*/cancel",
  "/api/appointments/*/reschedule",
  "/api/appointments/*/documents",
  "/api/bookings/consultations",
  "/api/bookings/subscriptions",
  "/api/bookings/webinars",
  "/api/bookings/classes",
  "/api/bookings/*/allocate",
  "/api/trials",
  "/api/plans/*/materials",
  "/api/stream/meetings", // Block new video call creation
  "/api/form/onboarding/*", // Block new user registration/onboarding
  "/api/verification/documents", // Block verification document uploads
  "/api/verification/submit", // Block verification submission
  "/api/verification/resubmit", // Block verification resubmission
  "/api/slots/appointments", // Block direct appointment creation/mutation
  "/api/waitlist", // Block waitlist mutations
  "/api/referrals", // Block referral code creation
  "/api/collaborators", // Block collaborator management
  "/api/payments/refunds", // Block refund mutations
  "/api/payments/disputes", // Block dispute handling mutations
  "/api/admin/payouts", // Block admin payout mutations
];

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Returns true if the route+method combination should be blocked in DEGRADED mode.
 * Prevents transactional writes (bookings, payments, cancellations) during
 * partial maintenance while still allowing users to browse and read data.
 */
export function isWriteBlockedInDegraded(
  pathname: string,
  method: string,
): boolean {
  if (READ_ONLY_METHODS.has(method.toUpperCase())) return false;

  return WRITE_BLOCKED_IN_DEGRADED.some((pattern) => {
    if (!pattern.includes("*")) {
      // Exact prefix match
      return pathname === pattern || pathname.startsWith(pattern + "/");
    }
    // Wildcard: split on '*' and check prefix + suffix with length guard
    const [prefix, suffix] = pattern.split("*");
    return (
      pathname.length >= prefix.length + suffix.length &&
      pathname.startsWith(prefix) &&
      pathname.endsWith(suffix)
    );
  });
}

/**
 * Validate maintenance bypass via header or cookie.
 */
export function validateBypass(
  request: NextRequest,
  storedSecret: string | null,
): boolean {
  if (!storedSecret) {
    const envSecret = process.env.MAINTENANCE_BYPASS_SECRET;
    if (!envSecret) return false;

    const headerVal = request.headers.get("x-maintenance-bypass");
    const cookieVal = request.cookies.get("maintenance_bypass")?.value;
    return headerVal === envSecret || cookieVal === envSecret;
  }

  const headerVal = request.headers.get("x-maintenance-bypass");
  const cookieVal = request.cookies.get("maintenance_bypass")?.value;
  return headerVal === storedSecret || cookieVal === storedSecret;
}
