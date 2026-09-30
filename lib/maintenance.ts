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

import prisma from "@/lib/prisma";
import redis, { withCircuitBreaker } from "@/lib/redis";
import { REDIS_KEYS } from "@/lib/maintenance-keys";
import { captureThrottled } from "@/lib/observability/throttled-capture";

export interface MaintenanceState {
  phase: MaintenancePhase;
  reason: string | null;
  estimatedEnd: string | null;
  bypassSecret: string | null;
  betterstackIncidentId: string | null;
  /**
   * True when the phase below is a GUESS, because Redis could not be read.
   *
   * The read fails open to OFF, which is the right behaviour for the request
   * path — a maintenance window must not turn a Redis blip into a platform-wide
   * 503. It is the wrong behaviour for anyone asking what the platform is
   * doing: OFF is a claim ("we are serving normally") and during an outage it
   * is a fabricated one. `/api/health` reported `phase: "OFF"` and looked
   * perfectly healthy while the read that produced it was throwing, and
   * `console.*` is stripped from Netlify's function log (#1122), so the
   * catch-all below logged to nowhere at all.
   *
   * `unreadable` is the honest bit. It does not change enforcement; it exists so
   * a monitor can distinguish "no window in force" from "we cannot tell".
   */
  unreadable: boolean;
}

const OFF_STATE: MaintenanceState = {
  phase: MaintenancePhase.OFF,
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
  betterstackIncidentId: null,
  unreadable: false,
};

/**
 * Read current maintenance state from Redis.
 * Fail-open: returns OFF if Redis is unreachable, and says so via `unreadable`.
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
        betterstackIncidentId: config.betterstackIncidentId ?? null,
        unreadable: false,
      };
    },
    // Fail-open: site stays up if Redis is down. The failure is REPORTED, not
    // just survived — see `unreadable` above. Throttled through the shared
    // helper because /api/health, the maintenance cron and the reconcile door
    // all read this, and a Redis outage is total rather than per-caller: one
    // event per key per minute is the whole information content.
    () => {
      reportMaintenanceReadUnreadable();
      return { ...OFF_STATE, unreadable: true };
    },
  );
}

const MAINTENANCE_UNREADABLE_KEY = "maintenance:read-unreadable";

function reportMaintenanceReadUnreadable(): void {
  captureThrottled(
    MAINTENANCE_UNREADABLE_KEY,
    new Error(
      "Maintenance phase read failed — reporting phase OFF. Enforcement fails open (correct); " +
        "the OFF answer is a guess, not a reading, and the Netlify function log strips console.*.",
    ),
    {
      subsystem: "maintenance",
      op: "getMaintenanceState",
      // A warning, not an error: nothing is broken for users (that is the point
      // of failing open), and paging for it would page for every Redis blip.
      // But it MUST be findable — an unreported unreadable read is how a real
      // OFFLINE window goes unenforced without anyone knowing.
      level: "warning",
      tags: { reason: "maintenance.read_unreadable" },
    },
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
    betterstackIncidentId?: string;
  } = {},
): Promise<void> {
  // Write both Redis keys concurrently to minimize inconsistency window.
  // #697 INF-1 — 24h TTL: an OFFLINE phase whose owner loses access must not
  // keep the platform down forever. Every setMaintenanceState call refreshes
  // the clock, so a tended window outlives the TTL; an abandoned one expires
  // to OFF. Long windows need a refresh at least daily (runbook rule).
  const MAINTENANCE_KEY_TTL_SECONDS = 24 * 60 * 60;
  await Promise.all([
    redis.set(REDIS_KEYS.PHASE, phase, { ex: MAINTENANCE_KEY_TTL_SECONDS }),
    redis.set(
      REDIS_KEYS.CONFIG,
      JSON.stringify({
        reason: config.reason ?? null,
        estimatedEnd: config.estimatedEnd ?? null,
        bypassSecret: config.bypassSecret ?? null,
        betterstackIncidentId: config.betterstackIncidentId ?? null,
      }),
      { ex: MAINTENANCE_KEY_TTL_SECONDS },
    ),
  ]);

  // Persist to Prisma for audit trail (transactional to prevent find+update races)
  await prisma.$transaction(async (tx) => {
    if (phase === MaintenancePhase.OFF) {
      // #1598 P1-W01 — platform rows only (organizationId null); the per-org
      // write API is #730/#746, so OFF must never close a tenant's window.
      const activeWindow = await tx.maintenanceWindow.findFirst({
        where: { organizationId: null, phase: { not: MaintenancePhase.OFF } },
        orderBy: { createdAt: "desc" },
      });

      if (activeWindow) {
        await tx.maintenanceWindow.update({
          where: { id: activeWindow.id },
          data: {
            phase: MaintenancePhase.OFF,
            endedAt: new Date(),
            endedBy: config.endedBy,
          },
        });
      }
    } else {
      // #1598 P1-W01 — same platform-only scope as the OFF branch above.
      const activeWindow = await tx.maintenanceWindow.findFirst({
        where: { organizationId: null, phase: { not: MaintenancePhase.OFF } },
        orderBy: { createdAt: "desc" },
      });

      if (activeWindow) {
        await tx.maintenanceWindow.update({
          where: { id: activeWindow.id },
          data: {
            phase,
            reason: config.reason,
            estimatedEnd:
              config.estimatedEnd &&
              !isNaN(new Date(config.estimatedEnd).getTime())
                ? new Date(config.estimatedEnd)
                : undefined,
          },
        });
      } else {
        await tx.maintenanceWindow.create({
          data: {
            phase,
            reason: config.reason,
            startedAt: new Date(),
            startedBy: config.startedBy,
            estimatedEnd:
              config.estimatedEnd &&
              !isNaN(new Date(config.estimatedEnd).getTime())
                ? new Date(config.estimatedEnd)
                : undefined,
            bypassSecret: config.bypassSecret,
          },
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Per-org maintenance (read side only — admin write API ships separately)
// ---------------------------------------------------------------------------

/**
 * Read the currently-active MaintenanceWindow row scoped to a single org.
 *
 * Per the schema comment on `MaintenanceWindow.organizationId`, NULL rows
 * are platform-wide and non-null rows scope to a single tenant. This helper
 * only returns the *org-specific* active window — callers should still
 * consult `getMaintenanceState()` for the platform-wide Redis check.
 *
 * Returns `null` if there is no active org-specific window. "Active" means
 * `phase !== OFF` and the most recent row by `createdAt`.
 *
 * Used by per-org financial jobs (payout batch, subscription invoicing)
 * to skip an individual tenant during a planned downtime window without
 * affecting other tenants.
 */
export async function getActiveOrgMaintenanceWindow(
  organizationId: string,
): Promise<{
  phase: MaintenancePhase;
  reason: string | null;
  estimatedEnd: Date | null;
} | null> {
  const row = await prisma.maintenanceWindow.findFirst({
    where: {
      organizationId,
      phase: { not: MaintenancePhase.OFF },
    },
    orderBy: { createdAt: "desc" },
    select: { phase: true, reason: true, estimatedEnd: true },
  });
  return row ?? null;
}
