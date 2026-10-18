// Seat rules shared by pricing, the event handlers and the payment write: who
// already holds a seat, which prior payment can be re-minted, and enrolment.

import type { Tx } from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  classEnrolmentFrom,
  type OpenClassEnrolment,
} from "@/lib/booking/class-enrolment";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";

/** A confirmed seat for this buyer; a HELD one belongs to an open order the reuse step may resume. */
export function holdsSettledSeat(
  appointment: { participants: { userId: string; status: string }[] } | null,
  userId: string,
): boolean {
  return (
    appointment?.participants.some(
      (seat) => seat.userId === userId && seat.status !== "HELD",
    ) ?? false
  );
}

/** The buyer already holds a live seat: a modelled 409, never a fault. */
export function alreadyHeldSeatError(
  kind: "WEBINAR" | "CLASS",
): BookingRuleError {
  return new BookingRuleError(
    "ALREADY_REGISTERED",
    kind === "CLASS"
      ? "You are already enrolled in this class"
      : "You are already registered for this webinar",
  );
}

export const SEAT_CHECKOUT_OPEN_MESSAGE =
  "You already have a checkout open for this seat. Finish it, or wait a few minutes for it to lapse and try again. You have not been charged for this attempt.";

/** One Payment per buyer per event appointment: a second insert is a raced seat checkout, answered 409. */
export function asSeatPaymentConflict(err: unknown): unknown {
  if (
    !isUniqueViolationOn(err, "userId") ||
    !isUniqueViolationOn(err, "appointmentId")
  ) {
    return err;
  }
  return new BookingRuleError(
    "PAYMENT_ALREADY_EXISTS",
    SEAT_CHECKOUT_OPEN_MESSAGE,
  );
}

/** The buyer's earlier Payment on a shared webinar/class appointment, if any. */
export function findPriorSeatPayment(
  tx: Tx,
  userId: string,
  appointmentId: string,
) {
  return tx.payment.findFirst({
    where: { userId, appointmentId },
    select: {
      id: true,
      userId: true,
      paymentIntent: true,
      gatewayPaymentId: true,
      amount: true,
      originalAmount: true,
      taxAmount: true,
      currency: true,
      paymentGateway: true,
      paymentStatus: true,
      refunds: {
        where: { status: "SUCCEEDED" },
        select: { amountPaise: true },
      },
    },
  });
}

/** Only an EXPIRED or FAILED seat payment is re-minted in place; every other prior row refuses. */
export function assertSeatRemintable(
  prior: NonNullable<Awaited<ReturnType<typeof findPriorSeatPayment>>>,
  kind: "WEBINAR" | "CLASS",
): void {
  if (
    prior.paymentStatus === PaymentStatus.EXPIRED ||
    prior.paymentStatus === PaymentStatus.FAILED
  ) {
    return;
  }
  if (prior.paymentStatus === PaymentStatus.PENDING) {
    throw new BookingRuleError(
      "PAYMENT_ALREADY_EXISTS",
      SEAT_CHECKOUT_OPEN_MESSAGE,
    );
  }
  const refundedPaise = (prior.refunds ?? []).reduce(
    (total, refund) => total + sumPaise(refund.amountPaise),
    0,
  );
  // A zero-amount seat has no refund rows, so only a priced seat can read as refunded.
  if (prior.amount > 0 && refundedPaise >= prior.amount) {
    throw new BookingRuleError(
      "SEAT_REBUY_UNSUPPORTED",
      "Your earlier seat here was refunded, and a refunded seat can't be bought again yet. Contact support if you'd like to rejoin.",
    );
  }
  throw alreadyHeldSeatError(kind);
}

/** #1819 — a batch past its host's cutoff refuses with ENROLMENT_CLOSED (409). */
export function assertClassEnrolmentOpen(
  enrolment: ReturnType<typeof classEnrolmentFrom>,
): OpenClassEnrolment {
  if (enrolment.state === "unscheduled") {
    throw new Error(
      "This class has not been scheduled yet. Enrollment opens once all sessions are scheduled.",
    );
  }
  if (enrolment.state === "closed") {
    throw new BookingRuleError(
      "ENROLMENT_CLOSED",
      "Enrolment for this batch has closed. Please choose a batch that has not started yet.",
    );
  }
  return enrolment;
}
