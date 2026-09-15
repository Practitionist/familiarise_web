/**
 * Send Appointment Reminders - Core Logic
 *
 * Sends reminder notifications for upcoming appointments.
 * - 24-hour reminders: appointments starting in 23-25 hours
 * - 1-hour reminders: appointments starting in 45-75 minutes
 *
 * This module exports the core function.
 * It is imported by:
 * - jobs/appointments/send-appointment-reminders.ts (GitHub Actions)
 * - app/api/cleanup/appointment-reminders/route.ts (API endpoint)
 *
 * Schedule: Every 15 minutes
 */

import prisma from "../../lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { collaboratorUserIds } from "@/lib/collaborators/recipients";
import redis from "../../lib/redis";
import { notifyAppointmentReminder } from "../../lib/novu/service";
import { notificationScope } from "../../lib/novu/workflows";
import { notificationHref } from "../../lib/novu/resolve-href";
import { planTitleOrSessionLabel } from "../../lib/novu/humanize";
import {
  EMAIL_BUDGET_MS,
  sendAppointmentReminderEmail,
  type ReminderWindowLabel,
} from "../../lib/email";
import { withCronLock } from "@/lib/cron/with-cron-lock";

// Reminder windows (in milliseconds)
const REMINDER_24H = {
  label: "24h" as const,
  minMs: 23 * 60 * 60 * 1000, // 23 hours
  maxMs: 25 * 60 * 60 * 1000, // 25 hours
};

const REMINDER_1H = {
  label: "1h" as const,
  minMs: 45 * 60 * 1000, // 45 minutes
  maxMs: 75 * 60 * 1000, // 75 minutes
};

export interface ReminderResult {
  success: boolean;
  reminders24h: number;
  reminders1h: number;
  errors: string[];
  timestamp: string;
}

async function sendRemindersForWindow(window: {
  label: ReminderWindowLabel;
  minMs: number;
  maxMs: number;
}): Promise<{ sent: number; errors: string[] }> {
  const now = Date.now();
  const windowStart = new Date(now + window.minMs);
  const windowEnd = new Date(now + window.maxMs);
  const errors: string[] = [];
  let sent = 0;

  // Find slots starting within the reminder window
  const upcomingOccurrences = await prisma.appointmentOccurrence.findMany({
    where: {
      startsAt: {
        gte: windowStart,
        lte: windowEnd,
      },
      isTentative: false,
      completionStatus: "SCHEDULED",
    },
    include: {
      appointment: {
        include: {
          // #1554 — the roster: every live seat holder.
          participants: {
            where: liveParticipant(),
            select: { userId: true },
          },
          consultation: {
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
            },
          },
          subscription: {
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
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  console.log(
    `Found ${upcomingOccurrences.length} slots in ${window.label} reminder window`,
  );

  // Deduplicate by appointmentId (multiple slots per appointment)
  const seenAppointments = new Set<string>();
  // Sessions of one class share a plan; one collaborator read per plan (#1593).
  const collaboratorsByPlan = new Map<string, Promise<string[]>>();
  const planCollaborators = (planType: "webinar" | "class", planId: string) => {
    const key = `${planType}:${planId}`;
    let ids = collaboratorsByPlan.get(key);
    if (!ids) {
      ids = collaboratorUserIds(planType, planId);
      collaboratorsByPlan.set(key, ids);
      // A failed lookup must not be memoised, or every later session of the
      // plan in this window would skip its reminders too.
      ids.catch(() => collaboratorsByPlan.delete(key));
    }
    return ids;
  };

  for (const slot of upcomingOccurrences) {
    const apt = slot.appointment;
    if (!apt || seenAppointments.has(apt.id)) continue;
    seenAppointments.add(apt.id);

    try {
      // Determine event type and plan info
      let appointmentType = "consultation";
      // #536 — empty, not "Unknown": an appointment matching none of the four
      // shapes below would have named the customer's session "Unknown".
      let planTitle = "";
      let consultantName = "Consultant";
      let consulteeName = "Consultee";
      // #1653 — lets the email name the consultee as the consultant's other party.
      let consultantUserId: string | undefined;
      const userIds: string[] = [];

      if (apt.consultation) {
        appointmentType = "consultation";
        planTitle = apt.consultation.consultationPlan?.title ?? "Consultation";
        consultantName =
          apt.consultation.consultationPlan?.consultantProfile?.user?.name ??
          "Consultant";
        consulteeName = apt.consultation.requestedBy?.user?.name ?? "Consultee";
        const cId =
          apt.consultation.consultationPlan?.consultantProfile?.userId;
        const eId = apt.consultation.requestedBy?.userId;
        consultantUserId = cId;
        if (cId) userIds.push(cId);
        if (eId) userIds.push(eId);
      } else if (apt.subscription) {
        appointmentType = "subscription";
        planTitle = apt.subscription.subscriptionPlan?.title ?? "Subscription";
        consultantName =
          apt.subscription.subscriptionPlan?.consultantProfile?.user?.name ??
          "Consultant";
        consulteeName = apt.subscription.requestedBy?.user?.name ?? "Consultee";
        const cId =
          apt.subscription.subscriptionPlan?.consultantProfile?.userId;
        const eId = apt.subscription.requestedBy?.userId;
        consultantUserId = cId;
        if (cId) userIds.push(cId);
        if (eId) userIds.push(eId);
      } else if (apt.webinar) {
        appointmentType = "webinar";
        planTitle = apt.webinar.webinarPlan?.title ?? "Webinar";
        consultantName =
          apt.webinar.webinarPlan?.consultantProfile?.user?.name ??
          "Consultant";
        // Attendees, the host (missing until #1580 — only the slot's joined
        // users were reminded) and the accepted collaborators (C-P1-5).
        for (const seat of apt.participants) {
          userIds.push(seat.userId);
        }
        const hostId = apt.webinar.webinarPlan?.consultantProfile?.userId;
        consultantUserId = hostId;
        if (hostId) userIds.push(hostId);
        userIds.push(
          ...(await planCollaborators("webinar", apt.webinar.webinarPlanId)),
        );
      } else if (apt.class) {
        appointmentType = "class";
        planTitle = apt.class.classPlan?.title ?? "Class";
        consultantName =
          apt.class.classPlan?.consultantProfile?.user?.name ?? "Consultant";
        // Same three parties as the webinar branch above.
        for (const seat of apt.participants) {
          userIds.push(seat.userId);
        }
        const hostId = apt.class.classPlan?.consultantProfile?.userId;
        consultantUserId = hostId;
        if (hostId) userIds.push(hostId);
        userIds.push(
          ...(await planCollaborators("class", apt.class.classPlanId)),
        );
      }

      // Deduplicate user IDs
      const uniqueUserIds = Array.from(new Set(userIds));

      if (uniqueUserIds.length === 0) continue;

      // Idempotency: skip if reminder already sent for this appointment+window
      const redisKey = `reminder:${apt.id}:${window.label}`;
      const ttlSeconds = window.label === "24h" ? 26 * 3600 : 2 * 3600;
      try {
        const alreadySent = await redis.set(redisKey, "1", {
          nx: true,
          ex: ttlSeconds,
        });
        if (!alreadySent) continue; // Key existed — already sent
      } catch {
        // Redis unavailable — send anyway rather than skip silently
      }

      await notifyAppointmentReminder(
        uniqueUserIds,
        {
          ...notificationScope(apt.organizationId),
          appointmentType,
          consultantName,
          consulteeName,
          planTitle: planTitleOrSessionLabel(planTitle, appointmentType),
          // Rendered per recipient timezone at the trigger boundary (#536).
          dateTime: slot.startsAt.toISOString(),
          dashboardUrl: notificationHref(apt.organizationId, "appointments"),
        },
        // 24h and 1h payloads are identical — key the Novu transactionId by
        // window so the second reminder isn't deduped away.
        `${apt.id}:${window.label}`,
      );

      // #1653 — the email twin, inside the same Redis guard so a re-run does
      // not send twice. No join link: the meeting route is not known here.
      await sendAppointmentReminderEmail(
        {
          appointmentId: apt.id,
          userIds: uniqueUserIds,
          windowLabel: window.label,
          consultantUserId,
          consultantName,
          consulteeName,
          planTitle: planTitleOrSessionLabel(planTitle, appointmentType),
          appointmentType,
          startsAt: slot.startsAt,
          dashboardUrl: notificationHref(apt.organizationId, "appointments"),
        },
        EMAIL_BUDGET_MS.JOB,
      );

      sent++;
    } catch (error) {
      errors.push(
        `Failed to send ${window.label} reminder for appointment ${apt.id}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return { sent, errors };
}

/**
 * Main function to send all appointment reminders
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function sendAppointmentReminders(): Promise<ReminderResult> {
  return withCronLock("send-appointment-reminders", { failMode: "open" }, () =>
    sendAppointmentRemindersUnlocked(),
  );
}

async function sendAppointmentRemindersUnlocked(): Promise<ReminderResult> {
  console.log("🔔 Starting appointment reminders scan...");

  const [result24h, result1h] = await Promise.all([
    sendRemindersForWindow(REMINDER_24H),
    sendRemindersForWindow(REMINDER_1H),
  ]);

  const allErrors = [...result24h.errors, ...result1h.errors];

  const result: ReminderResult = {
    success: allErrors.length === 0,
    reminders24h: result24h.sent,
    reminders1h: result1h.sent,
    errors: allErrors,
    timestamp: new Date().toISOString(),
  };

  console.log(
    `📊 Reminders sent: ${result.reminders24h} (24h) + ${result.reminders1h} (1h)`,
  );

  if (allErrors.length > 0) {
    console.log("\n⚠️ Errors encountered:");
    allErrors.forEach((e) => console.log(`   - ${e}`));
  }

  return result;
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
