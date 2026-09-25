import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { ladderOverrideAmount } from "@/lib/backoffice/refund-doors";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";

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
      const result = await refundBookingPayment({
        paymentId: body.paymentId,
        amountPaise: override?.amountPaise ?? body.amountPaise,
        reason: `ops refund: ${body.reason}`,
        initiatedByUserId: actor.userId,
        dedupeKey: `ops:${body.idempotencyKey ?? opsActionId}`,
      });
      return {
        target: { kind: "Payment", id: body.paymentId },
        before: { tierOverridePct: body.tierOverridePct ?? null },
        after: { ...result },
        response: { result },
      };
    },
  },
);
