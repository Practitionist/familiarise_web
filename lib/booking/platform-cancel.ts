/**
 * A platform operator (STAFF or ADMIN) who is not a party to a booking cancels
 * it only through the audited door at `/api/staff/appointments/[id]/cancel`.
 * The door grants the participant cancel route one request object; the route
 * refuses a privileged non-participant whose request carries no grant.
 */

import prisma from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { resolveBookingRefundContext } from "@/lib/booking/cancellation-scope";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import {
  committedSupportPaiseByPayment,
  type RefundCharge,
} from "@/lib/support/money-policy";

const grants = new WeakMap<Request, { opsActionId: string }>();

export function grantPlatformCancel(request: Request, opsActionId: string) {
  grants.set(request, { opsActionId });
}

export function platformCancelGrant(
  request: Request,
): { opsActionId: string } | null {
  return grants.get(request) ?? null;
}

/**
 * What a platform cancel would refund, per payment: a 1:1 booking refunds the
 * quote the operator confirmed; a webinar or class refunds every live seat, so
 * each payment is priced at its whole refundable balance.
 */
export async function platformCancelCharges(
  appointmentId: string,
  expectedRefundPaise: number,
): Promise<RefundCharge[]> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      consultationId: true,
      subscriptionId: true,
      webinarId: true,
      classId: true,
    },
  });
  if (!appointment)
    throw new OpsRefusal("NOT_FOUND", "Appointment not found.", 404);
  if (appointment.webinarId || appointment.classId) {
    const payments = await prisma.payment.findMany({
      where: { appointmentId, paymentStatus: "SUCCEEDED", deletedAt: null },
      select: { id: true, amount: true, ...REFUNDABLE_BALANCE_SELECT },
    });
    const committed = await committedSupportPaiseByPayment(
      prisma,
      payments.map((p) => p.id),
    );
    return payments.map((payment) => ({
      paymentId: payment.id,
      newPaise: refundableBalancePaise(Number(payment.amount), payment),
      priorPaise: committed.get(payment.id) ?? 0,
    }));
  }
  const ctx = await resolveBookingRefundContext({
    appointmentId,
    consultationId: appointment.consultationId,
    subscriptionId: appointment.subscriptionId,
  });
  if (!ctx.paidPayment) return [];
  const committed = await committedSupportPaiseByPayment(prisma, [
    ctx.paidPayment.id,
  ]);
  return [
    {
      paymentId: ctx.paidPayment.id,
      newPaise: expectedRefundPaise,
      priorPaise: committed.get(ctx.paidPayment.id) ?? 0,
    },
  ];
}
