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
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
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

/**
 * Expire one lapsed proposal through the guarded transition. Returns true
 * when it moved. Throws on anything but a lost race so the caller aborts the
 * batch loudly instead of skipping rows silently.
 */
async function expireOneProposal(id: string, now: Date): Promise<boolean> {
  try {
    await prisma.$transaction((tx) =>
      transitionRescheduleRequest(tx, {
        where: { id },
        to: "EXPIRED",
        // Repeat the cohort's stale-time predicate inside the CAS:
        // expiry is creation-only (no writer extends it), but the
        // predicate costs nothing and keeps the sweep honest if one
        // ever appears.
        whereAnd: { expiresAt: { lt: now } },
        reason: "Proposal lapsed without an answer",
      }),
    );
    return true;
  } catch (error) {
    // Answered between the read and the write — the answer wins, and
    // there is nothing left to expire.
    if (error instanceof IllegalTransitionError) return false;
    throw error;
  }
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
    //
    // Bounded batches: a pathological backlog must not load every id or hold
    // the hourly cron past the function ceiling — loop until a batch comes
    // back short.
    const BATCH_SIZE = 500;
    for (;;) {
      const stale = await prisma.rescheduleRequest.findMany({
        where: {
          status: { in: RESCHEDULE_OPEN_STATUSES },
          expiresAt: { lt: now },
        },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        select: { id: true },
      });
      if (stale.length === 0) break;

      for (const row of stale) {
        if (await expireOneProposal(row.id, now)) proposalsExpired += 1;
      }

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
    errors,
    timestamp: new Date().toISOString(),
  };
}
