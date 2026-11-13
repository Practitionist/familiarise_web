/**
 * Unpaid Trial Expiry - Core Logic
 *
 * Cancels a paid trial the learner never paid for once `paymentDueAt` (15 minutes
 * before the session at the latest) has passed. Without this an AWAITING_PAYMENT
 * trial holds the expert's time indefinitely: it counts as occupied in
 * `buildOccupiedAppointmentFilter`. No money moves: nothing was captured.
 *
 * The status move drops the trial out of that filter; since #1591 J4-P0-03
 * the held appointment is tombstoned too (softCancelTrialAppointment), so the
 * occurrence stops arming the overlap constraint and the seats read CANCELLED.
 *
 * The learner is not penalised: a cancelled trial frees the
 * learner-consultant pair, so they can request again. See
 * lib/trials/eligibility.ts.
 *
 * Registered as `expire-unpaid-trials` in lib/cron/cleanup-registry.ts and run by
 * the ticker every 15 minutes (`TARGET_EVERY_MINUTES` in lib/cron/schedule.ts).
 */

import { Prisma, TrialStatus } from "@prisma/client";

import { withCronLock } from "@/lib/cron/with-cron-lock";
import { transitionTrial } from "@/lib/booking/transitions";
import {
  expirePendingPaymentsInTx,
  type GatewayCancel,
} from "@/lib/booking/pending-payment-expiry";
import { cancelPaymentIntent } from "@/scripts/payments/cleanup-abandoned-payments";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { softCancelTrialAppointment } from "@/lib/trials/cancellation";
import { stageTrialLifecycleEmail } from "@/lib/email/senders/booking";
import { notifyTrialCancelled } from "@/lib/novu/service";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { goHref } from "@/lib/dashboard/go";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import prisma from "../../lib/prisma";
import type { PrismaLike } from "../../lib/prisma";

// Per-trial failures collapse to one event per op when the run ends.
const runFailures = createRunFailureReporter("trials");

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
  let gatewayCancels: GatewayCancel[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      // The held time's unpaid order dies first, in the capture's lock order
      // (payment → trial), so the cancelled trial leaves nothing payable.
      if (trial.appointmentId) {
        ({ gatewayCancels } = await expirePendingPaymentsInTx(tx, {
          appointmentId: trial.appointmentId,
          reason: "Trial pay-link lapsed without payment",
        }));
      }
      await transitionTrial(tx, {
        where: { id: trial.id },
        to: TrialStatus.CANCELLED,
        fromIn: [TrialStatus.AWAITING_PAYMENT],
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
      });
    });
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
  // Best-effort: a capture that still lands on EXPIRED is parked and refunded.
  for (const cancel of gatewayCancels) {
    try {
      await cancelPaymentIntent(cancel.paymentIntent, cancel.gateway);
    } catch (error) {
      runFailures.add(
        "expire-unpaid-trials-gateway-cancel",
        error,
        { trialId: trial.id },
        { expected: true },
      );
    }
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

/** An unpaid trial past its pay window (a never-minted null deadline included). */
function unpaidLapsedWhere(now: Date): Prisma.TrialWhereInput {
  return {
    paymentId: null,
    status: TrialStatus.AWAITING_PAYMENT,
    OR: [{ paymentDueAt: { lt: now } }, { paymentDueAt: null }],
  };
}

/** Probes both arms: a lapsed unpaid trial, or a cancelled one whose held call is still live. */
export async function hasUnpaidTrialWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const trial = await db.trial.findFirst({
    where: {
      OR: [unpaidLapsedWhere(now), untombstonedCancelledTrialWhere()],
    },
    select: { id: true },
  });
  return trial !== null;
}

async function expireUnpaidTrialsUnlocked(
  maxTrials: number,
): Promise<ExpireUnpaidTrialsResult> {
  const errors: string[] = [];
  let trialsExpired = 0;
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

  runFailures.flush();
  if (errors.length > 0) {
    console.error("❌ Unpaid trial expiry finished with errors:", errors);
  }

  return {
    success: errors.length === 0,
    trialsExpired,
    errors,
    timestamp: now.toISOString(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
