import { reportSentryError } from "@/lib/observability/report";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { getAppUrl } from "@/lib/url";
import { notifyRefundProcessed } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { applyReversal } from "./reversal-engine";
import { refundPayment, RefundValidationError } from "./refund";
import { isInternalFundedIntent, refundBookingPayment } from "./booking-refund";
import {
  computeRefundPct,
  parsePolicySnapshot,
} from "./cancellation-policy";

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

  const internal = payments.filter((p) =>
    isInternalFundedIntent(p.paymentIntent),
  );
  const gateway = payments.filter(
    (p) => !isInternalFundedIntent(p.paymentIntent),
  );

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
      reportSentryError(err, {
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
      reportSentryError(err, {
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

/**
 * Refund ONE attendee's seat when the organiser removes them from a live
 * class/webinar (#1003).
 *
 * The participant-removal endpoints moved the roster and left the money alone:
 * a consultant could pull a paying attendee out of an event and keep the fee,
 * with no refund, no earnings reversal and no notice to the attendee. The
 * moderation bulk-cancel has always refunded a removed attendee in full; the
 * interactive endpoints were the outlier.
 *
 * A removal is the organiser's act, so the frozen policy settles it at
 * `consultantInitiatedPct` (100% under the platform defaults) — the attendee
 * did nothing wrong. Routed through `refundBookingPayment` so an org-funded
 * seat reverses in-ledger instead of dying on UNKNOWN_GATEWAY.
 *
 * Never throws: the roster change has already committed.
 */
export async function refundRemovedAttendeeSeat(args: {
  kind: "class" | "webinar";
  eventId: string;
  attendeeUserId: string;
  initiatedByUserId: string | null;
}): Promise<{ amountRefundedPaise: number; refundPct: number } | null> {
  const eventFilter =
    args.kind === "webinar"
      ? { webinarId: args.eventId }
      : { classId: args.eventId };

  try {
    const payment = await prisma.payment.findFirst({
      // Deterministic: the seat they bought first is the one being released.
      orderBy: { createdAt: "asc" },
      where: {
        userId: args.attendeeUserId,
        appointment: eventFilter,
        paymentStatus: "SUCCEEDED",
        amount: { gt: 0 },
        deletedAt: null,
      },
      select: {
        id: true,
        amount: true,
        currency: true,
        organizationId: true,
        appointment: { select: { cancellationPolicySnapshot: true } },
      },
    });
    if (!payment) return null;

    const refundPct = computeRefundPct(
      parsePolicySnapshot(payment.appointment?.cancellationPolicySnapshot),
      // Ignored on the consultant-initiated branch.
      -1,
      true,
    );
    const amountPaise = Math.floor((Number(payment.amount) * refundPct) / 100);
    if (amountPaise <= 0) return { amountRefundedPaise: 0, refundPct };

    const result = await refundBookingPayment({
      paymentId: payment.id,
      amountPaise,
      reason: `removed from ${args.kind} ${args.eventId} by the organiser (${refundPct}%)`,
      initiatedByUserId: args.initiatedByUserId,
    });

    // Only the gateway rail puts money back where this person can see it. On
    // the internal rail the value returned to the org's wallet, accrual or
    // licence — the member never paid, so telling them a refund is coming is
    // simply false.
    if (result.rail === "GATEWAY") {
      void notifyRefundProcessed(args.attendeeUserId, {
        ...notificationScope(payment.organizationId),
        amount: amountPaise,
        currency: payment.currency,
        reason: `You were removed from this ${args.kind}.`,
        dashboardUrl: `${getAppUrl()}/dashboard`,
      }).catch(() => {});
    }

    return { amountRefundedPaise: result.amountRefundedPaise, refundPct };
  } catch (err) {
    // Benign idempotent re-drives — a seat already refunded, or a payment that
    // never captured. Paging ops for these turns every repeat click into an
    // incident. Mirrors the overage credit-back exemption above.
    const benign =
      err instanceof RefundValidationError &&
      (err.code === "ALREADY_FULLY_REFUNDED" ||
        err.code === "PAYMENT_NOT_SUCCEEDED");
    if (benign) return { amountRefundedPaise: 0, refundPct: 0 };

    reportSentryError(err, {
      subsystem: "payments",
      tags: { feature: "attendee-removal-refund" },
      extra: { ...args },
    });
    void recordSystemError({
      organizationId: null,
      category: "PAYMENT",
      summary: `Seat refund failed for attendee removed from ${args.kind} ${args.eventId}`,
      err,
      context: { ...args },
    }).catch(() => {});
    return { amountRefundedPaise: 0, refundPct: 0 };
  }
}
