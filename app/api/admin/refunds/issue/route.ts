import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import {
  assertSessionRefundable,
  ladderOverrideAmount,
  refundablePaymentPaise,
  refundInFlightOr,
} from "@/lib/backoffice/refund-doors";
import { assertRefundDoorOpen } from "@/lib/backoffice/refund-eligibility";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { occurrenceRefundKey } from "@/lib/booking/class-sessions";

/** 400 copy for a missing/malformed `idempotencyKey` (via withOpsAction). */
const KEY_REQUIRED_COPY =
  "idempotencyKey is required and must be a UUID — send the per-dialog key the refund dialog already mints. Without it this door cannot tell a double-click from a second refund, and would mint a fresh one instead, leaving the unique dedupe column inert.";

/**
 * Deterministic in the caller's key, so `Refund.dedupeKey @unique` fires on a
 * second click. A UUID has no colon: never equals `ops:credits:…`.
 */
function issueDedupeKey(body: {
  paymentId: string;
  idempotencyKey: string;
  occurrenceId?: string;
}): string {
  return body.occurrenceId
    ? occurrenceRefundKey(body.occurrenceId, body.paymentId)
    : `ops:${body.idempotencyKey}`;
}

/** The amount a replay must match; a session key's amount is judged by assertSessionRefundable. */
function replayAmount(body: {
  amountPaise?: number;
  occurrenceId?: string;
}): number | undefined {
  return body.occurrenceId ? undefined : body.amountPaise;
}

/**
 * #1771 K-5 — "Issue refund" and "Ladder override". A full refund (no
 * amount), a partial one, or the cancellation quote at an overridden tier;
 * all through the booking front door under the key `ops:<idempotencyKey>`.
 */
export const POST = withOpsAction(
  "refunds.manage",
  (body) =>
    body.tierOverridePct === undefined ? "refund.issue" : "refund.override",
  {
    paymentId: z.string().min(1),
    /**
     * Required, never defaulted: `Refund.dedupeKey @unique` collapses a
     * double-click only when the key is caller-minted. One key per dialog.
     */
    idempotencyKey: z
      .string({
        required_error: KEY_REQUIRED_COPY,
        invalid_type_error: KEY_REQUIRED_COPY,
      })
      .uuid(KEY_REQUIRED_COPY),
    amountPaise: z.number().int().positive().optional(),
    tierOverridePct: z.number().min(0).max(100).optional(),
    /** #1834 — a held-seat queue item: the refund carries that session's own key. */
    occurrenceId: z.string().min(1).optional(),
  },
  {
    mode: "gateway",
    target: ({ body }) => ({ kind: "Payment", id: body.paymentId }),
    run: async ({ body, actor }) => {
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
      const dedupeKey = issueDedupeKey(body);
      const replay = await assertRefundDoorOpen(
        body.paymentId,
        dedupeKey,
        replayAmount(body),
      );
      // A replayed override keeps the amount it sent, not one priced on today's balance.
      const override =
        body.tierOverridePct === undefined
          ? null
          : (replay ??
            (await ladderOverrideAmount(body.paymentId, body.tierOverridePct)));
      if (override && override.amountPaise <= 0) {
        throw new OpsRefusal(
          "NOTHING_TO_REFUND",
          "At that percentage nothing is owed on this booking.",
        );
      }
      const amountPaise = override?.amountPaise ?? body.amountPaise;
      if (body.occurrenceId) {
        await assertSessionRefundable({
          paymentId: body.paymentId,
          occurrenceId: body.occurrenceId,
          dedupeKey,
          amountPaise,
        });
      }
      const result = await refundBookingPayment({
        paymentId: body.paymentId,
        amountPaise,
        reason: `ops refund: ${body.reason}`,
        initiatedByUserId: actor.userId,
        dedupeKey,
        // A partial ops refund is not a cancellation; one that returns the rest ends the seat.
        keepSeatIfPartial: true,
        settlesOwedByHand: true,
      }).catch((err: unknown) =>
        refundInFlightOr(err, dedupeKey, {
          paymentId: body.paymentId,
          amountPaise,
        }),
      );
      return {
        target: { kind: "Payment", id: body.paymentId },
        before: { tierOverridePct: body.tierOverridePct ?? null },
        after: { ...result },
        response: { result },
      };
    },
  },
  {
    stepUp: true,
    secondApprover: {
      route: "/api/admin/refunds/issue",
      target: ({ body }) => ({ kind: "Payment", id: body.paymentId }),
      // A body naming both runs straight into the door's own refusal.
      amountPaise: async (body) => {
        // A refund the door would refuse is never held for a second admin.
        const replay = await assertRefundDoorOpen(
          body.paymentId,
          issueDedupeKey(body),
          replayAmount(body),
        );
        if (body.tierOverridePct === undefined) {
          return body.amountPaise ?? refundablePaymentPaise(body.paymentId);
        }
        if (body.amountPaise !== undefined) return 0;
        return (
          replay ??
          (await ladderOverrideAmount(body.paymentId, body.tierOverridePct))
        ).amountPaise;
      },
    },
  },
);
