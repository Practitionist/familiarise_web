import type { PaymentGateway } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { cancelPaymentIntent } from "@/scripts/payments/cleanup-abandoned-payments";

export interface GatewayCancel {
  paymentIntent: string;
  gateway: PaymentGateway;
}

/**
 * Expire every PENDING payment on a booking (optionally one buyer's) and give
 * back what its checkout consumed: referral credits and the org engagement.
 * PENDING → EXPIRED is a CAS, so a capture committing first keeps SUCCEEDED,
 * and a capture committing second lands on EXPIRED and is parked + refunded.
 */
export async function expirePendingPaymentsInTx(
  tx: Tx,
  args: { appointmentId: string; userId?: string; reason: string },
): Promise<{ expired: number; gatewayCancels: GatewayCancel[] }> {
  const pending = await tx.payment.findMany({
    where: {
      appointmentId: args.appointmentId,
      ...(args.userId ? { userId: args.userId } : {}),
      paymentStatus: "PENDING",
    },
    select: {
      id: true,
      paymentIntent: true,
      paymentGateway: true,
      isMockPayment: true,
    },
  });
  const gatewayCancels: GatewayCancel[] = [];
  let expired = 0;
  for (const payment of pending) {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    if (claimed.count === 0) continue;
    expired += 1;
    await reverseCreditsForPayment(payment.id, tx);
    await reverseBookingUtilization(tx, {
      paymentId: payment.id,
      reason: args.reason,
    });
    if (!payment.isMockPayment) {
      gatewayCancels.push({
        paymentIntent: payment.paymentIntent,
        gateway: payment.paymentGateway,
      });
    }
  }
  return { expired, gatewayCancels };
}

/**
 * Best-effort, post-commit: a gateway that refuses to cancel never revives the
 * booking; a capture that still lands is refunded by the capture-after-release path.
 */
export async function cancelGatewayOrders(
  cancels: GatewayCancel[],
  context: { op: string; appointmentId: string },
): Promise<void> {
  for (const cancel of cancels) {
    try {
      await cancelPaymentIntent(cancel.paymentIntent, cancel.gateway);
    } catch (error) {
      reportSentryError(error, {
        subsystem: "bookings",
        op: context.op,
        expected: true,
        extra: { appointmentId: context.appointmentId },
      });
    }
  }
}
