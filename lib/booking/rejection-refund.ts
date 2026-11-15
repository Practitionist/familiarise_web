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
 *
 * WHO may trigger this is a security property, not a detail: the percentage is
 * 100 and ignores every notice tier, so a buyer able to reach it has a
 * self-service full refund. See the actor guard below.
 *
 * The refund is stamped owed in the reject commit ({@link stampRejectionRefundOwed})
 * under `rejection:<requestId>:<paymentId>`, and the key makes the post-commit
 * drive, a retried drive and the retry sweep one refund between them.
 */

import * as Sentry from "@sentry/nextjs";

import prisma, { type Tx } from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { notifyRefundProcessed } from "@/lib/novu";
import { rejectionRefundReason } from "@/lib/payments/operations/refund-cause";
import { notificationScope } from "@/lib/novu/workflows";
import { goHref } from "@/lib/dashboard/go";
import { EMAIL_BUDGET_MS, sendRefundProcessedEmail } from "@/lib/email";
import { computeRefundPct } from "@/lib/payments/operations/cancellation-policy";
import {
  driveRefundOwed,
  stampOwedOrHeld,
  type OwedRefundAlreadyHeld,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import { isFreeCreditIntent } from "@/lib/payments/funding-rail";
import { resolveBookingRefundContext } from "./cancellation-scope";

export type RejectionRefundOutcome = {
  refundPct: number;
  amountRefundedPaise: number;
  /** Set when the refund leg failed; the rejection still stands. */
  failed?: boolean;
  /** Another door's refund was already owed, so this rejection added nothing. */
  alreadyOwed?: OwedRefundAlreadyHeld;
};

/** What a rejection owes, decided in the reject commit; null when nothing was paid. */
export type RejectionRefundPlan = {
  refundPct: number;
  owed: RefundOwedMarker | null;
  alreadyOwed?: OwedRefundAlreadyHeld;
};

type RejectionArgs = {
  kind: "consultation" | "subscription";
  requestId: string;
  /**
   * Who declined. `CONSULTEE` must never reach here — the PATCH routes reject
   * it with a 403 — and this is the second lock on that door, not the first.
   */
  actor: "CONSULTANT" | "PLATFORM" | "CONSULTEE";
};

/**
 * Quotes the rejection on the reject transaction and stamps the refund owed
 * beside the status move. A consultee actor stamps nothing: the consultant-
 * initiated tier is 100% and ignores notice, so it is never theirs to trigger.
 */
export async function stampRejectionRefundOwed(
  tx: Tx,
  args: RejectionArgs,
): Promise<RejectionRefundPlan | null> {
  if (args.actor === "CONSULTEE") return null;
  const ctx = await resolveBookingRefundContext(
    args.kind === "consultation"
      ? { consultationId: args.requestId }
      : { subscriptionId: args.requestId },
    undefined,
    tx,
  );
  const paid = ctx.paidPayment;
  if (!paid) return null;
  const refundPct = computeRefundPct(
    ctx.policy,
    // Irrelevant on the consultant-initiated branch, but pass the real value
    // so a future policy that tiers consultant cancellations still works.
    ctx.hoursUntilNextSession ?? -1,
    true,
  );
  const key = `rejection:${args.requestId}:${paid.id}`;
  const reason = rejectionRefundReason(args.kind, refundPct);
  // The credits rail accepts no partial amount, so a credit-funded
  // payment restores whole at a positive tier instead of through the clamp.
  // Integer basis points in BigInt, as cancellation-policy does.
  const amountPaise = isFreeCreditIntent(paid.paymentIntent)
    ? null
    : Math.min(
        Number(
          (BigInt(paid.amountPaise) * BigInt(Math.round(refundPct * 100))) /
            BigInt(10_000),
        ),
        paid.refundablePaise,
      );
  const owed: RefundOwedMarker | null =
    refundPct > 0 && (amountPaise === null || amountPaise > 0)
      ? { paymentId: paid.id, amountPaise, key, reason }
      : null;
  const alreadyOwed = owed ? await stampOwedOrHeld(tx, owed) : null;
  // First writer wins: the owed refund already on the payment is the one driven.
  if (alreadyOwed) return { refundPct, owed: null, alreadyOwed };
  return { refundPct, owed };
}

/**
 * Refund a declined paid request after the reject commit, by driving the
 * marker it stamped. Never throws: a failure is reported and left on the
 * marker for the retry sweep.
 */
export async function refundRejectedRequest(
  args: RejectionArgs & {
    initiatedByUserId: string;
    plan: RejectionRefundPlan | null;
  },
): Promise<RejectionRefundOutcome | null> {
  if (args.actor === "CONSULTEE") {
    void recordSystemErrorSafe({
      organizationId: null,
      category: "PAYMENT",
      summary:
        `A consultee-initiated REJECT reached the rejection refund for ` +
        `${args.kind} ${args.requestId}; refusing to refund at the ` +
        `consultant-initiated tier`,
      err: new Error("REJECTION_REFUND_WRONG_ACTOR"),
      context: { kind: args.kind, requestId: args.requestId },
    });
    return null;
  }
  const { plan } = args;
  if (!plan) return null;
  if (!plan.owed) {
    return {
      refundPct: plan.refundPct,
      amountRefundedPaise: 0,
      ...(plan.alreadyOwed ? { alreadyOwed: plan.alreadyOwed } : {}),
    };
  }

  const outcome = await driveRefundOwed(plan.owed, {
    initiatedByUserId: args.initiatedByUserId,
  });
  if (outcome.kind === "refunded" || outcome.kind === "replayed") {
    // Only the gateway rail returns money the payer can see, and the notice
    // quotes the CONFIRMED amount, never the requested one.
    if (outcome.kind === "refunded" && outcome.refund.rail === "GATEWAY") {
      await notifyRejectedRequestPayer(
        plan.owed.paymentId,
        outcome.refund.amountRefundedPaise,
      );
    }
    return {
      refundPct: plan.refundPct,
      amountRefundedPaise: outcome.refund.amountRefundedPaise,
    };
  }
  if (outcome.kind === "settled") {
    return { refundPct: plan.refundPct, amountRefundedPaise: 0 };
  }
  if (outcome.kind === "failed") {
    Sentry.captureException(
      outcome.error instanceof Error
        ? outcome.error
        : new Error(String(outcome.error)),
      {
        tags: { subsystem: "bookings" },
        extra: { kind: args.kind, requestId: args.requestId },
      },
    );
  }
  return { refundPct: 0, amountRefundedPaise: 0, failed: true };
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
    // The expert declined the payer's request: required whatever their switches say.
    await notifyRefundProcessed(
      payment.userId,
      {
        ...notificationScope(payment.organizationId),
        amount: amountPaise,
        currency: payment.currency,
        reason: "Your booking request was declined by the consultant.",
        // #1527 — the recipient is always the payer.
        dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
      },
      {
        required: { kind: "REQUEST_DECLINED", recipients: [payment.userId] },
      },
    );
    // #1653 — the email twin; the sender never throws.
    await sendRefundProcessedEmail(
      {
        userId: payment.userId,
        paymentId,
        amountPaise,
        currency: payment.currency,
        required: true,
      },
      { budgetMs: EMAIL_BUDGET_MS.REQUEST },
    );
  } catch (error) {
    // A missed notification must never fail a settled refund.
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
  }
}
