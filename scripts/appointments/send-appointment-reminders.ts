/**
 * Send Appointment Reminders - Core Logic
 *
 * Sends reminder notifications for upcoming appointments.
 * - 24-hour reminders: appointments starting in 23-25 hours
 * - 1-hour reminders: appointments starting in 45-75 minutes
 * - 15-minute reminders: appointments starting in 5-21 minutes
 * Group events remind paid seats only; unpaid HELD seats hear nothing.
 *
 * This module exports the core function.
 * It is imported by:
 * - lib/cron/cleanup-registry.ts (the /api/cleanup/[job] twin and the ticker)
 *
 * Schedule: Every 15 minutes
 */

import prisma from "../../lib/prisma";
import type { PrismaLike } from "../../lib/prisma";
import { paidParticipant } from "@/lib/booking/participants";
import {
  notifyAppointmentReminder,
  type TriggerOptions,
} from "../../lib/novu/service";
import { attemptTrigger } from "../../lib/novu/outbox";
import { notificationScope } from "../../lib/novu/workflows";
import { notificationHref } from "../../lib/novu/resolve-href";
import { planTitleOrSessionLabel } from "../../lib/novu/humanize";
import {
  APPOINTMENT_REMINDER_EMAIL_TYPE,
  appointmentReminderEntityRef,
  attemptStaged,
  EMAIL_BUDGET_MS,
  reminderSpec,
  sendAppointmentReminderEmail,
  type ReminderWindowLabel,
} from "../../lib/email";
import {
  stageSpecGuarded,
  type StagingTx,
} from "../../lib/email/senders/shared";
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

// 16 minutes wide, so a 15-minute cadence with a tick up to a minute late always reaches each session.
const REMINDER_15M = {
  label: "15m" as const,
  minMs: 5 * 60 * 1000,
  maxMs: 21 * 60 * 1000,
};

/** Every reminder window; staged rows dedupe a session a second tick also reaches. */
export const REMINDER_WINDOWS = [REMINDER_24H, REMINDER_1H, REMINDER_15M];

export interface ReminderResult {
  success: boolean;
  reminders24h: number;
  reminders1h: number;
  reminders15m: number;
  errors: string[];
  timestamp: string;
}

const MAX_SESSIONS_PER_WINDOW_PER_RUN = 25;

/** The `FailedEmail.entityRef` the email twin stages under. */
function reminderEntityRef(appointmentId: string, window: ReminderWindowLabel) {
  return appointmentReminderEntityRef(appointmentId, window);
}

const USER_BATCH_SELECT = {
  id: true,
  erasedAt: true,
  email: true,
  name: true,
  timezone: true,
  notificationPreferences: {
    select: {
      allNotifications: true,
      inAppEnabled: true,
      emailEnabled: true,
      appointmentReminders: true,
      paymentNotifications: true,
      subscriptionAlerts: true,
      trialNotifications: true,
      supportUpdates: true,
      feedbackAlerts: true,
      orgBillingAlerts: true,
      orgMembershipAlerts: true,
      orgProgramAlerts: true,
    },
  },
} as const;

type UpcomingOccurrence = Awaited<
  ReturnType<typeof queryUpcomingOccurrences>
>[number];

interface PreparedSlotReminder {
  slotId: string;
  startsAt: Date;
  appointmentId: string;
  organizationId: string | null;
  isMultiSession: boolean;
  appointmentType: string;
  planTitle: string;
  consultantName: string;
  consulteeName: string;
  consultantUserId?: string;
  collabIds: string[];
  uniqueUserIds: string[];
}

interface PreloadedWindowContext {
  alreadyStaged: Set<string>;
  bellTx?: TriggerOptions["tx"];
  emailTx?: StagingTx;
}

/** Slack past one window-width so a late tick does not push already-staged
 * slots back into the capped cohort; the dedupe read itself is unbounded. */
const STAGED_LOOKBACK_MARGIN_MS = 20 * 60 * 1000;

/**
 * Slot ids whose reminder for this window is already staged, so the bounded
 * cohort read skips them. A slot still in the window was staged at most one
 * window-width ago, which bounds the read by `createdAt`.
 */
async function stagedReminderSlotIds(
  window: { label: ReminderWindowLabel; minMs: number; maxMs: number },
  now: number,
): Promise<string[]> {
  // Split the writer's own builder output so the reader cannot drift from it.
  const [prefix, suffix] = appointmentReminderEntityRef(
    "|",
    window.label,
  ).split("|");
  const rows = await prisma.failedEmail.findMany({
    where: {
      emailType: APPOINTMENT_REMINDER_EMAIL_TYPE,
      createdAt: {
        gte: new Date(
          now - (window.maxMs - window.minMs) - STAGED_LOOKBACK_MARGIN_MS,
        ),
      },
      entityRef: { startsWith: prefix, endsWith: suffix },
    },
    select: { entityRef: true },
  });
  // One row is staged per recipient, so a slot's ref repeats; the WHERE needs it once.
  const ids = new Set<string>();
  for (const { entityRef } of rows) {
    if (entityRef) {
      ids.add(entityRef.slice(prefix.length, entityRef.length - suffix.length));
    }
  }
  return [...ids];
}

// Shared by the window read, the run's early return and the ticker's idle probe.
function reminderWindowWhere(windowStart: Date, windowEnd: Date) {
  return {
    startsAt: { gte: windowStart, lte: windowEnd },
    isTentative: false,
    completionStatus: "SCHEDULED" as const,
  };
}

function queryUpcomingOccurrences(
  windowStart: Date,
  windowEnd: Date,
  maxPerRun: number,
  stagedSlotIds: string[],
) {
  return prisma.appointmentOccurrence.findMany({
    where: {
      ...(stagedSlotIds.length > 0 ? { id: { notIn: stagedSlotIds } } : {}),
      ...reminderWindowWhere(windowStart, windowEnd),
    },
    orderBy: { startsAt: "asc" },
    take: maxPerRun,
    include: {
      appointment: {
        include: {
          participants: {
            where: paidParticipant(),
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
}

function appendUnique(map: Map<string, string[]>, key: string, value: string) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [value]);
  } else if (!existing.includes(value)) {
    existing.push(value);
  }
}

// Single batch collaborator query for all webinar and class plans in the window.
async function batchLoadCollaborators(
  occurrences: UpcomingOccurrence[],
): Promise<Map<string, string[]>> {
  const webinarPlanIds = Array.from(
    new Set(
      occurrences.flatMap((slot) =>
        slot.appointment?.webinar?.webinarPlanId
          ? [slot.appointment.webinar.webinarPlanId]
          : [],
      ),
    ),
  );
  const classPlanIds = Array.from(
    new Set(
      occurrences.flatMap((slot) =>
        slot.appointment?.class?.classPlanId
          ? [slot.appointment.class.classPlanId]
          : [],
      ),
    ),
  );

  const byPlan = new Map<string, string[]>();
  if (webinarPlanIds.length === 0 && classPlanIds.length === 0) {
    return byPlan;
  }

  const planFilters = [
    ...(webinarPlanIds.length > 0
      ? [{ webinarPlanId: { in: webinarPlanIds } }]
      : []),
    ...(classPlanIds.length > 0 ? [{ classPlanId: { in: classPlanIds } }] : []),
  ];

  const rows = await prisma.collaborator.findMany({
    where: {
      OR: planFilters,
      status: "ACCEPTED",
      consultantProfile: { deletedAt: null },
    },
    select: {
      webinarPlanId: true,
      classPlanId: true,
      consultantProfile: { select: { userId: true } },
    },
  });

  for (const row of rows) {
    const userId = row.consultantProfile.userId;
    if (row.webinarPlanId) {
      appendUnique(byPlan, `webinar:${row.webinarPlanId}`, userId);
    } else if (row.classPlanId) {
      appendUnique(byPlan, `class:${row.classPlanId}`, userId);
    } else {
      for (const id of webinarPlanIds)
        appendUnique(byPlan, `webinar:${id}`, userId);
      for (const id of classPlanIds)
        appendUnique(byPlan, `class:${id}`, userId);
    }
  }

  return byPlan;
}

function prepareSlotReminder(
  slot: UpcomingOccurrence,
  collaboratorsByPlan: Map<string, string[]>,
): PreparedSlotReminder | null {
  const apt = slot.appointment;
  if (!apt) return null;

  let appointmentType = "consultation";
  let planTitle = "";
  let consultantName = "Consultant";
  let consulteeName = "Consultee";
  let consultantUserId: string | undefined;
  let collabIds: string[] = [];
  const userIds: string[] = [];

  if (apt.consultation) {
    appointmentType = "consultation";
    planTitle = apt.consultation.consultationPlan?.title ?? "Consultation";
    consultantName =
      apt.consultation.consultationPlan?.consultantProfile?.user?.name ??
      "Consultant";
    consulteeName = apt.consultation.requestedBy?.user?.name ?? "Consultee";
    const cId = apt.consultation.consultationPlan?.consultantProfile?.userId;
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
    const cId = apt.subscription.subscriptionPlan?.consultantProfile?.userId;
    const eId = apt.subscription.requestedBy?.userId;
    consultantUserId = cId;
    if (cId) userIds.push(cId);
    if (eId) userIds.push(eId);
  } else if (apt.webinar) {
    appointmentType = "webinar";
    planTitle = apt.webinar.webinarPlan?.title ?? "Webinar";
    consultantName =
      apt.webinar.webinarPlan?.consultantProfile?.user?.name ?? "Consultant";
    for (const seat of apt.participants) {
      userIds.push(seat.userId);
    }
    const hostId = apt.webinar.webinarPlan?.consultantProfile?.userId;
    consultantUserId = hostId;
    if (hostId) userIds.push(hostId);
    collabIds =
      collaboratorsByPlan.get(`webinar:${apt.webinar.webinarPlanId}`) ?? [];
    userIds.push(...collabIds);
  } else if (apt.class) {
    appointmentType = "class";
    planTitle = apt.class.classPlan?.title ?? "Class";
    consultantName =
      apt.class.classPlan?.consultantProfile?.user?.name ?? "Consultant";
    for (const seat of apt.participants) {
      userIds.push(seat.userId);
    }
    const hostId = apt.class.classPlan?.consultantProfile?.userId;
    consultantUserId = hostId;
    if (hostId) userIds.push(hostId);
    collabIds = collaboratorsByPlan.get(`class:${apt.class.classPlanId}`) ?? [];
    userIds.push(...collabIds);
  } else if (apt.trial) {
    if (apt.trial.status !== "SCHEDULED") return null;
    appointmentType = "trial";
    planTitle = apt.trial.subscriptionPlan?.title ?? "Trial";
    consultantName =
      apt.trial.subscriptionPlan?.consultantProfile?.user?.name ?? "Consultant";
    consulteeName = apt.trial.consulteeProfile?.user?.name ?? "Consultee";
    const cId = apt.trial.subscriptionPlan?.consultantProfile?.userId;
    const eId = apt.trial.consulteeProfile?.userId;
    consultantUserId = cId;
    if (cId) userIds.push(cId);
    if (eId) userIds.push(eId);
  }

  const uniqueUserIds = Array.from(new Set(userIds));
  if (uniqueUserIds.length === 0) return null;

  return {
    slotId: slot.id,
    startsAt: slot.startsAt,
    appointmentId: apt.id,
    organizationId: apt.organizationId,
    isMultiSession: Boolean(apt.class || apt.subscription),
    appointmentType,
    planTitle,
    consultantName,
    consulteeName,
    consultantUserId,
    collabIds,
    uniqueUserIds,
  };
}

// Batch-loads staged reminder refs, participant user profiles/timezones/preferences, and email suppressions upfront.
async function preloadWindowContext(
  upcomingOccurrences: UpcomingOccurrence[],
  preparedSlots: PreparedSlotReminder[],
  windowLabel: ReminderWindowLabel,
  legacyReminderEntityRef: (
    appointmentId: string,
    label: ReminderWindowLabel,
  ) => string,
): Promise<PreloadedWindowContext> {
  const entityRefs = upcomingOccurrences.flatMap((slot) => {
    const refs = [appointmentReminderEntityRef(slot.id, windowLabel)];
    if (slot.appointment?.id) {
      refs.push(legacyReminderEntityRef(slot.appointment.id, windowLabel));
    }
    return refs;
  });

  const allUserIds = Array.from(
    new Set(preparedSlots.flatMap((item) => item.uniqueUserIds)),
  );

  const [stagedRows, preloadedUsers] = await Promise.all([
    prisma.failedEmail.findMany({
      where: {
        emailType: APPOINTMENT_REMINDER_EMAIL_TYPE,
        entityRef: { in: entityRefs },
      },
      select: { entityRef: true },
    }),
    "user" in prisma && allUserIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: allUserIds } },
          select: USER_BATCH_SELECT,
        })
      : Promise.resolve([]),
  ]);

  const alreadyStaged = new Set(
    stagedRows
      .map((row) => row.entityRef)
      .filter((ref): ref is string => ref !== null),
  );

  if (!("user" in prisma)) {
    return { alreadyStaged };
  }

  const usersById = new Map(preloadedUsers.map((u) => [u.id, u]));
  const cachedUserDelegate = new Proxy(prisma.user, {
    get(target, prop, receiver) {
      if (prop === "findMany") {
        return async (args?: {
          where?: { id?: { in?: string[] } | string };
        }) => {
          const idFilter = args?.where?.id;
          if (!idFilter) return Array.from(usersById.values());
          if (typeof idFilter === "string") {
            const match = usersById.get(idFilter);
            return match ? [match] : [];
          }
          if (idFilter.in) {
            return idFilter.in.flatMap((id) => {
              const match = usersById.get(id);
              return match ? [match] : [];
            });
          }
          return Array.from(usersById.values());
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const bellTx: TriggerOptions["tx"] = {
    user: cachedUserDelegate,
    membership: prisma.membership,
    notificationOutbox: prisma.notificationOutbox,
  };

  if (!("emailSuppression" in prisma)) {
    return { alreadyStaged, bellTx };
  }

  const normalizedEmails = Array.from(
    new Set(
      preloadedUsers
        .map((u) => u.email?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email)),
    ),
  );

  const suppressions =
    normalizedEmails.length > 0
      ? await prisma.emailSuppression.findMany({
          where: { email: { in: normalizedEmails } },
        })
      : [];
  const suppressionsByEmail = new Map(
    suppressions.map((row) => [row.email.trim().toLowerCase(), row]),
  );

  const cachedSuppressionDelegate = new Proxy(prisma.emailSuppression, {
    get(target, prop, receiver) {
      if (prop === "findUnique") {
        return async (args: { where: { email?: string } }) => {
          const lookup = args.where.email?.trim().toLowerCase();
          return lookup ? (suppressionsByEmail.get(lookup) ?? null) : null;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const emailTx: StagingTx = {
    user: cachedUserDelegate,
    emailSuppression: cachedSuppressionDelegate,
    failedEmail: prisma.failedEmail,
  };

  return { alreadyStaged, bellTx, emailTx };
}

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

  const upcomingOccurrences = await queryUpcomingOccurrences(
    windowStart,
    windowEnd,
    maxPerRun,
    await stagedReminderSlotIds(window, now),
  );

  console.log(
    `Found ${upcomingOccurrences.length} slots in ${window.label} reminder window`,
  );

  const capped = upcomingOccurrences.length >= maxPerRun;
  if (capped) warnIfWindowCapped(window.label, maxPerRun);

  const legacyReminderEntityRef = (
    appointmentId: string,
    windowLabel: ReminderWindowLabel,
  ) => `appointment:${appointmentId}:${windowLabel}`;

  const collaboratorsByPlan = await batchLoadCollaborators(upcomingOccurrences);
  const preparedSlots = upcomingOccurrences
    .map((slot) => prepareSlotReminder(slot, collaboratorsByPlan))
    .filter((item): item is PreparedSlotReminder => item !== null);

  const { alreadyStaged, bellTx, emailTx } = await preloadWindowContext(
    upcomingOccurrences,
    preparedSlots,
    window.label,
    legacyReminderEntityRef,
  );

  // The required job lease serializes email staging; staged rows suppress replay
  // after a completed or interrupted run, and the bell has its own unique outbox key.
  for (const item of preparedSlots) {
    if (
      alreadyStaged.has(reminderEntityRef(item.slotId, window.label)) ||
      (!item.isMultiSession &&
        alreadyStaged.has(
          legacyReminderEntityRef(item.appointmentId, window.label),
        ))
    ) {
      continue;
    }

    try {
      const formattedPlanTitle = planTitleOrSessionLabel(
        item.planTitle,
        item.appointmentType,
      );
      const dashboardUrl = notificationHref(
        item.organizationId,
        "appointments",
      );
      const bellPayload = {
        ...notificationScope(item.organizationId),
        appointmentType: item.appointmentType,
        consultantName: item.consultantName,
        consulteeName: item.consulteeName,
        planTitle: formattedPlanTitle,
        dateTime: item.startsAt.toISOString(),
        dashboardUrl,
      };

      if (bellTx) {
        const bellResults = await notifyAppointmentReminder(
          item.uniqueUserIds,
          bellPayload,
          `${item.slotId}:${window.label}`,
          { tx: bellTx },
        );
        const stagedRows = new Map(
          bellResults
            .map((result) => result.staged)
            .filter((row): row is NonNullable<typeof row> => Boolean(row))
            .map((row) => [row.id, row] as const),
        );
        await Promise.all(
          [...stagedRows.values()].map((row) => attemptTrigger(row)),
        );
      } else {
        await notifyAppointmentReminder(
          item.uniqueUserIds,
          bellPayload,
          `${item.slotId}:${window.label}`,
        );
      }

      const emailArgs = {
        appointmentId: item.appointmentId,
        occurrenceId: item.slotId,
        userIds: item.uniqueUserIds,
        collaboratorUserIds: item.collabIds,
        windowLabel: window.label,
        consultantUserId: item.consultantUserId,
        consultantName: item.consultantName,
        consulteeName: item.consulteeName,
        planTitle: formattedPlanTitle,
        appointmentType: item.appointmentType,
        startsAt: item.startsAt,
        dashboardUrl,
      };

      if (emailTx && reminderSpec) {
        const staged = await stageSpecGuarded(
          reminderSpec(emailArgs),
          item.uniqueUserIds,
          emailTx,
        );
        await attemptStaged(
          staged,
          APPOINTMENT_REMINDER_EMAIL_TYPE,
          EMAIL_BUDGET_MS.JOB,
        );
      } else {
        await sendAppointmentReminderEmail(emailArgs, EMAIL_BUDGET_MS.JOB);
      }

      sent++;
    } catch (error) {
      errors.push(
        `Failed to send ${window.label} reminder for appointment ${item.appointmentId}: ${error instanceof Error ? error.message : "Unknown error"}`,
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
        label === "24h"
          ? "the remainder drains on the next tick; the 24h window is 2 h wide"
          : `sessions past the cap may lose this window's ${label} reminder — the tick is 15 min, so there may be no further tick before it closes`,
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
  return withCronLock(
    "send-appointment-reminders",
    { failMode: "closed" },
    () => sendAppointmentRemindersUnlocked(maxPerWindow),
  );
}

/** One indexed read: is any live session inside a reminder window? */
export async function hasAppointmentReminderWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  const at = now.getTime();
  const offsetWindowWhere = (window: { minMs: number; maxMs: number }) =>
    reminderWindowWhere(
      new Date(at + window.minMs),
      new Date(at + window.maxMs),
    );
  if (outOfTime()) return true;
  const found = await db.appointmentOccurrence.findFirst({
    where: {
      OR: [
        offsetWindowWhere(REMINDER_24H),
        offsetWindowWhere(REMINDER_1H),
        offsetWindowWhere(REMINDER_15M),
      ],
    },
    select: { id: true },
  });
  return found !== null;
}

async function sendAppointmentRemindersUnlocked(
  maxPerWindow: number,
): Promise<ReminderResult> {
  console.log("🔔 Starting appointment reminders scan...");
  console.log(`   Per-window cap: ${maxPerWindow} slot(s)`);

  if (!(await hasAppointmentReminderWork(prisma, new Date(), () => false))) {
    return {
      success: true,
      reminders24h: 0,
      reminders1h: 0,
      reminders15m: 0,
      errors: [],
      timestamp: new Date().toISOString(),
    };
  }

  const [result24h, result1h, result15m] = await Promise.all([
    sendRemindersForWindow(REMINDER_24H, maxPerWindow),
    sendRemindersForWindow(REMINDER_1H, maxPerWindow),
    sendRemindersForWindow(REMINDER_15M, maxPerWindow),
  ]);

  const allErrors = [
    ...result24h.errors,
    ...result1h.errors,
    ...result15m.errors,
  ];
  // A capped run is not a failed run: the rows it did not reach are still in
  // the window and the next tick collects them. Reporting it as a failure
  // would page on a backlog that is draining.
  const capped = result24h.capped || result1h.capped || result15m.capped;

  const result: ReminderResult = {
    success: allErrors.length === 0,
    reminders24h: result24h.sent,
    reminders1h: result1h.sent,
    reminders15m: result15m.sent,
    errors: allErrors,
    timestamp: new Date().toISOString(),
  };

  console.log(
    `📊 Reminders sent: ${result.reminders24h} (24h) + ${result.reminders1h} (1h) + ${result.reminders15m} (15m)`,
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
