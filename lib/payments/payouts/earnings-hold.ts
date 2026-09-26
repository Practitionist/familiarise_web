/**
 * #1569 — when an earning may be released.
 *
 * The hold used to start at capture time, so a booking paid a month ahead was
 * payable weeks before the call happened and a refund after the session had
 * nothing left to claw back. The anchor is now the later of the capture and the
 * END of the last live occurrence, plus the type's hold hours; a reschedule that
 * moves the call moves the release with it.
 *
 * Its own module: `replaceOccurrence` and the allocator need it, and
 * `earnings-service` pulls Stream, Razorpay and Novu through its imports.
 */

import type { PrismaLike } from "@/lib/prisma";
import { PAYOUT_CONSTANTS, type AppointmentType } from "./constants";

const HOUR_MS = 60 * 60 * 1000;

// #1569 — a voided session never anchors a hold: it was not delivered.
const DEAD_OCCURRENCE_STATUSES = [
  "CANCELLED",
  "RESCHEDULED",
  "VOIDED",
] as const;

/** Hours the type's earnings are held after the anchor. */
export function holdHoursFor(appointmentType: AppointmentType): number {
  return (
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS[appointmentType] ||
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION
  );
}

/** `max(captureTime, lastOccurrenceEndsAt) + holdHours`. */
export function computeHoldUntil(args: {
  capturedAt: Date;
  lastOccurrenceEndsAt: Date | null;
  holdHours: number;
}): Date {
  const anchor = Math.max(
    args.capturedAt.getTime(),
    args.lastOccurrenceEndsAt?.getTime() ?? 0,
  );
  return new Date(anchor + args.holdHours * HOUR_MS);
}

/** The end of the appointment's last live occurrence, or null when it has none. */
export async function lastLiveOccurrenceEnd(
  db: PrismaLike,
  appointmentId: string,
): Promise<Date | null> {
  const last = await db.appointmentOccurrence.findFirst({
    where: {
      appointmentId,
      deletedAt: null,
      completionStatus: { notIn: [...DEAD_OCCURRENCE_STATUSES] },
    },
    orderBy: { endsAt: "desc" },
    select: { endsAt: true },
  });
  return last?.endsAt ?? null;
}

/** Types whose fee buys ONE call; a subscription or class fee buys the purchase. */
const PER_CALL_TYPES: readonly AppointmentType[] = ["CONSULTATION", "WEBINAR"];

/**
 * What a capture stamps on its earnings: the paid occurrence for a per-call
 * fee (NULL for a whole-purchase fee, until it is split) and the end the hold
 * anchors on.
 */
export async function resolveEarningsAnchor(
  db: PrismaLike,
  appointmentId: string | null | undefined,
  appointmentType: AppointmentType,
): Promise<{
  appointmentOccurrenceId: string | null;
  lastOccurrenceEndsAt: Date | null;
}> {
  if (!appointmentId) {
    return { appointmentOccurrenceId: null, lastOccurrenceEndsAt: null };
  }
  const last = await db.appointmentOccurrence.findFirst({
    where: {
      appointmentId,
      deletedAt: null,
      completionStatus: { notIn: [...DEAD_OCCURRENCE_STATUSES] },
    },
    orderBy: { endsAt: "desc" },
    select: { id: true, endsAt: true },
  });
  return {
    appointmentOccurrenceId:
      last && PER_CALL_TYPES.includes(appointmentType) ? last.id : null,
    lastOccurrenceEndsAt: last?.endsAt ?? null,
  };
}

/**
 * Re-anchor every unreleased earning of the appointment's payments after its
 * live occurrences changed (first allocation, top-up, reschedule). PENDING rows
 * only: a READY or PAID row has already left the hold, and a dispute-held row
 * keeps the hold the dispute imposed.
 *
 * The capture instant is the earnings row's own `createdAt` — Payment carries
 * no capture timestamp and its `createdAt` is order creation, which can sit
 * days earlier — and a hold is never moved EARLIER than it already is: a
 * recompute may only extend the wait, never shorten a release the capture
 * already promised.
 */
export async function recomputeEarningsHold(
  db: PrismaLike,
  appointmentId: string,
): Promise<number> {
  const appointment = await db.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      appointmentType: true,
      payment: {
        where: { paymentStatus: "SUCCEEDED", deletedAt: null },
        select: { id: true },
      },
    },
  });
  if (!appointment || appointment.payment.length === 0) return 0;

  const lastEnd = await lastLiveOccurrenceEnd(db, appointmentId);
  const holdHours = holdHoursFor(
    appointment.appointmentType as AppointmentType,
  );
  // #1766 — a NULL hold is an undelivered subscription tranche; only the
  // completion path may stamp it, so a reschedule leaves it alone.
  const pending = await db.consultantEarnings.findMany({
    where: {
      paymentId: { in: appointment.payment.map((p) => p.id) },
      status: "PENDING",
      holdUntil: { not: null },
    },
    select: { id: true, createdAt: true, holdUntil: true },
  });
  let moved = 0;
  for (const earning of pending) {
    if (!earning.holdUntil) continue;
    const computed = computeHoldUntil({
      capturedAt: earning.createdAt,
      lastOccurrenceEndsAt: lastEnd,
      holdHours,
    });
    if (computed.getTime() <= earning.holdUntil.getTime()) continue;
    await db.consultantEarnings.update({
      where: { id: earning.id },
      data: { holdUntil: computed },
    });
    moved += 1;
  }
  return moved;
}
