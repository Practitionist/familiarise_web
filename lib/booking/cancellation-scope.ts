/**
 * Resolve the refund facts for a WHOLE booking, not one appointment (#1006).
 *
 * Cancellation is a whole-booking act, but a booking is not always one
 * Appointment row. A subscription is a slot-less placeholder created at
 * checkout — which is the row that carries the Payment — plus one further
 * Appointment per allocated session, none of which carry money. A class is one
 * Appointment per session with every attendee's Payment piled onto the first.
 * Only a consultation and a webinar are genuinely 1:1 with their Appointment.
 *
 * The cancel route used to read the payment, the frozen policy snapshot and
 * the start time straight off the appointment it was handed, so:
 *
 *   - cancelling a subscription refunded NOTHING. The dashboards target the
 *     next actionable session, which never carries a Payment, so the route
 *     found no payment and skipped the refund block entirely while still
 *     cancelling every slot and the subscription itself.
 *   - the refund tier depended on WHICH session you cancelled from, and was
 *     computed from the earliest slot including already-delivered ones — so a
 *     live subscription whose first session is in the past always scored 0%.
 *
 * This module answers those questions once, against every appointment of the
 * booking: which payment funds it, whose terms were frozen at purchase, when
 * the next undelivered session starts, and how much has already been consumed.
 */

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";

/** Slots that still represent an undelivered session. */
const LIVE_SLOT_STATUSES = ["SCHEDULED", "RESCHEDULED"] as const;

export type BookingRefundContext = {
  /** The single SUCCEEDED, non-zero payment funding this booking, if any. */
  paidPayment: {
    id: string;
    /** Gross captured — the base the policy percentage applies to. */
    amountPaise: number;
    /**
     * Gross less anything already given back. Callers must clamp to this: a
     * percentage of the gross overshoots on a payment with an earlier partial
     * refund, and the refund operation rejects the whole request rather than
     * paying the remainder.
     */
    refundablePaise: number;
  } | null;
  /** Terms frozen at purchase; null falls back to the platform defaults. */
  policySnapshot: Prisma.JsonValue | null;
  /**
   * Hours until the earliest session that has not been delivered or cancelled,
   * or null when the booking has no live session at all (an unallocated
   * subscription, or one whose sessions have all been held).
   */
  hoursUntilNextSession: number | null;
  /** Sessions already delivered — the proration input (#1006). */
  sessionsCompleted: number;
  /** Sessions still owed to the buyer. */
  sessionsRemaining: number;
  /**
   * Slots of ANY status on the booking. Zero means no session was ever
   * scheduled, which is a different fact from "every session is terminal" —
   * and the two must not be conflated, because only the former means the
   * consultant never held time for this buyer.
   */
  slotsTotal: number;
};

/** Identifies a booking: the parent request/event, or a lone appointment. */
export type BookingRef = {
  /** Only used when no parent link is given (trials, unlinked appointments). */
  appointmentId?: string;
  consultationId?: string | null;
  subscriptionId?: string | null;
  classId?: string | null;
  webinarId?: string | null;
};

/** Every Appointment row belonging to the same booking as `ref`. */
export function bookingAppointmentFilter(
  ref: BookingRef,
): Prisma.AppointmentWhereInput {
  if (ref.subscriptionId) return { subscriptionId: ref.subscriptionId };
  if (ref.classId) return { classId: ref.classId };
  if (ref.consultationId) return { consultationId: ref.consultationId };
  if (ref.webinarId) return { webinarId: ref.webinarId };
  // Trials and anything unlinked are genuinely single-appointment.
  if (ref.appointmentId) return { id: ref.appointmentId };
  throw new Error("bookingAppointmentFilter: no booking identifier given");
}

export async function resolveBookingRefundContext(
  ref: BookingRef,
  /**
   * Restrict the payment lookup to one buyer. Required for group events, where
   * every attendee's Payment hangs off the same appointment; omit it for 1:1
   * bookings, which have exactly one payer.
   */
  payerUserId?: string,
): Promise<BookingRefundContext> {
  const rows = await prisma.appointment.findMany({
    // Deterministic: the booking's oldest appointment is the one checkout
    // created, so it is the row that carries the payment and the frozen terms.
    orderBy: { createdAt: "asc" },
    where: { ...bookingAppointmentFilter(ref), deletedAt: null },
    select: {
      id: true,
      cancellationPolicySnapshot: true,
      payment: {
        where: {
          paymentStatus: "SUCCEEDED",
          amount: { gt: 0 },
          deletedAt: null,
          ...(payerUserId ? { userId: payerUserId } : {}),
        },
        select: {
          id: true,
          amount: true,
          refunds: { select: { amountPaise: true, status: true } },
          disputes: { select: { amountPaise: true, status: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      slotsOfAppointment: {
        where: { deletedAt: null },
        select: { startsAt: true, completionStatus: true },
      },
    },
  });

  const payer = rows.find((r) => r.payment.length > 0);
  const payment = payer?.payment[0];
  // Mirror the refund operation's own balance maths, or the caller computes an
  // amount that operation will reject. A FAILED/CANCELLED refund moved no
  // money; a lost chargeback did, via the bank rather than an app refund.
  const alreadyReturned = payment
    ? payment.refunds
        .filter((r) => r.status === "SUCCEEDED" || r.status === "PENDING")
        .reduce((a, r) => a + r.amountPaise, 0) +
      payment.disputes
        .filter((d) => d.status === "LOST" || d.status === "CHARGE_REFUNDED")
        .reduce((a, d) => a + d.amountPaise, 0)
    : 0;
  const paidPayment = payment
    ? {
        id: payment.id,
        amountPaise: Number(payment.amount),
        refundablePaise: Math.max(0, Number(payment.amount) - alreadyReturned),
      }
    : null;

  // The terms that bind are the ones frozen on the row the buyer actually paid
  // for. The subscription placeholder predates the snapshot write, so fall back
  // to any session row's snapshot before dropping to the platform defaults.
  const policySnapshot =
    payer?.cancellationPolicySnapshot ??
    rows.find((r) => r.cancellationPolicySnapshot !== null)
      ?.cancellationPolicySnapshot ??
    null;

  const slots = rows.flatMap((r) => r.slotsOfAppointment);
  const liveStarts = slots
    .filter((s) =>
      (LIVE_SLOT_STATUSES as readonly string[]).includes(s.completionStatus),
    )
    .map((s) => s.startsAt.getTime())
    .sort((a, b) => a - b);

  return {
    paidPayment,
    policySnapshot,
    hoursUntilNextSession:
      liveStarts.length > 0 ? (liveStarts[0] - Date.now()) / 3_600_000 : null,
    sessionsCompleted: slots.filter((s) => s.completionStatus === "COMPLETED")
      .length,
    sessionsRemaining: liveStarts.length,
    slotsTotal: slots.length,
  };
}
