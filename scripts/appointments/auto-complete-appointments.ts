/**
 * Auto-Complete Appointments - Core Logic
 *
 * Automatically marks appointments as COMPLETED after their session time ends.
 * For Webinars/Classes: Updates status to COMPLETED.
 * For Consultations/Subscriptions: Status inferred from slot times (SCHEDULED stays).
 *
 * This enables:
 * - Feedback collection from participants
 * - Final billing/payout processing
 * - Accurate reporting
 *
 * This module exports the core function.
 * It is imported by:
 * - jobs/auto-complete-appointments.ts (GitHub Actions)
 * - app/api/cleanup/auto-complete-appointments/route.ts (API endpoint)
 *
 * Schedule: Hourly
 */

import prisma from "../../lib/prisma";
import { WebinarStatus, ClassStatus } from "@prisma/client";

// Only complete appointments that ended at least 1 hour ago
// This gives buffer time for any post-session activities
const COMPLETION_BUFFER_HOURS = 1;

export interface AutoCompleteResult {
  success: boolean;
  webinarsCompleted: number;
  classesCompleted: number;
  consultationsIdentified: number;
  subscriptionsIdentified: number;
  errors: string[];
  timestamp: string;
}

/**
 * Auto-complete webinars that have ended
 */
async function completeWebinars(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED or IN_PROGRESS webinars where all slots have ended
  const webinarsToComplete = await prisma.webinar.findMany({
    where: {
      status: { in: [WebinarStatus.SCHEDULED, WebinarStatus.IN_PROGRESS] },
      appointment: {
        slotsOfAppointment: {
          every: {
            endsAt: { lt: bufferTime },
          },
        },
      },
    },
    include: {
      webinarPlan: { select: { title: true } },
      appointment: {
        include: {
          slotsOfAppointment: {
            orderBy: { endsAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  console.log(`Found ${webinarsToComplete.length} webinars to auto-complete`);

  for (const webinar of webinarsToComplete) {
    try {
      const lastSlot = webinar.appointment?.slotsOfAppointment[0];
      console.log(`\nCompleting webinar ${webinar.id}`);
      console.log(`   Title: ${webinar.webinarPlan.title}`);
      console.log(`   Previous status: ${webinar.status}`);
      console.log(`   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`);

      await prisma.webinar.update({
        where: { id: webinar.id },
        data: { status: WebinarStatus.COMPLETED },
      });

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete webinar ${webinar.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Auto-complete classes that have ended (all sessions done)
 */
async function completeClasses(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED or IN_PROGRESS classes where all slots have ended
  const classesToComplete = await prisma.class.findMany({
    where: {
      status: { in: [ClassStatus.SCHEDULED, ClassStatus.IN_PROGRESS] },
      appointments: {
        every: {
          slotsOfAppointment: {
            every: {
              endsAt: { lt: bufferTime },
            },
          },
        },
      },
    },
    include: {
      classPlan: { select: { title: true } },
      appointments: {
        include: {
          slotsOfAppointment: {
            orderBy: { endsAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  console.log(`Found ${classesToComplete.length} classes to auto-complete`);

  for (const cls of classesToComplete) {
    try {
      // Find the latest slot end time across all appointments
      let latestEnd: Date | null = null;
      for (const apt of cls.appointments) {
        const slot = apt.slotsOfAppointment[0];
        if (slot && (!latestEnd || slot.endsAt > latestEnd)) {
          latestEnd = slot.endsAt;
        }
      }

      console.log(`\nCompleting class ${cls.id}`);
      console.log(`   Title: ${cls.classPlan.title}`);
      console.log(`   Previous status: ${cls.status}`);
      console.log(`   Last slot ended: ${latestEnd?.toISOString() || "Unknown"}`);

      await prisma.class.update({
        where: { id: cls.id },
        data: { status: ClassStatus.COMPLETED },
      });

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete class ${cls.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Identify consultations that have ended (for reporting purposes)
 * These stay as SCHEDULED but we track them for monitoring
 */
async function identifyCompletedConsultations(): Promise<number> {
  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  const completedConsultations = await prisma.consultation.count({
    where: {
      requestStatus: "SCHEDULED",
      appointment: {
        slotsOfAppointment: {
          every: {
            endsAt: { lt: bufferTime },
          },
        },
      },
    },
  });

  console.log(`\nIdentified ${completedConsultations} completed consultations (remain SCHEDULED)`);
  return completedConsultations;
}

/**
 * Identify subscriptions that have ended (for reporting purposes)
 * These stay as SCHEDULED but we track them for monitoring
 */
async function identifyCompletedSubscriptions(): Promise<number> {
  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  const completedSubscriptions = await prisma.subscription.count({
    where: {
      requestStatus: "SCHEDULED",
      appointments: {
        every: {
          slotsOfAppointment: {
            every: {
              endsAt: { lt: bufferTime },
            },
          },
        },
      },
    },
  });

  console.log(`Identified ${completedSubscriptions} completed subscriptions (remain SCHEDULED)`);
  return completedSubscriptions;
}

/**
 * Main function to auto-complete all eligible appointments
 */
export async function autoCompleteAppointments(): Promise<AutoCompleteResult> {
  const allErrors: string[] = [];

  console.log("🔄 Starting auto-complete appointments scan...");
  console.log(`   Buffer time: ${COMPLETION_BUFFER_HOURS} hour(s) after session end`);

  // Complete webinars
  const webinarResult = await completeWebinars();
  allErrors.push(...webinarResult.errors);

  // Complete classes
  const classResult = await completeClasses();
  allErrors.push(...classResult.errors);

  // Identify completed consultations (for reporting)
  const consultationsIdentified = await identifyCompletedConsultations();

  // Identify completed subscriptions (for reporting)
  const subscriptionsIdentified = await identifyCompletedSubscriptions();

  // Summary
  console.log("\n📊 Auto-Complete Summary:");
  console.log(`   Webinars completed: ${webinarResult.completed}`);
  console.log(`   Classes completed: ${classResult.completed}`);
  console.log(`   Consultations ended (SCHEDULED): ${consultationsIdentified}`);
  console.log(`   Subscriptions ended (SCHEDULED): ${subscriptionsIdentified}`);

  if (allErrors.length > 0) {
    console.log("\n⚠️ Errors encountered:");
    allErrors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: allErrors.length === 0,
    webinarsCompleted: webinarResult.completed,
    classesCompleted: classResult.completed,
    consultationsIdentified,
    subscriptionsIdentified,
    errors: allErrors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
