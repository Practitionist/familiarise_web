/**
 * Process Expired Waitlist Notifications (core)
 *
 * Processes expired waitlist notifications and notifies the next person in
 * queue. Importable core in the standard cron shape (#856): the GitHub
 * Actions entry is jobs/waitlist/process-expired-notifications.ts.
 *
 * Schedule: Every hour (via GitHub Actions workflow)
 */

import prisma from "@/lib/prisma";
import { WaitlistStatus } from "@prisma/client";
import { processExpiredNotifications, handleSlotOpening } from "@/lib/waitlist";
import { sendWaitlistExpiredEmail } from "@/lib/waitlist/notifications";
import { getAppUrl } from "../../lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { withDbConnectRetry } from "@/lib/db/connect-retry";

export interface ProcessExpirationsResult {
  processed: number;
  emailed: number;
  errors: Array<{ id: string; error: string }>;
  success: boolean;
}

/**
 * #814/#821 — the locked, connect-retrying entry. The lock was previously
 * imported but never taken; the connect-retry absorbs the GH-runner →
 * Supabase-pooler ETIMEDOUTs that failed whole runs on the first query.
 * A retried body is safe — expiry processing is CAS-guarded and the
 * 5-minute respondedAt window bounds duplicate notify attempts.
 */
export async function processWaitlistExpirations(): Promise<ProcessExpirationsResult> {
  return withCronLock(
    "process-expired-notifications",
    { failMode: "open" },
    () => withDbConnectRetry(processExpirationsCore),
  );
}

async function processExpirationsCore(): Promise<ProcessExpirationsResult> {
  // Process expired notifications
  const result = await processExpiredNotifications();

  console.log(`✅ Processed ${result.processed} expired notifications`);

  const errors: Array<{ id: string; error: string }> = result.errors.map(
    ({ id, error }) => ({ id, error: String(error) }),
  );
  if (result.errors.length > 0) {
    console.warn(`⚠️ ${result.errors.length} errors occurred:`);
    result.errors.forEach(({ id, error }) => {
      console.warn(`  - Entry ${id}: ${error}`);
    });
  }

  // For each expired entry, notify next person and send expired email
  const expiredEntries = await prisma.waitlist.findMany({
    where: {
      status: WaitlistStatus.EXPIRED,
      respondedAt: {
        gte: new Date(Date.now() - 5 * 60 * 1000), // Within last 5 minutes (just processed)
      },
    },
    include: {
      user: {
        select: {
          email: true,
          name: true,
        },
      },
      webinar: {
        include: {
          webinarPlan: true,
        },
      },
      class: {
        include: {
          classPlan: true,
        },
      },
    },
  });

  let emailed = 0;
  for (const entry of expiredEntries) {
    const eventTitle =
      entry.webinar?.webinarPlan.title ||
      entry.class?.classPlan.title ||
      "Event";
    const eventType = entry.webinarId ? "webinar" : "class";
    const eventId = entry.webinarId || entry.classId;

    try {
      // Send expired notification email
      if (entry.user.email) {
        await sendWaitlistExpiredEmail({
          email: entry.user.email,
          name: entry.user.name || "Valued User",
          eventTitle,
          eventType,
          rejoinUrl: eventId
            ? `${getAppUrl()}/explore/programs/plans/${eventType}s/${eventId}`
            : undefined,
        });
        emailed++;
      }

      // Notify next person in queue
      await handleSlotOpening({
        webinarId: entry.webinarId ?? undefined,
        classId: entry.classId ?? undefined,
        slotsAvailable: 1,
        reason: "cancellation",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ id: entry.id, error: message });
      console.error(`  ❌ Failed post-expiry handling for ${entry.id}:`, error);
    }
  }

  return {
    processed: result.processed,
    emailed,
    errors,
    success: errors.length === 0,
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
