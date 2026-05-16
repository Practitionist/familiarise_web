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

// Redis key constants.
//
// The default keys are PLATFORM-SCOPED ("maintenance:phase" /
// "maintenance:config") — that's the legacy behaviour and the middleware
// still reads from them on every request. The per-org variants
// ("maintenance:phase:org:<orgId>") are introduced in PR #655 as a
// Tier 1 placeholder so org-aware admin routes can write to them in a
// post-MVP follow-up without touching middleware again. Today nothing
// writes to the per-org keys; the helpers below are scaffolding.
const REDIS_KEYS = {
  PHASE: "maintenance:phase",
  CONFIG: "maintenance:config",
} as const;

export function platformMaintenanceKeys(): {
  phase: string;
  config: string;
} {
  return { phase: REDIS_KEYS.PHASE, config: REDIS_KEYS.CONFIG };
}

/**
 * Per-org maintenance Redis key scaffolding. Returns the org-scoped
 * `maintenance:phase:org:<orgId>` + `maintenance:config:org:<orgId>`
 * pair. Lookup order at read time will be: org-scoped first, fall back
 * to platform if the org has no active window.
 *
 * The middleware does NOT consume these yet — that's the post-MVP
 * Tier 2 work tracked in the enterprise post-MVP issue. Exporting the
 * key shape now lets any admin tooling (e.g. a `setOrgMaintenance`
 * helper added later) write under the canonical namespace from day
 * one, so the eventual middleware-read changes are a one-line lookup
 * swap.
 */
export function orgMaintenanceKeys(organizationId: string): {
  phase: string;
  config: string;
} {
  return {
    phase: `maintenance:phase:org:${organizationId}`,
    config: `maintenance:config:org:${organizationId}`,
  };
}

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

// Matches paths ending with a file extension (e.g. .js, .css, .png, .woff2)
// More precise than pathname.includes(".") which false-positives on /api/v2.0/foo
const HAS_FILE_EXTENSION = /\.\w{2,10}$/;

/**
 * Check if a route is exempt from maintenance mode.
 */
export function isMaintenanceExempt(pathname: string): boolean {
  if (HAS_FILE_EXTENSION.test(pathname)) return true;
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Transactional write routes to block during DEGRADED maintenance.
// Read-only methods (GET, HEAD, OPTIONS) are always allowed.
// Patterns support a single '*' wildcard segment (e.g. /api/events/*/allocate).
const WRITE_BLOCKED_IN_DEGRADED = [
  "/api/checkout",
  "/api/appointments/*/cancel",
  "/api/appointments/*/reschedule",
  "/api/appointments/*/documents",
  "/api/events/consultations",
  "/api/events/subscriptions",
  "/api/events/webinars",
  "/api/events/classes",
  "/api/events/*/allocate",
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
