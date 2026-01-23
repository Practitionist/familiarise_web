/**
 * Send Waitlist Expiration Reminders
 *
 * This script sends reminder emails to users whose waitlist spot offers will expire in ~12 hours.
 * Run via: npx ts-node scripts/waitlist/send-expiration-reminders.ts
 *
 * Schedule: Every hour (via GitHub Actions workflow)
 */

import prisma from "@/lib/prisma";
import { WaitlistStatus } from "@prisma/client";
import { sendWaitlistExpiringEmail } from "@/lib/waitlist/notifications";

async function main() {
  console.log("🔔 Starting expiration reminder sender...");
  const startTime = Date.now();

  try {
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

    let sentCount = 0;
    let errorCount = 0;

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
        continue;
      }

      try {
        // Send reminder email
        await sendWaitlistExpiringEmail({
          email: entry.user.email,
          name: entry.user.name || "Valued User",
          eventTitle,
          eventType,
          eventId: planId,
          expiresAt: entry.expiresAt,
          waitlistId: entry.id,
        });

        // Mark as reminded
        await prisma.waitlist.update({
          where: { id: entry.id },
          data: { reminderSentAt: now },
        });

        sentCount++;
        console.log(
          `  ✅ Sent reminder to ${entry.user.email} for "${eventTitle}"`
        );
      } catch (error) {
        errorCount++;
        console.error(`  ❌ Failed to send reminder for entry ${entry.id}:`, error);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `\n🎉 Completed in ${duration}s. Reminders sent: ${sentCount}, Errors: ${errorCount}`
    );

    process.exit(0);
  } catch (error) {
    console.error("❌ Error sending expiration reminders:", error);
    process.exit(1);
  }
}

main();
