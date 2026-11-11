/**
 * Unpaid Trial Expiry - Core Logic
 *
 * Cancels paid trials the consultant accepted but the learner never paid for,
 * once `paymentDueAt` has passed. Without this an AWAITING_PAYMENT trial holds
 * a consultant's slot indefinitely: it counts as occupied in
 * `buildOccupiedAppointmentFilter`, so the consultant can neither deliver it
 * nor rebook the time.
 *
 * The status move drops the trial out of that filter; since #1591 J4-P0-03
 * the held appointment is tombstoned too (softCancelTrialAppointment), so the
 * occurrence stops arming the overlap constraint and the seats read CANCELLED.
 *
 * The learner is not penalised: a cancelled trial frees the
 * learner-consultant pair, so they can request again. See
 * lib/trials/eligibility.ts.
 *
 * This module exports the core function. It is imported by:
 * - jobs/trials/expire-unpaid-trials.ts (GitHub Actions)
 * - app/api/cleanup/expire-unpaid-trials/route.ts (API endpoint)
 *
 * Schedule: Hourly
 */

import { Prisma, TrialStatus } from "@prisma/client";

import { withCronLock } from "@/lib/cron/with-cron-lock";
import { transitionTrial } from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { softCancelTrialAppointment } from "@/lib/trials/cancellation";
import { stageTrialLifecycleEmail } from "@/lib/email/senders/booking";
import { notifyTrialCancelled } from "@/lib/novu/service";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { goHref } from "@/lib/dashboard/go";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { stageTrialRefundedBell } from "@/lib/trials/refund-bell";
import prisma from "../../lib/prisma";
import type { PrismaLike } from "../../lib/prisma";

// Per-trial failures collapse to one event per op when the run ends.
const runFailures = createRunFailureReporter("trials");

export interface ExpireUnpaidTrialsResult {
  success: boolean;
  trialsExpired: number;
  /** #1775 C-12 — paid trials the consultant never answered, refunded in full. */
  trialsUnansweredRefunded: number;
  errors: string[];
  timestamp: string;
}

/**
 * Expire unpaid trial sessions.
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion. #1775 C-12 — fail-closed: arm (ii) refunds money.
//
// `maxTrials` is the Netlify ticker's bite (#1583 P1). The cohort below is a
// loop of 500-row batches (4 × 500 for Actions) and each row costs a guarded
// transition, a tombstone and a bell — plus, in arm (ii), a full gateway
// refund. CANCELLED leaves the cohort and there is no persisted cursor, so a
// smaller cap is a budget and not a drop.
export async function expireUnpaidTrials(opts?: {
  maxTrials?: number;
}): Promise<ExpireUnpaidTrialsResult> {
  const maxTrials =
    opts?.maxTrials && opts.maxTrials > 0
      ? Math.floor(opts.maxTrials)
      : BATCH_SIZE * MAX_BATCHES_PER_RUN;
  return withCronLock("expire-unpaid-trials", { failMode: "closed" }, () =>
    expireUnpaidTrialsUnlocked(maxTrials),
  );
}

/** One guarded transition per lapsed trial, and the batch/run bounds. */
const BATCH_SIZE = 500;
const MAX_BATCHES_PER_RUN = 4;

/** What the tombstone and the consultee notice need, read with the cohort. */
const EXPIRY_SELECT = {
  id: true,
  appointmentId: true,
  consulteeProfile: { select: { user: { select: { id: true, name: true } } } },
  subscriptionPlan: {
    select: {
      title: true,
      consultantProfile: { select: { user: { select: { name: true } } } },
    },
  },
  appointment: {
    select: {
      organizationId: true,
      occurrences: {
        where: { deletedAt: null },
        orderBy: { startsAt: "asc" as const },
        take: 1,
        select: { startsAt: true },
      },
    },
  },
} as const;

const EXPIRY_SELECT_WITH_PAYMENT = {
  ...EXPIRY_SELECT,
  paymentId: true,
} as const;

type LapsedTrial = {
  id: string;
  appointmentId: string | null;
  consulteeProfile: { user: { id: string; name: string | null } };
  subscriptionPlan: {
    title: string;
    consultantProfile: { user: { name: string | null } };
  };
  appointment: {
    organizationId?: string | null;
    occurrences: { startsAt: Date }[];
  } | null;
};

/**
 * Moves a trial whose step failed to the back of its `updatedAt asc` cohort,
 * so one poison row cannot head every bounded run.
 */
async function rotateTrial(trialId: string): Promise<void> {
  try {
    await prisma.trial.updateMany({
      where: { id: trialId },
      data: { updatedAt: new Date() },
    });
  } catch (error) {
    console.warn(`⚠️ Could not rotate trial ${trialId}:`, describe(error));
  }
}

/**
 * Expire one lapsed trial through the guarded transition. Returns true when
 * it moved. Throws on anything but a lost race; the caller records the
 * failure and rotates the row.
 */
async function expireOneTrial(trial: LapsedTrial, now: Date): Promise<boolean> {
  try {
    await prisma.$transaction((tx) =>
      transitionTrial(tx, {
        where: { id: trial.id },
        to: TrialStatus.CANCELLED,
        fromIn: [TrialStatus.AWAITING_PAYMENT, TrialStatus.PENDING],
        // Repeat the cohort's predicate inside the CAS: a pay-link re-minted
        // (deadline moved) or a capture (paymentId set) since the read must
        // match zero rows. #1775 C-12 — no money moves in this arm.
        whereAnd: unpaidLapsedWhere(now),
        data: {
          // The link is dead once cancelled; leaving it would let a stale
          // dashboard row send someone to a checkout for a released slot.
          pendingPaymentUrl: null,
          paymentDueAt: null,
        },
        reason: "Trial pay-link lapsed without payment",
      }),
    );
  } catch (error) {
    // Scheduled or paid between the read and the write — the payment
    // wins, and there is nothing left to expire.
    if (error instanceof IllegalTransitionError) return false;
    throw error;
  }

  // #1591 J4-P0-03 / #1583 A-P1-05 — the CAS win owns the held call: the
  // appointment/occurrence tombstone and the participants' CANCELLED ride
  // it, in a second transaction AFTER this one commits (PG_POOL_MAX=1). A
  // failure here is isolated: the trial is CANCELLED already, and the repair
  // cohort below re-tombstones it on the next run.
  if (trial.appointmentId) {
    await tombstoneHeldCall(trial.id, trial.appointmentId);
  }
  // The same notice the interactive cancel path sends; never fatal.
  try {
    const dashboardUrl = goHref("client", "appointments");
    const consultantName =
      trial.subscriptionPlan.consultantProfile.user.name || "Consultant";
    const consulteeName = trial.consulteeProfile.user.name || "User";
    const startsAt = trial.appointment?.occurrences[0]?.startsAt;
    const organizationId = trial.appointment?.organizationId ?? undefined;
    const cancelBellInput = {
      organizationId,
      consultantName,
      consulteeName,
      planTitle: trial.subscriptionPlan.title,
      status: TrialStatus.CANCELLED,
      dateTime: startsAt?.toISOString(),
      dashboardUrl,
    };
    const [, emailRows] = await Promise.all([
      Promise.resolve(
        notifyTrialCancelled([trial.consulteeProfile.user.id], cancelBellInput),
      ).catch(() => []),
      stageTrialLifecycleEmail(prisma, {
        trialId: trial.id,
        userIds: [trial.consulteeProfile.user.id],
        kind: "TRIAL_CANCELLED",
        planTitle: trial.subscriptionPlan.title,
        consultantName,
        consulteeName,
        startsAt,
        dashboardUrl,
      }).catch(() => []),
    ]);
    await flushNotificationsAfter(
      {
        emails: [{ rows: emailRows, emailType: "TRIAL_CANCELLED" }],
      },
      "expire-unpaid-trials.lapsed",
    );
  } catch (error) {
    runFailures.add(
      "expire-unpaid-trials-notify",
      error,
      { trialId: trial.id },
      { expected: true },
    );
  }
  return true;
}

async function tombstoneHeldCall(
  trialId: string,
  appointmentId: string,
): Promise<boolean> {
  try {
    await softCancelTrialAppointment(appointmentId);
    return true;
  } catch (error) {
    runFailures.add("expire-unpaid-trials-tombstone", error, {
      trialId,
      appointmentId,
    });
    return false;
  }
}

/**
 * A CANCELLED trial whose held call is still live: the tombstone step failed
 * after the CAS committed, or the row predates #1591 J4-P0-03. The
 * AWAITING_PAYMENT cohort never revisits it, so this bounded pass does.
 */
const REPAIR_BATCH_SIZE = 50;
function untombstonedCancelledTrialWhere(): Prisma.TrialWhereInput {
  return {
    status: TrialStatus.CANCELLED,
    appointment: { deletedAt: null },
  };
}

async function repairUntombstonedCancelledTrials(): Promise<number> {
  const stale = await prisma.trial.findMany({
    where: untombstonedCancelledTrialWhere(),
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: REPAIR_BATCH_SIZE,
    select: { id: true, appointmentId: true },
  });
  let repaired = 0;
  for (const row of stale) {
    if (!row.appointmentId) continue;
    if (await tombstoneHeldCall(row.id, row.appointmentId)) repaired += 1;
    else await rotateTrial(row.id);
  }
  return repaired;
}

/**
 * #1775 C-12 (i) — an unpaid trial past its pay window: AWAITING_PAYMENT (the
 * legacy accept-then-pay shape, including a never-minted null deadline) or a
 * paid trial still PENDING and uncaptured. A free PENDING trial has no
 * deadline and never matches.
 */
function unpaidLapsedWhere(now: Date): Prisma.TrialWhereInput {
  return {
    paymentId: null,
    OR: [
      { status: TrialStatus.PENDING, paymentDueAt: { lt: now } },
      // A paid trial requested before charge-at-request has no order and no
      // deadline; accept now refuses it, so it lapses a day after the request.
      {
        status: TrialStatus.PENDING,
        paymentDueAt: null,
        appointmentId: null,
        requestedAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        subscriptionPlan: { trialPriceInPaise: { gt: 0 } },
      },
      {
        status: TrialStatus.AWAITING_PAYMENT,
        OR: [{ paymentDueAt: { lt: now } }, { paymentDueAt: null }],
      },
    ],
  };
}

/** #1775 C-12 (ii) — the consultant has 48 h to answer a paid trial. */
export const TRIAL_ANSWER_HOURS = 48;

const unansweredCutoff = (now: Date) =>
  new Date(now.getTime() - TRIAL_ANSWER_HOURS * 60 * 60 * 1000);

/** Repeated inside the cancel CAS, so a trial answered since the read matches zero rows. */
function unansweredTrialWhere(cutoff: Date): Prisma.TrialWhereInput {
  return { paymentId: { not: null }, requestedAt: { lt: cutoff } };
}

function pendingUnansweredTrialWhere(cutoff: Date): Prisma.TrialWhereInput {
  return { status: TrialStatus.PENDING, ...unansweredTrialWhere(cutoff) };
}

/** Unanswered cancels inside the refund-retry lookback. */
function unansweredCancelHistoryWhere(
  since: Date,
): Prisma.BookingStatusHistoryWhereInput {
  return {
    entity: "TRIAL",
    reason: "TRIAL_UNANSWERED",
    toStatus: TrialStatus.CANCELLED,
    createdAt: { gte: since },
  };
}

const unansweredRetrySince = (now: Date) =>
  new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

/** Probes every arm; the history arm is a superset of the refund retry. */
export async function hasUnpaidTrialWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const trial = await db.trial.findFirst({
    where: {
      OR: [
        unpaidLapsedWhere(now),
        untombstonedCancelledTrialWhere(),
        pendingUnansweredTrialWhere(unansweredCutoff(now)),
      ],
    },
    select: { id: true },
  });
  if (trial) return true;
  if (outOfTime()) return true;
  const cancel = await db.bookingStatusHistory.findFirst({
    where: unansweredCancelHistoryWhere(unansweredRetrySince(now)),
    select: { id: true },
  });
  return cancel !== null;
}

type UnansweredTrial = LapsedTrial & {
  paymentId: string | null;
  consultantProfile: { user: { id: string } };
};

/** The one refund an unanswered paid trial is owed, keyed so a retry is safe. */
const unansweredRefundKey = (paymentId: string) =>
  `trial-unanswered:${paymentId}`;

/** Full refund, then the learner's bell; false when it must be retried. */
async function refundUnansweredTrial(trial: {
  id: string;
  paymentId: string | null;
  appointment?: { organizationId?: string | null } | null;
  consulteeProfile: { user: { id: string } };
  subscriptionPlan: {
    title: string;
    consultantProfile: { user: { name: string | null } };
  };
}): Promise<boolean> {
  if (!trial.paymentId) return false;
  try {
    await refundBookingPayment({
      paymentId: trial.paymentId,
      reason: "trial unanswered within 48 h — automatic full refund",
      initiatedByUserId: null,
      dedupeKey: unansweredRefundKey(trial.paymentId),
    });
    const consultantName =
      trial.subscriptionPlan.consultantProfile.user.name ?? "The consultant";
    const organizationId = trial.appointment?.organizationId ?? undefined;
    const refundBellInput = {
      id: trial.id,
      consulteeUserId: trial.consulteeProfile.user.id,
      planTitle: trial.subscriptionPlan.title,
      consultantName,
      organizationId,
    };
    const [refundBell, emailRows] = await Promise.all([
      Promise.resolve(stageTrialRefundedBell(prisma, refundBellInput)).catch(
        () => null,
      ),
      stageTrialLifecycleEmail(prisma, {
        trialId: trial.id,
        userIds: [trial.consulteeProfile.user.id],
        kind: "TRIAL_CANCELLED",
        planTitle: trial.subscriptionPlan.title,
        consultantName,
        dashboardUrl: goHref("client", "payments"),
      }).catch(() => []),
    ]);
    await flushNotificationsAfter(
      {
        bells: [refundBell],
        emails: [{ rows: emailRows, emailType: "TRIAL_CANCELLED" }],
      },
      "expire-unpaid-trials.unanswered",
    );
    return true;
  } catch (error) {
    runFailures.add("expire-unanswered-paid-trials-refund", error, {
      trialId: trial.id,
      paymentId: trial.paymentId,
    });
    return false;
  }
}

/**
 * A refund that failed after the CAS left the trial CANCELLED with the money
 * still captured. Trials cancelled TRIAL_UNANSWERED in the last 14 days whose
 * keyed refund does not exist are retried; the key makes a repeat a no-op.
 */
async function retryUnansweredTrialRefunds(now: Date): Promise<number> {
  const cancelled = await prisma.bookingStatusHistory.findMany({
    where: unansweredCancelHistoryWhere(unansweredRetrySince(now)),
    select: { entityId: true },
    take: 200,
  });
  if (cancelled.length === 0) return 0;
  const trials = await prisma.trial.findMany({
    where: {
      id: { in: cancelled.map((c) => c.entityId) },
      status: TrialStatus.CANCELLED,
      paymentId: { not: null },
    },
    select: EXPIRY_SELECT_WITH_PAYMENT,
  });
  const done = new Set(
    (
      await prisma.refund.findMany({
        where: {
          dedupeKey: {
            in: trials.map((t) => unansweredRefundKey(t.paymentId ?? "")),
          },
          // A FAILED/CANCELLED row moved no money; its key is free to retry.
          status: { notIn: ["FAILED", "CANCELLED"] },
        },
        select: { dedupeKey: true },
      })
    ).map((r) => r.dedupeKey),
  );
  let retried = 0;
  for (const trial of trials) {
    if (!trial.paymentId || done.has(unansweredRefundKey(trial.paymentId)))
      continue;
    if (await refundUnansweredTrial(trial)) retried += 1;
  }
  return retried;
}

/**
 * #1775 C-12 (ii) — a paid trial (PENDING, captured) the consultant never
 * answered within 48 h of the request ends CANCELLED (TRIAL_UNANSWERED; the
 * enum has no EXPIRED) and is refunded in full after the commit.
 */
async function expireUnansweredPaidTrials(
  now: Date,
  maxTrials: number,
  errors: string[],
): Promise<number> {
  const cutoff = unansweredCutoff(now);
  const unanswered = unansweredTrialWhere(cutoff);
  const rows: UnansweredTrial[] = await prisma.trial.findMany({
    where: pendingUnansweredTrialWhere(cutoff),
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: maxTrials,
    select: {
      ...EXPIRY_SELECT,
      paymentId: true,
      consultantProfile: { select: { user: { select: { id: true } } } },
    },
  });
  let refunded = 0;
  for (const trial of rows) {
    try {
      await prisma.$transaction(async (tx) => {
        await transitionTrial(tx, {
          where: { id: trial.id },
          to: TrialStatus.CANCELLED,
          fromIn: [TrialStatus.PENDING],
          whereAnd: unanswered,
          reason: "TRIAL_UNANSWERED",
        });
      });
    } catch (error) {
      if (error instanceof IllegalTransitionError) continue;
      errors.push(
        `Failed to cancel unanswered trial ${trial.id}: ${describe(error)}`,
      );
      runFailures.add("expire-unanswered-paid-trials-cancel", error, {
        trialId: trial.id,
      });
      await rotateTrial(trial.id);
      continue;
    }
    if (trial.appointmentId) {
      await tombstoneHeldCall(trial.id, trial.appointmentId);
    }
    if (await refundUnansweredTrial(trial)) refunded += 1;
  }
  refunded += await retryUnansweredTrialRefunds(now);
  return refunded;
}

async function expireUnpaidTrialsUnlocked(
  maxTrials: number,
): Promise<ExpireUnpaidTrialsResult> {
  const errors: string[] = [];
  let trialsExpired = 0;
  let trialsUnansweredRefunded = 0;
  const now = new Date();

  console.log("🧹 Starting unpaid trial expiry...");
  console.log(`   Per-run cap: ${maxTrials} trial(s)`);

  // Each arm has its own try, so a failure in one never skips the money arm.
  try {
    // One guarded transition per lapsed trial rather than a bulk updateMany.
    // fromIn repeats the cohort read's status inside the CAS where: a capture
    // that moves AWAITING_PAYMENT → SCHEDULED between the read and the write
    // matches zero rows instead of cancelling a paid trial (doctrine rule 5).
    // Each move also appends the BookingStatusHistory row every other writer
    // emits. Idempotent: CANCELLED leaves the cohort, and a failed row is
    // rotated behind the rest by `updatedAt`.
    let processed = 0;
    for (;;) {
      if (processed >= maxTrials) break;
      // A null paymentDueAt on AWAITING_PAYMENT means the pay-link was never
      // minted after acceptance; holding a slot nobody can pay for is the worst case.
      const stale = await prisma.trial.findMany({
        where: unpaidLapsedWhere(now),
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: Math.min(BATCH_SIZE, maxTrials - processed),
        select: EXPIRY_SELECT,
      });
      if (stale.length === 0) break;

      for (const row of stale) {
        processed += 1;
        try {
          if (await expireOneTrial(row, now)) trialsExpired += 1;
        } catch (error) {
          errors.push(`Failed to expire trial ${row.id}: ${describe(error)}`);
          runFailures.add("expire-unpaid-trials-expire", error, {
            trialId: row.id,
          });
          await rotateTrial(row.id);
        }
      }

      if (stale.length < BATCH_SIZE) break;
    }
    console.log(`   Trials expired: ${trialsExpired}`);
  } catch (error) {
    errors.push(`Lapsed-trial arm failed: ${describe(error)}`);
  }

  try {
    const repaired = await repairUntombstonedCancelledTrials();
    if (repaired > 0) console.log(`   Held calls re-tombstoned: ${repaired}`);
  } catch (error) {
    errors.push(`Repair arm failed: ${describe(error)}`);
  }

  try {
    trialsUnansweredRefunded = await expireUnansweredPaidTrials(
      now,
      maxTrials,
      errors,
    );
    console.log(
      `   Unanswered paid trials refunded: ${trialsUnansweredRefunded}`,
    );
  } catch (error) {
    errors.push(`Unanswered paid-trial arm failed: ${describe(error)}`);
  }

  runFailures.flush();
  if (errors.length > 0) {
    console.error("❌ Unpaid trial expiry finished with errors:", errors);
  }

  return {
    success: errors.length === 0,
    trialsExpired,
    trialsUnansweredRefunded,
    errors,
    timestamp: now.toISOString(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
