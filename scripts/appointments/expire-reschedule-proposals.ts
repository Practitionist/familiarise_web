/**
 * Reschedule Proposal Expiry - Core Logic
 *
 * Expires proposals nobody answered, so a booking is never left in a state
 * neither party trusts.
 *
 * #1527 decision 9 — nobody decided, so the booking goes back to exactly what
 * it was: the released slots and the request's status are restored through the
 * same helper a withdrawal uses (lib/booking/reschedule-restore.ts). Before
 * #1846 the slots stayed released, and a confirmed session evaporated because
 * a consultant did not click. If the original time was taken while the
 * proposal was open, the restore meets the overlap constraint; the proposal
 * then expires without it, the slots stay released for the consultant to
 * re-place, and the miss is reported.
 *
 * Expiry itself is set at creation as min(now + 72h, earliest released session
 * − 24h); see lib/booking/reschedule-proposals.ts for why a single fixed timer
 * gets one of those two cases wrong.
 *
 * This module exports the core function.
 * It is imported by:
 * - jobs/appointments/expire-reschedule-proposals.ts (GitHub Actions)
 * - app/api/cleanup/reschedule-proposals/route.ts (API endpoint)
 *
 * Schedule: hourly
 */

import * as Sentry from "@sentry/nextjs";
import prisma, { type Tx } from "../../lib/prisma";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionRescheduleRequest,
} from "@/lib/booking/transitions";
import {
  reportPartialRestore,
  restoreRescheduledBooking,
  type RestorableRequest,
} from "@/lib/booking/reschedule-restore";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { reportSentryError } from "@/lib/observability/report";
import {
  AppointmentBusyError,
  withAppointmentLock,
} from "@/utils/appointmentlock";

export interface RescheduleProposalExpiryResult {
  success: boolean;
  proposalsExpired: number;
  /** Expired, but the original time was taken, so the slots stay released. */
  proposalsExpiredUnrestored: number;
  errors: string[];
  timestamp: string;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open because the work is idempotent.
export async function expireRescheduleProposals(): Promise<RescheduleProposalExpiryResult> {
  return withCronLock("expire-reschedule-proposals", { failMode: "open" }, () =>
    expireRescheduleProposalsUnlocked(),
  );
}

const EXPIRY_REASON = "Proposal lapsed without an answer";

/** The proposal fields the restore needs, read with the cohort. */
const EXPIRY_SELECT = {
  id: true,
  appointmentId: true,
  createdAt: true,
  releasedOccurrenceIds: true,
  appointment: { select: { consultationId: true, subscriptionId: true } },
} as const;

type ExpiryOutcome = "restored" | "unrestored" | "skipped";

/** The guarded EXPIRED edge, with the cohort's stale-time predicate repeated. */
function expireProposal(tx: Tx, id: string, now: Date): Promise<void> {
  return transitionRescheduleRequest(tx, {
    where: { id },
    to: "EXPIRED",
    // Repeat the cohort's stale-time predicate inside the CAS: expiry is
    // creation-only (no writer extends it), but the predicate costs nothing
    // and keeps the sweep honest if one ever appears.
    whereAnd: { expiresAt: { lt: now } },
    reason: EXPIRY_REASON,
  });
}

/**
 * Expire one lapsed proposal and restore its booking, under the appointment
 * lock every other lifecycle writer takes (#1846), so an answer or a cancel
 * cannot interleave with the restore. Throws on anything but a lost race or a
 * held lock so the caller aborts the batch loudly instead of skipping rows
 * silently.
 */
async function expireOneProposal(
  row: RestorableRequest,
  now: Date,
): Promise<ExpiryOutcome> {
  try {
    return await withAppointmentLock(row.appointmentId, async () => {
      try {
        const restored = await prisma.$transaction(async (tx) => {
          await expireProposal(tx, row.id, now);
          return restoreRescheduledBooking(tx, row, {
            actorUserId: null,
            reason: EXPIRY_REASON,
            op: "reschedule-expiry",
          });
        });
        reportPartialRestore(row, restored, "reschedule-expiry");
        return "restored";
      } catch (error) {
        if (!isExclusionViolation(error)) throw error;
        // The consultant's original time was booked while the proposal was
        // open. The restore's transaction rolled back whole, so expire alone:
        // the slots stay released and the booking waits in the allocate queue,
        // which is the pre-#1846 behaviour and the only one that fits.
        await prisma.$transaction((tx) => expireProposal(tx, row.id, now));
        reportSentryError(error, {
          subsystem: "jobs",
          op: "reschedule-expiry-overlap",
          expected: true,
          level: "warning",
          extra: { rescheduleRequestId: row.id },
        });
        return "unrestored";
      }
    });
  } catch (error) {
    // Answered between the read and the write — the answer wins, and there
    // is nothing left to expire. A held appointment lock means a live writer
    // is on this booking right now; the next hourly tick takes the row.
    if (
      error instanceof IllegalTransitionError ||
      error instanceof AppointmentBusyError
    ) {
      return "skipped";
    }
    throw error;
  }
}

async function expireRescheduleProposalsUnlocked(): Promise<RescheduleProposalExpiryResult> {
  const errors: string[] = [];
  let proposalsExpired = 0;
  let proposalsExpiredUnrestored = 0;

  console.log("⏳ Expiring lapsed reschedule proposals...");

  try {
    const now = new Date();

    // The status+expiresAt index covers this predicate exactly.
    //
    // One guarded transition per lapsed proposal rather than a bulk updateMany:
    // the helper bakes the open-from set into the UPDATE's WHERE clause (a
    // proposal answered between the read and the write matches zero rows
    // instead of being overwritten) and appends the BookingStatusHistory row
    // every other writer emits. Idempotent by construction: EXPIRED leaves the
    // open set, so a re-run after a partial failure picks up precisely what is
    // left. Clearing openForAppointmentId releases the nullable-unique
    // reservation so the pair can try again.
    //
    // Bounded batches: a pathological backlog must not load every id or hold
    // the hourly cron past the function ceiling — loop until a batch comes
    // back short. Capped per invocation too: the GH Actions workflow times
    // out at 10 minutes, and per-row transactions on a huge backlog could
    // outrun it — the next hourly tick continues where this one stopped,
    // since EXPIRED leaves the cohort.
    const BATCH_SIZE = 500;
    const MAX_BATCHES_PER_RUN = 4;
    let batchesRun = 0;
    for (;;) {
      if (batchesRun >= MAX_BATCHES_PER_RUN) break;
      const stale = await prisma.rescheduleRequest.findMany({
        where: {
          status: { in: RESCHEDULE_OPEN_STATUSES },
          expiresAt: { lt: now },
        },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        select: EXPIRY_SELECT,
      });
      if (stale.length === 0) break;

      for (const row of stale) {
        const outcome = await expireOneProposal(row, now);
        if (outcome !== "skipped") proposalsExpired += 1;
        if (outcome === "unrestored") proposalsExpiredUnrestored += 1;
      }
      batchesRun += 1;

      if (stale.length < BATCH_SIZE) break;
    }

    if (proposalsExpired > 0) {
      console.log(`   Expired ${proposalsExpired} proposal(s)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    console.error("❌ Reschedule proposal expiry failed:", message);
    // Neither caller (GH Actions wrapper, cleanup API route) sees a throw from
    // this function — the failure is folded into the result object instead —
    // so this is the only place left to report it.
    Sentry.captureException(
      error instanceof Error ? error : new Error(message),
      { tags: { subsystem: "jobs", job: "expire-reschedule-proposals" } },
    );
  }

  return {
    success: errors.length === 0,
    proposalsExpired,
    proposalsExpiredUnrestored,
    errors,
    timestamp: new Date().toISOString(),
  };
}
