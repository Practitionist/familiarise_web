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
import {
  WebinarStatus,
  ClassStatus,
  AppointmentStatus,
  TrialSessionStatus,
} from "@prisma/client";
import { notifyAppointmentCompleted } from "../../lib/novu/service";
import { notificationScope } from "../../lib/novu/workflows";
import { getAppUrl } from "../../lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { REQUEST_ALLOWED_FROM } from "@/lib/booking/transitions";

// Only complete appointments that ended at least 1 hour ago
// This gives buffer time for any post-session activities
const COMPLETION_BUFFER_HOURS = 1;

export interface AutoCompleteResult {
  success: boolean;
  webinarsCompleted: number;
  classesCompleted: number;
  consultationsCompleted: number;
  subscriptionsCompleted: number;
  trialsCompleted: number;
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
          some: {
            endsAt: { lt: bufferTime },
          },
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
      console.log(
        `   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`,
      );

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
        some: {
          slotsOfAppointment: {
            some: {
              endsAt: { lt: bufferTime },
            },
          },
        },
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
      console.log(
        `   Last slot ended: ${latestEnd?.toISOString() || "Unknown"}`,
      );

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
      status: { in: [AppointmentStatus.APPROVED, AppointmentStatus.SCHEDULED] },
      appointment: {
        slotsOfAppointment: {
          some: {
            endsAt: { lt: bufferTime },
          },
          every: {
            endsAt: { lt: bufferTime },
          },
        },
      },
    },
    include: {
      consultationPlan: {
        select: {
          title: true,
          consultantProfile: {
            select: { userId: true, user: { select: { name: true } } },
          },
        },
      },
      requestedBy: {
        select: { userId: true, user: { select: { name: true } } },
      },
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

  console.log(
    `Found ${consultationsToComplete.length} consultations to auto-complete`,
  );

  for (const consultation of consultationsToComplete) {
    try {
      const lastSlot = consultation.appointment?.slotsOfAppointment[0];
      console.log(`\nCompleting consultation ${consultation.id}`);
      console.log(`   Title: ${consultation.consultationPlan.title}`);
      console.log(`   Previous status: ${consultation.status}`);
      console.log(
        `   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`,
      );

      // #836 — guard rides the WHERE: a cancel landing between the sweep's
      // read and this write must not be overwritten by COMPLETED.
      const moved = await prisma.consultation.updateMany({
        where: {
          id: consultation.id,
          status: { in: REQUEST_ALLOWED_FROM.COMPLETED },
        },
        data: { status: AppointmentStatus.COMPLETED },
      });
      if (moved.count === 0) {
        console.log(`   ⏭️ Skipped — status changed since sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;

      // Fire-and-forget: notify both parties (non-blocking)
      const consultantUserId =
        consultation.consultationPlan?.consultantProfile?.userId;
      const consulteeUserId = consultation.requestedBy?.userId;
      const userIds = [consultantUserId, consulteeUserId].filter(
        (id): id is string => !!id,
      );
      if (userIds.length > 0) {
        void notifyAppointmentCompleted(userIds, {
          ...notificationScope(consultation.appointment?.organizationId),
          appointmentType: "consultation",
          consultantName:
            consultation.consultationPlan?.consultantProfile?.user?.name ??
            "Consultant",
          consulteeName: consultation.requestedBy?.user?.name ?? "Consultee",
          planTitle: consultation.consultationPlan.title,
          dashboardUrl: `${getAppUrl()}/dashboard`,
        }).catch((error) =>
          console.error(
            `[auto-complete] Failed to send consultation completion notification:`,
            error,
          ),
        );
      }
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
      status: { in: [AppointmentStatus.APPROVED, AppointmentStatus.SCHEDULED] },
      appointments: {
        some: {
          slotsOfAppointment: {
            some: {
              endsAt: { lt: bufferTime },
            },
          },
        },
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
      subscriptionPlan: {
        select: {
          title: true,
          consultantProfile: {
            select: { userId: true, user: { select: { name: true } } },
          },
        },
      },
      requestedBy: {
        select: { userId: true, user: { select: { name: true } } },
      },
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

  console.log(
    `Found ${subscriptionsToComplete.length} subscriptions to auto-complete`,
  );

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
      console.log(`   Previous status: ${subscription.status}`);
      console.log(
        `   Last slot ended: ${latestEnd?.toISOString() || "Unknown"}`,
      );

      // #836 — guard rides the WHERE: a cancel landing between the sweep's
      // read and this write must not be overwritten by COMPLETED.
      const moved = await prisma.subscription.updateMany({
        where: {
          id: subscription.id,
          status: { in: REQUEST_ALLOWED_FROM.COMPLETED },
        },
        data: { status: AppointmentStatus.COMPLETED },
      });
      if (moved.count === 0) {
        console.log(`   ⏭️ Skipped — status changed since sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;

      // Fire-and-forget: notify both parties (non-blocking)
      const consultantUserId =
        subscription.subscriptionPlan?.consultantProfile?.userId;
      const consulteeUserId = subscription.requestedBy?.userId;
      const userIds = [consultantUserId, consulteeUserId].filter(
        (id): id is string => !!id,
      );
      if (userIds.length > 0) {
        void notifyAppointmentCompleted(userIds, {
          ...notificationScope(subscription.appointments[0]?.organizationId),
          appointmentType: "subscription",
          consultantName:
            subscription.subscriptionPlan?.consultantProfile?.user?.name ??
            "Consultant",
          consulteeName: subscription.requestedBy?.user?.name ?? "Consultee",
          planTitle: subscription.subscriptionPlan.title,
          dashboardUrl: `${getAppUrl()}/dashboard`,
        }).catch((error) =>
          console.error(
            `[auto-complete] Failed to send subscription completion notification:`,
            error,
          ),
        );
      }
    } catch (error) {
      const msg = `Failed to complete subscription ${subscription.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Auto-complete trial sessions that have ended
 */
async function completeTrials(): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED trials where the appointment slot has ended
  const trialsToComplete = await prisma.trialSession.findMany({
    where: {
      status: TrialSessionStatus.SCHEDULED,
      appointment: {
        slotsOfAppointment: {
          some: {
            endsAt: { lt: bufferTime },
          },
          every: {
            endsAt: { lt: bufferTime },
          },
        },
      },
    },
    include: {
      subscriptionPlan: { select: { title: true } },
      consulteeProfile: {
        include: {
          user: {
            select: { id: true, name: true, image: true },
          },
        },
      },
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

  console.log(`Found ${trialsToComplete.length} trials to auto-complete`);

  for (const trial of trialsToComplete) {
    try {
      const lastSlot = trial.appointment?.slotsOfAppointment[0];
      console.log(`\nCompleting trial ${trial.id}`);
      console.log(`   Plan: ${trial.subscriptionPlan.title}`);
      console.log(`   Consultee: ${trial.consulteeProfile.user.name}`);
      console.log(`   Previous status: ${trial.status}`);
      console.log(
        `   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`,
      );

      await prisma.trialSession.update({
        where: { id: trial.id },
        data: {
          status: TrialSessionStatus.COMPLETED,
          completedAt: new Date(),
        },
      });

      // Log activity for trial completion
      try {
        await prisma.activityLog.create({
          data: {
            activityType: "TRIAL_COMPLETED",
            description: `Completed trial session with ${trial.consulteeProfile.user.name}: ${trial.subscriptionPlan.title}`,
            actorId: trial.consulteeProfile.user.id,
            actorName: trial.consulteeProfile.user.name,
            actorImage: trial.consulteeProfile.user.image,
            consultantProfileId: trial.consultantProfileId,
            trialSessionId: trial.id,
            metadata: {
              planTitle: trial.subscriptionPlan.title,
              autoCompleted: true,
            },
          },
        });
      } catch (activityError) {
        console.warn(`   ⚠️ Failed to log activity: ${activityError}`);
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete trial ${trial.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors };
}

/**
 * Mark individual SlotOfAppointment records with per-slot completion status.
 * Runs BEFORE parent-level completion so that parent logic can rely on slot statuses.
 *
 * - Slots past buffer WITH MeetingSession.endedAt → COMPLETED
 * - Slots past buffer WITHOUT MeetingSession → UNVERIFIED (may be offline sessions)
 */
async function completeIndividualSlots(): Promise<{
  completed: number;
  unverified: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  try {
    // Slots past buffer WITH MeetingSession.endedAt → COMPLETED
    // Note: completedAt = cron run time (not session endedAt). Real-time
    // completion via webhooks (session-handlers.ts) uses the actual endedAt.
    // This cron is a fallback for missed webhooks, so the cron timestamp
    // represents "when the system acknowledged completion."
    const completedResult = await prisma.slotOfAppointment.updateMany({
      where: {
        completionStatus: "SCHEDULED",
        endsAt: { lt: bufferTime },
        meetingSession: { endedAt: { not: null } },
      },
      data: { completionStatus: "COMPLETED", completedAt: new Date() },
    });

    // Slots past buffer WITHOUT MeetingSession → UNVERIFIED
    const unverifiedResult = await prisma.slotOfAppointment.updateMany({
      where: {
        completionStatus: "SCHEDULED",
        endsAt: { lt: bufferTime },
        meetingSession: null,
      },
      data: { completionStatus: "UNVERIFIED" },
    });

    // Slots with MeetingSession but no endedAt (orphaned sessions — call
    // started but webhook never fired) → UNVERIFIED
    const orphanedResult = await prisma.slotOfAppointment.updateMany({
      where: {
        completionStatus: "SCHEDULED",
        endsAt: { lt: bufferTime },
        meetingSession: { endedAt: null },
      },
      data: { completionStatus: "UNVERIFIED" },
    });

    if (
      completedResult.count > 0 ||
      unverifiedResult.count > 0 ||
      orphanedResult.count > 0
    ) {
      console.log(
        `   Slot-level: ${completedResult.count} completed, ${unverifiedResult.count + orphanedResult.count} unverified (${orphanedResult.count} orphaned)`,
      );
    }

    return {
      completed: completedResult.count,
      unverified: unverifiedResult.count + orphanedResult.count,
      errors,
    };
  } catch (error) {
    const message = `Failed to complete individual slots: ${error instanceof Error ? error.message : "Unknown error"}`;
    console.error(`   ❌ ${message}`);
    errors.push(message);
    return { completed: 0, unverified: 0, errors };
  }
}

/**
 * Main function to auto-complete all eligible appointments
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function autoCompleteAppointments(): Promise<AutoCompleteResult> {
  return withCronLock("auto-complete-appointments", { failMode: "open" }, () =>
    autoCompleteAppointmentsUnlocked(),
  );
}

async function autoCompleteAppointmentsUnlocked(): Promise<AutoCompleteResult> {
  const allErrors: string[] = [];

  console.log("🔄 Starting auto-complete appointments scan...");
  console.log(
    `   Buffer time: ${COMPLETION_BUFFER_HOURS} hour(s) after session end`,
  );

  // Complete individual slots first (per-slot status before parent-level)
  const slotResult = await completeIndividualSlots();
  allErrors.push(...slotResult.errors);

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

  // Complete trial sessions
  const trialResult = await completeTrials();
  allErrors.push(...trialResult.errors);

  // Summary
  console.log("\n📊 Auto-Complete Summary:");
  console.log(
    `   Slots: ${slotResult.completed} completed, ${slotResult.unverified} unverified`,
  );
  console.log(`   Webinars completed: ${webinarResult.completed}`);
  console.log(`   Classes completed: ${classResult.completed}`);
  console.log(`   Consultations completed: ${consultationResult.completed}`);
  console.log(`   Subscriptions completed: ${subscriptionResult.completed}`);
  console.log(`   Trials completed: ${trialResult.completed}`);

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
    trialsCompleted: trialResult.completed,
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
