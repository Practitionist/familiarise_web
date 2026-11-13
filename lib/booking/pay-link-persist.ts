import { AppointmentStatus, PaymentStatus, TrialStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import { reportSentryMessage } from "@/lib/observability/report";

export type PayLinkKind = "trial" | "consultation" | "subscription";

/**
 * What a caller may hand the consultee after its pay-link persist CAS matched
 * zero rows: the link that is live on the row now (ours, when a concurrent
 * mint under the same atom reused the same order; a sibling's, when it won
 * the persist), or null when the request is no longer payable at all.
 */
export interface OrphanedPayLinkOutcome {
  url: string | null;
}

async function readPayable(
  kind: PayLinkKind,
  id: string,
): Promise<{ payable: boolean; url: string | null }> {
  if (kind === "trial") {
    const row = await prisma.trial.findUnique({
      where: { id },
      select: { status: true, pendingPaymentUrl: true },
    });
    return {
      payable: row?.status === TrialStatus.AWAITING_PAYMENT,
      url: row?.pendingPaymentUrl ?? null,
    };
  }
  const row =
    kind === "consultation"
      ? await prisma.consultation.findUnique({
          where: { id },
          select: { status: true, pendingPaymentUrl: true },
        })
      : await prisma.subscription.findUnique({
          where: { id },
          select: { status: true, pendingPaymentUrl: true },
        });
  return {
    payable: row?.status === AppointmentStatus.APPROVED_PENDING_PAYMENT,
    url: row?.pendingPaymentUrl ?? null,
  };
}

/**
 * A pay-link persist that matched zero rows (#1583 A-P0-06). Re-reads the
 * request: if it is still payable and already carries this very order, the
 * mint was a reuse and nothing is orphaned; otherwise the freshly minted
 * order has no row to be paid against and is tombstoned the #1695 way — its
 * PENDING Payment flips to EXPIRED with `expiresAt` now, so no sweep re-drives
 * it, no checkout resumes it and a late capture on it is refunded. A Razorpay
 * order cannot be voided, so the tombstone is the whole answer. The approval
 * mint already owns the Payment row (`paymentIntent` is unique), which is why
 * this is a conditional update rather than a second row.
 */
export async function reconcileOrphanedPayLink(args: {
  kind: PayLinkKind;
  id: string;
  paymentIntentId: string;
  checkoutUrl: string;
}): Promise<OrphanedPayLinkOutcome> {
  const live = await readPayable(args.kind, args.id);
  if (live.payable && live.url === args.checkoutUrl) {
    return { url: args.checkoutUrl };
  }
  const tombstoned = await prisma.payment.updateMany({
    where: {
      paymentIntent: args.paymentIntentId,
      paymentStatus: PaymentStatus.PENDING,
    },
    data: { paymentStatus: PaymentStatus.EXPIRED, expiresAt: new Date() },
  });
  reportSentryMessage("PAY_LINK_ORPHANED", {
    subsystem: args.kind === "trial" ? "trials" : "bookings",
    op: `${args.kind}-pay-link-persist`,
    expected: true,
    extra: {
      [`${args.kind}Id`]: args.id,
      paymentIntentId: args.paymentIntentId,
      tombstoned: tombstoned.count,
      stillPayable: live.payable,
    },
  });
  return { url: live.payable ? live.url : null };
}
