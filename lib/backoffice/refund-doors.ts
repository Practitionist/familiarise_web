/**
 * #1771 K-5 — the admin refund doors' arithmetic. The refund itself always
 * goes through `refundBookingPayment`; this only prices a ladder override.
 */

import prisma from "@/lib/prisma";
import { resolveBookingRefundContext } from "@/lib/booking/cancellation-scope";
import { fundingRailForIntent } from "@/lib/payments/operations/booking-refund";
import { quoteBookingRefund } from "@/lib/payments/operations/cancellation-policy";
import { OpsRefusal } from "./ops-refusal-error";

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
