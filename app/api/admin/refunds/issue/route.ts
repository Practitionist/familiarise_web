import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import {
  assertSessionRefundable,
  ladderOverrideAmount,
  refundInFlightOr,
} from "@/lib/backoffice/refund-doors";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { occurrenceRefundKey } from "@/lib/booking/class-sessions";

/**
 * Actionable copy for a missing/malformed `idempotencyKey`. Surfaced verbatim
 * by `withOpsAction` as `{ error, code: "INVALID_BODY" }` with a 400 — the
 * route's existing validation convention, so no new pattern is introduced here.
 */
const KEY_REQUIRED_COPY =
  "idempotencyKey is required and must be a UUID — send the per-dialog key the refund dialog already mints. Without it this door cannot tell a double-click from a second refund, and would mint a fresh one instead, leaving the unique dedupe column inert.";

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
     * REQUIRED, and refused when omitted — never defaulted here.
     *
     * Invariant: this door's `Refund.dedupeKey` is a pure function of a
     * caller-minted key, so `Refund.dedupeKey @unique` is what collapses a
     * double-click. The defect was the `?? opsActionId` fallback: a per-request
     * `randomUUID()` is unique on every click BY CONSTRUCTION, so the unique
     * column never fired, the in-transaction refundable-balance re-derivation
     * still saw the full balance, and one double-click issued two real refunds.
     * A server-minted key is that same inert column, so omission is a 4xx with
     * this message rather than a silently fresh key.
     *
     * One key per dialog: a double-click or a retry reuses the first refund.
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
      // Deterministic in the caller's key, so `Refund.dedupeKey @unique` fires
      // on the second click. The credits door namespaces under `ops:credits:`;
      // that cannot collide with this bare `ops:` slot because a validated UUID
      // contains no colon — `ops:<uuid>` never equals `ops:credits:<uuid>`.
      const dedupeKey = body.occurrenceId
        ? occurrenceRefundKey(body.occurrenceId, body.paymentId)
        : `ops:${body.idempotencyKey}`;
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
