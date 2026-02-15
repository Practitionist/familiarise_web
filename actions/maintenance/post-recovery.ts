"use server";

/**
 * Post-Recovery Automation — called when ending maintenance mode.
 *
 * Verifies critical systems are operational:
 * - Database connectivity
 * - Redis connectivity
 * - Sends "we're back" broadcast notification
 */

import { notifyMaintenanceEnded } from "@/lib/novu/service";
import prisma from "@/lib/prisma";
import { checkRedisHealth } from "@/lib/redis";

interface RecoveryResult {
  database: boolean;
  redis: boolean;
  notification: boolean;
  errors: string[];
}

export async function runPostRecovery(): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    database: false,
    redis: false,
    notification: false,
    errors: [],
  };

  // 1. Verify DB connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
    result.database = true;
  } catch (error) {
    result.errors.push(
      `Database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 2. Check Redis health
  try {
    result.redis = await checkRedisHealth();
    if (!result.redis) {
      result.errors.push("Redis: PING failed");
    }
  } catch (error) {
    result.errors.push(
      `Redis: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 3. Send "we're back" broadcast notification
  try {
    const notifResult = await notifyMaintenanceEnded({
      phase: "OFF",
      reason: "Maintenance completed",
    });
    result.notification = notifResult.success;
  } catch (error) {
    result.errors.push(
      `Notification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log(
    JSON.stringify({
      event: "maintenance_post_recovery",
      result,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}
