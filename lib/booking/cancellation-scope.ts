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

import prisma, { type Db, type Tx } from "@/lib/prisma";
import { recordSystemError } from "@/lib/enterprise/system-events";
import {
  isCompletedOccurrence,
  sessionsTotalOf,
} from "@/lib/booking/entitlement";
import type { CancellationPolicyTerms } from "@/lib/payments/operations/cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "@/lib/payments/operations/cancellation-policy-store";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";

/** Slots that still represent an undelivered session. */
const LIVE_SLOT_STATUSES = ["SCHEDULED", "RESCHEDULED"] as const;

export type BookingRefundContext = {
  /** The single SUCCEEDED payment funding this booking (zero-amount credit-funded included), if any. */
  paidPayment: {
    id: string;
    /** Gross captured — the base the policy percentage applies to. */
    amountPaise: number;
    /** #1161 — free_ (credit-funded) detection for the restoration rail. */
    paymentIntent: string;
    /**
     * Gross less anything already given back. Callers must clamp to this: a
     * percentage of the gross overshoots on a payment with an earlier partial
     * refund, and the refund operation rejects the whole request rather than
     * paying the remainder.
     */
    refundablePaise: number;
  } | null;
  /**
   * #1499 — the terms the buyer was sold under, loaded from the immutable policy
   * version the booking points at. Always populated: a booking with no policy row
   * resolves to the platform ladder rather than to null, so no caller has to.
   */
  policy: CancellationPolicyTerms;
  /**
   * Hours until the earliest session that has not been delivered or cancelled,
   * or null when the booking has no live session at all (an unallocated
   * subscription, or one whose sessions have all been held).
   */
  hoursUntilNextSession: number | null;
  /** Sessions delivered — COMPLETED or UNVERIFIED (#1006, #1766). */
  sessionsCompleted: number;
  /** Sessions still owed to the buyer. */
  sessionsRemaining: number;
  /**
   * #1766 — the plan entitlement a subscription was sold as (the frozen
   * `Subscription.sessionsTotal`, or the plan's total for an older row); null
   * for every other booking, which quotes off its slots.
   */
  sessionsTotal: number | null;
  /** #1766 — start instants (epoch ms, ascending) of the sessions still scheduled. */
  scheduledStarts: number[];
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

/**
 * The ONE Appointment row of the booking `ref` names. #1554 — a purchase is a
 * single wrapper and every event FK on it is unique, so an id and a parent
 * link identify the same row; the id wins when the caller already has it.
 */
export function bookingAppointmentFilter(
  ref: BookingRef,
): Prisma.AppointmentWhereInput {
  if (ref.appointmentId) return { id: ref.appointmentId };
  if (ref.subscriptionId) return { subscriptionId: ref.subscriptionId };
  if (ref.classId) return { classId: ref.classId };
  if (ref.consultationId) return { consultationId: ref.consultationId };
  if (ref.webinarId) return { webinarId: ref.webinarId };
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
  /**
   * #1695 — the cancel route reads this INSIDE its appointment lock and
   * transaction, so a reschedule or capture landing between the quote and the
   * cancel cannot change the tier underneath it. A global-client read inside a
   * transaction deadlocks on the single-connection pool (#1435), so the
   * caller's client is threaded through.
   */
  db: Db | Tx = prisma,
): Promise<BookingRefundContext> {
  const row = await db.appointment.findFirst({
    // #1554 — one wrapper per booking: this is the row checkout created, so
    // it carries the payment and the frozen terms.
    where: { ...bookingAppointmentFilter(ref), deletedAt: null },
    select: {
      id: true,
      cancellationPolicy: POLICY_TERMS_INCLUDE,
      payment: {
        where: {
          paymentStatus: "SUCCEEDED",
          // #1161 — no amount floor: a fully-credit-funded payment (amount 0,
          // free_ intent) must surface here or the cancel route's credit-
          // restoration branch can never fire (it was dead code behind this
          // filter — caught by the #1180 preview work).
          deletedAt: null,
          ...(payerUserId ? { userId: payerUserId } : {}),
        },
        select: {
          id: true,
          amount: true,
          // #1161 — free_ detection: a fully-credit-funded payment refunds as
          // credit restoration, which the amount-based tier math cannot see.
          paymentIntent: true,
          ...REFUNDABLE_BALANCE_SELECT,
        },
        orderBy: { createdAt: "asc" },
      },
      // #1766 — the unused-session quote measures against the plan.
      subscription: {
        select: {
          sessionsTotal: true,
          subscriptionPlan: { select: { totalSessions: true } },
        },
      },
      occurrences: {
        // #1554 — every attendee of a class shares the appointment's
        // occurrences, so there is no per-payer subset to scope to; the payer
        // filter lives on the payment lookup above.
        where: { deletedAt: null },
        select: { startsAt: true, completionStatus: true, isTentative: true },
      },
    },
  });

  const payments = row?.payment ?? [];
  const payment = payments[0];
  // More than one SUCCEEDED payment for one PAYER should be unreachable:
  // `@@unique([userId, appointmentId])` means one row per payer per
  // appointment, and the CHARGE_MEMBER overage side-charge is deliberately
  // created with `appointmentId: null` to avoid exactly that clash
  // (overage-settlement.ts). Which is precisely why this must not stay silent
  // — if it ever fires, the model has changed under us and a buyer is being
  // refunded less than they paid. #1554 — a class or webinar wrapper carries
  // one Payment per attendee, so the alarm is only meaningful once the lookup
  // is scoped to a payer (or the booking has exactly one: the 1:1 types).
  const singlePayer = !!payerUserId || (!ref.classId && !ref.webinarId);
  if (singlePayer && payments.length > 1) {
    void recordSystemError({
      organizationId: null,
      category: "PAYMENT",
      summary:
        `Booking carries ${payments.length} refundable payments; only the ` +
        `oldest is being refunded, so the buyer may be owed more`,
      err: new Error("MULTIPLE_REFUNDABLE_PAYMENTS"),
      context: { ref, payerUserId, paymentIds: payments.map((p) => p.id) },
    }).catch(() => {});
  }
  const paidPayment = payment
    ? {
        id: payment.id,
        amountPaise: Number(payment.amount),
        paymentIntent: payment.paymentIntent,
        refundablePaise: refundableBalancePaise(
          Number(payment.amount),
          payment,
        ),
      }
    : null;

  // The terms that bind are the ones stamped on the row the buyer paid for; a
  // booking with none reads as the platform ladder, which is what it was sold
  // under.
  const policy = termsFromPolicyRow(row?.cancellationPolicy ?? null);

  const slots = row?.occurrences ?? [];
  const liveStarts = slots
    .filter((s) =>
      (LIVE_SLOT_STATUSES as readonly string[]).includes(s.completionStatus),
    )
    .map((s) => s.startsAt.getTime())
    .sort((a, b) => a - b);

  // A RESCHEDULED row is the tombstone of a moved session, so it is not on the
  // calendar twice; a tentative row is an unpaid hold, not an entitlement.
  const scheduledStarts = slots
    .filter((s) => s.completionStatus === "SCHEDULED" && !s.isTentative)
    .map((s) => s.startsAt.getTime())
    .sort((a, b) => a - b);

  return {
    paidPayment,
    policy,
    hoursUntilNextSession:
      liveStarts.length > 0 ? (liveStarts[0] - Date.now()) / 3_600_000 : null,
    sessionsCompleted: slots.filter(isCompletedOccurrence).length,
    sessionsRemaining: liveStarts.length,
    slotsTotal: slots.length,
    sessionsTotal: row?.subscription ? sessionsTotalOf(row.subscription) : null,
    scheduledStarts,
  };
}
