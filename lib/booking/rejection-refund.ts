/**
 * Refund a paid request the consultant declined (#1004).
 *
 * `REJECTED` is legally reachable from `PENDING` and
 * `APPROVED_PENDING_PAYMENT` (lib/booking/transitions.ts), and the
 * direct-checkout flow captures the money BEFORE the request is created — it
 * lands `PENDING` with a `SUCCEEDED` payment already attached. So a consultant
 * declining a direct-checkout booking left the buyer paid-up with nothing to
 * show for it, and no way out: `REJECTED` is not in `CANCELLABLE_FROM`, so the
 * cancel route 409s and the money simply stayed captured.
 *
 * A rejection is the consultant's act and nothing has been delivered, so the
 * policy's consultant-initiated percentage applies to the whole amount — the
 * same rule trials already use when a consultant rejects
 * (`lib/trials/cancellation.ts`).
 *
 * Deliberately never throws: the rejection has already committed by the time
 * this runs and a gateway failure must not roll it back. Failures surface in
 * Sentry and as `failed` on the result.
 */

import * as Sentry from "@sentry/nextjs";

import prisma from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { notifyRefundProcessed } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import {
  computeRefundPct,
  parsePolicySnapshot,
} from "@/lib/payments/operations/cancellation-policy";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { resolveBookingRefundContext } from "./cancellation-scope";

export type RejectionRefundOutcome = {
  refundPct: number;
  amountRefundedPaise: number;
  /** Set when the refund leg failed; the rejection still stands. */
  failed?: boolean;
};

export async function refundRejectedRequest(args: {
  kind: "consultation" | "subscription";
  requestId: string;
  initiatedByUserId: string;
}): Promise<RejectionRefundOutcome | null> {
  try {
    const ctx = await resolveBookingRefundContext(
      args.kind === "consultation"
        ? { consultationId: args.requestId }
        : { subscriptionId: args.requestId },
    );
    if (!ctx.paidPayment) return null;

    const refundPct = computeRefundPct(
      parsePolicySnapshot(ctx.policySnapshot),
      // Irrelevant on the consultant-initiated branch, but pass the real value
      // so a future policy that tiers consultant cancellations still works.
      ctx.hoursUntilNextSession ?? -1,
      true,
    );
    const amountPaise = Math.floor(
      (ctx.paidPayment.amountPaise * refundPct) / 100,
    );
    if (amountPaise <= 0) return { refundPct, amountRefundedPaise: 0 };

    const result = await refundBookingPayment({
      paymentId: ctx.paidPayment.id,
      amountPaise,
      reason: `${args.kind} request rejected by consultant (${refundPct}%)`,
      initiatedByUserId: args.initiatedByUserId,
    });

    void notifyRejectedRequestPayer(ctx.paidPayment.id, amountPaise);

    return { refundPct, amountRefundedPaise: result.amountRefundedPaise };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "bookings" },
        extra: { kind: args.kind, requestId: args.requestId },
      },
    );
    console.error(
      `[reject] refund failed for ${args.kind} ${args.requestId}:`,
      error,
    );
    return { refundPct: 0, amountRefundedPaise: 0, failed: true };
  }
}

async function notifyRejectedRequestPayer(
  paymentId: string,
  amountPaise: number,
): Promise<void> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { userId: true, currency: true, organizationId: true },
    });
    if (!payment) return;
    await notifyRefundProcessed(payment.userId, {
      ...notificationScope(payment.organizationId),
      amount: amountPaise,
      currency: payment.currency,
      reason: "Your booking request was declined by the consultant.",
      dashboardUrl: `${getAppUrl()}/dashboard`,
    });
  } catch (error) {
    // A missed notification must never fail a settled refund.
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
  }
}
