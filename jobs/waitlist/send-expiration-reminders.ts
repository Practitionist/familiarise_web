/**
 * Job: Send Waitlist Expiration Reminders
 *
 * Modular job function that can be called from various schedulers
 * (GitHub Actions, Vercel Cron, AWS Lambda, etc.)
 */

import prisma from "@/lib/prisma";
import { WaitlistStatus } from "@prisma/client";
import { sendWaitlistExpiringEmail } from "@/lib/waitlist/notifications";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

export interface SendRemindersResult {
  found: number;
  sent: number;
  errors: Array<{ id: string; error: string }>;
  duration: number;
}

/**
 * Send reminder emails to users whose spot offers expire in ~12 hours
 *
 * 1. Find entries where status = NOTIFIED AND expiresAt - now() < 12 hours AND not already reminded
 * 2. Send reminder email
 * 3. Mark as reminded
 */
export async function sendExpirationRemindersJob(): Promise<SendRemindersResult> {
  await abortIfMaintenance("send-expiration-reminders");
  const startTime = Date.now();
  const errors: Array<{ id: string; error: string }> = [];

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
      reminderSentAt: null,
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

  let sent = 0;

  for (const entry of entriesToRemind) {
    const eventTitle =
      entry.webinar?.webinarPlan.title ||
      entry.class?.classPlan.title ||
      "Event";
    const eventType = entry.webinarId ? "webinar" : "class";
    const planId = entry.webinar?.webinarPlan.id || entry.class?.classPlan.id;
    const eventId = entry.webinarId || entry.classId;

    if (!entry.user.email || !entry.expiresAt || !planId || !eventId) {
      errors.push({ id: entry.id, error: "Missing required data" });
      continue;
    }

    try {
      // Send reminder email
      await sendWaitlistExpiringEmail({
        email: entry.user.email,
        name: entry.user.name || "Valued User",
        eventTitle,
        eventType,
        eventId: eventId,
        expiresAt: entry.expiresAt,
        waitlistId: entry.id,
      });

      // Mark as reminded
      await prisma.waitlist.update({
        where: { id: entry.id },
        data: { reminderSentAt: now },
      });

      sent++;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      errors.push({ id: entry.id, error: errorMessage });
    }
  }

  return {
    found: entriesToRemind.length,
    sent,
    errors,
    duration: Date.now() - startTime,
  };
}

export default sendExpirationRemindersJob;
