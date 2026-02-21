/**
 * Maintenance Mode Library
 *
 * Two-tier state management:
 * - Redis: fast edge reads for middleware (fail-open: defaults to OFF if unreachable)
 * - Prisma: audit trail and scheduling for admin dashboard
 *
 * Three phases: OFF → DEGRADED (read-only, warning banner) → OFFLINE (full maintenance page)
 */

import { MaintenancePhase } from "@prisma/client";
import { NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import redis, { withCircuitBreaker } from "@/lib/redis";

// Redis key constants
const REDIS_KEYS = {
  PHASE: "maintenance:phase",
  CONFIG: "maintenance:config",
} as const;

// Routes exempt from maintenance mode
const EXEMPT_PREFIXES = [
  "/api/webhooks/", // Payment webhooks (stripe, razorpay, lemon-squeezy, xflow)
  "/api/health",
  "/api/auth/",
  "/api/admin/maintenance",
  "/maintenance",
  "/_next/",
  "/favicon",
];

export interface MaintenanceState {
  phase: MaintenancePhase;
  reason: string | null;
  estimatedEnd: string | null;
  bypassSecret: string | null;
}

const OFF_STATE: MaintenanceState = {
  phase: MaintenancePhase.OFF,
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
};

/**
 * Read current maintenance state from Redis.
 * Fail-open: returns OFF if Redis is unreachable.
 */
export async function getMaintenanceState(): Promise<MaintenanceState> {
  return withCircuitBreaker(
    async () => {
      const [phase, configRaw] = await Promise.all([
        redis.get<string>(REDIS_KEYS.PHASE),
        redis.get<string>(REDIS_KEYS.CONFIG),
      ]);

      if (!phase || phase === "OFF") return OFF_STATE;

      let config: Partial<MaintenanceState> = {};
      if (configRaw) {
        try {
          config =
            typeof configRaw === "string" ? JSON.parse(configRaw) : configRaw;
        } catch {
          // Malformed config — treat as no config
        }
      }

      return {
        phase: phase as MaintenancePhase,
        reason: config.reason ?? null,
        estimatedEnd: config.estimatedEnd ?? null,
        bypassSecret: config.bypassSecret ?? null,
      };
    },
    // Fail-open: site stays up if Redis is down
    () => OFF_STATE,
  );
}

/**
 * Set maintenance state in Redis and persist to Prisma.
 */
export async function setMaintenanceState(
  phase: MaintenancePhase,
  config: {
    reason?: string;
    estimatedEnd?: string;
    bypassSecret?: string;
    startedBy?: string;
    endedBy?: string;
  } = {},
): Promise<void> {
  // Write to Redis
  await redis.set(REDIS_KEYS.PHASE, phase);
  await redis.set(
    REDIS_KEYS.CONFIG,
    JSON.stringify({
      reason: config.reason ?? null,
      estimatedEnd: config.estimatedEnd ?? null,
      bypassSecret: config.bypassSecret ?? null,
    }),
  );

  // Persist to Prisma for audit trail
  if (phase === MaintenancePhase.OFF) {
    // End the current active window
    const activeWindow = await prisma.maintenanceWindow.findFirst({
      where: { phase: { not: MaintenancePhase.OFF } },
      orderBy: { createdAt: "desc" },
    });

    if (activeWindow) {
      await prisma.maintenanceWindow.update({
        where: { id: activeWindow.id },
        data: {
          phase: MaintenancePhase.OFF,
          endedAt: new Date(),
          endedBy: config.endedBy,
        },
      });
    }
  } else {
    // Find active window or create new one
    const activeWindow = await prisma.maintenanceWindow.findFirst({
      where: { phase: { not: MaintenancePhase.OFF } },
      orderBy: { createdAt: "desc" },
    });

    if (activeWindow) {
      await prisma.maintenanceWindow.update({
        where: { id: activeWindow.id },
        data: {
          phase,
          reason: config.reason,
          estimatedEnd:
            config.estimatedEnd && !isNaN(new Date(config.estimatedEnd).getTime())
              ? new Date(config.estimatedEnd)
              : undefined,
        },
      });
    } else {
      await prisma.maintenanceWindow.create({
        data: {
          phase,
          reason: config.reason,
          startedAt: new Date(),
          startedBy: config.startedBy,
          estimatedEnd:
            config.estimatedEnd && !isNaN(new Date(config.estimatedEnd).getTime())
              ? new Date(config.estimatedEnd)
              : undefined,
          bypassSecret: config.bypassSecret,
        },
      });
    }
  }
}

/**
 * Check if a route is exempt from maintenance mode.
 */
export function isMaintenanceExempt(pathname: string): boolean {
  // Static assets are always exempt
  if (pathname.includes(".")) return true;

  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Validate maintenance bypass via header or cookie.
 */
export function validateBypass(
  request: NextRequest,
  storedSecret: string | null,
): boolean {
  if (!storedSecret) {
    // Fall back to env var
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
