/**
 * Process Expired Waitlist Notifications
 *
 * This script processes expired waitlist notifications and notifies the next person in queue.
 * Run via: npx ts-node scripts/waitlist/process-expired-notifications.ts
 *
 * Schedule: Every hour (via GitHub Actions workflow)
 */

import prisma from "@/lib/prisma";
import { WaitlistStatus } from "@prisma/client";
import { processExpiredNotifications, handleSlotOpening } from "@/lib/waitlist";
import { sendWaitlistExpiredEmail } from "@/lib/waitlist/notifications";
import { getAppUrl } from "../../lib/url";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

async function main() {
  console.log("🕐 Starting expired notification processor...");
  const startTime = Date.now();

  try {
    // Process expired notifications
    const result = await processExpiredNotifications();

    console.log(`✅ Processed ${result.processed} expired notifications`);

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

    for (const entry of expiredEntries) {
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
      }

      // Notify next person in queue
      await handleSlotOpening({
        webinarId: entry.webinarId ?? undefined,
        classId: entry.classId ?? undefined,
        slotsAvailable: 1,
        reason: "cancellation",
      });
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `\n🎉 Completed in ${duration}s. Processed: ${result.processed}, Emails sent: ${expiredEntries.length}`,
    );

    process.exit(0);
  } catch (error) {
    // #476 — lock held = another run is live; skip cleanly (exit 0).
    if (error instanceof CronLockHeldError) {
      console.log(`⏭️  ${error.message}`);
      process.exit(0);
    }
    console.error("❌ Error processing expired notifications:", error);
    process.exit(1);
  }
}

main();
