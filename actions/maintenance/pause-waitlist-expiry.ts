"use server";

/**
 * Waitlist Expiry Pause — extends NOTIFIED claim windows during maintenance.
 *
 * Users in NOTIFIED waitlist status have a 48-hour window to claim a spot.
 * If maintenance starts during that window, the timer is extended by the
 * maintenance duration so they don't lose their spot unfairly.
 */

import { WaitlistStatus } from "@prisma/client";

import prisma from "@/lib/prisma";

interface PauseResult {
  extended: number;
}

/**
 * Extend expiresAt for all NOTIFIED waitlist entries whose claim window
 * overlaps with the maintenance window.
 */
export async function pauseWaitlistExpiry(
  maintenanceStart: Date,
  maintenanceEnd: Date,
): Promise<PauseResult> {
  const durationMs = maintenanceEnd.getTime() - maintenanceStart.getTime();
  if (durationMs <= 0) {
    return { extended: 0 };
  }

  // Find NOTIFIED entries whose expiry falls during or after maintenance start
  const entries = await prisma.waitlist.findMany({
    where: {
      status: WaitlistStatus.NOTIFIED,
      expiresAt: { gte: maintenanceStart },
    },
    select: { id: true, expiresAt: true },
  });

  if (entries.length === 0) {
    return { extended: 0 };
  }

  // Extend each entry's expiry by the maintenance duration (parallel for performance)
  const validEntries = entries.filter((e) => e.expiresAt);
  if (validEntries.length === 0) {
    return { extended: 0 };
  }

  await Promise.all(
    validEntries.map((entry) =>
      prisma.waitlist.update({
        where: { id: entry.id },
        data: {
          expiresAt: new Date(entry.expiresAt!.getTime() + durationMs),
        },
      }),
    ),
  );
  const extended = validEntries.length;

  console.log(
    JSON.stringify({
      event: "maintenance_waitlist_expiry_paused",
      extended,
      durationMs,
      timestamp: new Date().toISOString(),
    }),
  );

  return { extended };
}
