/**
 * Auto-Complete Appointments - Core Logic
 *
 * Automatically marks appointments as COMPLETED after their session time ends.
 * For Webinars/Classes: Updates status to COMPLETED.
 * For Consultations/Subscriptions: Updates status to COMPLETED.
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
import { WebinarStatus, ClassStatus, RequestStatus } from "@prisma/client";

// Only complete appointments that ended at least 1 hour ago
// This gives buffer time for any post-session activities
const COMPLETION_BUFFER_HOURS = 1;

export interface AutoCompleteResult {
  success: boolean;
  webinarsCompleted: number;
  classesCompleted: number;
  consultationsCompleted: number;
  subscriptionsCompleted: number;
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
 * Auto-complete consultations that have ended
 */
async function completeConsultations(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find APPROVED or SCHEDULED consultations where all slots have ended
  const consultationsToComplete = await prisma.consultation.findMany({
    where: {
      requestStatus: { in: [RequestStatus.APPROVED, RequestStatus.SCHEDULED] },
      appointment: {
        slotsOfAppointment: {
          every: {
            endsAt: { lt: bufferTime },
          },
        },
      },
    },
    include: {
      consultationPlan: { select: { title: true } },
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

  console.log(`Found ${consultationsToComplete.length} consultations to auto-complete`);

  for (const consultation of consultationsToComplete) {
    try {
      const lastSlot = consultation.appointment?.slotsOfAppointment[0];
      console.log(`\nCompleting consultation ${consultation.id}`);
      console.log(`   Title: ${consultation.consultationPlan.title}`);
      console.log(`   Previous status: ${consultation.requestStatus}`);
      console.log(`   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`);

      await prisma.consultation.update({
        where: { id: consultation.id },
        data: { requestStatus: RequestStatus.COMPLETED },
      });

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete consultation ${consultation.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Auto-complete subscriptions that have ended (all sessions done)
 */
async function completeSubscriptions(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find APPROVED or SCHEDULED subscriptions where all slots have ended
  const subscriptionsToComplete = await prisma.subscription.findMany({
    where: {
      requestStatus: { in: [RequestStatus.APPROVED, RequestStatus.SCHEDULED] },
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
      subscriptionPlan: { select: { title: true } },
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

  console.log(`Found ${subscriptionsToComplete.length} subscriptions to auto-complete`);

  for (const subscription of subscriptionsToComplete) {
    try {
      // Find the latest slot end time across all appointments
      let latestEnd: Date | null = null;
      for (const apt of subscription.appointments) {
        const slot = apt.slotsOfAppointment[0];
        if (slot && (!latestEnd || slot.endsAt > latestEnd)) {
          latestEnd = slot.endsAt;
        }
      }

      console.log(`\nCompleting subscription ${subscription.id}`);
      console.log(`   Title: ${subscription.subscriptionPlan.title}`);
      console.log(`   Previous status: ${subscription.requestStatus}`);
      console.log(`   Last slot ended: ${latestEnd?.toISOString() || "Unknown"}`);

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { requestStatus: RequestStatus.COMPLETED },
      });

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete subscription ${subscription.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
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

  // Complete consultations
  const consultationResult = await completeConsultations();
  allErrors.push(...consultationResult.errors);

  // Complete subscriptions
  const subscriptionResult = await completeSubscriptions();
  allErrors.push(...subscriptionResult.errors);

  // Summary
  console.log("\n📊 Auto-Complete Summary:");
  console.log(`   Webinars completed: ${webinarResult.completed}`);
  console.log(`   Classes completed: ${classResult.completed}`);
  console.log(`   Consultations completed: ${consultationResult.completed}`);
  console.log(`   Subscriptions completed: ${subscriptionResult.completed}`);

  if (allErrors.length > 0) {
    console.log("\n⚠️ Errors encountered:");
    allErrors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: allErrors.length === 0,
    webinarsCompleted: webinarResult.completed,
    classesCompleted: classResult.completed,
    consultationsCompleted: consultationResult.completed,
    subscriptionsCompleted: subscriptionResult.completed,
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
