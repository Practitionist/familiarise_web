/**
 * Job: Process Expired Waitlist Notifications
 *
 * Modular job function that can be called from various schedulers
 * (GitHub Actions, Vercel Cron, AWS Lambda, etc.)
 */

import { processExpiredNotifications, handleSlotOpening } from "@/lib/waitlist";
import { sendWaitlistExpiredEmail } from "@/lib/waitlist/notifications";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { getAppUrl } from "../../lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface ProcessExpiredResult {
  processed: number;
  emailsSent: number;
  errors: Array<{ id: string; error: string }>;
  duration: number;
}

/**
 * Process expired waitlist notifications
 *
 * 1. Find entries where status = NOTIFIED AND expiresAt < now()
 * 2. Mark as EXPIRED
 * 3. Send expiration notification email
 * 4. Notify next person in queue
 */
// #476 — entry-level cron lock; fail-open (repeat-safe side effects).
export async function processExpiredNotificationsJob(): Promise<ProcessExpiredResult> {
  return withCronLock("process-expired-notifications", { failMode: "open" }, () =>
    processExpiredNotificationsJobUnlocked(),
  );
}

async function processExpiredNotificationsJobUnlocked(): Promise<ProcessExpiredResult> {
  await abortIfMaintenance("process-expired-notifications");
  const startTime = Date.now();
  const errors: Array<{ id: string; error: string }> = [];

  // Process expired notifications - now returns the processed entries directly
  const result = await processExpiredNotifications();

  let emailsSent = 0;

  // Use the entries returned from processExpiredNotifications instead of re-querying
  for (const entry of result.entries) {
    try {
      const eventTitle =
        entry.webinar?.webinarPlan.title ||
        entry.class?.classPlan.title ||
        "Event";
      const eventType = entry.webinarId ? "webinar" : "class";
      const eventId = entry.webinarId || entry.classId;

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
        emailsSent++;
      }

      // Notify next person in queue
      await handleSlotOpening({
        webinarId: entry.webinarId ?? undefined,
        classId: entry.classId ?? undefined,
        slotsAvailable: 1,
        reason: "cancellation",
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      errors.push({ id: entry.id, error: errorMessage });
    }
  }

  return {
    processed: result.processed,
    emailsSent,
    errors: [...result.errors, ...errors],
    duration: Date.now() - startTime,
  };
}

export default processExpiredNotificationsJob;
