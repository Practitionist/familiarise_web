/**
 * Job: Process Expired Waitlist Notifications
 *
 * Modular job function that can be called from various schedulers
 * (GitHub Actions, Vercel Cron, AWS Lambda, etc.)
 */

import prisma from "@/lib/prisma";
import { WaitlistStatus } from "@prisma/client";
import {
  processExpiredNotifications,
  handleSlotOpening,
} from "@/lib/waitlist";
import { sendWaitlistExpiredEmail } from "@/lib/waitlist/notifications";

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
export async function processExpiredNotificationsJob(): Promise<ProcessExpiredResult> {
  const startTime = Date.now();
  const errors: Array<{ id: string; error: string }> = [];

  // Process expired notifications
  const result = await processExpiredNotifications();

  // Get recently expired entries to send emails and notify next
  const expiredEntries = await prisma.waitlist.findMany({
    where: {
      status: WaitlistStatus.EXPIRED,
      respondedAt: {
        gte: new Date(Date.now() - 5 * 60 * 1000), // Within last 5 minutes
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

  let emailsSent = 0;

  for (const entry of expiredEntries) {
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
            ? `${process.env.NEXT_PUBLIC_APP_URL}/explore/programs/plans/${eventType}s/${eventId}`
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
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
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
