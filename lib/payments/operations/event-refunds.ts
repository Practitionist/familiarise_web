import { reportError } from "@/lib/observability/report";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { applyReversal } from "./reversal-engine";
import { refundPayment, RefundValidationError } from "./refund";

/**
 * Whole-event refund (#776 §C) — the production front door for the reversal
 * engine's CLASS_MULTI path.
 *
 * A cancelled class/webinar must refund EVERY attendee. Those attendees paid
 * through two very different rails, and each needs its own reversal:
 *
 *   - GATEWAY / MOCK seats (paymentIntent pi_/cs_/order_/pay_/…_mock_) — real
 *     card money. They must credit the card, so they go through `refundPayment`
 *     (which owns the gateway phases + its own overage credit-back). Routing
 *     them through the engine would strand the customer's money — the engine
 *     never calls the gateway.
 *   - INTERNAL org-funded seats (paymentIntent org_wallet/org_license/
 *     org_invoice) — no card ever charged; the money lives in the wallet /
 *     invoice accrual / license ledger. `refundPayment` can't refund these
 *     (createRefund throws UNKNOWN_GATEWAY on a synthetic id), so they reverse
 *     purely in-ledger via one CLASS_MULTI transaction.
 *
 * Idempotency: this fans out NEW refunds each call, so callers must invoke it at
 * most once per event — the appointment-cancel CAS and the moderation
 * `moved === 0` guard both provide that. A second call would double-refund.
 */

export type WholeEventRefundSummary = {
  refundsIssued: number;
  refundedPaise: number;
  childRefundIds: string[];
  failures: { paymentId: string; error: string }[];
};

/** Org-funded seats carry a synthetic paymentIntent the gateways can't refund. */
function isInternalFunded(paymentIntent: string): boolean {
  return paymentIntent.startsWith("org_");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function refundWholeEventPayments(
  kind: "class" | "webinar",
  eventId: string,
  reason: string,
  initiatedByUserId: string | null,
): Promise<WholeEventRefundSummary> {
  const summary: WholeEventRefundSummary = {
    refundsIssued: 0,
    refundedPaise: 0,
    childRefundIds: [],
    failures: [],
  };

  const payments = await prisma.payment.findMany({
    where: {
      appointment:
        kind === "webinar" ? { webinarId: eventId } : { classId: eventId },
      paymentStatus: "SUCCEEDED",
      amount: { gt: 0 },
    },
    select: { id: true, amount: true, paymentIntent: true },
  });
  if (payments.length === 0) return summary;

  const internal = payments.filter((p) => isInternalFunded(p.paymentIntent));
  const gateway = payments.filter((p) => !isInternalFunded(p.paymentIntent));

  // Gateway / mock seats — one gateway-aware refund each (refundPayment also
  // handles any CHARGE_MEMBER overage credit-back internally).
  for (const p of gateway) {
    try {
      const r = await refundPayment({ paymentId: p.id, reason, initiatedByUserId });
      summary.refundsIssued += 1;
      summary.refundedPaise += r.amountRefundedPaise;
      summary.childRefundIds.push(r.refundId);
    } catch (err) {
      summary.failures.push({ paymentId: p.id, error: errMsg(err) });
      reportError(err, {
        subsystem: "payments",
        tags: { feature: "whole-event-refund" },
        extra: { paymentId: p.id, eventId, kind },
      });
    }
  }

  // Internal org-funded seats — one CLASS_MULTI reversal (ledger-only). Full
  // reversal: amountPaise == Σ child amounts, so each child reverses in full.
  const memberOverageFollowUps: string[] = [];
  if (internal.length > 0) {
    const internalTotal = internal.reduce((s, p) => s + p.amount, 0);
    try {
      const result = await withSerializableRetry(() =>
        prisma.$transaction(
          (tx) =>
            applyReversal(tx, {
              source: {
                kind: "CLASS_MULTI",
                paymentIds: internal.map((p) => p.id),
              },
              amountPaise: internalTotal,
              reason,
              // Correlation tag only — reverseClassMulti mints its own child
              // Refund rows and keys idempotency off those, not this string.
              refundId: `event:${kind}:${eventId}`,
              initiatedByUserId,
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      summary.refundsIssued += result.childRefundIds.length;
      summary.refundedPaise += internalTotal;
      summary.childRefundIds.push(...result.childRefundIds);
      for (const c of result.cascades) {
        if (c.memberOverageRefundDue) {
          memberOverageFollowUps.push(c.memberOverageRefundDue.overagePaymentId);
        }
      }
    } catch (err) {
      // The whole internal batch rolled back atomically — surface each seat.
      for (const p of internal) {
        summary.failures.push({ paymentId: p.id, error: errMsg(err) });
      }
      reportError(err, {
        subsystem: "payments",
        tags: { feature: "whole-event-refund" },
        extra: { eventId, kind, internalCount: internal.length },
      });
    }
  }

  // #715/#716 — CHARGE_MEMBER overages on the internal seats were collected on
  // separate gateway side-payments the CLASS_MULTI tx can't touch. Credit them
  // back now (best-effort; ops-paged on non-benign failure).
  for (const overagePaymentId of memberOverageFollowUps) {
    try {
      const r = await refundPayment({
        paymentId: overagePaymentId,
        reason: `overage credit-back — ${kind} ${eventId} cancelled`,
        initiatedByUserId,
      });
      summary.childRefundIds.push(r.refundId);
    } catch (err) {
      const benign =
        err instanceof RefundValidationError &&
        (err.code === "ALREADY_FULLY_REFUNDED" ||
          err.code === "PAYMENT_NOT_SUCCEEDED");
      if (!benign) {
        summary.failures.push({ paymentId: overagePaymentId, error: errMsg(err) });
        void recordSystemError({
          organizationId: null,
          category: "PAYMENT",
          summary: `Overage credit-back failed for side-payment ${overagePaymentId}`,
          err,
          context: { overagePaymentId, eventId, kind },
        }).catch(() => {});
      }
    }
  }

  return summary;
}
