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
 * Registered in lib/cron/cleanup-registry.ts; the ticker runs it every 30 minutes.
 *
 * One consultation it deliberately does not complete: a paid session the
 * consultant never joined belongs to `detect-consultant-no-shows` (:57), which
 * cancels and refunds it. Both jobs classify presence through
 * `lib/booking/session-outcome.ts` so their candidate sets partition instead of
 * racing (#1504, #1569).
 */

import prisma from "../../lib/prisma";
import type { PrismaLike } from "../../lib/prisma";
import {
  WebinarStatus,
  ClassStatus,
  AppointmentStatus,
  OccurrenceCompletionStatus,
  TrialStatus,
  Prisma,
} from "@prisma/client";
import {
  stageAppointmentCompletedEmails,
  stageSubscriptionLifecycleEmail,
} from "@/lib/email/senders/booking";
import { stageTrialCompletedNotices } from "@/lib/booking/trial-completed-notice";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { notifyAppointmentCompleted } from "../../lib/novu/service";
import { notificationScope } from "../../lib/novu/workflows";
import { notificationHref } from "../../lib/novu/resolve-href";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  startDeadline,
  startDeadlineShare,
  SWEEP_START_DEADLINE_MS,
  type RunDeadline,
} from "@/lib/cron/run-deadline";
import {
  EVENT_ALLOWED_FROM,
  REQUEST_ALLOWED_FROM,
  transitionClassEvent,
  transitionConsultationRequest,
  transitionSubscriptionRequest,
  transitionTrial,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import {
  settleSubscriptionCycle,
  settleSubscriptionCycleWithNotice,
} from "@/lib/booking/subscription-cycle";
import {
  soldTermsOf,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";
import {
  alertStaleNeedsHuman,
  confirmClosedOutcomes,
  escalateAgedNeedsHuman,
  decideSlotOutcome,
  OUTCOME_SLOT_SELECT,
  readOutageWindows,
  staleNeedsHumanWhere,
  type OutcomeSlot,
  type SlotDecision,
} from "@/lib/booking/session-outcome-sweep";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import {
  AWAITING_HUMAN,
  UNSETTLED_MISS,
  unconfirmedClosedVerdictWhere,
} from "@/lib/booking/misses";
import { sessionHostUserIds } from "@/lib/booking/session-hosts";
import { recomputeMenteesHelped } from "@/lib/profiles/mentees-helped";
import { stampTrialEarningsHold } from "@/lib/trials/earnings-hold";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  SWEEP_LOCK_RETRY_CONFIG,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import {
  ACCOUNTED_SESSION,
  ClassNotFinishedError,
  classIsFinished,
  classMayBeFinished,
} from "@/lib/booking/class-completion";
import {
  stampClassEndRefundsOwed,
  type ClassEndSettlement,
} from "@/lib/payments/operations/event-refunds";

// Only complete appointments that ended at least 1 hour ago
// This gives buffer time for any post-session activities
const COMPLETION_BUFFER_HOURS = 1;
// Sessions judged per bite when the caller passes no bite; each may ask Stream
// for its call report.
const MAX_SLOT_OUTCOMES_PER_BITE = 500;

// Parents per bite when the caller passes no bite. Each pass reads oldest
// `updatedAt` first and its CAS moves the row out of the cohort (COMPLETED is
// terminal), so the next bite or the next run continues where this one stopped.
const MAX_PARENTS_PER_BITE = 25;

// #1583 B-P1-16 — "every session has ended" counts live confirmed rows only:
// a stale tentative hold or a tombstoned row must not veto completion.
function allLiveOccurrencesEnded(
  bufferTime: Date,
): Prisma.AppointmentOccurrenceListRelationFilter {
  const live = { isTentative: false, deletedAt: null };
  return {
    some: { ...live, endsAt: { lt: bufferTime } },
    none: { ...live, endsAt: { gte: bufferTime } },
  };
}

// #1569 — a wrapper owing a make-up or refund, or holding a session the slot
// pass has not decided, is not finished: completion would release its earnings.
function endedAndSettled(
  bufferTime: Date,
): Prisma.AppointmentWhereInput["AND"] {
  return [
    { occurrences: allLiveOccurrencesEnded(bufferTime) },
    { occurrences: { none: UNSETTLED_MISS } },
    { occurrences: { none: AWAITING_HUMAN } },
    {
      occurrences: {
        none: {
          completionStatus: OccurrenceCompletionStatus.SCHEDULED,
          isTentative: false,
          deletedAt: null,
        },
      },
    },
  ];
}

const AUTO_COMPLETE_REASON = "auto-complete";

// Every final CAS repeats it: a session parked after the cohort read keeps the booking open.
const NO_PARKED_SESSION = {
  appointment: { occurrences: { none: AWAITING_HUMAN } },
};

// The pass cohorts, shared by each pass's read and the ticker's idle probe.
type SettledAnd = Prisma.AppointmentWhereInput["AND"];

function completableWebinarWhere(settled: SettledAnd) {
  return {
    status: WebinarStatus.SCHEDULED,
    appointment: { AND: settled },
  } satisfies Prisma.WebinarWhereInput;
}

// Every placed session has ended. A class between batches matches too: the
// pass skips it on the row it read (classMayBeFinished), and the completing
// transaction decides the rest (classIsFinished).
function completableClassWhere(settled: SettledAnd) {
  return {
    status: ClassStatus.SCHEDULED,
    // One wrapper: at least one occurrence, and every live one ended.
    appointment: { AND: settled },
  } satisfies Prisma.ClassWhereInput;
}

function completableConsultationWhere(bufferTime: Date) {
  return {
    status: AppointmentStatus.APPROVED,
    // A voided consultation is owed its make-up or refund first.
    appointment: {
      AND: [
        { occurrences: allLiveOccurrencesEnded(bufferTime) },
        { occurrences: { none: UNSETTLED_MISS } },
        { occurrences: { none: AWAITING_HUMAN } },
      ],
    },
  } satisfies Prisma.ConsultationWhereInput;
}

/** Every live session ended and decided, and no void left unsettled: otherwise plan-end settlement owns completion. */
function completableSubscriptionWhere(settled: SettledAnd) {
  return {
    status: AppointmentStatus.APPROVED,
    appointment: { AND: settled },
  } satisfies Prisma.SubscriptionWhereInput;
}

function completableTrialWhere(bufferTime: Date) {
  return {
    status: TrialStatus.SCHEDULED,
    // A free trial's void is a record only, so the unsettled-miss
    // check (which a void never leaves on a trial) is not applied here.
    appointment: {
      AND: [
        { occurrences: allLiveOccurrencesEnded(bufferTime) },
        { occurrences: { none: AWAITING_HUMAN } },
        {
          occurrences: {
            none: {
              completionStatus: OccurrenceCompletionStatus.SCHEDULED,
              isTentative: false,
              deletedAt: null,
            },
          },
        },
      ],
    },
    // A paid trial that was voided waits for ops, or for its free rebook to settle the void.
    OR: [
      { paymentId: null },
      {
        appointment: {
          occurrences: {
            none: {
              completionStatus: OccurrenceCompletionStatus.VOIDED,
              seatsSettledAt: null,
            },
          },
        },
      },
    ],
  } satisfies Prisma.TrialWhereInput;
}

function undecidedSlotWhere(bufferTime: Date) {
  return {
    endsAt: { lt: bufferTime },
    isTentative: false,
    deletedAt: null,
    completionStatus: OccurrenceCompletionStatus.SCHEDULED,
  } satisfies Prisma.AppointmentOccurrenceWhereInput;
}

/** Every pass, the window-close pass and the needs-human alert; parents are probed as they stand, before any slot is decided. */
export async function hasAutoCompleteWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  const bufferTime = new Date(
    now.getTime() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );
  const settled = endedAndSettled(bufferTime);
  if (outOfTime()) return true;
  const slot = await db.appointmentOccurrence.findFirst({
    where: {
      OR: [
        undecidedSlotWhere(bufferTime),
        staleNeedsHumanWhere(now),
        unconfirmedClosedVerdictWhere(now),
      ],
    },
    select: { id: true },
  });
  if (slot) return true;
  if (outOfTime()) return true;
  const webinar = await db.webinar.findFirst({
    where: completableWebinarWhere(settled),
    select: { id: true },
  });
  if (webinar) return true;
  if (outOfTime()) return true;
  const cohort = await db.class.findFirst({
    where: completableClassWhere(settled),
    select: { id: true },
  });
  if (cohort) return true;
  if (outOfTime()) return true;
  const consultation = await db.consultation.findFirst({
    where: completableConsultationWhere(bufferTime),
    select: { id: true },
  });
  if (consultation) return true;
  if (outOfTime()) return true;
  const subscription = await db.subscription.findFirst({
    where: completableSubscriptionWhere(settled),
    select: { id: true },
  });
  if (subscription) return true;
  if (outOfTime()) return true;
  const trial = await db.trial.findFirst({
    where: completableTrialWhere(bufferTime),
    select: { id: true },
  });
  return trial !== null;
}

/** One bite of a pass; `read` holds every id the bite's cohort read returned. */
interface PassBite {
  completed: number;
  errors: string[];
  read: string[];
  /** What the class pass's completing commits stamped. */
  classEnd?: ClassEndSettlement;
}

/** Excludes rows an earlier bite of this run read but left in the cohort. */
function unseen(seen: string[]): { id?: { notIn: string[] } } {
  return seen.length > 0 ? { id: { notIn: seen } } : {};
}

export interface AutoCompleteResult {
  success: boolean;
  webinarsCompleted: number;
  classesCompleted: number;
  consultationsCompleted: number;
  subscriptionsCompleted: number;
  trialsCompleted: number;
  sessionsCompleted: number;
  sessionsVoided: number;
  sessionsUnverified: number;
  classEndSeatsOwed: number;
  classEndOwedPaise: number;
  classEndCreditSeatsEscalated: number;
  errors: string[];
  timestamp: string;
  /** The window-close pass's resume cursor, kept by the run trail; absent when the pass was skipped. */
  checkpoint?: string | null;
}

/** A pass's completion helper, its lock calls bounded by the pass's start deadline. */
function lockedCompletion(deadline: RunDeadline) {
  return (appointmentId: string | undefined, run: () => Promise<unknown>) =>
    completeUnderLock(appointmentId, deadline, run);
}

/**
 * One guarded completion under the appointment lock the lifecycle doors and the
 * ops outcome door hold, so a park through them either committed before the CAS
 * reads or waits for it. False when the CAS matched nothing, or the lock was busy,
 * stalled or unreachable: the booking waits for the next run.
 */
async function completeUnderLock(
  appointmentId: string | undefined,
  deadline: RunDeadline,
  run: () => Promise<unknown>,
): Promise<boolean> {
  // The cohort requires the wrapper; a row without one is left alone.
  if (!appointmentId) return false;
  // Each Redis call gets the smaller of its own bound and the run's time left; a stall skips the booking.
  const left = (deadline.until ?? Infinity) - Date.now();
  const callTimeoutMs = Math.min(SWEEP_LOCK_RETRY_CONFIG.callTimeoutMs, left);
  if (callTimeoutMs <= 0) return false;
  try {
    await withAppointmentLock(appointmentId, run, {
      ...SWEEP_LOCK_RETRY_CONFIG,
      callTimeoutMs,
      deadlineAt: deadline.until,
    });
    return true;
  } catch (error) {
    if (
      error instanceof IllegalTransitionError ||
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Auto-complete webinars that have ended
 */
async function completeWebinars(
  maxParents: number,
  seen: string[],
  pastDeadline: () => boolean,
): Promise<PassBite> {
  const errors: string[] = [];
  const completeThroughHelper = lockedCompletion(pastDeadline);
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED webinars where all slots have ended
  const webinarsToComplete = await prisma.webinar.findMany({
    orderBy: { updatedAt: "asc" },
    take: maxParents,
    where: {
      ...unseen(seen),
      ...completableWebinarWhere(endedAndSettled(bufferTime)),
    },
    include: {
      webinarPlan: { select: { title: true } },
      appointment: {
        include: {
          occurrences: {
            orderBy: { endsAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  console.log(`Found ${webinarsToComplete.length} webinars to auto-complete`);

  for (const webinar of webinarsToComplete) {
    if (pastDeadline()) break;
    try {
      const lastSlot = webinar.appointment?.occurrences[0];
      console.log(`\nCompleting webinar ${webinar.id}`);
      console.log(`   Title: ${webinar.webinarPlan.title}`);
      console.log(`   Previous status: ${webinar.status}`);
      console.log(
        `   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`,
      );

      // CAS (#1319): a webinar cancelled since the cohort read must not be
      // resurrected as COMPLETED — that would release earnings for nothing.
      // #1583 A-P1-03 — through the helper, so the history row rides along.
      const moved = await completeThroughHelper(webinar.appointment?.id, () =>
        prisma.$transaction((tx) =>
          transitionWebinarEvent(tx, {
            where: { id: webinar.id },
            whereAnd: NO_PARKED_SESSION,
            to: WebinarStatus.COMPLETED,
            fromIn: EVENT_ALLOWED_FROM.COMPLETED,
            reason: AUTO_COMPLETE_REASON,
          }),
        ),
      );
      if (!moved) {
        console.log(`   ⏭️ Skipped — status changed since the sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete webinar ${webinar.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors, read: webinarsToComplete.map((row) => row.id) };
}

/**
 * One class per commit: its completion and every seat's class-end marker land
 * together, from a fixed number of ledger reads; retry-auto-refunds drives them.
 */
const CLASS_END_TX_TIMEOUT_MS = 6_000;

/** Adds one class's settlement into the run's running total. */
function addSettlement(
  total: ClassEndSettlement,
  settlement: ClassEndSettlement,
): void {
  total.owed += settlement.owed;
  total.owedPaise += settlement.owedPaise;
  total.escalated += settlement.escalated;
}

/**
 * Auto-complete classes that have ended (all sessions done)
 */
async function completeClasses(
  maxParents: number,
  seen: string[],
  pastDeadline: () => boolean,
): Promise<PassBite> {
  const errors: string[] = [];
  const completeThroughHelper = lockedCompletion(pastDeadline);
  let completed = 0;
  const classEnd: ClassEndSettlement = { owed: 0, owedPaise: 0, escalated: 0 };

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED classes where all slots have ended
  const classesToComplete = await prisma.class.findMany({
    // A class whose period has ended is always finished, so those are read
    // first and classes still between batches cannot hold them back.
    orderBy: [
      { schedulingPeriodEndsAt: { sort: "asc", nulls: "first" } },
      { updatedAt: "asc" },
    ],
    take: maxParents,
    where: {
      ...unseen(seen),
      ...completableClassWhere(endedAndSettled(bufferTime)),
    },
    include: {
      classPlan: { select: { title: true, totalSessions: true } },
      appointment: {
        include: {
          occurrences: {
            orderBy: { endsAt: "desc" },
            take: 1,
          },
          _count: { select: { occurrences: { where: ACCOUNTED_SESSION } } },
        },
      },
    },
  });

  console.log(`Found ${classesToComplete.length} classes whose sessions ended`);

  for (const cls of classesToComplete) {
    if (pastDeadline()) break;
    // A class between batches costs this pass nothing beyond the row above.
    if (
      !classMayBeFinished(
        {
          schedulingPeriodEndsAt: cls.schedulingPeriodEndsAt,
          totalSessions: cls.classPlan.totalSessions,
          accountedRows: cls.appointment?._count.occurrences ?? 0,
        },
        new Date(),
      )
    ) {
      continue;
    }
    try {
      // The latest occurrence end on the wrapper
      const latestEnd: Date | null =
        cls.appointment?.occurrences[0]?.endsAt ?? null;

      // CAS first, so it holds the class row while the checks below read: a
      // session placed since the cohort read is either seen here or refused by
      // the CAS it meets. The completing commit also stamps each seat's refund
      // for sessions sold but never placed.
      let notFinished = false;
      const wrapperId = cls.appointment?.id;
      const moved = await completeThroughHelper(wrapperId, async () => {
        try {
          const settlement = await prisma.$transaction(
            async (tx) => {
              await transitionClassEvent(tx, {
                where: { id: cls.id },
                whereAnd: NO_PARKED_SESSION,
                to: ClassStatus.COMPLETED,
                fromIn: EVENT_ALLOWED_FROM.COMPLETED,
                reason: AUTO_COMPLETE_REASON,
              });
              const stillEnded = await tx.appointment.findFirst({
                where: { classId: cls.id, AND: endedAndSettled(bufferTime) },
                select: { id: true },
              });
              if (
                !stillEnded ||
                !(await classIsFinished(tx, cls.id, new Date()))
              ) {
                throw new ClassNotFinishedError(cls.id);
              }
              return stampClassEndRefundsOwed(tx, cls.id);
            },
            { timeout: CLASS_END_TX_TIMEOUT_MS },
          );
          addSettlement(classEnd, settlement);
        } catch (error) {
          if (!(error instanceof ClassNotFinishedError)) throw error;
          notFinished = true;
        }
      });
      if (notFinished) continue;
      if (!moved) {
        console.log(
          `\n⏭️ Class ${cls.id} skipped: status changed since the sweep read`,
        );
        continue;
      }

      console.log(`\nCompleting class ${cls.id}`);
      console.log(`   Title: ${cls.classPlan.title}`);
      console.log(`   Previous status: ${cls.status}`);
      console.log(
        `   Last slot ended: ${latestEnd?.toISOString() || "Unknown"}`,
      );

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;
    } catch (error) {
      const msg = `Failed to complete class ${cls.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return {
    completed,
    errors,
    read: classesToComplete.map((row) => row.id),
    classEnd,
  };
}

/**
 * Auto-complete consultations that have ended
 */
async function completeConsultations(
  maxParents: number,
  seen: string[],
  pastDeadline: () => boolean,
): Promise<PassBite> {
  const errors: string[] = [];
  const completeThroughHelper = lockedCompletion(pastDeadline);
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find APPROVED consultations where all slots have ended
  const consultationsToComplete = await prisma.consultation.findMany({
    orderBy: { updatedAt: "asc" },
    take: maxParents,
    where: {
      ...unseen(seen),
      ...completableConsultationWhere(bufferTime),
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
          // Every session, newest first: `[0]` is the last one for logging,
          // and the deferral below reads each one's completion.
          occurrences: {
            orderBy: { endsAt: "desc" },
          },
        },
      },
    },
  });

  console.log(
    `Found ${consultationsToComplete.length} consultations to auto-complete`,
  );

  for (const consultation of consultationsToComplete) {
    if (pastDeadline()) break;
    try {
      const lastSlot = consultation.appointment?.occurrences[0];
      const consultantUserId =
        consultation.consultationPlan?.consultantProfile?.userId;
      const consulteeUserId = consultation.requestedBy?.userId;
      console.log(`\nCompleting consultation ${consultation.id}`);
      console.log(`   Title: ${consultation.consultationPlan.title}`);
      console.log(`   Previous status: ${consultation.status}`);
      console.log(
        `   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`,
      );

      // #1569 — the slot pass decides each session first and leaves a
      // consultation host no-show SCHEDULED for detect-consultant-no-shows
      // until the handoff (#1504), so an undecided session holds the parent.
      if (
        consultation.appointment?.occurrences.some(
          (o) =>
            o.completionStatus === OccurrenceCompletionStatus.SCHEDULED &&
            !o.isTentative &&
            !o.deletedAt,
        )
      ) {
        console.log(
          `   ⏭️ Deferred — a session is not decided yet (live, or the no-show detector owns it)`,
        );
        continue;
      }

      // #836 — guard rides the WHERE: a cancel landing between the sweep's
      // read and this write must not be overwritten by COMPLETED.
      const moved = await completeThroughHelper(
        consultation.appointment?.id,
        () =>
          prisma.$transaction((tx) =>
            transitionConsultationRequest(tx, {
              where: { id: consultation.id, ...NO_PARKED_SESSION },
              to: AppointmentStatus.COMPLETED,
              fromIn: REQUEST_ALLOWED_FROM.COMPLETED,
              reason: AUTO_COMPLETE_REASON,
            }),
          ),
      );
      if (!moved) {
        console.log(`   ⏭️ Skipped — status changed since sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;

      const userIds = [consultantUserId, consulteeUserId].filter(
        (id): id is string => !!id,
      );
      if (userIds.length > 0) {
        const dashboardUrl = notificationHref(
          consultation.appointment?.organizationId,
          "appointments",
        );
        const [bellResults, emailRows] = await Promise.all([
          notifyAppointmentCompleted(
            userIds,
            {
              ...notificationScope(consultation.appointment?.organizationId),
              appointmentType: "consultation",
              consultantName:
                consultation.consultationPlan?.consultantProfile?.user?.name ??
                "Consultant",
              consulteeName:
                consultation.requestedBy?.user?.name ?? "Consultee",
              planTitle: consultation.consultationPlan.title,
              dashboardUrl,
            },
            { deferAttempt: true },
          ).catch((error) => {
            console.error(
              `[auto-complete] Failed to send consultation completion notification:`,
              error,
            );
            return [];
          }),
          stageAppointmentCompletedEmails(prisma, {
            appointmentId: consultation.appointment?.id ?? consultation.id,
            userIds,
            planTitle: consultation.consultationPlan.title,
            appointmentType: "Consultation",
            dashboardUrl,
          }).catch((error) => {
            console.error(
              `[auto-complete] Failed to stage consultation completion email:`,
              error,
            );
            return [];
          }),
        ]);
        await flushNotificationsAfter(
          {
            bells: (bellResults ?? []).map((r) => r?.staged),
            emails: [{ rows: emailRows, emailType: "CLASS_SESSION_COMPLETED" }],
          },
          "auto-complete.consultation",
        );
      }
    } catch (error) {
      const msg = `Failed to complete consultation ${consultation.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return {
    completed,
    errors,
    read: consultationsToComplete.map((row) => row.id),
  };
}

/**
 * Auto-complete subscriptions that have ended (all sessions done)
 */
async function completeSubscriptions(
  maxParents: number,
  seen: string[],
  pastDeadline: () => boolean,
): Promise<PassBite> {
  const errors: string[] = [];
  const completeThroughHelper = lockedCompletion(pastDeadline);
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find APPROVED or SCHEDULED subscriptions where all slots have ended
  const subscriptionsToComplete = await prisma.subscription.findMany({
    orderBy: { updatedAt: "asc" },
    take: maxParents,
    where: {
      ...unseen(seen),
      ...completableSubscriptionWhere(endedAndSettled(bufferTime)),
    },
    include: {
      subscriptionPlan: {
        select: {
          title: true,
          totalSessions: true,
          sessionsPerWeek: true,
          durationInMonths: true,
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
          occurrences: {
            orderBy: { endsAt: "desc" },
            select: {
              startsAt: true,
              endsAt: true,
              completionStatus: true,
              isTentative: true,
              deletedAt: true,
            },
          },
        },
      },
    },
  });

  console.log(
    `Found ${subscriptionsToComplete.length} subscriptions to auto-complete`,
  );

  for (const subscription of subscriptionsToComplete) {
    if (pastDeadline()) break;
    try {
      // #1766 — COMPLETED is terminal: a plan whose live cycle ended but whose
      // entitlement is not spent is waiting for its next cycle, not finished.
      const entitlement = subscriptionEntitlement({
        ...soldTermsOf(subscription),
        occurrences: subscription.appointment?.occurrences ?? [],
        schedulingPeriodStartsAt: subscription.schedulingPeriodStartsAt,
        schedulingTimezone: subscription.schedulingTimezone,
        planEndsAt: subscription.planEndsAt,
      });
      if (entitlement.remaining > 0) {
        console.log(
          `   ⏭️ Subscription ${subscription.id} has ${entitlement.remaining} session(s) left — next cycle pending`,
        );
        continue;
      }

      // The latest occurrence end on the wrapper
      const latestEnd: Date | null =
        subscription.appointment?.occurrences[0]?.endsAt ?? null;

      console.log(`\nCompleting subscription ${subscription.id}`);
      console.log(`   Title: ${subscription.subscriptionPlan.title}`);
      console.log(`   Previous status: ${subscription.status}`);
      console.log(
        `   Last slot ended: ${latestEnd?.toISOString() || "Unknown"}`,
      );

      // #836 — guard rides the WHERE: a cancel landing between the sweep's
      // read and this write must not be overwritten by COMPLETED. The tranche
      // holds are stamped first in the same commit: a session-count refund
      // can end the entitlement with no delivery left to stamp them.
      const appointmentId = subscription.appointment?.id;
      const moved = await completeThroughHelper(appointmentId, () =>
        prisma.$transaction(async (tx) => {
          if (appointmentId)
            await settleSubscriptionCycle(tx, {
              appointmentId,
              now: new Date(),
            });
          return transitionSubscriptionRequest(tx, {
            where: { id: subscription.id, ...NO_PARKED_SESSION },
            to: AppointmentStatus.COMPLETED,
            reason: AUTO_COMPLETE_REASON,
          });
        }),
      );
      if (!moved) {
        console.log(`   ⏭️ Skipped — status changed since sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;

      const consultantUserId =
        subscription.subscriptionPlan?.consultantProfile?.userId;
      const consulteeUserId = subscription.requestedBy?.userId;
      const userIds = [consultantUserId, consulteeUserId].filter(
        (id): id is string => !!id,
      );
      if (userIds.length > 0) {
        const dashboardUrl = notificationHref(
          subscription.appointment?.organizationId,
          "appointments",
        );
        const [bellResults, emailRows] = await Promise.all([
          notifyAppointmentCompleted(
            userIds,
            {
              ...notificationScope(subscription.appointment?.organizationId),
              appointmentType: "subscription",
              consultantName:
                subscription.subscriptionPlan?.consultantProfile?.user?.name ??
                "Consultant",
              consulteeName:
                subscription.requestedBy?.user?.name ?? "Consultee",
              planTitle: subscription.subscriptionPlan.title,
              dashboardUrl,
            },
            { deferAttempt: true },
          ).catch((error) => {
            console.error(
              `[auto-complete] Failed to send subscription completion notification:`,
              error,
            );
            return [];
          }),
          stageAppointmentCompletedEmails(prisma, {
            appointmentId: subscription.appointment?.id ?? subscription.id,
            userIds,
            planTitle: subscription.subscriptionPlan.title,
            appointmentType: "Subscription",
            dashboardUrl,
          }).catch((error) => {
            console.error(
              `[auto-complete] Failed to stage subscription completion email:`,
              error,
            );
            return [];
          }),
        ]);
        await flushNotificationsAfter(
          {
            bells: (bellResults ?? []).map((r) => r?.staged),
            emails: [{ rows: emailRows, emailType: "CLASS_SESSION_COMPLETED" }],
          },
          "auto-complete.subscription",
        );
      }
    } catch (error) {
      const msg = `Failed to complete subscription ${subscription.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return {
    completed,
    errors,
    read: subscriptionsToComplete.map((row) => row.id),
  };
}

/**
 * Auto-complete trial sessions that have ended
 */
async function completeTrials(
  maxParents: number,
  seen: string[],
  pastDeadline: () => boolean,
): Promise<PassBite> {
  const errors: string[] = [];
  const completeThroughHelper = lockedCompletion(pastDeadline);
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED trials where the appointment slot has ended
  const trialsToComplete = await prisma.trial.findMany({
    orderBy: { updatedAt: "asc" },
    take: maxParents,
    where: {
      ...unseen(seen),
      ...completableTrialWhere(bufferTime),
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
      consulteeProfile: {
        include: {
          user: {
            select: { id: true, name: true },
          },
        },
      },
      appointment: {
        include: {
          occurrences: {
            orderBy: { endsAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  console.log(`Found ${trialsToComplete.length} trials to auto-complete`);

  for (const trial of trialsToComplete) {
    if (pastDeadline()) break;
    try {
      const lastSlot = trial.appointment?.occurrences[0];
      console.log(`\nCompleting trial ${trial.id}`);
      console.log(`   Plan: ${trial.subscriptionPlan.title}`);
      console.log(`   Consultee: ${trial.consulteeProfile.user.name}`);
      console.log(`   Previous status: ${trial.status}`);
      console.log(
        `   Last slot ended: ${lastSlot?.endsAt?.toISOString() || "Unknown"}`,
      );

      // CAS (#1319): a trial cancelled or converted since the read stays put.
      const completedAt = new Date();
      const moved = await completeThroughHelper(trial.appointment?.id, () =>
        prisma.$transaction(async (tx) => {
          await transitionTrial(tx, {
            where: { id: trial.id },
            whereAnd: NO_PARKED_SESSION,
            to: TrialStatus.COMPLETED,
            data: { completedAt },
          });
          // #1775 C-9 — delivery starts the paid trial's earnings hold.
          await stampTrialEarningsHold(tx, trial.paymentId, completedAt);
        }),
      );
      if (!moved) {
        console.log(`   ⏭️ Skipped — status changed since the sweep read`);
        continue;
      }

      console.log(`   ✅ Marked as COMPLETED`);
      completed++;

      const consultantUserId =
        trial.subscriptionPlan?.consultantProfile?.userId;
      const consulteeUserId = trial.consulteeProfile?.user?.id;
      if (consultantUserId || consulteeUserId) {
        const staged = await stageTrialCompletedNotices({
          trialId: trial.id,
          consultantUserId,
          consulteeUserId,
          consultantName:
            trial.subscriptionPlan?.consultantProfile?.user?.name ??
            "Consultant",
          consulteeName: trial.consulteeProfile?.user?.name ?? "Consultee",
          planTitle: trial.subscriptionPlan.title,
          subscriptionPlanId: trial.subscriptionPlanId,
          startsAt: lastSlot?.startsAt ?? null,
          dashboardUrl: notificationHref(
            trial.appointment?.organizationId,
            "appointments",
          ),
        });
        await flushNotificationsAfter(
          {
            bells: staged.bells,
            emails: [{ list: staged.emails, emailType: "TRIAL_COMPLETED" }],
          },
          "auto-complete.trial",
        );
      }
    } catch (error) {
      const msg = `Failed to complete trial ${trial.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { completed, errors, read: trialsToComplete.map((row) => row.id) };
}

type SlotTally = {
  completed: number;
  unverified: number;
  voided: number;
  deferred: number;
};

/** Counts one decision; true when it moved the row. */
function tallyDecision(tally: SlotTally, decision: SlotDecision): boolean {
  if (decision.kind === "deferred") {
    tally.deferred++;
    return false;
  }
  if (!decision.moved) return false;
  if (decision.to === OccurrenceCompletionStatus.COMPLETED) tally.completed++;
  else if (decision.to === OccurrenceCompletionStatus.VOIDED) tally.voided++;
  else tally.unverified++;
  return true;
}

/**
 * Recompute `ConsultantProfile.totalMenteesHelped` for every consultant whose
 * session this pass actually decided.
 *
 * The stat is a stored column (see lib/profiles/mentees-helped.ts for the
 * definition and why a column rather than a read-time count), and this is the
 * only place a session stops being a booking and becomes a delivered one — so it
 * is the only place the column can move. Hooked to the SLOT pass rather than the
 * five parent passes because the slot pass is the one that walks every event
 * type uniformly; a host-side user id comes straight off `OUTCOME_SLOT_SELECT`.
 *
 * Any DECIDED row counts, not just COMPLETED: the read predicate admits a
 * voided-but-attended session as delivered, and a stat whose writer and reader
 * disagree is worse than a stat that lags by an hour.
 *
 * Best-effort and never fatal. A failure here must not take down a pass that has
 * already moved real statuses; the column is idempotent, so the next pass for
 * that consultant repairs it.
 *
 * Cost: one indexed `userId IN (…)` read plus five small indexed aggregates per
 * consultant, and it is skipped entirely when the pass decided nothing — which
 * is the steady state once the backlog is drained, and the case the 20 s Netlify
 * tick budget is most sensitive to. It runs AFTER the outcome loop, so the work
 * that does decide rows is never behind it. No per-run cap: a cap that deferred
 * a consultant would leave their column permanently stale once their sessions
 * stopped, which is worse than the queries it saved.
 */
async function settleMenteesHelped(
  hostUserIds: Set<string>,
  failures: RunFailureReporter,
): Promise<void> {
  if (hostUserIds.size === 0) return;
  const profiles = await prisma.consultantProfile.findMany({
    where: { userId: { in: [...hostUserIds] } },
    select: { id: true },
  });
  for (const profile of profiles) {
    try {
      await recomputeMenteesHelped(prisma, profile.id);
    } catch (error) {
      failures.add(
        "auto-complete-appointments.mentees-helped",
        error,
        { consultantProfileId: profile.id },
        { level: "warning" },
      );
    }
  }
}

/**
 * #1766 — per distinct subscription wrapper, in a fresh transaction: the
 * consultee's cycle bell, deduped on the cycle so a re-run is quiet.
 */
async function settleCycleBells(wrappers: Set<string>): Promise<void> {
  for (const appointmentId of wrappers) {
    const settled = await prisma.$transaction((tx) =>
      settleSubscriptionCycleWithNotice(tx, { appointmentId, now: new Date() }),
    );
    const emailRows = settled?.emailArgs
      ? await stageSubscriptionLifecycleEmail(prisma, settled.emailArgs).catch(
          (err) => {
            console.error(
              "[auto-complete-appointments] subscription cycle email stage failed:",
              err,
            );
            return [];
          },
        )
      : [];
    await flushNotificationsAfter(
      {
        bells: settled?.bells ?? [],
        emails: emailRows.length
          ? [{ rows: emailRows, emailType: "SUBSCRIPTION_RENEWED" }]
          : [],
      },
      "subscription-cycle.renewed",
    );
  }
}

/** Decides one session and records what the bite's tail must settle. */
async function decideOneSlot(
  slot: OutcomeSlot,
  ctx: Omit<
    Parameters<typeof decideSlotOutcome>[1],
    "onUnreadable" | "failures" | "settleDeadlineAt"
  >,
  run: SlotRun,
  settle: { wrappers: Set<string>; decidedHosts: Set<string> },
): Promise<void> {
  const decision = await decideSlotOutcome(slot, {
    ...ctx,
    onUnreadable: (id) => run.unreadable.push(id),
    failures: run.streamFailures,
    settleDeadlineAt: run.settleDeadlineAt,
  });
  if (tallyDecision(run.tally, decision) && slot.appointment.subscriptionId) {
    settle.wrappers.add(slot.appointmentId);
  }
  if (decision.kind === "written" && decision.moved) {
    for (const id of sessionHostUserIds(slot.appointment)) {
      settle.decidedHosts.add(id);
    }
  }
}

/** What the slot pass carries across its bites; reported once per run. */
interface SlotRun {
  tally: SlotTally;
  /** Sessions parked this run because Stream's record could not be read in time. */
  unreadable: string[];
  /** Stream read failures across every bite, reported once. */
  streamFailures: RunFailureReporter;
  /** Every session's Stream reads must answer by the end of the run's start budget. */
  settleDeadlineAt: number;
  menteeFailures: RunFailureReporter;
}

/**
 * #1569 D2 — the one writer of each past session's outcome. Runs BEFORE the
 * parent passes so they read decided rows: presence is classified by
 * `classifySessionOutcome` and written as COMPLETED, VOIDED or UNVERIFIED in
 * one CAS per row (`decideSlotOutcome`). A live overrun and a consultation host
 * no-show still inside the detector's handoff are left SCHEDULED.
 */
async function completeIndividualSlots(
  maxOutcomes: number,
  seen: string[],
  pastDeadline: () => boolean,
  run: SlotRun,
): Promise<{ errors: string[]; read: string[] }> {
  const errors: string[] = [];
  const now = new Date();
  const bufferTime = new Date(
    now.getTime() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  try {
    // Doctrine rule 1: a tentative hold is an unpaid reservation and a
    // tombstoned row was already released; neither is a session to judge.
    const cohort = await prisma.appointmentOccurrence.findMany({
      where: {
        ...unseen(seen),
        ...undecidedSlotWhere(bufferTime),
      },
      select: OUTCOME_SLOT_SELECT,
      orderBy: { endsAt: "asc" },
      take: maxOutcomes,
    });
    const read = cohort.map((slot) => slot.id);
    // An idle bite skips the outage read; the parent passes still run.
    if (cohort.length === 0) return { errors, read };
    // The cohort is ordered by end, so the earliest start is not cohort[0]'s.
    const earliestStart = new Date(
      Math.min(
        bufferTime.getTime(),
        ...cohort.map((slot) => slot.startsAt.getTime()),
      ),
    );
    const outages = await readOutageWindows(prisma, earliestStart);
    const wrappers = new Set<string>();
    const decidedHosts = new Set<string>();
    for (const slot of cohort) {
      if (pastDeadline()) break;
      try {
        await decideOneSlot(slot, { now, outages }, run, {
          wrappers,
          decidedHosts,
        });
      } catch (error) {
        errors.push(
          `Failed to decide session ${slot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await settleCycleBells(wrappers);
    await settleMenteesHelped(decidedHosts, run.menteeFailures);
    return { errors, read };
  } catch (error) {
    const message = `Failed to decide session outcomes: ${error instanceof Error ? error.message : "Unknown error"}`;
    console.error(`   ❌ ${message}`);
    errors.push(message);
    return { errors, read: [] };
  }
}

/** The parent passes, in the order a round runs them after the slot pass. */
const PARENT_PASSES = [
  { key: "webinars", run: completeWebinars },
  { key: "classes", run: completeClasses },
  { key: "consultations", run: completeConsultations },
  { key: "subscriptions", run: completeSubscriptions },
  { key: "trials", run: completeTrials },
] as const;

type ParentKey = (typeof PARENT_PASSES)[number]["key"];

type ParentPassState = (typeof PARENT_PASSES)[number] & {
  completed: number;
  seen: string[];
  open: boolean;
  /** When this pass stops starting rows; the class pass stops early. */
  pastDeadline: () => boolean;
};

/**
 * One round is a bite of every pass still open, slots first so the parents
 * read decided rows; a pass closes once a bite reads a short cohort (a parent
 * pass only after the slot pass has closed). Returns the number of rounds run.
 */
async function drainRounds(
  bites: {
    maxParents: number;
    maxSlotOutcomes: number;
    pastDeadline: () => boolean;
    slotsPastDeadline: () => boolean;
  },
  slotRun: SlotRun,
  parents: ParentPassState[],
  allErrors: string[],
  classEnd: ClassEndSettlement,
): Promise<number> {
  const { maxParents, maxSlotOutcomes, pastDeadline, slotsPastDeadline } =
    bites;
  const slotSeen: string[] = [];
  let slotsOpen = true;
  let rounds = 0;
  const startable = (p: ParentPassState) => p.open && !p.pastDeadline();
  while (!pastDeadline() && (slotsOpen || parents.some(startable))) {
    rounds++;
    if (slotsOpen) {
      const bite = await completeIndividualSlots(
        maxSlotOutcomes,
        slotSeen,
        slotsPastDeadline,
        slotRun,
      );
      allErrors.push(...bite.errors);
      slotSeen.push(...bite.read);
      // Past its share the slot pass closes, so the parent passes get the rest; unread sessions wait for the next run.
      slotsOpen = bite.read.length === maxSlotOutcomes && !slotsPastDeadline();
    }
    for (const pass of parents) {
      if (!startable(pass)) continue;
      const bite = await pass.run(maxParents, pass.seen, pass.pastDeadline);
      allErrors.push(...bite.errors);
      pass.completed += bite.completed;
      if (bite.classEnd) addSettlement(classEnd, bite.classEnd);
      pass.seen.push(...bite.read);
      // A later slot bite can make more parents eligible, so a short parent
      // cohort closes its pass only once the slot pass has closed.
      pass.open = bite.read.length === maxParents || slotsOpen;
    }
  }
  return rounds;
}

/**
 * Main function to auto-complete all eligible appointments
 */
// Locked at the core so every entry shares one mutual exclusion; fail-closed
// because the class pass stamps refunds owed.
//
/** The window-close pass's share of the start budget, so a weak backlog never starves the drain. */
const OUTCOME_CONFIRM_BUDGET_SHARE = 0.25;

// `maxParents` and `maxSlotOutcomes` are bite sizes: the run loops bites until
// every pass reads a short cohort or `startedAt` + SWEEP_START_DEADLINE_MS passes.
export async function autoCompleteAppointments(opts?: {
  maxParents?: number;
  maxSlotOutcomes?: number;
  /** When the request began (ms epoch); defaults to this call. */
  startedAt?: number;
}): Promise<AutoCompleteResult> {
  const maxParents =
    opts?.maxParents && opts.maxParents > 0
      ? Math.floor(opts.maxParents)
      : MAX_PARENTS_PER_BITE;
  const maxSlotOutcomes =
    opts?.maxSlotOutcomes && opts.maxSlotOutcomes > 0
      ? Math.floor(opts.maxSlotOutcomes)
      : MAX_SLOT_OUTCOMES_PER_BITE;
  const startedAt = opts?.startedAt ?? Date.now();
  const deadlines = {
    pastDeadline: startDeadline(startedAt),
    // A class's commit holds every seat's stamps, so none starts after half the start budget.
    classesPastDeadline: startDeadlineShare(0.5, startedAt),
    // Each session may spend several Stream reads settling, so sessions stop at half the budget too.
    slotsPastDeadline: startDeadlineShare(0.5, startedAt),
    // A session started near that cutoff still finishes its Stream reads inside the ticker's abort.
    settleDeadlineAt: startedAt + SWEEP_START_DEADLINE_MS,
    // From the request's start, like the shares above, so a slow start cannot push it into the drain's time.
    confirmPastDeadline: startDeadlineShare(
      OUTCOME_CONFIRM_BUDGET_SHARE,
      startedAt,
    ),
  };
  return withCronLock(
    "auto-complete-appointments",
    { failMode: "closed" },
    () =>
      autoCompleteAppointmentsUnlocked(maxParents, maxSlotOutcomes, deadlines),
  );
}

async function autoCompleteAppointmentsUnlocked(
  maxParents: number,
  maxSlotOutcomes: number,
  deadlines: {
    pastDeadline: () => boolean;
    classesPastDeadline: () => boolean;
    slotsPastDeadline: () => boolean;
    settleDeadlineAt: number;
    confirmPastDeadline: () => boolean;
  },
): Promise<AutoCompleteResult> {
  const { pastDeadline, classesPastDeadline, slotsPastDeadline } = deadlines;
  const allErrors: string[] = [];

  console.log("🔄 Starting auto-complete appointments scan...");
  console.log(
    `   Buffer time: ${COMPLETION_BUFFER_HOURS} hour(s) after session end`,
  );
  console.log(
    `   Bite: ${maxSlotOutcomes} session(s), ${maxParents} parent(s) per pass`,
  );

  const slotRun: SlotRun = {
    tally: { completed: 0, unverified: 0, voided: 0, deferred: 0 },
    unreadable: [],
    streamFailures: createRunFailureReporter("stream"),
    settleDeadlineAt: deadlines.settleDeadlineAt,
    menteeFailures: createRunFailureReporter("bookings"),
  };
  const parents: ParentPassState[] = PARENT_PASSES.map((pass) => ({
    ...pass,
    completed: 0,
    seen: [] as string[],
    open: true,
    pastDeadline: pass.key === "classes" ? classesPastDeadline : pastDeadline,
  }));
  const classEnd: ClassEndSettlement = { owed: 0, owedPaise: 0, escalated: 0 };
  let rounds = 0;
  let checkpoint: string | null | undefined;
  try {
    // Before the drain, which can spend the whole budget, and before the alerts, so a confirmed verdict is not counted as waiting.
    const confirms = await confirmClosedOutcomes(
      new Date(),
      deadlines.confirmPastDeadline,
    );
    checkpoint = confirms.checkpoint;
    allErrors.push(...confirms.errors);
    console.log(
      `   Closed verdicts: ${confirms.confirmed} confirmed, ${confirms.weak} left for ops`,
    );
    rounds = await drainRounds(
      { maxParents, maxSlotOutcomes, pastDeadline, slotsPastDeadline },
      slotRun,
      parents,
      allErrors,
      classEnd,
    );
    try {
      // Owner decision — a needs-human item older than 72 h is warned about, throttled.
      await alertStaleNeedsHuman(prisma, new Date());
    } catch (error) {
      allErrors.push(
        `Failed to alert stale needs-human sessions: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
    try {
      // Parked over 7 days: escalated so an ended plan's settlement never waits silently.
      await escalateAgedNeedsHuman(prisma, new Date());
    } catch (error) {
      allErrors.push(
        `Failed to escalate aged needs-human sessions: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  } finally {
    // Run-level reports survive a bite that throws.
    if (slotRun.unreadable.length > 0) {
      await reportStandingFinding({
        key: "session-outcome-sweep:attendance-unreadable",
        ids: slotRun.unreadable,
        message: `${slotRun.unreadable.length} session(s) parked INCONCLUSIVE: Stream's participant record could not be read within 72 hours`,
      }).catch((error: unknown) => {
        allErrors.push(
          `Failed to report unreadable sessions: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      });
    }
    slotRun.streamFailures.flush();
    slotRun.menteeFailures.flush();
  }

  const completed = (key: ParentKey) =>
    parents.find((p) => p.key === key)?.completed ?? 0;
  const { tally } = slotRun;

  // Summary
  console.log(`\n📊 Auto-Complete Summary (${rounds} round(s)):`);
  console.log(`   Sessions deferred: ${tally.deferred}`);
  console.log(`   Webinars completed: ${completed("webinars")}`);
  console.log(`   Classes completed: ${completed("classes")}`);
  console.log(`   Consultations completed: ${completed("consultations")}`);
  console.log(`   Subscriptions completed: ${completed("subscriptions")}`);
  console.log(`   Trials completed: ${completed("trials")}`);

  if (allErrors.length > 0) {
    console.log("\n⚠️ Errors encountered:");
    allErrors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: allErrors.length === 0,
    webinarsCompleted: completed("webinars"),
    classesCompleted: completed("classes"),
    consultationsCompleted: completed("consultations"),
    subscriptionsCompleted: completed("subscriptions"),
    trialsCompleted: completed("trials"),
    sessionsCompleted: tally.completed,
    sessionsVoided: tally.voided,
    sessionsUnverified: tally.unverified,
    classEndSeatsOwed: classEnd.owed,
    classEndOwedPaise: classEnd.owedPaise,
    classEndCreditSeatsEscalated: classEnd.escalated,
    errors: allErrors,
    timestamp: new Date().toISOString(),
    // The run trail keeps it for the window-close pass's next run; a skipped pass writes none.
    ...(checkpoint !== undefined && { checkpoint }),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
