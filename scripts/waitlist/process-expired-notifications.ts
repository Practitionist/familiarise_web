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
 * #814/#821 — the locked, connect-warming entry. The lock was previously
 * imported but never taken; the connect-retry absorbs the GH-runner →
 * Supabase-pooler ETIMEDOUTs that failed whole runs on the first query.
 *
 * The retry wraps ONLY a no-op connection warm-up, never the body: the body
 * sends emails and notifies queue successors (non-idempotent side effects),
 * and replaying it after a mid-run transient would resend them. The
 * observed failure mode (#814/#821 logs) is the FIRST query timing out on a
 * cold pooler, which the warm-up covers.
 */
export async function processWaitlistExpirations(): Promise<ProcessExpirationsResult> {
  return withCronLock(
    "process-expired-notifications",
    { failMode: "open" },
    async () => {
      await withDbConnectRetry(() => prisma.$queryRaw`SELECT 1`);
      return processExpirationsCore();
    },
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
      // Send expired notification email — the helper reports failures via
      // { success: false } instead of throwing, so count only real sends.
      if (entry.user.email) {
        const sendResult = await sendWaitlistExpiredEmail({
          email: entry.user.email,
          name: entry.user.name || "Valued User",
          eventTitle,
          eventType,
          rejoinUrl: eventId
            ? `${getAppUrl()}/explore/programs/plans/${eventType}s/${eventId}`
            : undefined,
        });
        if (sendResult.success) {
          emailed++;
        } else {
          errors.push({
            id: entry.id,
            error: String(sendResult.error ?? "email delivery failed"),
          });
          console.error(
            `  ❌ Expired-notice delivery failed for ${entry.id}: ${sendResult.error}`,
          );
        }
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
