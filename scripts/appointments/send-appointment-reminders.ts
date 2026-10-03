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
  APPOINTMENT_REMINDER_EMAIL_TYPE,
  appointmentReminderEntityRef,
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

/**
 * Per-window per-run ceiling, and the default for every caller that does not
 * pass one.
 *
 * This cohort used to have NO bound at all: the read below was time-windowed
 * and nothing else, and the Netlify ticker drives it inside a 20 s abort. The
 * cost per row is a Redis round trip, a Novu trigger, a recipient
 * preference read, a React render and a Resend call, so an unbounded window at
 * a burst is a guaranteed abort with a partial send — and the rows past the
 * abort point leave the window unnoticed.
 *
 * The value is a REMINDER cap, not a correctness cap: within the two-hour 24h
 * window a capped run simply re-reads the same window next tick and finishes
 * the remainder, so the bound is a budget and not a drop. The 1h window is only
 * 30 minutes wide against a 15-minute tick, so a burst wider than this cap in
 * one half hour DOES lose the tail of that window's 1h reminders — see
 * {@link warnIfWindowCapped}, which makes that loud instead of silent.
 */
const MAX_SESSIONS_PER_WINDOW_PER_RUN = 25;

/** Redis dedupe key for one slot+window. Slot-scoped on purpose (#1554/#1589). */
function reminderKey(slotId: string, window: ReminderWindowLabel): string {
  return `reminder:${slotId}:${window}`;
}

/** The `FailedEmail.entityRef` the email twin stages under (#1653). */
function reminderEntityRef(appointmentId: string, window: ReminderWindowLabel) {
  return appointmentReminderEntityRef(appointmentId, window);
}

/**
 * The full dedupe window: from this run until the reminder window has closed
 * behind us.
 *
 * Every slot in the window starts in the FUTURE of this run, so the key has to
 * outlive the whole window, not just the send. The old values (26 h / 2 h) were
 * flat and considerably longer than the windows they guard (25 h / 2 h), which
 * meant a session re-timed inside its own reminder window could never be
 * re-reminded at the new time — the key followed the slot, not the time.
 */
function fullDedupeTtlSeconds(window: { maxMs: number }): number {
  // +1 min of margin so a run that starts a second before the window's tail
  // still suppresses the next tick's re-read of that same tail.
  return Math.ceil(window.maxMs / 1000) + 60;
}

/**
 * The in-flight TTL the key is written with.
 *
 * A kill between "key written" and "reminder sent" used to lose the reminder
 * permanently: the key WAS the dedupe, nothing re-read the slot because the
 * key suppressed it, and no relay owns this side effect. So the key is now
 * written short and extended only after the send settles. A process that dies
 * in the gap leaves a key that expires, and the next tick re-reads the slot
 * and re-sends.
 *
 * The floor is the real recovery bound, so it must comfortably exceed the
 * send: two outbox stages plus a Resend call on a cold instance have been seen
 * past 20 s, and a key that expired mid-send would let the next tick
 * double-send rather than merely re-offer.
 */
const IN_FLIGHT_TTL_SECONDS = 300;

async function sendRemindersForWindow(
  window: {
    label: ReminderWindowLabel;
    minMs: number;
    maxMs: number;
  },
  maxPerRun: number,
): Promise<{ sent: number; errors: string[]; capped: boolean }> {
  const now = Date.now();
  const windowStart = new Date(now + window.minMs);
  const windowEnd = new Date(now + window.maxMs);
  const errors: string[] = [];
  let sent = 0;

  // Find slots starting within the reminder window.
  //
  // Soonest-first, because "oldest-first" is the wrong order for a reminder:
  // the session nearest its start is the one whose notice is worth most, and
  // if the cap is ever hit the rows that lose their notice must be the ones
  // with the most runway left.
  const upcomingOccurrences = await prisma.appointmentOccurrence.findMany({
    where: {
      startsAt: {
        gte: windowStart,
        lte: windowEnd,
      },
      isTentative: false,
      completionStatus: "SCHEDULED",
    },
    orderBy: { startsAt: "asc" },
    take: maxPerRun,
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
          // #1589 N-P1-02 — a trial's held call is a non-tentative SCHEDULED
          // occurrence from acceptance on; the status gate is on the trial.
          trial: {
            select: {
              status: true,
              subscriptionPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
              consulteeProfile: {
                select: { userId: true, user: { select: { name: true } } },
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

  const capped = upcomingOccurrences.length >= maxPerRun;
  if (capped) warnIfWindowCapped(window.label, maxPerRun);

  /**
   * The DURABLE half of the dedupe, and the reason a capped run is safe to
   * repeat.
   *
   * The Redis key is per SLOT and lives only in Redis, so it cannot be part of
   * a SQL predicate — a re-read of the same capped batch re-collects the rows
   * it already handled, and without this the cap would turn every tick after
   * the first into N no-op Redis round trips with no progress. The email twin
   * stages a `FailedEmail` row under a per-APPOINTMENT+window entityRef before
   * it sends, so that set is queryable, and an appointment already reminded
   * for this window is dropped from the batch.
   *
   * This is also what makes a kill recoverable rather than merely detectable:
   * the row is written before the send, so a process that dies after staging
   * leaves a durable record the next tick can see, and a process that dies
   * before staging leaves none — and the short-TTL Redis key below has already
   * expired, so the slot is offered again.
   */
  const alreadyStaged = new Set(
    (
      await prisma.failedEmail.findMany({
        where: {
          emailType: APPOINTMENT_REMINDER_EMAIL_TYPE,
          entityRef: {
            in: upcomingOccurrences
              .map((slot) => slot.appointment?.id)
              .filter((id): id is string => typeof id === "string")
              .map((id) => reminderEntityRef(id, window.label)),
          },
        },
        select: { entityRef: true },
      })
    ).map((row) => row.entityRef),
  );

  // Per-slot dedupe via the Redis key below (not per-appointment): a
  // multi-slot booking notifies each session in the window exactly once.
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
    if (!apt) continue;
    if (alreadyStaged.has(reminderEntityRef(apt.id, window.label))) continue;

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
      } else if (apt.trial) {
        // An AWAITING_PAYMENT trial still holds its occurrence; only a
        // SCHEDULED (paid or free) trial gets the reminder pair.
        if (apt.trial.status !== "SCHEDULED") continue;
        appointmentType = "trial";
        planTitle = apt.trial.subscriptionPlan?.title ?? "Trial";
        consultantName =
          apt.trial.subscriptionPlan?.consultantProfile?.user?.name ??
          "Consultant";
        consulteeName = apt.trial.consulteeProfile?.user?.name ?? "Consultee";
        const cId = apt.trial.subscriptionPlan?.consultantProfile?.userId;
        const eId = apt.trial.consulteeProfile?.userId;
        consultantUserId = cId;
        if (cId) userIds.push(cId);
        if (eId) userIds.push(eId);
      }

      // Deduplicate user IDs
      const uniqueUserIds = Array.from(new Set(userIds));

      if (uniqueUserIds.length === 0) continue;

      // Claim the slot, then send, then EXTEND the claim.
      //
      // The claim is written with the short in-flight TTL, not the dedupe
      // window. Writing the full TTL first is what made a kill in the gap
      // unrecoverable: the key existed, so every later tick skipped the slot,
      // and nothing else owns this side effect — the reminder was simply gone.
      // Short-first means a kill leaves a key that expires, and the next tick
      // re-offers the session.
      //
      // On Redis failure skip the send (unchanged): a fail-open double-notify
      // is worse than a missed reminder the next tick redrives. The dedupe is
      // fail-closed; the cron lock stays fail-open.
      const redisKey = reminderKey(slot.id, window.label);
      try {
        const alreadySent = await redis.set(redisKey, "1", {
          nx: true,
          ex: IN_FLIGHT_TTL_SECONDS,
        });
        if (!alreadySent) continue; // Key existed — another claim is in flight
      } catch {
        continue;
      }

      // Only now is the claim promoted to the full dedupe window. Every
      // failure path below returns to here with the short key still in place,
      // so a partial send re-offers on the next tick rather than being
      // suppressed forever.
      let claimExtendable = true;
      try {
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
          // slot+window so each session notifies once and the second window
          // isn't deduped away. This is what keeps the BELL arm at-most-once
          // across a re-offer: Novu rejects a repeated transactionId, so a
          // tick that re-sends after a kill stages an existing row and the
          // vendor drops it.
          `${slot.id}:${window.label}`,
        );

        // #1653 — the email twin, inside the same claim so a re-run does not
        // send twice. No join link: the meeting route is not known here. This
        // stages its `FailedEmail` row BEFORE the wire call, which is the
        // durable record the next tick reads above.
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
        claimExtendable = false;
        errors.push(
          `Failed to send ${window.label} reminder for appointment ${apt.id}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      } finally {
        if (claimExtendable) {
          // Best-effort promote. A failure here costs a duplicate on the next
          // tick (the bell's transactionId absorbs it; the email twin would
          // re-send), which is the cheaper of the two available errors.
          await redis
            .set(redisKey, "1", { ex: fullDedupeTtlSeconds(window) })
            .catch(() => {
              errors.push(
                `Could not extend the reminder dedupe for slot ${slot.id}; the next tick may repeat it`,
              );
            });
        } else {
          // Release the claim outright rather than waiting out the in-flight
          // TTL: the send already failed, so there is nothing to protect and
          // the next tick should be free to retry immediately.
          await redis.del(redisKey).catch(() => {});
        }
      }
    } catch (error) {
      errors.push(
        `Failed to send ${window.label} reminder for appointment ${apt.id}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return { sent, errors, capped };
}

/**
 * A hit cap means rows this run did not reach are still in the window, and for
 * the 1h window there may not be another tick before it closes. Loud, because
 * the alternative — a cap that quietly truncates a reminder cohort — is the
 * failure the cap was added to remove.
 */
function warnIfWindowCapped(label: ReminderWindowLabel, cap: number): void {
  console.warn(
    JSON.stringify({
      event: "appointment_reminders_window_capped",
      window: label,
      cap,
      note:
        label === "1h"
          ? "sessions past the cap lose this window's 1h reminder — the window is 30 min wide and the tick is 15 min, so there may be no further tick before it closes"
          : "the remainder drains on the next tick; the 24h window is 2 h wide",
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Main function to send all appointment reminders.
 *
 * `maxPerWindow` is the bound the Netlify ticker asks for (#1583 P1 — it drives
 * this route inside a 20 s abort and the cohort read used to have no cap at
 * all). A caller that omits it keeps {@link MAX_SESSIONS_PER_WINDOW_PER_RUN},
 * which is also what the GitHub Actions twin gets.
 */
export async function sendAppointmentReminders(opts?: {
  maxPerWindow?: number;
}): Promise<ReminderResult> {
  const maxPerWindow =
    opts?.maxPerWindow && opts.maxPerWindow > 0
      ? Math.floor(opts.maxPerWindow)
      : MAX_SESSIONS_PER_WINDOW_PER_RUN;
  return withCronLock("send-appointment-reminders", { failMode: "open" }, () =>
    sendAppointmentRemindersUnlocked(maxPerWindow),
  );
}

async function sendAppointmentRemindersUnlocked(
  maxPerWindow: number,
): Promise<ReminderResult> {
  console.log("🔔 Starting appointment reminders scan...");
  console.log(`   Per-window cap: ${maxPerWindow} slot(s)`);

  const [result24h, result1h] = await Promise.all([
    sendRemindersForWindow(REMINDER_24H, maxPerWindow),
    sendRemindersForWindow(REMINDER_1H, maxPerWindow),
  ]);

  const allErrors = [...result24h.errors, ...result1h.errors];
  // A capped run is not a failed run: the rows it did not reach are still in
  // the window and the next tick collects them. Reporting it as a failure
  // would page on a backlog that is draining.
  const capped = result24h.capped || result1h.capped;

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
  if (capped) {
    console.log(
      "   ⚠️ A window hit its cap — the remainder drains on the next tick (see appointment_reminders_window_capped).",
    );
  }

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
