/**
 * Tentative Slot Cleanup - Core Logic
 *
 * Releases slots marked as isTentative=true that are associated with
 * abandoned booking flows (no successful payment after 24 hours, #833).
 *
 * This happens when:
 * - User started booking but never completed payment
 * - Payment failed and user abandoned checkout
 * - System error prevented slot release after payment failure
 *
 * This module exports the core cleanup function.
 * It is imported by:
 * - jobs/cleanup-tentative-occurrences.ts (GitHub Actions)
 * - app/api/cleanup/tentative-occurrences/route.ts (API endpoint)
 *
 * Schedule: Every 2 hours
 */

import prisma from "../../lib/prisma";
import type { PrismaLike } from "../../lib/prisma";
import {
  PaymentStatus,
  OccurrenceCompletionStatus,
  type Prisma,
} from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { transitionSlotsInChunks } from "@/lib/booking/slot-release";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";

// #833 — hours, not days: gateway orders expire well inside a day, so a
// 7-day hold locked users out of rebooking for most of a week. 24h keeps
// margin over Payment.expiresAt and the 2-hourly cron cadence; the parent
// status guard below still protects requests under consultant review.
const TENTATIVE_EXPIRATION_HOURS = 24;

const REVIEWING = ["PENDING", "APPROVED_PENDING_PAYMENT"] as const;
const LIVE_EVENT = ["SCHEDULED"] as const;
// A trial holding its time: the unpaid-trial sweep ends an unpaid hold.
const LIVE_TRIAL = ["AWAITING_PAYMENT", "SCHEDULED"] as const;

/**
 * A live tentative hold with no successful payment whose parent is not under
 * review, a live event or a live trial, and whose booking has no open
 * reschedule request (a session released for a move is tentative until that
 * request ends); the release CAS re-states it under the row lock.
 */
function releasableTentativeWhere() {
  return {
    isTentative: true,
    deletedAt: null,
    appointment: {
      payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
      rescheduleRequests: {
        none: { status: { in: RESCHEDULE_OPEN_STATUSES } },
      },
      AND: [
        {
          OR: [
            { consultation: null },
            { consultation: { status: { notIn: [...REVIEWING] } } },
          ],
        },
        {
          OR: [
            { subscription: null },
            { subscription: { status: { notIn: [...REVIEWING] } } },
          ],
        },
        {
          OR: [
            { webinar: null },
            { webinar: { status: { notIn: [...LIVE_EVENT] } } },
          ],
        },
        {
          OR: [
            { class: null },
            { class: { status: { notIn: [...LIVE_EVENT] } } },
          ],
        },
        {
          OR: [
            { trial: null },
            { trial: { status: { notIn: [...LIVE_TRIAL] } } },
          ],
        },
      ],
    },
  } satisfies Prisma.AppointmentOccurrenceWhereInput;
}

/** Grace runs from the last write, so a reschedule that re-holds an old row gets the full window. */
function staleTentativeWhere(expirationDate: Date) {
  return {
    ...releasableTentativeWhere(),
    updatedAt: { lt: expirationDate },
  } satisfies Prisma.AppointmentOccurrenceWhereInput;
}

const tentativeExpiration = (nowMs: number) =>
  new Date(nowMs - TENTATIVE_EXPIRATION_HOURS * 60 * 60 * 1000);

export async function hasTentativeOccurrenceWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.appointmentOccurrence.findFirst({
    where: staleTentativeWhere(tentativeExpiration(now.getTime())),
    select: { id: true },
  });
  return row !== null;
}

export interface TentativeSlotCleanupResult {
  success: boolean;
  slotsReleased: number;
  appointmentsAffected: number;
  errors: string[];
  timestamp: string;
}

// #1169 PR 6 — per-run cap (expire-event-channels precedent): an
// unbounded scan over every stale tentative row OOMs/times out the
// function before it pages. Oldest-first so hourly runs drain a backlog.
const MAX_SLOTS_PER_RUN = 5000;

/**
 * Find and release stale tentative slots
 *
 * `maxPerRun` is the bound, and it is overridable per invocation because the
 * HTTP twin passes one: a soft cancel per chunk over 5,000 rows is 5,000 row
 * locks inside the ticker's 6 s abort, and the cohort read carries a four-way OR
 * over four relations, so it is one of the more expensive reads in the fleet
 * per row. The write stamps `deletedAt`, which takes the row out of the cohort
 * the next read collects, so a smaller cap is a budget and not a drop.
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: this releases holds and blocks rebooking, so
// a silent unlocked double-run under a Redis outage is worse than a missed
// 2-hourly tick (#1859 M-P0-11). The release itself stays CAS-guarded (#829),
// the lock is what collapses the double-fire to a single run.
export async function cleanupTentativeOccurrences(opts?: {
  maxPerRun?: number;
}): Promise<TentativeSlotCleanupResult> {
  const maxPerRun =
    opts?.maxPerRun && opts.maxPerRun > 0
      ? Math.floor(opts.maxPerRun)
      : MAX_SLOTS_PER_RUN;
  return withCronLock(
    "cleanup-tentative-occurrences",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => cleanupTentativeSlotsUnlocked(maxPerRun),
  );
}

async function cleanupTentativeSlotsUnlocked(
  maxPerRun: number,
): Promise<TentativeSlotCleanupResult> {
  const errors: string[] = [];
  let slotsReleased = 0;
  const appointmentsAffected = new Set<string>();

  const expirationDate = tentativeExpiration(Date.now());

  console.log("🧹 Starting tentative slot cleanup...");
  console.log(`   Expiration threshold: ${TENTATIVE_EXPIRATION_HOURS} hours`);
  console.log(`   Per-run cap: ${maxPerRun} slot(s)`);

  try {
    // Find tentative slots with no successful payment AND whose parent event
    // is not actively pending review (PENDING / APPROVED_PENDING_PAYMENT).
    // Without this check, we could release slots a consultant is reviewing.
    const staleTentativeSlots = await prisma.appointmentOccurrence.findMany({
      take: maxPerRun,
      orderBy: { updatedAt: "asc" },
      where: staleTentativeWhere(expirationDate),
      include: {
        appointment: {
          include: {
            payment: { select: { id: true, paymentStatus: true } },
            consultation: {
              select: {
                id: true,
                status: true,
                requestedBy: {
                  include: { user: { select: { name: true, email: true } } },
                },
              },
            },
            subscription: {
              select: {
                id: true,
                status: true,
                requestedBy: {
                  include: { user: { select: { name: true, email: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (staleTentativeSlots.length >= maxPerRun) {
      console.warn(
        JSON.stringify({
          event: "cleanup_tentative_slots_capped",
          cap: maxPerRun,
          note: "backlog exceeds one run; the next scheduled run continues",
          timestamp: new Date().toISOString(),
        }),
      );
    }

    console.log(`Found ${staleTentativeSlots.length} stale tentative slots`);

    for (const slot of staleTentativeSlots) {
      console.log(`\nProcessing tentative slot ${slot.id}`);
      console.log(`   Appointment ID: ${slot.appointmentId}`);
      console.log(
        `   Created: ${slot.createdAt.toISOString()} (last write ${slot.updatedAt.toISOString()})`,
      );
      console.log(
        `   Slot time: ${slot.startsAt.toISOString()} - ${slot.endsAt.toISOString()}`,
      );

      // Get user info
      const consultation = slot.appointment.consultation;
      const subscription = slot.appointment.subscription;
      const user =
        consultation?.requestedBy?.user || subscription?.requestedBy?.user;
      console.log(
        `   User: ${user?.name || "Unknown"} (${user?.email || "N/A"})`,
      );

      // Log payment status
      const payments = slot.appointment.payment;
      if (payments.length === 0) {
        console.log(`   Payment: None`);
      } else {
        payments.forEach((p) => {
          console.log(`   Payment ${p.id}: ${p.paymentStatus}`);
        });
      }

      appointmentsAffected.add(slot.appointmentId);
    }

    // Release the stale tentative slots so the consultant's calendar frees
    // up. Doctrine rule 2: the slot is freed by status alone, so this is a
    // CAS soft-cancel — the row survives for support and disputes.
    // Only slots whose IDs we already confirmed are safe to release.
    if (staleTentativeSlots.length > 0) {
      // One transaction so the tombstone and its history rows land together.
      slotsReleased = await transitionSlotsInChunks(
        staleTentativeSlots.map((s) => s.id),
        (idChunk) => ({
          // Re-stated under the row lock: a hold confirmed by a capture, a
          // parent back under review or live, or a move opened since the scan
          // keeps its slot.
          where: { id: { in: idChunk }, ...releasableTentativeWhere() },
          to: OccurrenceCompletionStatus.CANCELLED,
          data: { deletedAt: new Date() },
          // Default from-set on purpose (SCHEDULED / UNVERIFIED / RESCHEDULED):
          // auto-complete stamps a past SCHEDULED slot UNVERIFIED an hour after
          // it ends and does not exclude tentative rows, so a 24h-old hold is
          // usually UNVERIFIED by now. Only COMPLETED is out of reach, which is
          // right — a session that actually happened is not a stale hold.
          allowZero: true,
        }),
      );

      console.log(`\n✅ Released ${slotsReleased} tentative slots`);
    }

    // Summary
    console.log("\n📊 Tentative Slot Cleanup Summary:");
    console.log(`   Slots released: ${slotsReleased}`);
    console.log(`   Appointments affected: ${appointmentsAffected.size}`);
  } catch (error) {
    const msg = `Failed to cleanup tentative slots: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
  }

  return {
    success: errors.length === 0,
    slotsReleased,
    appointmentsAffected: appointmentsAffected.size,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
