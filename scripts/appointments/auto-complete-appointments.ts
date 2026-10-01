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
 * Schedule: Hourly, at :07.
 *
 * One consultation it deliberately does not complete: a paid session the
 * consultant never joined belongs to `detect-consultant-no-shows` (:57), which
 * cancels and refunds it. Both jobs classify presence through
 * `lib/booking/session-outcome.ts` so their candidate sets partition instead of
 * racing (#1504, #1569).
 */

import prisma from "../../lib/prisma";
import {
  WebinarStatus,
  ClassStatus,
  AppointmentStatus,
  OccurrenceCompletionStatus,
  TrialStatus,
  Prisma,
} from "@prisma/client";
import { notifyAppointmentCompleted } from "../../lib/novu/service";
import { notificationScope } from "../../lib/novu/workflows";
import { notificationHref } from "../../lib/novu/resolve-href";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  EVENT_ALLOWED_FROM,
  REQUEST_ALLOWED_FROM,
  transitionClassEvent,
  transitionConsultationRequest,
  transitionSubscriptionRequest,
  transitionTrial,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import { settleSubscriptionCycle } from "@/lib/booking/subscription-cycle";
import { attemptTrigger } from "@/lib/novu/outbox";
import {
  sessionsTotalOf,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";
import {
  alertStaleNeedsHuman,
  decideSlotOutcome,
  OUTCOME_SLOT_SELECT,
  readOutageWindows,
  type SlotDecision,
} from "@/lib/booking/session-outcome-sweep";
import { reportSentryMessage } from "@/lib/observability/report";
import { AWAITING_HUMAN, UNSETTLED_MISS } from "@/lib/booking/misses";
import { sessionHostUserIds } from "@/lib/booking/session-hosts";
import { recomputeMenteesHelped } from "@/lib/profiles/mentees-helped";
import { stampTrialEarningsHold } from "@/lib/trials/earnings-hold";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

// Only complete appointments that ended at least 1 hour ago
// This gives buffer time for any post-session activities
const COMPLETION_BUFFER_HOURS = 1;
// #1569 — sessions judged per run; each may ask Stream for its call report, so
// a backlog drains over several hourly runs instead of one long one.
const MAX_SLOT_OUTCOMES_PER_RUN = 500;

// #1775 — the per-parent cap, and the reason it exists. All FIVE parent passes
// (webinars, classes, consultations, subscriptions, trials) read their cohort
// with no `take` and no `orderBy` at all, so "500 per run" bounded only the
// slot pass and the five parents were unbounded. On Actions that is merely
// slow; on the Netlify ticker — which drives this route inside a 20 s abort —
// it is a guaranteed mid-run abort, and the abort lands in the middle of a
// parent CAS loop, so a cold tick could complete some parents and abandon
// others with no record that it had.
//
// Oldest-first on `updatedAt`, which is the parent's last write: a row that
// has been sitting SCHEDULED longest is the one whose earnings hold has been
// waiting longest, so that is the right end of the queue to drain first. Every
// parent pass is a guarded CAS out of the cohort (COMPLETED is terminal), so a
// capped run continues on the next tick with the rows it did not reach.
const MAX_PARENTS_PER_RUN = 25;

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
 * Run one guarded completion; false when the CAS matched nothing because the
 * row moved since the cohort read (the helper's throw IS the old count === 0).
 */
async function completeThroughHelper(
  run: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (error instanceof IllegalTransitionError) return false;
    throw error;
  }
}

/**
 * Auto-complete webinars that have ended
 */
async function completeWebinars(maxParents: number): Promise<{
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
    orderBy: { updatedAt: "asc" },
    take: maxParents,
    where: {
      status: { in: [WebinarStatus.SCHEDULED, WebinarStatus.IN_PROGRESS] },
      appointment: { AND: endedAndSettled(bufferTime) },
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
      const moved = await completeThroughHelper(() =>
        prisma.$transaction((tx) =>
          transitionWebinarEvent(tx, {
            where: { id: webinar.id },
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

  return { completed, errors };
}

/**
 * Auto-complete classes that have ended (all sessions done)
 */
async function completeClasses(maxParents: number): Promise<{
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
    orderBy: { updatedAt: "asc" },
    take: maxParents,
    where: {
      status: { in: [ClassStatus.SCHEDULED, ClassStatus.IN_PROGRESS] },
      // #1554 — one wrapper: at least one occurrence, and every live one ended.
      appointment: { AND: endedAndSettled(bufferTime) },
    },
    include: {
      classPlan: { select: { title: true } },
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

  console.log(`Found ${classesToComplete.length} classes to auto-complete`);

  for (const cls of classesToComplete) {
    try {
      // The latest occurrence end on the wrapper
      const latestEnd: Date | null =
        cls.appointment?.occurrences[0]?.endsAt ?? null;

      console.log(`\nCompleting class ${cls.id}`);
      console.log(`   Title: ${cls.classPlan.title}`);
      console.log(`   Previous status: ${cls.status}`);
      console.log(
        `   Last slot ended: ${latestEnd?.toISOString() || "Unknown"}`,
      );

      // CAS (#1319) — same reasoning as the webinar arm above.
      const moved = await completeThroughHelper(() =>
        prisma.$transaction((tx) =>
          transitionClassEvent(tx, {
            where: { id: cls.id },
            to: ClassStatus.COMPLETED,
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
async function completeConsultations(maxParents: number): Promise<{
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
    orderBy: { updatedAt: "asc" },
    take: maxParents,
    where: {
      status: { in: [AppointmentStatus.APPROVED, AppointmentStatus.SCHEDULED] },
      // A voided consultation is owed its make-up or refund first (#1569 D4).
      appointment: {
        AND: [
          { occurrences: allLiveOccurrencesEnded(bufferTime) },
          { occurrences: { none: UNSETTLED_MISS } },
          { occurrences: { none: AWAITING_HUMAN } },
        ],
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
      const moved = await completeThroughHelper(() =>
        prisma.$transaction((tx) =>
          transitionConsultationRequest(tx, {
            where: { id: consultation.id },
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

      // Fire-and-forget: notify both parties (non-blocking)
      const userIds = [consultantUserId, consulteeUserId].filter(
        (id): id is string => !!id,
      );
      if (userIds.length > 0) {
        await notifyAppointmentCompleted(userIds, {
          ...notificationScope(consultation.appointment?.organizationId),
          appointmentType: "consultation",
          consultantName:
            consultation.consultationPlan?.consultantProfile?.user?.name ??
            "Consultant",
          consulteeName: consultation.requestedBy?.user?.name ?? "Consultee",
          planTitle: consultation.consultationPlan.title,
          dashboardUrl: notificationHref(
            consultation.appointment?.organizationId,
            "appointments",
          ),
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
async function completeSubscriptions(maxParents: number): Promise<{
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
    orderBy: { updatedAt: "asc" },
    take: maxParents,
    where: {
      status: { in: [AppointmentStatus.APPROVED, AppointmentStatus.SCHEDULED] },
      // #1554 — one wrapper: at least one occurrence, and every live one ended.
      appointment: {
        AND: [
          { occurrences: allLiveOccurrencesEnded(bufferTime) },
          { occurrences: { none: UNSETTLED_MISS } },
          { occurrences: { none: AWAITING_HUMAN } },
        ],
      },
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
    try {
      // #1766 — COMPLETED is terminal: a plan whose live cycle ended but whose
      // entitlement is not spent is waiting for its next cycle, not finished.
      const entitlement = subscriptionEntitlement({
        sessionsTotal: sessionsTotalOf(subscription),
        sessionsPerWeek: subscription.subscriptionPlan.sessionsPerWeek,
        durationInMonths: subscription.subscriptionPlan.durationInMonths,
        occurrences: subscription.appointment?.occurrences ?? [],
        schedulingPeriodStartsAt: subscription.schedulingPeriodStartsAt,
        schedulingTimezone: subscription.schedulingTimezone,
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
      // read and this write must not be overwritten by COMPLETED.
      const moved = await completeThroughHelper(() =>
        prisma.$transaction((tx) =>
          transitionSubscriptionRequest(tx, {
            where: { id: subscription.id },
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

      // Fire-and-forget: notify both parties (non-blocking)
      const consultantUserId =
        subscription.subscriptionPlan?.consultantProfile?.userId;
      const consulteeUserId = subscription.requestedBy?.userId;
      const userIds = [consultantUserId, consulteeUserId].filter(
        (id): id is string => !!id,
      );
      if (userIds.length > 0) {
        await notifyAppointmentCompleted(userIds, {
          ...notificationScope(subscription.appointment?.organizationId),
          appointmentType: "subscription",
          consultantName:
            subscription.subscriptionPlan?.consultantProfile?.user?.name ??
            "Consultant",
          consulteeName: subscription.requestedBy?.user?.name ?? "Consultee",
          planTitle: subscription.subscriptionPlan.title,
          dashboardUrl: notificationHref(
            subscription.appointment?.organizationId,
            "appointments",
          ),
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
async function completeTrials(maxParents: number): Promise<{
  completed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let completed = 0;

  const bufferTime = new Date(
    Date.now() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );

  // Find SCHEDULED trials where the appointment slot has ended
  const trialsToComplete = await prisma.trial.findMany({
    orderBy: { updatedAt: "asc" },
    take: maxParents,
    where: {
      status: TrialStatus.SCHEDULED,
      // #1569 D4 — a free trial's void is a record only, so the unsettled-miss
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
      // A paid trial that was voided waits for ops.
      OR: [
        { paymentId: null },
        {
          appointment: {
            occurrences: {
              none: { completionStatus: OccurrenceCompletionStatus.VOIDED },
            },
          },
        },
      ],
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
      try {
        const completedAt = new Date();
        await prisma.$transaction(async (tx) => {
          await transitionTrial(tx, {
            where: { id: trial.id },
            to: TrialStatus.COMPLETED,
            data: { completedAt },
          });
          // #1775 C-9 — delivery starts the paid trial's earnings hold.
          await stampTrialEarningsHold(tx, trial.paymentId, completedAt);
        });
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        console.log(`   ⏭️ Skipped — status changed since the sweep read`);
        continue;
      }

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
            trialId: trial.id,
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
async function settleMenteesHelped(hostUserIds: Set<string>): Promise<void> {
  if (hostUserIds.size === 0) return;
  const profiles = await prisma.consultantProfile.findMany({
    where: { userId: { in: [...hostUserIds] } },
    select: { id: true },
  });
  for (const profile of profiles) {
    try {
      await recomputeMenteesHelped(prisma, profile.id);
    } catch (error) {
      reportSentryMessage("mentees helped recompute failed", {
        subsystem: "bookings",
        op: "auto-complete-appointments",
        level: "warning",
        extra: {
          consultantProfileId: profile.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

/**
 * #1766 — per distinct subscription wrapper, in a fresh transaction: the
 * consultee's cycle bell, deduped on the cycle so a re-run is quiet.
 */
async function settleCycleBells(wrappers: Set<string>): Promise<void> {
  for (const appointmentId of wrappers) {
    const staged = await prisma.$transaction((tx) =>
      settleSubscriptionCycle(tx, { appointmentId, now: new Date() }),
    );
    for (const row of staged ?? []) {
      // Best-effort after commit: the relay retries a failed attempt.
      try {
        await attemptTrigger(row);
      } catch (error) {
        console.error(
          `   ⚠️ Cycle bell attempt failed for ${appointmentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

/**
 * #1569 D2 — the one writer of each past session's outcome. Runs BEFORE the
 * parent passes so they read decided rows: presence is classified by
 * `classifySessionOutcome` and written as COMPLETED, VOIDED or UNVERIFIED in
 * one CAS per row (`decideSlotOutcome`). A live overrun and a consultation host
 * no-show still inside the detector's handoff are left SCHEDULED.
 */
async function completeIndividualSlots(maxOutcomes: number): Promise<{
  completed: number;
  unverified: number;
  voided: number;
  deferred: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const now = new Date();
  const bufferTime = new Date(
    now.getTime() - COMPLETION_BUFFER_HOURS * 60 * 60 * 1000,
  );
  const tally: SlotTally = {
    completed: 0,
    unverified: 0,
    voided: 0,
    deferred: 0,
  };
  let feedGaps = 0;

  try {
    // Doctrine rule 1: a tentative hold is an unpaid reservation and a
    // tombstoned row was already released; neither is a session to judge.
    const cohort = await prisma.appointmentOccurrence.findMany({
      where: {
        endsAt: { lt: bufferTime },
        isTentative: false,
        deletedAt: null,
        completionStatus: OccurrenceCompletionStatus.SCHEDULED,
      },
      select: OUTCOME_SLOT_SELECT,
      orderBy: { endsAt: "asc" },
      take: maxOutcomes,
    });
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
      try {
        const decision = await decideSlotOutcome(slot, {
          now,
          outages,
          onFeedGap: () => feedGaps++,
        });
        if (tallyDecision(tally, decision) && slot.appointment.subscriptionId) {
          wrappers.add(slot.appointmentId);
        }
        if (decision.kind === "written" && decision.moved) {
          for (const id of sessionHostUserIds(slot.appointment)) {
            decidedHosts.add(id);
          }
        }
      } catch (error) {
        errors.push(
          `Failed to decide session ${slot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // Owner decision — a needs-human item older than 72 h is warned about, throttled.
    await alertStaleNeedsHuman(prisma, now);
    // #1543 — silence must not mean "fine": Stream saw people we recorded nobody for.
    if (feedGaps > 0) {
      reportSentryMessage("attendance feed gap", {
        subsystem: "stream",
        op: "auto-complete-appointments",
        level: "warning",
        extra: { sessions: feedGaps },
      });
    }
    await settleCycleBells(wrappers);
    await settleMenteesHelped(decidedHosts);
    console.log(
      `   Sessions: ${tally.completed} completed, ${tally.voided} voided, ${tally.unverified} unverified, ${tally.deferred} deferred`,
    );
    return { ...tally, errors };
  } catch (error) {
    const message = `Failed to decide session outcomes: ${error instanceof Error ? error.message : "Unknown error"}`;
    console.error(`   ❌ ${message}`);
    errors.push(message);
    return { ...tally, errors };
  }
}

/**
 * Main function to auto-complete all eligible appointments
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
//
// `maxParents` is the Netlify ticker's bite across each of the five parent
// passes (#1775); `maxSlotOutcomes` bounds the slot pass, which was already
// bounded. A caller that omits them keeps the Actions figures.
export async function autoCompleteAppointments(opts?: {
  maxParents?: number;
  maxSlotOutcomes?: number;
}): Promise<AutoCompleteResult> {
  const maxParents =
    opts?.maxParents && opts.maxParents > 0
      ? Math.floor(opts.maxParents)
      : MAX_PARENTS_PER_RUN;
  const maxSlotOutcomes =
    opts?.maxSlotOutcomes && opts.maxSlotOutcomes > 0
      ? Math.floor(opts.maxSlotOutcomes)
      : MAX_SLOT_OUTCOMES_PER_RUN;
  return withCronLock("auto-complete-appointments", { failMode: "open" }, () =>
    autoCompleteAppointmentsUnlocked(maxParents, maxSlotOutcomes),
  );
}

async function autoCompleteAppointmentsUnlocked(
  maxParents: number,
  maxSlotOutcomes: number,
): Promise<AutoCompleteResult> {
  const allErrors: string[] = [];

  console.log("🔄 Starting auto-complete appointments scan...");
  console.log(
    `   Buffer time: ${COMPLETION_BUFFER_HOURS} hour(s) after session end`,
  );
  console.log(
    `   Per-run cap: ${maxSlotOutcomes} session(s), ${maxParents} parent(s) per pass`,
  );

  // Complete individual slots first (per-slot status before parent-level)
  const slotResult = await completeIndividualSlots(maxSlotOutcomes);
  allErrors.push(...slotResult.errors);

  // Complete webinars
  const webinarResult = await completeWebinars(maxParents);
  allErrors.push(...webinarResult.errors);

  // Complete classes
  const classResult = await completeClasses(maxParents);
  allErrors.push(...classResult.errors);

  // Complete consultations
  const consultationResult = await completeConsultations(maxParents);
  allErrors.push(...consultationResult.errors);

  // Complete subscriptions
  const subscriptionResult = await completeSubscriptions(maxParents);
  allErrors.push(...subscriptionResult.errors);

  // Complete trial sessions
  const trialResult = await completeTrials(maxParents);
  allErrors.push(...trialResult.errors);

  // Summary
  console.log("\n📊 Auto-Complete Summary:");
  console.log(
    `   Sessions: ${slotResult.completed} completed, ${slotResult.voided} voided, ${slotResult.unverified} unverified`,
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
