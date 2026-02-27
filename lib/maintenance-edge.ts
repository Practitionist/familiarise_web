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

// Redis key constants
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
  try {
    const [phase, configRaw] = await Promise.all([
      redisGet(REDIS_KEYS.PHASE),
      redisGet(REDIS_KEYS.CONFIG),
    ]);

    if (!phase || phase === "OFF") return OFF_STATE;

    let config: Partial<MaintenanceState> = {};
    if (configRaw) {
      try {
        config = JSON.parse(configRaw);
      } catch {
        // Malformed config — treat as no config
      }
    }

    return {
      phase: phase as MaintenanceState["phase"],
      reason: config.reason ?? null,
      estimatedEnd: config.estimatedEnd ?? null,
      bypassSecret: config.bypassSecret ?? null,
    };
  } catch {
    // Fail-open: site stays up if Redis is down
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
