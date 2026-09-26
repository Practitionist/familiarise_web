/**
 * #1771 K-5 — the admin refund doors' arithmetic. The refund itself always
 * goes through `refundBookingPayment`; this only prices a ladder override.
 */

import prisma from "@/lib/prisma";
import { resolveBookingRefundContext } from "@/lib/booking/cancellation-scope";
import { fundingRailForIntent } from "@/lib/payments/operations/booking-refund";
import { quoteBookingRefund } from "@/lib/payments/operations/cancellation-policy";
import {
  findDedupedRefund,
  RefundGatewayError,
} from "@/lib/payments/operations/refund";
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
    sessionsCompleted: ctx.sessionsCompleted,
    scheduledStarts: ctx.scheduledStarts,
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

/**
 * A gateway refund whose call threw after its keyed row was reserved is in
 * flight, not failed: the row stays PENDING for the reconcile cron (#779).
 * The door answers that row, so the retry and the first call agree (QA #1824).
 */
export async function refundInFlightOr(err: unknown, dedupeKey: string) {
  if (!(err instanceof RefundGatewayError)) throw err;
  const row = await findDedupedRefund(dedupeKey).catch(() => null);
  if (!row) {
    throw new OpsRefusal(
      "GATEWAY_REFUND_FAILED",
      "The gateway refused the refund and nothing is pending — check the payment and try again.",
      502,
    );
  }
  return {
    refundId: row.refundId,
    amountRefundedPaise: row.amountRefundedPaise,
    rail: "GATEWAY" as const,
    status: row.status,
  };
}

/** #1834 — the occurrence must sit on the payment's booking under a live seat it funds. */
async function assertSessionOnPayment(paymentId: string, occurrenceId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId, deletedAt: null },
    select: { appointmentId: true, userId: true },
  });
  const occurrence = await prisma.appointmentOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { appointmentId: true },
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
          select: { id: true },
        })
      : null;
  if (!seat) {
    throw new OpsRefusal(
      "SESSION_NOT_ON_PAYMENT",
      "That session is not part of this payment's booking, or the payment holds no live seat for it.",
    );
  }
}

/**
 * #1834 — a session key refunds once. A retry that resolves to the first
 * refund's amount replays it; any other amount is refused, never deduped.
 */
export async function assertSessionRefundable(args: {
  paymentId: string;
  occurrenceId: string;
  dedupeKey: string;
  amountPaise: number | undefined;
}): Promise<void> {
  await assertSessionOnPayment(args.paymentId, args.occurrenceId);
  const prior = await prisma.refund.findUnique({
    where: { dedupeKey: args.dedupeKey },
    select: { amountPaise: true, status: true },
  });
  if (!prior || prior.status === "FAILED" || prior.status === "CANCELLED") {
    return;
  }
  // A full refund resolves to the balance the first refund saw: today's plus its own amount.
  let asked = args.amountPaise;
  if (asked === undefined) {
    const row = await prisma.payment.findUnique({
      where: { id: args.paymentId },
      select: { amount: true, ...REFUNDABLE_BALANCE_SELECT },
    });
    asked = row
      ? refundableBalancePaise(Number(row.amount), row) +
        Number(prior.amountPaise)
      : undefined;
  }
  if (asked === Number(prior.amountPaise)) return;
  throw new OpsRefusal(
    "SESSION_ALREADY_REFUNDED",
    "This session was already refunded at a different amount. Issue any further refund without the session link.",
  );
}
