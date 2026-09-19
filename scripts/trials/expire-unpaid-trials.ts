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

import { TrialStatus } from "@prisma/client";

import { withCronLock } from "@/lib/cron/with-cron-lock";
import { transitionTrial } from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { softCancelTrialAppointment } from "@/lib/trials/cancellation";
import { notifyTrialCancelled } from "@/lib/novu/service";
import { reportSentryError } from "@/lib/observability/report";
import prisma from "../../lib/prisma";

export interface ExpireUnpaidTrialsResult {
  success: boolean;
  trialsExpired: number;
  errors: string[];
  timestamp: string;
}

/**
 * Expire unpaid trial sessions.
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: the updateMany is idempotent, lock is
// belt-and-braces.
export async function expireUnpaidTrials(): Promise<ExpireUnpaidTrialsResult> {
  return withCronLock("expire-unpaid-trials", { failMode: "open" }, () =>
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
        fromIn: [TrialStatus.AWAITING_PAYMENT],
        // Repeat the cohort's stale-time predicate inside the CAS: a
        // pay-link re-minted between the read and the write moves the
        // deadline out from under the sweep and must not be cancelled.
        whereAnd: {
          OR: [{ paymentDueAt: { lt: now } }, { paymentDueAt: null }],
        },
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
  // it, in a second transaction AFTER this one commits (PG_POOL_MAX=1).
  if (trial.appointmentId) {
    await softCancelTrialAppointment(trial.appointmentId);
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

async function expireUnpaidTrialsUnlocked(): Promise<ExpireUnpaidTrialsResult> {
  const errors: string[] = [];
  let trialsExpired = 0;
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
      const stale = await prisma.trial.findMany({
        where: {
          status: TrialStatus.AWAITING_PAYMENT,
          // A null paymentDueAt means the pay-link was never minted — the gateway
          // call failed after acceptance. Sweep those too: holding a slot for a
          // trial nobody can pay for is the worst case of all.
          OR: [{ paymentDueAt: { lt: now } }, { paymentDueAt: null }],
        },
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    console.error("❌ Failed to expire unpaid trials:", message);
  }

  return {
    success: errors.length === 0,
    trialsExpired,
    errors,
    timestamp: now.toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
