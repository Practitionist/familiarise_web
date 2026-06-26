/**
 * Send Waitlist Expiration Reminders (core)
 *
 * Sends reminder emails to users whose waitlist spot offers will expire in
 * ~12 hours. Importable core in the standard cron shape (#856): the GitHub
 * Actions entry is jobs/waitlist/send-expiration-reminders.ts.
 *
 * Schedule: Every hour (via GitHub Actions workflow)
 */

import prisma from "@/lib/prisma";
import { WaitlistStatus } from "@prisma/client";
import { sendWaitlistExpiringEmail } from "@/lib/waitlist/notifications";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { withDbConnectRetry } from "@/lib/db/connect-retry";

export interface SendRemindersResult {
  found: number;
  sent: number;
  errors: Array<{ id: string; error: string }>;
  success: boolean;
}

/**
 * #814/#821 — the locked, connect-warming entry. The lock was previously
 * imported but never taken; the connect-retry absorbs the GH-runner →
 * Supabase-pooler ETIMEDOUTs that failed whole runs on the first query.
 *
 * The retry wraps ONLY a no-op connection warm-up, never the body: the body
 * sends emails (non-idempotent side effects), and replaying it after a
 * mid-run transient would resend notifications. The observed failure mode
 * (#814/#821 logs) is the FIRST query timing out on a cold pooler, which
 * the warm-up covers.
 */
export async function sendExpirationReminders(): Promise<SendRemindersResult> {
  return withCronLock(
    "send-expiration-reminders",
    { failMode: "open" },
    async () => {
      await withDbConnectRetry(() => prisma.$queryRaw`SELECT 1`);
      return sendRemindersCore();
    },
  );
}

async function sendRemindersCore(): Promise<SendRemindersResult> {
  const now = new Date();
  const twelveHoursFromNow = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const thirteenHoursFromNow = new Date(now.getTime() + 13 * 60 * 60 * 1000);

  // Find NOTIFIED entries expiring in 12-13 hours that haven't been reminded yet
  const entriesToRemind = await prisma.waitlist.findMany({
    where: {
      status: WaitlistStatus.NOTIFIED,
      expiresAt: {
        gte: twelveHoursFromNow,
        lt: thirteenHoursFromNow,
      },
      reminderSentAt: null, // Haven't sent reminder yet
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

  console.log(`📧 Found ${entriesToRemind.length} entries to remind`);

  let sent = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const entry of entriesToRemind) {
    const eventTitle =
      entry.webinar?.webinarPlan.title ||
      entry.class?.classPlan.title ||
      "Event";
    const eventType = entry.webinarId ? "webinar" : "class";
    const planId = entry.webinar?.webinarPlan.id || entry.class?.classPlan.id;
    const eventId = entry.webinarId || entry.classId;

    if (!entry.user.email || !entry.expiresAt || !planId || !eventId) {
      console.warn(`⚠️ Skipping entry ${entry.id}: missing required data`);
      errors.push({ id: entry.id, error: "missing required data" });
      continue;
    }

    try {
      // Send reminder email — the rejoin link wants the PLAN id (the
      // deleted jobs/ duplicate drifted to the event id here; the plan id
      // is what the explore route resolves).
      const sendResult = await sendWaitlistExpiringEmail({
        email: entry.user.email,
        name: entry.user.name || "Valued User",
        eventTitle,
        eventType,
        eventId: planId,
        expiresAt: entry.expiresAt,
        waitlistId: entry.id,
      });

      // The helper reports failures via { success: false } instead of
      // throwing — stamping reminderSentAt on a failed delivery would
      // silently drop the reminder forever.
      if (!sendResult.success) {
        errors.push({
          id: entry.id,
          error: String(sendResult.error ?? "email delivery failed"),
        });
        console.error(
          `  ❌ Reminder delivery failed for entry ${entry.id}: ${sendResult.error}`,
        );
        continue;
      }

      // Mark as reminded
      await prisma.waitlist.update({
        where: { id: entry.id },
        data: { reminderSentAt: now },
      });

      sent++;
      console.log(
        `  ✅ Sent reminder to ${entry.user.email} for "${eventTitle}"`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ id: entry.id, error: message });
      console.error(
        `  ❌ Failed to send reminder for entry ${entry.id}:`,
        error,
      );
    }
  }

  return {
    found: entriesToRemind.length,
    sent,
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
