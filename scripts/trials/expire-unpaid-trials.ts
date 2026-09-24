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
import { notifyTrialCancelled } from "@/lib/novu/service";
import { reportSentryError } from "@/lib/observability/report";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { stageTrialRefundedBell } from "@/lib/trials/refund-bell";
import prisma from "../../lib/prisma";

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
export async function expireUnpaidTrials(): Promise<ExpireUnpaidTrialsResult> {
  return withCronLock("expire-unpaid-trials", { failMode: "closed" }, () =>
    expireUnpaidTrialsUnlocked(),
  );
}

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
      occurrences: {
        where: { deletedAt: null },
        orderBy: { startsAt: "asc" as const },
        take: 1,
        select: { startsAt: true },
      },
    },
  },
} as const;

type LapsedTrial = {
  id: string;
  appointmentId: string | null;
  consulteeProfile: { user: { id: string; name: string | null } };
  subscriptionPlan: {
    title: string;
    consultantProfile: { user: { name: string | null } };
  };
  appointment: { occurrences: { startsAt: Date }[] } | null;
};

/**
 * Expire one lapsed trial through the guarded transition. Returns true when
 * it moved. Throws on anything but a lost race so the caller aborts the
 * batch loudly instead of skipping rows silently.
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
        whereAnd: unpaidLapsed(now),
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
    await notifyTrialCancelled([trial.consulteeProfile.user.id], {
      consultantName:
        trial.subscriptionPlan.consultantProfile.user.name || "Consultant",
      consulteeName: trial.consulteeProfile.user.name || "User",
      planTitle: trial.subscriptionPlan.title,
      status: TrialStatus.CANCELLED,
      dateTime: trial.appointment?.occurrences[0]?.startsAt.toISOString(),
      dashboardUrl: "/dashboard",
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "trials",
      op: "expire-unpaid-trials-notify",
      expected: true,
      extra: { trialId: trial.id },
    });
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
    reportSentryError(error, {
      subsystem: "trials",
      op: "expire-unpaid-trials-tombstone",
      extra: { trialId, appointmentId },
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
async function repairUntombstonedCancelledTrials(): Promise<number> {
  const stale = await prisma.trial.findMany({
    where: {
      status: TrialStatus.CANCELLED,
      appointment: { deletedAt: null },
    },
    orderBy: { updatedAt: "asc" },
    take: REPAIR_BATCH_SIZE,
    select: { id: true, appointmentId: true },
  });
  let repaired = 0;
  for (const row of stale) {
    if (!row.appointmentId) continue;
    if (await tombstoneHeldCall(row.id, row.appointmentId)) repaired += 1;
  }
  return repaired;
}

/**
 * #1775 C-12 (i) — an unpaid trial past its pay window: AWAITING_PAYMENT (the
 * legacy accept-then-pay shape, including a never-minted null deadline) or a
 * paid trial still PENDING and uncaptured. A free PENDING trial has no
 * deadline and never matches.
 */
function unpaidLapsed(now: Date): Prisma.TrialWhereInput {
  return {
    paymentId: null,
    OR: [
      { status: TrialStatus.PENDING, paymentDueAt: { lt: now } },
      {
        status: TrialStatus.AWAITING_PAYMENT,
        OR: [{ paymentDueAt: { lt: now } }, { paymentDueAt: null }],
      },
    ],
  };
}

/** #1775 C-12 (ii) — the consultant has 48 h to answer a paid trial. */
export const TRIAL_ANSWER_HOURS = 48;

type UnansweredTrial = LapsedTrial & {
  paymentId: string | null;
  consultantProfile: { user: { id: string } };
};

/**
 * #1775 C-12 (ii) — a paid trial (PENDING, captured) the consultant never
 * answered within 48 h of the request ends CANCELLED (TRIAL_UNANSWERED; the
 * enum has no EXPIRED) and is refunded in full after the commit.
 */
async function expireUnansweredPaidTrials(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - TRIAL_ANSWER_HOURS * 60 * 60 * 1000);
  const unanswered: Prisma.TrialWhereInput = {
    paymentId: { not: null },
    requestedAt: { lt: cutoff },
  };
  const rows: UnansweredTrial[] = await prisma.trial.findMany({
    where: { status: TrialStatus.PENDING, ...unanswered },
    orderBy: { requestedAt: "asc" },
    take: 500,
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
        await stageTrialRefundedBell(tx, {
          id: trial.id,
          consulteeUserId: trial.consulteeProfile.user.id,
          planTitle: trial.subscriptionPlan.title,
          consultantName: trial.subscriptionPlan.consultantProfile.user.name,
        });
      });
    } catch (error) {
      if (error instanceof IllegalTransitionError) continue;
      throw error;
    }
    if (trial.appointmentId) {
      await tombstoneHeldCall(trial.id, trial.appointmentId);
    }
    try {
      await refundBookingPayment({
        paymentId: trial.paymentId!,
        reason: "trial unanswered within 48 h — automatic full refund",
        initiatedByUserId: null,
      });
      refunded += 1;
    } catch (error) {
      reportSentryError(error, {
        subsystem: "trials",
        op: "expire-unanswered-paid-trials-refund",
        extra: { trialId: trial.id, paymentId: trial.paymentId },
      });
    }
  }
  return refunded;
}

async function expireUnpaidTrialsUnlocked(): Promise<ExpireUnpaidTrialsResult> {
  const errors: string[] = [];
  let trialsExpired = 0;
  let trialsUnansweredRefunded = 0;
  const now = new Date();

  console.log("🧹 Starting unpaid trial expiry...");

  try {
    // One guarded transition per lapsed trial rather than a bulk updateMany.
    // fromIn repeats the cohort read's status inside the CAS where: a capture
    // that moves AWAITING_PAYMENT → SCHEDULED between the read and the write
    // matches zero rows instead of cancelling a paid trial (doctrine rule 5).
    // Each move also appends the BookingStatusHistory row every other writer
    // emits. Idempotent: CANCELLED leaves the cohort.
    //
    // Bounded batches: see expire-reschedule-proposals — same hourly-cron
    // ceiling reasoning. Capped per invocation too (4 x 500 rows max); the
    // next hourly tick continues, since CANCELLED leaves the cohort.
    const BATCH_SIZE = 500;
    const MAX_BATCHES_PER_RUN = 4;
    let batchesRun = 0;
    for (;;) {
      if (batchesRun >= MAX_BATCHES_PER_RUN) break;
      // A null paymentDueAt on AWAITING_PAYMENT means the pay-link was never
      // minted after acceptance; holding a slot nobody can pay for is the worst case.
      const stale = await prisma.trial.findMany({
        where: unpaidLapsed(now),
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        select: EXPIRY_SELECT,
      });
      if (stale.length === 0) break;

      for (const row of stale) {
        if (await expireOneTrial(row, now)) trialsExpired += 1;
      }
      batchesRun += 1;

      if (stale.length < BATCH_SIZE) break;
    }

    console.log(`   Trials expired: ${trialsExpired}`);

    const repaired = await repairUntombstonedCancelledTrials();
    if (repaired > 0) console.log(`   Held calls re-tombstoned: ${repaired}`);

    trialsUnansweredRefunded = await expireUnansweredPaidTrials(now);
    console.log(
      `   Unanswered paid trials refunded: ${trialsUnansweredRefunded}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    console.error("❌ Failed to expire unpaid trials:", message);
  }

  return {
    success: errors.length === 0,
    trialsExpired,
    trialsUnansweredRefunded,
    errors,
    timestamp: now.toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
