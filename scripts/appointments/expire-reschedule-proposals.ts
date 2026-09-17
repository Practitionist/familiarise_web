/**
 * Reschedule Proposal Expiry - Core Logic
 *
 * Auto-declines proposals nobody answered, so a booking is never left in a
 * state neither party trusts.
 *
 * A lapsed proposal falls back to the consultant's ordinary allocate queue
 * rather than reverting the request: the slots stay released, so the consultant
 * still sees work to do — they simply lose the consultee's suggested times.
 * That keeps the flow from ever dead-ending.
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
import prisma from "../../lib/prisma";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionRescheduleRequest,
} from "../../lib/booking/transitions";
import { IllegalTransitionError } from "../../lib/enterprise/transitions";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface RescheduleProposalExpiryResult {
  success: boolean;
  proposalsExpired: number;
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

async function expireRescheduleProposalsUnlocked(): Promise<RescheduleProposalExpiryResult> {
  const errors: string[] = [];
  let proposalsExpired = 0;

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
    const stale = await prisma.rescheduleRequest.findMany({
      where: {
        status: { in: RESCHEDULE_OPEN_STATUSES },
        expiresAt: { lt: now },
      },
      select: { id: true },
    });

    for (const row of stale) {
      try {
        await prisma.$transaction((tx) =>
          transitionRescheduleRequest(tx, {
            where: { id: row.id },
            to: "EXPIRED",
            reason: "Proposal lapsed without an answer",
          }),
        );
        proposalsExpired += 1;
      } catch (error) {
        // Answered between the read and the write — the answer wins, and
        // there is nothing left to expire.
        if (error instanceof IllegalTransitionError) continue;
        throw error;
      }
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
    errors,
    timestamp: new Date().toISOString(),
  };
}
