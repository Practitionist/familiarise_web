// Seat rules shared by pricing, the event handlers and the payment write: who
// already holds a seat, which prior payment can be re-minted, and enrolment.

import type { Tx } from "@/lib/prisma";
import { PaymentStatus, type Prisma } from "@prisma/client";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  classEnrolmentFrom,
  type OpenClassEnrolment,
} from "@/lib/booking/class-enrolment";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { isPriceFreePayment } from "@/lib/payments/funding-rail";
import type { SeatRegistration } from "@/lib/booking/participants";
import {
  latestSeatReasons,
  REJOIN_OPENING_REASONS,
} from "@/lib/booking/seat-history";
import { conductRemovalStands } from "@/lib/support/conduct-removal-state";

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

const REMOVED_SEAT_MESSAGE =
  "The organiser removed you from this event. Contact support if you think this was a mistake.";

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

const PRIOR_SEAT_PAYMENT_SELECT = {
  id: true,
  userId: true,
  paymentIntent: true,
  gatewayPaymentId: true,
  amount: true,
  originalAmount: true,
  taxAmount: true,
  gstRegime: true,
  currency: true,
  paymentGateway: true,
  paymentStatus: true,
  refunds: {
    where: { status: "SUCCEEDED" },
    select: { amountPaise: true },
  },
  // The seat this payment funded; a released one means the buyer left, a marked one that they were removed.
  appointmentParticipants: {
    select: { id: true, status: true, removedByUserId: true },
  },
} satisfies Prisma.PaymentSelect;

type PriorSeatTx = Tx;

function queryPriorSeat(
  tx: PriorSeatTx,
  userId: string,
  appointmentId: string,
) {
  return tx.payment.findFirst({
    where: { userId, appointmentId },
    select: PRIOR_SEAT_PAYMENT_SELECT,
  });
}

type PriorSeatRow = NonNullable<Awaited<ReturnType<typeof queryPriorSeat>>>;

/** A prior seat payment, with the SEAT reason that decides a rejoin and whether a conduct removal blocks a re-mint. */
export type PriorSeatPayment = PriorSeatRow & {
  lastSeatReason: string | null;
  conductStands: boolean;
};

const isReleasedSeat = (seat: { status: string }) =>
  seat.status === "CANCELLED" || seat.status === "REFUNDED";

/** An unmarked released seat on a lapsed or open order: a re-mint would revive it, so a standing conduct case must be read. */
function mayRemintReleased(row: PriorSeatRow): boolean {
  const seats = row.appointmentParticipants ?? [];
  return (
    row.paymentStatus !== PaymentStatus.SUCCEEDED &&
    seats.length > 0 &&
    seats.every((seat) => isReleasedSeat(seat) && !seat.removedByUserId)
  );
}

/** Whether the row is a left price-free seat, the only kind whose history decides the answer. */
function mayRejoin(row: PriorSeatRow): boolean {
  const seats = row.appointmentParticipants;
  return (
    row.paymentStatus === PaymentStatus.SUCCEEDED &&
    row.amount === 0 &&
    isPriceFreePayment({
      paymentIntent: row.paymentIntent,
      amountPaise: row.amount,
      listPricePaise: row.originalAmount,
    }) &&
    seats.length > 0 &&
    seats.every((seat) => seat.status === "CANCELLED" && !seat.removedByUserId)
  );
}

/** Attaches the latest SEAT reason and a standing conduct removal, read only for rows they could decide. */
async function withLastSeatReason(
  tx: PriorSeatTx,
  appointmentId: string,
  rows: PriorSeatRow[],
): Promise<PriorSeatPayment[]> {
  const seatIds = rows
    .filter(mayRejoin)
    .flatMap((row) => row.appointmentParticipants.map((seat) => seat.id));
  const latest = await latestSeatReasons(tx, seatIds);
  const priors: PriorSeatPayment[] = [];
  for (const row of rows) {
    priors.push({
      ...row,
      lastSeatReason: mayRejoin(row)
        ? (latest.get(row.appointmentParticipants[0].id) ?? null)
        : null,
      conductStands: mayRemintReleased(row)
        ? await conductRemovalStands(appointmentId, row.userId, tx)
        : false,
    });
  }
  return priors;
}

/** The buyer's earlier Payment on a shared webinar/class appointment, if any. */
export async function findPriorSeatPayment(
  tx: PriorSeatTx,
  userId: string,
  appointmentId: string,
): Promise<PriorSeatPayment | null> {
  const row = await queryPriorSeat(tx, userId, appointmentId);
  return row
    ? ((await withLastSeatReason(tx, appointmentId, [row]))[0] ?? null)
    : null;
}

/** Each user's prior Payment on the appointment, in one query; Payment is unique per (userId, appointmentId). */
export async function findPriorSeatPayments(
  tx: PriorSeatTx,
  appointmentId: string,
  userIds: readonly string[],
): Promise<Map<string, PriorSeatPayment>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx.payment.findMany({
    where: { appointmentId, userId: { in: [...userIds] } },
    select: PRIOR_SEAT_PAYMENT_SELECT,
  });
  const priors = await withLastSeatReason(tx, appointmentId, rows);
  return new Map(priors.map((row) => [row.userId, row]));
}

export type SeatRebuyRefusal =
  "CHECKOUT_OPEN" | "REFUNDED" | "REMOVED" | "LEFT" | "ALREADY_REGISTERED";

/** How a prior seat payment stands: a refusal, a free seat the buyer may rejoin, or null to re-mint. */
export type PriorSeatStanding = SeatRebuyRefusal | "REJOINABLE" | null;

/** The one classifier pricing, the payment write and the waitlist share. */
export function priorSeatStanding(prior: PriorSeatPayment): PriorSeatStanding {
  const seats = prior.appointmentParticipants ?? [];
  // Every seat released (CANCELLED or REFUNDED, free or paid): the buyer left, not still held.
  const released = seats.length > 0 && seats.every(isReleasedSeat);
  // A removal outlasts its order: a lapsed or open checkout never re-mints a removed seat.
  if (
    released &&
    (seats.some((seat) => Boolean(seat.removedByUserId)) || prior.conductStands)
  ) {
    return "REMOVED";
  }
  if (
    prior.paymentStatus === PaymentStatus.EXPIRED ||
    prior.paymentStatus === PaymentStatus.FAILED
  ) {
    return null;
  }
  if (prior.paymentStatus === PaymentStatus.PENDING) return "CHECKOUT_OPEN";
  const refundedPaise = (prior.refunds ?? []).reduce(
    (total, refund) => total + sumPaise(refund.amountPaise),
    0,
  );
  // A zero-amount seat has no refund rows, so only a priced seat can read as refunded.
  if (prior.amount > 0 && refundedPaise >= prior.amount) return "REFUNDED";
  if (!released) return "ALREADY_REGISTERED";
  // Only a price-free seat left by its holder revives in place; its payment stays as it was.
  const priceFree =
    prior.amount === 0 &&
    isPriceFreePayment({
      paymentIntent: prior.paymentIntent,
      amountPaise: prior.amount,
      listPricePaise: prior.originalAmount,
    });
  // A seat with no SEAT history left before history was kept, so it waits for a staff lift.
  const opened =
    prior.lastSeatReason !== null &&
    (REJOIN_OPENING_REASONS as readonly string[]).includes(
      prior.lastSeatReason,
    );
  return priceFree &&
    opened &&
    seats.every((seat) => seat.status === "CANCELLED")
    ? "REJOINABLE"
    : "LEFT";
}

/** Why a prior seat payment blocks a new one; null for an EXPIRED or FAILED row and a rejoinable free seat. */
export function seatRebuyRefusal(
  prior: PriorSeatPayment,
): SeatRebuyRefusal | null {
  const standing = priorSeatStanding(prior);
  return standing === "REJOINABLE" ? null : standing;
}

/** A prior seat that refuses before order reuse: a settled seat, or a removed one whatever its order. */
export function refusesBeforeReuse(prior: PriorSeatPayment | null): boolean {
  return (
    prior !== null &&
    (prior.paymentStatus === PaymentStatus.SUCCEEDED ||
      priorSeatStanding(prior) === "REMOVED")
  );
}

/** The buyer may start a seat checkout on this appointment. */
export function canBuySeat(prior: PriorSeatPayment | null): boolean {
  return prior === null || seatRebuyRefusal(prior) === null;
}

/** An EXPIRED or FAILED seat payment is re-minted and a left free seat rejoins; every other prior row refuses. */
export function assertSeatRemintable(
  prior: PriorSeatPayment,
  kind: "WEBINAR" | "CLASS",
): void {
  const refusal = seatRebuyRefusal(prior);
  if (refusal === null) return;
  if (refusal === "CHECKOUT_OPEN") {
    throw new BookingRuleError(
      "PAYMENT_ALREADY_EXISTS",
      SEAT_CHECKOUT_OPEN_MESSAGE,
    );
  }
  if (refusal === "REMOVED") {
    throw new BookingRuleError("SEAT_REBUY_UNSUPPORTED", REMOVED_SEAT_MESSAGE);
  }
  if (refusal === "REFUNDED") {
    throw new BookingRuleError(
      "SEAT_REBUY_UNSUPPORTED",
      "Your earlier seat here was refunded, and a refunded seat can't be bought again yet. Contact support if you'd like to rejoin.",
    );
  }
  if (refusal === "LEFT") {
    throw new BookingRuleError(
      "SEAT_REBUY_UNSUPPORTED",
      "You left this event earlier, and a seat you've left can't be bought again yet. Contact support if you'd like to rejoin.",
    );
  }
  throw alreadyHeldSeatError(kind);
}

/**
 * How an event checkout records its seat, refusing first when the prior payment
 * may not be bought again. A rejoin revives only the CANCELLED seat it classified.
 */
export function seatRegistrationFor(
  prior: PriorSeatPayment | null,
  userId: string,
  kind: "WEBINAR" | "CLASS",
): SeatRegistration {
  const standing = prior ? priorSeatStanding(prior) : null;
  if (prior && standing !== null && standing !== "REJOINABLE") {
    assertSeatRemintable(prior, kind);
  }
  return standing === "REJOINABLE"
    ? {
        actorUserId: userId,
        reviveReason: "rejoined",
        reviveFromIn: ["CANCELLED"],
      }
    : { actorUserId: userId, reviveReason: "registered" };
}

/**
 * Stamps the seat this checkout just wrote with its terms, matching only an unmarked row in
 * the status the checkout set; a seat the write did not reach refuses the commit.
 */
export async function stampRecordedSeat(
  tx: Pick<Tx, "appointmentParticipant">,
  args: {
    appointmentId: string;
    userId: string;
    status: "HELD" | "CONFIRMED";
    kind: "WEBINAR" | "CLASS";
    data: Prisma.AppointmentParticipantUpdateManyMutationInput;
  },
): Promise<void> {
  const seat = { appointmentId: args.appointmentId, userId: args.userId };
  const stamped = await tx.appointmentParticipant.updateMany({
    where: { ...seat, status: args.status, removedByUserId: null },
    data: args.data,
  });
  if (stamped.count === 1) return;
  const row = await tx.appointmentParticipant.findFirst({
    where: seat,
    select: { removedByUserId: true },
  });
  if (row?.removedByUserId) {
    throw new BookingRuleError("SEAT_REBUY_UNSUPPORTED", REMOVED_SEAT_MESSAGE);
  }
  throw alreadyHeldSeatError(args.kind);
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
