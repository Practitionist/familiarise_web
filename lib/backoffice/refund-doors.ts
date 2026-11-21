/**
 * #1771 K-5 — the admin refund doors' arithmetic. The refund itself always
 * goes through `refundBookingPayment`; this only prices a ladder override.
 */

import { z } from "zod";

import prisma from "@/lib/prisma";
import { resolveBookingRefundContext } from "@/lib/booking/cancellation-scope";
import { fundingRailForIntent } from "@/lib/payments/funding-rail";
import { quoteBookingRefund } from "@/lib/payments/operations/cancellation-policy";
import {
  assertRefundReplayMatches,
  findDedupedRefund,
  RefundGatewayError,
  type RefundReplayRequest,
} from "@/lib/payments/operations/refund";
import { handSettledOwedSchema } from "@/lib/payments/operations/refund-owed";
import { OpsRefusal } from "./ops-refusal-error";
import { LIVE_PARTICIPANT_STATUSES } from "@/lib/booking/participants";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";

/**
 * The cancellation quote with every rung replaced by `tierOverridePct`: the
 * same proration and the same clamp to the refundable balance, so an override
 * can lift or lower the percentage but never the base it applies to. The
 * override rides the consultant-initiated rung, which the ladder applies to
 * every session whatever its notice.
 */
export async function ladderOverrideAmount(
  paymentId: string,
  tierOverridePct: number,
): Promise<{ amountPaise: number; proratedBasePaise: number }> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId, deletedAt: null },
    select: {
      paymentIntent: true,
      appointment: {
        select: {
          id: true,
          consultationId: true,
          subscriptionId: true,
          classId: true,
          webinarId: true,
        },
      },
    },
  });
  const appointment = payment?.appointment;
  if (!payment || !appointment) {
    throw new OpsRefusal("PAYMENT_NOT_FOUND", "Payment not found.", 404);
  }
  if (appointment.classId || appointment.webinarId) {
    throw new OpsRefusal(
      "LADDER_OVERRIDE_ONE_TO_ONE",
      "A ladder override prices a 1:1 booking; refund a class or webinar seat by amount.",
    );
  }
  if (fundingRailForIntent(payment.paymentIntent) === "CREDITS") {
    throw new OpsRefusal(
      "CREDIT_FUNDED",
      "This booking was paid in credits, which come back whole — use a full refund.",
    );
  }
  const ctx = await resolveBookingRefundContext({
    appointmentId: appointment.id,
    consultationId: appointment.consultationId,
    subscriptionId: appointment.subscriptionId,
  });
  if (ctx.paidPayment?.id !== paymentId) {
    throw new OpsRefusal(
      "NOTHING_TO_REFUND",
      "This payment is not the one funding the booking.",
    );
  }
  const quote = quoteBookingRefund({
    policy: { ...ctx.policy, consultantInitiatedPct: tierOverridePct },
    hoursUntilNextSession: ctx.hoursUntilNextSession,
    slotsTotal: ctx.slotsTotal,
    sessionsRemaining: ctx.sessionsRemaining,
    sessionsTotal: ctx.sessionsTotal,
    sessionsRefunded: ctx.sessionsRefunded,
    sessionsCompleted: ctx.sessionsCompleted,
    scheduledStarts: ctx.scheduledStarts,
    nowMs: ctx.quotedAtMs,
    alreadyRefundedPaise: ctx.alreadyRefundedPaise,
    isSubscription: !!appointment.subscriptionId,
    isConsultantInitiated: true,
    isFreeCreditFunded: false,
    grossPaise: ctx.paidPayment.amountPaise,
    refundablePaise: ctx.paidPayment.refundablePaise,
  });
  return {
    amountPaise: quote.refundPaise,
    proratedBasePaise: quote.proratedBasePaise,
  };
}

const SETTLED_OWED_METADATA = z.object({ settledOwed: handSettledOwedSchema });

/**
 * A gateway refund whose call threw after its keyed row was reserved is in
 * flight, not failed: the row stays PENDING for the reconcile cron (#779).
 * The door answers that row, so the retry and the first call agree (QA #1824).
 */
export async function refundInFlightOr(
  err: unknown,
  dedupeKey: string,
  request: RefundReplayRequest,
) {
  if (!(err instanceof RefundGatewayError)) throw err;
  const row = await findDedupedRefund(dedupeKey, request).catch(() => null);
  if (!row) {
    throw new OpsRefusal(
      "GATEWAY_REFUND_FAILED",
      "The gateway refused the refund and nothing is pending — check the payment and try again.",
      502,
    );
  }
  // A hand refund still in flight has already settled the owed refund it took over.
  const recorded = await prisma.refund
    .findUnique({ where: { id: row.refundId }, select: { metadata: true } })
    .then((r) => SETTLED_OWED_METADATA.safeParse(r?.metadata))
    .catch(() => null);
  return {
    refundId: row.refundId,
    amountRefundedPaise: row.amountRefundedPaise,
    rail: "GATEWAY" as const,
    status: row.status,
    ...(recorded?.success ? { settledOwed: recorded.data.settledOwed } : {}),
  };
}

/** #1834 — the occurrence must sit on the payment's booking under a live seat it funds. */
async function assertSessionOnPayment(paymentId: string, occurrenceId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId, deletedAt: null },
    select: {
      appointmentId: true,
      userId: true,
      amount: true,
      createdAt: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
  const occurrence = await prisma.appointmentOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { appointmentId: true, startsAt: true },
  });
  const seat =
    payment?.appointmentId &&
    occurrence?.appointmentId === payment.appointmentId
      ? await prisma.appointmentParticipant.findFirst({
          where: {
            appointmentId: payment.appointmentId,
            userId: payment.userId,
            status: { in: LIVE_PARTICIPANT_STATUSES },
            OR: [{ paymentId }, { paymentId: null }],
          },
          select: { createdAt: true },
        })
      : null;
  if (!seat || !payment || !occurrence) {
    throw new OpsRefusal(
      "SESSION_NOT_ON_PAYMENT",
      "That session is not part of this payment's booking, or the payment holds no live seat for it.",
    );
  }
  // The ledger's join time: the later of the seat row and its payment.
  const joinedAt = Math.max(
    seat.createdAt.getTime(),
    payment.createdAt.getTime(),
  );
  if (occurrence.startsAt.getTime() <= joinedAt) {
    throw new OpsRefusal(
      "SESSION_BEFORE_SEAT",
      "That session started before this seat was bought, so the seat was never owed it.",
    );
  }
  return payment;
}

/**
 * #1834 — a session key refunds once. A retry that resolves to the first
 * refund's amount replays it, even after that refund ended the seat; any
 * other amount is refused, never deduped.
 */
export async function assertSessionRefundable(args: {
  paymentId: string;
  occurrenceId: string;
  dedupeKey: string;
  amountPaise: number | undefined;
}): Promise<void> {
  const prior = await prisma.refund.findUnique({
    where: { dedupeKey: args.dedupeKey },
    select: { paymentId: true, amountPaise: true, status: true },
  });
  if (!prior || prior.status === "FAILED" || prior.status === "CANCELLED") {
    await assertSessionOnPayment(args.paymentId, args.occurrenceId);
    return;
  }
  assertRefundReplayMatches(prior, { paymentId: args.paymentId });
  // The key names the session and payment, so the stored refund is judged without the seat.
  const payment = await prisma.payment.findUnique({
    where: { id: args.paymentId, deletedAt: null },
    select: { amount: true, ...REFUNDABLE_BALANCE_SELECT },
  });
  // A full refund resolves to the balance the first refund saw: today's plus its own amount.
  const asked =
    args.amountPaise ??
    (payment ? refundableBalancePaise(Number(payment.amount), payment) : 0) +
      Number(prior.amountPaise);
  if (asked === Number(prior.amountPaise)) return;
  throw new OpsRefusal(
    "SESSION_ALREADY_REFUNDED",
    "This session was already refunded at a different amount. Issue any further refund without the session link.",
  );
}

/** What a full refund of this payment would return now; 0 when it is unknown. */
export async function refundablePaymentPaise(
  paymentId: string,
): Promise<number> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId, deletedAt: null },
    select: { amount: true, ...REFUNDABLE_BALANCE_SELECT },
  });
  return payment ? refundableBalancePaise(Number(payment.amount), payment) : 0;
}

/** An upper bound on a whole-event refund: every SUCCEEDED seat's refundable balance. */
export async function refundableEventPaise(
  kind: "class" | "webinar",
  eventId: string,
): Promise<number> {
  const payments = await prisma.payment.findMany({
    where: {
      appointment:
        kind === "webinar" ? { webinarId: eventId } : { classId: eventId },
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    select: { amount: true, ...REFUNDABLE_BALANCE_SELECT },
  });
  return payments.reduce(
    (sum, p) => sum + refundableBalancePaise(Number(p.amount), p),
    0,
  );
}
