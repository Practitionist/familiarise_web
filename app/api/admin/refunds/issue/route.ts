import { z } from "zod";

import prisma from "@/lib/prisma";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import {
  ladderOverrideAmount,
  refundInFlightOr,
} from "@/lib/backoffice/refund-doors";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { occurrenceRefundKey } from "@/lib/booking/class-sessions";

/**
 * #1834 — a session's key refunds once; a retry at the same amount replays
 * it, and a different amount is refused rather than silently deduped.
 */
async function assertSessionKeyFree(
  dedupeKey: string,
  amountPaise: number | undefined,
): Promise<void> {
  const prior = await prisma.refund.findUnique({
    where: { dedupeKey },
    select: { amountPaise: true, status: true },
  });
  if (!prior || prior.status === "FAILED" || prior.status === "CANCELLED") {
    return;
  }
  if (amountPaise === undefined || Number(prior.amountPaise) === amountPaise) {
    return;
  }
  throw new OpsRefusal(
    "SESSION_ALREADY_REFUNDED",
    "This session was already refunded at a different amount. Issue any further refund without the session link.",
  );
}

/**
 * #1771 K-5 — "Issue refund" and "Ladder override". A full refund (no
 * amount), a partial one, or the cancellation quote at an overridden tier;
 * all through the booking front door under the key `ops:<opsActionId>`.
 */
export const POST = withOpsAction(
  "refunds.manage",
  (body) =>
    body.tierOverridePct === undefined ? "refund.issue" : "refund.override",
  {
    paymentId: z.string().min(1),
    /** One per dialog: a double-click or retry reuses the first refund. */
    idempotencyKey: z.string().uuid().optional(),
    amountPaise: z.number().int().positive().optional(),
    tierOverridePct: z.number().min(0).max(100).optional(),
    /** #1834 — a held-seat queue item: the refund carries that session's own key. */
    occurrenceId: z.string().min(1).optional(),
  },
  {
    mode: "gateway",
    target: ({ body }) => ({ kind: "Payment", id: body.paymentId }),
    run: async ({ body, actor, opsActionId }) => {
      if (
        body.amountPaise !== undefined &&
        body.tierOverridePct !== undefined
      ) {
        throw new OpsRefusal(
          "INVALID_BODY",
          "Give an amount or a tier override, not both.",
          400,
        );
      }
      await assertMoneyOpsBudget(actor.userId);
      const override =
        body.tierOverridePct === undefined
          ? null
          : await ladderOverrideAmount(body.paymentId, body.tierOverridePct);
      if (override && override.amountPaise <= 0) {
        throw new OpsRefusal(
          "NOTHING_TO_REFUND",
          "At that percentage nothing is owed on this booking.",
        );
      }
      const amountPaise = override?.amountPaise ?? body.amountPaise;
      const dedupeKey = body.occurrenceId
        ? occurrenceRefundKey(body.occurrenceId, body.paymentId)
        : `ops:${body.idempotencyKey ?? opsActionId}`;
      if (body.occurrenceId) {
        await assertSessionKeyFree(dedupeKey, amountPaise);
      }
      const result = await refundBookingPayment({
        paymentId: body.paymentId,
        amountPaise,
        reason: `ops refund: ${body.reason}`,
        initiatedByUserId: actor.userId,
        dedupeKey,
        // A partial ops refund is not a cancellation: the seat stays live.
        keepSeat: amountPaise !== undefined,
      }).catch((err: unknown) => refundInFlightOr(err, dedupeKey));
      return {
        target: { kind: "Payment", id: body.paymentId },
        before: { tierOverridePct: body.tierOverridePct ?? null },
        after: { ...result },
        response: { result },
      };
    },
  },
);
